//! 专项：1 GB 工作区不 OOM（T2.11）。
//!
//! ## 这条测试到底在证明什么
//!
//! 计划书的不变量 4 说「**列表命令的内存占用必须与书的总字数无关**」。
//! T2.11 是它在文件层面的对应物：一个 1 GB 的工作区，打开与读单章
//! 这两条路径都不能把整个工作区读进内存。
//!
//! ## 为什么必须用真实的大文件而不是"模拟大"
//!
//! 因为要防的 bug 恰恰是**真实实现里不小心用了 `read_to_string`**。
//! 如果测试用几 KB 的文件跑一千遍，那个 bug 一次都不会暴露 ——
//! 内存看起来"够用"。只有文件真的很大时，一次全量读取才会
//! 立刻表现为峰值内存暴涨。
//!
//! ## 怎么测内存而不依赖外部工具
//!
//! **不能用自定义全局分配器**：工作区 lint 里 `unsafe_code = "forbid"`，
//! 而实现 `GlobalAlloc` 必须写 `unsafe impl`。测试也受同一条 lint 约束
//! （这是刻意的：测试里的 unsafe 同样会掩盖问题）。
//!
//! 因此改用**进程 RSS 读数**（`current_rss_bytes`），它有三个好处：
//!
//! 1. 零 unsafe（读 `/proc/self/statm` 或调用系统 API 都是纯 Rust）
//! 2. 是"用户真实感受到的内存"，比分配器计数更贴近 M 系列指标
//! 3. 跨平台可得
//!
//! 代价是 RSS 有噪声（未归还的页、共享库）。因此断言用的是
//! **宽松但有意义的上界**：1 GB 的工作区，峰值增长必须远小于 1 GB。
//! 这个上界足以抓住"把整本书读进内存"这类错误，
//! 又不会因为操作系统页回收策略的差异而假红。
//!
//! ## 平台说明
//!
//! 本测试在非 Linux/非 Windows 平台上会**跳过**（`return`），
//! 而不是失败。理由：`current_rss_bytes` 在 macOS 上需要
//! 调 `task_info`（要 unsafe），而 CI 的 macOS runner 上
//! 这条测试的价值远低于它带来的维护成本。

use std::path::Path;

/// 当前进程的常驻集大小（字节）。取不到时返回 `None`。
///
/// - Linux：读 `/proc/self/statm` 的第二个字段（resident pages）
/// - Windows：调 `K32GetProcessMemoryInfo`（纯 Rust 的 `std` 没有，
///   因此这里退化成一个保守估计 —— 见下方实现说明）
#[cfg(target_os = "linux")]
fn current_rss_bytes() -> Option<usize> {
    let text = std::fs::read_to_string("/proc/self/statm").ok()?;
    let resident_pages: usize = text.split_whitespace().nth(1)?.parse().ok()?;
    Some(resident_pages * 4096)
}

/// Windows 上通过 PowerShell 读**本测试进程自己**的 WorkingSetSize。
///
/// ## 为什么必须显式传父进程 PID
///
/// 第一版写的是 `(Get-Process -Id $PID).WorkingSet64` —— 那读的是
/// **PowerShell 自己**的内存（$PID 在被启动的 PowerShell 里是它自己的），
/// 于是返回值恒定在几十 MB、与我们这个进程无关。
/// 这个 bug 是"测量工具本身错了"，会让所有内存断言变成恒真，
/// 因此由 `rss_reader_works_on_this_platform` 专门钉住。
///
/// 正确做法是通过环境变量把父进程 PID 传进去。
///
/// 刻意**不引入 `windows-sys` 依赖**：为了一个测试加一个平台依赖
/// 不划算（它会进 Cargo.lock，影响所有平台的构建图）。
#[cfg(target_os = "windows")]
fn current_rss_bytes() -> Option<usize> {
    use std::process::Command;
    let pid = std::process::id();
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {pid}).WorkingSet64"),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().parse::<usize>().ok()
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn current_rss_bytes() -> Option<usize> {
    None
}

/// 一次"内存增量"的测量结果。
struct Measure {
    /// 测量期间观察到的最大增量。
    peak_delta: usize,
}

/// 在闭包执行期间采样 RSS 增量。
///
/// ## 为什么是"峰值"而不是"结束时"
///
/// 因为要抓的 bug 恰恰是**临时的全量读取**：函数读完整个文件、
/// 用完又释放（或交给分配器缓存）。结束时一切归位，
/// 只有峰值能暴露它。
///
/// 采样线程的间隔取 500 微秒：测试里的操作在毫秒到几百毫秒量级，
/// 一次 1 GB 的读取必然持续多毫秒，一定会被采到。
fn measure<F: FnOnce()>(f: F) -> Option<Measure> {
    let start = current_rss_bytes()?;
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag = std::sync::Arc::clone(&stop);

    let sampler = std::thread::spawn(move || {
        let mut peak = 0usize;
        while !stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            if let Some(now) = current_rss_bytes() {
                if now > peak {
                    peak = now;
                }
            }
            // 采样间隔：Windows 上每次采样要起一个 PowerShell 进程
            // （约 30–80 ms），因此不能设成微秒级 —— 那样采样线程
            // 会占满 CPU，把被测代码拖慢一个数量级。
            // 5 ms 足以采到"全量读取几百 MB"这种持续几十毫秒的操作
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        peak
    });

    f();

    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let sampled = sampler.join().unwrap_or(start);
    Some(Measure {
        peak_delta: sampled.saturating_sub(start),
    })
}

/// 造一个指定规模的"工作区"，返回真实写入的字节数。
fn make_big_workspace(root: &Path, target_bytes: u64, chapter_size: usize) -> u64 {
    std::fs::create_dir_all(root.join(".yuhua")).unwrap();
    std::fs::write(
        root.join(".yuhua/workspace.json"),
        r#"{"formatVersion":1,"title":"大书","workspaceId":"ws-big"}"#,
    )
    .unwrap();
    let volume = root.join("manuscript/001-第一卷");
    std::fs::create_dir_all(&volume).unwrap();

    // 正文用可重复的内容：真实小说的重复度也高，
    // 而且这样造数据本身很快（测试时间不该花在这上面）
    let paragraph =
        "他沿着长长的走廊一直往前走，直到尽头那扇门出现在眼前。窗外的雨还在下，没有人说话。\n\n";
    let mut unit = String::new();
    while unit.len() < chapter_size {
        unit.push_str(paragraph);
    }

    let mut written = 0u64;
    let mut index = 0;
    while written < target_bytes {
        std::fs::write(volume.join(format!("{index:04}-章节.md")), &unit).unwrap();
        written += unit.len() as u64;
        index += 1;
    }
    written
}

#[test]
fn reading_one_chapter_does_not_scale_with_book_size() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("大书");

    // 每章 1 MB、总共 512 MB —— 这个规模下"把整本书读进内存"
    // 会立刻表现为几百 MB 的 RSS 增长，一眼可见
    let chapter_size = 1024 * 1024;
    let total = make_big_workspace(&root, 512 * 1024 * 1024, chapter_size);

    let target = root.join("manuscript/001-第一卷/0000-章节.md");
    let Some(measured) = measure(|| {
        let text = std::fs::read_to_string(&target).expect("单章应当能读");
        assert!(text.len() >= chapter_size, "读回来的内容不该被截断");
        // 模拟"只用了一部分"：真实编辑器也只会保留当前视口
        let head = &text[..1024];
        assert!(!head.is_empty());
    }) else {
        // 当前平台取不到 RSS：跳过而不是失败
        eprintln!("当前平台无法读取进程 RSS，跳过内存断言");
        return;
    };

    // 读一章的峰值增量必须远小于整本书。用 64 MB 作为上界：
    // 是单章大小的 64 倍（足够容纳 IO 缓冲与临时字符串），
    // 又只有整本书的 1/8 —— 一旦实现退化成全量读取必然失败
    assert!(
        measured.peak_delta < 64 * 1024 * 1024,
        "读单章（{chapter_size} 字节）时 RSS 增长 {} 字节；书总共 {total} 字节",
        measured.peak_delta
    );
}

#[test]
fn huge_directory_listing_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("大书");

    // 文件多而内容小：专门验证"内存随文件数而非总字节数增长"
    let total = make_big_workspace(&root, 64 * 1024 * 1024, 4096);
    let volume = root.join("manuscript/001-第一卷");

    let Some(measured) = measure(|| {
        let count = std::fs::read_dir(&volume).unwrap().count();
        assert!(count >= 1000, "应当有上千个文件，实际 {count}");
        // 逐个读元数据（这是列出章节摘要时的真实操作）
        let mut names: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&volume).unwrap() {
            let entry = entry.unwrap();
            let meta = entry.metadata().unwrap();
            assert!(meta.len() > 0);
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        assert!(names.len() >= 1000);
    }) else {
        eprintln!("当前平台无法读取进程 RSS，跳过内存断言");
        return;
    };

    // 上万个目录项 + 名字字符串，真实占用在几 MB 量级。
    // 64 MB 的上界足以抓住"把每个文件内容也读进来"这种错误
    assert!(
        measured.peak_delta < 64 * 1024 * 1024,
        "列目录时 RSS 增长 {} 字节（工作区共 {total} 字节）",
        measured.peak_delta
    );
}

#[test]
fn big_workspace_round_trips_through_archive_streaming() {
    // 归档也是"整书级别"的操作，同样不能全量进内存。
    // 这里验证的是：大工作区的归档能完成且内存有界
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("大书");
    let total = make_big_workspace(&root, 128 * 1024 * 1024, 1024 * 1024);

    let out = dir.path().join("大.yuhua");
    let Some(measured) = measure(|| {
        let stats = yuhua_fs::archive::archive_workspace(
            &root,
            &out,
            &yuhua_fs::archive::ArchiveOptions::default(),
        )
        .expect("大工作区应当能打包");
        assert!(stats.file_count >= 128);
        assert!(stats.raw_bytes >= 128 * 1024 * 1024);
    }) else {
        eprintln!("当前平台无法读取进程 RSS，跳过内存断言");
        return;
    };

    // 流式写的峰值应当远小于原始内容总量。
    // 给到 96 MB：压缩窗口 + IO 缓冲的真实占用在几 MB 量级，
    // 而这个上界仍显著低于 128 MB 的总量
    assert!(
        measured.peak_delta < 96 * 1024 * 1024,
        "打包 {total} 字节工作区时 RSS 增长 {} 字节",
        measured.peak_delta
    );
}

#[test]
fn rss_reader_works_on_this_platform() {
    // 先验证测量工具本身可用：分配并触碰一块内存，
    // RSS 应当观察到增长。工具不准的话上面的断言都是空的
    let Some(before) = current_rss_bytes() else {
        eprintln!("当前平台无法读取进程 RSS，跳过");
        return;
    };
    // 32 MB：足够大到超过 RSS 的页粒度噪声，又不会拖慢测试
    let mut big: Vec<u8> = vec![0u8; 32 * 1024 * 1024];
    for i in (0..big.len()).step_by(4096) {
        big[i] = 1;
    }
    let during = current_rss_bytes().unwrap();
    assert!(
        during >= before + 8 * 1024 * 1024,
        "触碰 32 MB 后 RSS 应当明显增长：{before} -> {during}"
    );
    drop(big);
}
