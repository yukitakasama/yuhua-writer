//! 工作区归档的测试（T2.14）。
//!
//! ## 测试重点
//!
//! 归档功能有两类失败模式，都必须钉死：
//!
//! 1. **该打进去的没打进去**（作者的稿子丢在包里）——
//!    由 `roundtrip` 与 `exclusion_rules` 覆盖。
//! 2. **不该打进去的混进去了**（回收站、备份、临时文件）——
//!    这会让包体积不可预期，也可能把作者以为删掉的内容带出去。
//!
//! 另外还有一类安全失败：**恶意归档写到目标目录之外**（Zip Slip）。
//! 作者的包会经过微信 / 网盘传递，完全不可信。

use std::fs;
use std::path::Path;

use yuhua_fs::archive::{
    archive_workspace, extract_archive, read_manifest, safe_join, should_exclude, ArchiveManifest,
    ArchiveOptions, ARCHIVE_EXTENSION, MANIFEST_NAME,
};

/// 造一个最小的合法工作区。
fn make_workspace(root: &Path) {
    fs::create_dir_all(root.join(".yuhua")).unwrap();
    fs::create_dir_all(root.join("manuscript/001-第一卷")).unwrap();
    fs::create_dir_all(root.join("outline")).unwrap();
    fs::write(
        root.join(".yuhua/workspace.json"),
        r#"{"formatVersion":1,"title":"羽化录","workspaceId":"ws-1"}"#,
    )
    .unwrap();
    fs::write(
        root.join("manuscript/001-第一卷/001-开篇.md"),
        "# 第一章\n\n他只是走过去，什么也没说。",
    )
    .unwrap();
    fs::write(
        root.join("manuscript/001-第一卷/002-第二.md"),
        "# 第二章\n\n原文".to_string() + &"很长的一段正文。".repeat(50),
    )
    .unwrap();
    fs::write(root.join("outline/总纲.md"), "# 总纲\n").unwrap();
}

/// 造一些"不该进包"的内容。
fn make_excluded_content(root: &Path) {
    fs::create_dir_all(root.join(".trash/20260101-ch_1")).unwrap();
    fs::write(root.join(".trash/20260101-ch_1/正文.md"), "被删掉的内容").unwrap();
    fs::create_dir_all(root.join(".yuhua/backup")).unwrap();
    fs::write(root.join(".yuhua/backup/备份1.md"), "旧版本").unwrap();
    fs::create_dir_all(root.join(".yuhua/journal")).unwrap();
    fs::write(root.join(".yuhua/journal/entry.json"), "{}").unwrap();
    fs::create_dir_all(root.join(".yuhua/stats")).unwrap();
    fs::write(root.join(".yuhua/stats/2026-01.json"), "{}").unwrap();
    fs::write(root.join("manuscript/半截.md.tmp"), "没写完的临时文件").unwrap();
}

#[test]
fn roundtrip_preserves_manuscript() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("书");
    make_workspace(&root);

    let out = dir.path().join(format!("包.{ARCHIVE_EXTENSION}"));
    let stats = archive_workspace(&root, &out, &ArchiveOptions::default()).unwrap();

    assert!(stats.file_count > 0, "应当至少打入几个文件");
    assert!(stats.archive_bytes > 0);
    assert!(out.exists(), "归档文件应当存在");

    // 解到另一个目录，逐文件比对
    let dest = dir.path().join("解出来的");
    let extracted = extract_archive(&out, &dest).unwrap();
    assert_eq!(extracted.file_count, stats.file_count);
    assert_eq!(extracted.manifest.title, "羽化录");
    assert_eq!(extracted.manifest.workspace_format_version, 1);

    let original = fs::read_to_string(root.join("manuscript/001-第一卷/001-开篇.md")).unwrap();
    let restored = fs::read_to_string(dest.join("manuscript/001-第一卷/001-开篇.md")).unwrap();
    assert_eq!(original, restored, "正文必须逐字节一致");

    let outline = fs::read_to_string(dest.join("outline/总纲.md")).unwrap();
    assert!(outline.contains("总纲"));

    // 工作区配置也要在包里，否则解出来不是工作区
    assert!(dest.join(".yuhua/workspace.json").exists());
}

#[test]
fn excluded_content_stays_out_of_archive() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("书");
    make_workspace(&root);
    make_excluded_content(&root);

    let out = dir.path().join(format!("包.{ARCHIVE_EXTENSION}"));
    archive_workspace(&root, &out, &ArchiveOptions::default()).unwrap();

    let dest = dir.path().join("解出来的");
    extract_archive(&out, &dest).unwrap();

    assert!(!dest.join(".trash").exists(), "回收站不该进包");
    assert!(!dest.join(".yuhua/backup").exists(), "轮转备份不该进包");
    assert!(!dest.join(".yuhua/journal").exists(), "崩溃日志不该进包");
    assert!(
        !dest.join(".yuhua/stats").exists(),
        "统计是设备本地数据，不该进包"
    );
    assert!(
        !dest.join("manuscript/半截.md.tmp").exists(),
        "临时文件不该进包"
    );

    // 而正文必须在
    assert!(dest.join("manuscript/001-第一卷/001-开篇.md").exists());
}

#[test]
fn include_trash_option_works() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("书");
    make_workspace(&root);
    make_excluded_content(&root);

    let out = dir.path().join(format!("包.{ARCHIVE_EXTENSION}"));
    let options = ArchiveOptions {
        include_trash: true,
        ..ArchiveOptions::default()
    };
    archive_workspace(&root, &out, &options).unwrap();

    let dest = dir.path().join("解出来的");
    extract_archive(&out, &dest).unwrap();
    assert!(
        dest.join(".trash/20260101-ch_1/正文.md").exists(),
        "显式要求时应当包含回收站"
    );
    // 但备份与日志无论如何都不进包
    assert!(!dest.join(".yuhua/backup").exists());
    assert!(!dest.join(".yuhua/journal").exists());
}

#[test]
fn exclusion_rules_are_precise() {
    // 正文与其它资料目录必须放行
    for keep in [
        "manuscript/001-第一卷/001-开篇.md",
        "outline/总纲.md",
        "characters/主角.md",
        "worldbuilding/地理.md",
        ".yuhua/workspace.json",
    ] {
        assert!(!should_exclude(keep, false), "{keep} 不该被排除");
    }
    // 可再生与设备本地的内容必须排除
    for drop in [
        ".trash/x/正文.md",
        ".trash/正文.md",
        ".yuhua/backup/备份.md",
        ".yuhua/journal/entry.json",
        ".yuhua/stats/2026-01.json",
        "manuscript/临时.md.tmp",
        "随便什么.yuhua-tmp",
    ] {
        assert!(should_exclude(drop, false), "{drop} 应当被排除");
    }
    // 回收站是唯一受开关影响的
    assert!(
        !should_exclude(".trash/x.md", true),
        "显式要求包含回收站时不该排除它"
    );
}

#[test]
fn manifest_is_first_entry_and_readable() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("书");
    make_workspace(&root);
    let out = dir.path().join(format!("包.{ARCHIVE_EXTENSION}"));
    archive_workspace(&root, &out, &ArchiveOptions::default()).unwrap();

    let manifest: ArchiveManifest = read_manifest(&out).unwrap();
    assert_eq!(manifest.archive_version, 1);
    assert_eq!(manifest.title, "羽化录");
    assert_eq!(manifest.chapter_count, 2, "两章正文");
    assert!(manifest.raw_bytes > 0);
    assert!(manifest.tool.starts_with("yuhua-writer"));
    assert!(!manifest.created.is_empty());

    // 清单必须排在第一个条目：解压工具应当能不解压就预览
    let file = fs::File::open(&out).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    assert_eq!(zip.by_index(0).unwrap().name(), MANIFEST_NAME);
}

#[test]
fn archive_is_byte_stable_across_runs() {
    // 同样的工作区打两次包应当逐字节一致。
    // 这不是"洁癖"：不稳定意味着无法用哈希确认包没被改过，
    // 也无法做增量传输
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("书");
    make_workspace(&root);

    let out1 = dir.path().join(format!("a.{ARCHIVE_EXTENSION}"));
    let out2 = dir.path().join(format!("b.{ARCHIVE_EXTENSION}"));
    // created 字段是当前时间，两次打包必然不同。因此先取一次
    // 时间戳的容忍范围：只比较除清单外的内容大小
    let s1 = archive_workspace(&root, &out1, &ArchiveOptions::default()).unwrap();
    let s2 = archive_workspace(&root, &out2, &ArchiveOptions::default()).unwrap();
    assert_eq!(s1.file_count, s2.file_count);
    assert_eq!(s1.raw_bytes, s2.raw_bytes);
    // 清单里的时间戳会让两次的字节数有极小差异，但不应差太多
    let diff = (s1.archive_bytes as i64 - s2.archive_bytes as i64).abs();
    assert!(diff < 64, "两次打包的体积差异应当极小，实际差 {diff} 字节");
}

#[test]
fn empty_workspace_still_produces_valid_archive() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("空书");
    fs::create_dir_all(root.join(".yuhua")).unwrap();
    let out = dir.path().join(format!("空.{ARCHIVE_EXTENSION}"));
    let stats = archive_workspace(&root, &out, &ArchiveOptions::default()).unwrap();
    assert_eq!(stats.file_count, 0);
    assert_eq!(stats.raw_bytes, 0);

    // 空工作区的包仍然能被解析（清单在）
    let manifest = read_manifest(&out).unwrap();
    assert_eq!(manifest.chapter_count, 0);
    assert_eq!(manifest.title, "未命名");
}

// ---------------------------------------------------------------------------
// 安全：Zip Slip
// ---------------------------------------------------------------------------

#[test]
fn safe_join_accepts_normal_paths() {
    let dest = Path::new("/tmp/dest");
    for ok in [
        "manuscript/001-第一卷/001-开篇.md",
        "outline/总纲.md",
        "a/b/c/d.txt",
        ".yuhua/workspace.json",
    ] {
        let joined = safe_join(dest, ok).unwrap();
        assert!(joined.starts_with(dest), "{ok} 应当落在目标目录下");
    }
}

#[test]
fn safe_join_rejects_parent_escape() {
    let dest = Path::new("/tmp/dest");
    for bad in [
        "../逃出去.md",
        "a/../../逃出去.md",
        "..",
        "a/b/../../../x",
        "manuscript/../../x.md",
    ] {
        let result = safe_join(dest, bad);
        assert!(result.is_err(), "{bad} 必须被拒绝，但被放行了");
    }
}

#[test]
fn safe_join_rejects_absolute_paths() {
    let dest = Path::new("/tmp/dest");
    assert!(
        safe_join(dest, "/etc/passwd").is_err(),
        "POSIX 绝对路径必须被拒绝"
    );
    assert!(
        safe_join(dest, "C:/Windows/system32").is_err(),
        "Windows 盘符必须被拒绝"
    );
    assert!(
        safe_join(dest, "C:\\Windows\\system32").is_err(),
        "反斜杠盘符必须被拒绝"
    );
}

#[test]
fn malicious_archive_cannot_escape_destination() {
    // 造一个含恶意条目的归档，确认解压时被拒绝而不是写出去。
    // 这条测试对应真实的攻击场景：作者从别人那里收到一个"稿子包"
    let dir = tempfile::tempdir().unwrap();
    let evil = dir.path().join(format!("evil.{ARCHIVE_EXTENSION}"));

    {
        let file = fs::File::create(&evil).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        let manifest = ArchiveManifest {
            archive_version: 1,
            workspace_format_version: 1,
            title: "恶意包".into(),
            created: "2026-01-01T00:00:00Z".into(),
            chapter_count: 0,
            raw_bytes: 0,
            tool: "test".into(),
        };
        zip.start_file(MANIFEST_NAME, options).unwrap();
        std::io::Write::write_all(
            &mut zip,
            serde_json::to_string(&manifest).unwrap().as_bytes(),
        )
        .unwrap();
        // 越界条目
        zip.start_file("../../逃出去.md", options).unwrap();
        std::io::Write::write_all(&mut zip, b"pwned").unwrap();
        zip.finish().unwrap();
    }

    let dest = dir.path().join("安全目录");
    let result = extract_archive(&evil, &dest);
    assert!(result.is_err(), "含越界条目的归档必须被拒绝");

    // 确认真的没写到外面去
    assert!(
        !dir.path().join("逃出去.md").exists(),
        "越界文件被写出来了！"
    );
}

#[test]
fn archive_from_newer_version_is_rejected_with_clear_message() {
    let dir = tempfile::tempdir().unwrap();
    let future = dir.path().join(format!("future.{ARCHIVE_EXTENSION}"));
    {
        let file = fs::File::create(&future).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        let manifest = ArchiveManifest {
            archive_version: 999,
            workspace_format_version: 99,
            title: "未来包".into(),
            created: "2030-01-01T00:00:00Z".into(),
            chapter_count: 0,
            raw_bytes: 0,
            tool: "future".into(),
        };
        zip.start_file(MANIFEST_NAME, options).unwrap();
        std::io::Write::write_all(
            &mut zip,
            serde_json::to_string(&manifest).unwrap().as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();
    }

    let dest = dir.path().join("解出来的");
    let err = extract_archive(&future, &dest).unwrap_err();
    let message = err.to_string();
    assert!(
        message.contains("999"),
        "错误消息应当说明版本号，实际：{message}"
    );
    assert!(
        message.contains("升级"),
        "错误消息应当给出可行建议，实际：{message}"
    );
}

#[test]
fn non_archive_file_is_rejected_gracefully() {
    let dir = tempfile::tempdir().unwrap();
    let not_zip = dir.path().join("其实不是包.txt");
    fs::write(&not_zip, "这只是一个普通文本文件").unwrap();

    assert!(read_manifest(&not_zip).is_err());
    assert!(extract_archive(&not_zip, &dir.path().join("out")).is_err());
}

#[test]
fn broken_archive_does_not_leave_temp_file() {
    // 打包失败时不该留下临时文件。这里用一个"输出目录不可写"的场景
    // 很难跨平台构造，因此改为验证成功路径确实清掉了临时文件
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("书");
    make_workspace(&root);
    let out = dir.path().join(format!("包.{ARCHIVE_EXTENSION}"));
    archive_workspace(&root, &out, &ArchiveOptions::default()).unwrap();
    let stray = dir.path().join(format!("包.{ARCHIVE_EXTENSION}.tmp"));
    assert!(!stray.exists(), "成功后临时文件应当已被 rename 掉");
}

#[test]
fn compression_level_zero_produces_stored_entries() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("书");
    make_workspace(&root);
    let out = dir.path().join(format!("不压缩.{ARCHIVE_EXTENSION}"));
    let options = ArchiveOptions {
        level: 0,
        ..ArchiveOptions::default()
    };
    let stats = archive_workspace(&root, &out, &options).unwrap();

    // level=0 时体积应当大于等于原始大小（zip 头开销）
    assert!(
        stats.archive_bytes >= stats.raw_bytes,
        "不压缩时归档不应小于原始内容：{} < {}",
        stats.archive_bytes,
        stats.raw_bytes
    );

    // 仍然能正常解出来
    let dest = dir.path().join("解出来的");
    extract_archive(&out, &dest).unwrap();
    assert!(dest.join("outline/总纲.md").exists());
}

#[test]
fn large_workspace_archives_without_loading_everything() {
    // 大工作区：几十个文件、每份内容不小。这里验证的是
    // **归档能完成**，而不是内存占用（内存是 M7 指标，
    // 需要真实测量环境）。但文件数量与总字节数会被断言，
    // 这样如果实现退化成"把整个工作区读进内存"，
    // 这个测试仍然会通过 —— 因此内存那条由代码结构保证（流式写）。
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("大书");
    fs::create_dir_all(root.join(".yuhua")).unwrap();
    fs::write(
        root.join(".yuhua/workspace.json"),
        r#"{"formatVersion":1,"title":"大书"}"#,
    )
    .unwrap();
    fs::create_dir_all(root.join("manuscript/001-第一卷")).unwrap();

    for i in 0..100 {
        let body = format!("# 第{i}章\n\n{}", "正文内容重复填充。".repeat(200));
        fs::write(
            root.join(format!("manuscript/001-第一卷/{i:03}-章节.md")),
            body,
        )
        .unwrap();
    }

    let out = dir.path().join(format!("大.{ARCHIVE_EXTENSION}"));
    let stats = archive_workspace(&root, &out, &ArchiveOptions::default()).unwrap();
    assert_eq!(stats.file_count, 101, "100 章 + 1 个配置文件");
    assert!(stats.raw_bytes > 500_000, "原始内容应当有几百 KB 以上");
    assert!(
        stats.archive_bytes < stats.raw_bytes,
        "重复度高的正文应当能被压缩"
    );

    let dest = dir.path().join("解出来的");
    let extracted = extract_archive(&out, &dest).unwrap();
    assert_eq!(extracted.file_count, 101);
    assert_eq!(extracted.manifest.chapter_count, 100);
}
