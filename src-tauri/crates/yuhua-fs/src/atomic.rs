//! 原子写 —— 数据安全的基石。
//!
//! ## 为什么必须原子
//!
//! 朴素的 `fs::write` 会先截断文件再写入。如果在这两步之间断电、
//! 蓝屏、或者 WebView 进程被杀，用户的稿子就变成了**半截文件**：
//! 前半是新的、后半是旧内容的残渣，且长度信息已丢失。对写作软件来说，
//! 这是不可接受的数据损失。
//!
//! ## 做法（rename 的原子性）
//!
//! ```text
//! 1. 在**同目录**下创建临时文件   xxx.md.tmp-<随机>
//! 2. 写入全部内容
//! 3. sync_all()  —— 把数据从 OS 页缓存刷到物理磁盘
//! 4. rename(tmp, target)  —— 原子替换
//! ```
//!
//! 关键点：
//!
//! - **临时文件必须与目标同目录**。跨分区 / 跨卷的 rename 不是原子操作，
//!   系统会退化成「复制 + 删除」，原子性就没了。
//! - **必须 fsync**。只写不 sync，数据可能还躺在页缓存里，
//!   断电后 rename 已生效但内容为空 —— 这正是「文件变成 0 字节」的经典成因。
//! - **Windows 上 rename 默认不能覆盖已存在文件**，必须用 `rename` 的
//!   覆盖语义；Rust 标准库的 `std::fs::rename` 在 Windows 上走的是
//!   `MoveFileEx`，已具备覆盖语义，因此可以直接用。
//!
//! 失败回滚：任何一步失败，我们都尽力删除临时文件，
//! 保证工作区里不会堆积 `.tmp-` 垃圾（它们会被云盘同步，污染用户目录）。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use yuhua_core::{Result, YuhuaError};

/// 临时文件后缀前缀。
///
/// 用一个显眼且不太可能与用户文件重名的标记，便于：
/// 1. 崩溃后扫描并清理孤儿临时文件
/// 2. 在文件管理器里一眼认出这不是用户内容
pub const TEMP_MARKER: &str = ".tmp-";

/// 生成与目标同目录的临时文件路径。
///
/// 随机后缀而不是固定 `.tmp`：避免同一章的两次并发保存
/// （例如自动保存与手动 Ctrl+S 撞在一起）互相踩踏。
fn temp_path_for(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let short = &suffix[..8];
    target.with_file_name(format!("{name}{TEMP_MARKER}{short}"))
}

/// 把字节原子地写入目标路径。
///
/// 成功后目标文件要么是完整旧内容、要么是完整新内容，不存在中间态。
pub fn atomic_write_bytes(target: &Path, data: &[u8]) -> Result<()> {
    // 目标目录必须存在，否则临时文件都创建不出来
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| YuhuaError::io(parent, e))?;
    }

    let tmp = temp_path_for(target);

    // 用一个闭包把「写入 + fsync」包起来，这样任何一步失败都能走统一的清理分支
    let write_result = (|| -> std::io::Result<()> {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true) // 若临时文件已存在则失败，绝不覆盖别人的写入
            .open(&tmp)?;
        f.write_all(data)?;
        // 必须 fsync：否则断电后可能 rename 成功但内容为空
        f.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_result {
        // 回滚：清理可能残留的临时文件。忽略清理本身的错误 ——
        // 原始错误更有价值，不应被清理失败掩盖。
        let _ = fs::remove_file(&tmp);
        return Err(YuhuaError::io(&tmp, e));
    }

    // 原子替换
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(YuhuaError::io(target, e));
    }

    // 尽力把 rename 本身也落盘（目录项变更）。
    // 失败不算致命：某些文件系统（如部分网络盘、云盘挂载点）不支持对目录 fsync，
    // 此时数据已经通过 sync_all 落盘，rename 会在下一个检查点生效。
    // 这里刻意**不报错**，否则会把「云盘上无法 fsync 目录」变成保存失败。
    if let Some(parent) = target.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

/// 把字符串按 UTF-8 原子写盘。
///
/// 这是章节保存的主入口。
pub fn atomic_write(target: &Path, contents: &str) -> Result<()> {
    atomic_write_bytes(target, contents.as_bytes())
}

/// 清理目录下遗留的临时文件（崩溃后调用）。
///
/// 返回被清理的文件数。
///
/// 崩溃时临时文件会留在工作区里。它们会被云盘同步出去、也会让用户困惑，
/// 因此在工作区打开时扫一遍并清掉是必要的。**只删带 [`TEMP_MARKER`] 标记的**，
/// 绝不碰用户文件。
pub fn sweep_temp_files(dir: &Path) -> Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut removed = 0usize;
    let entries = fs::read_dir(dir).map_err(|e| YuhuaError::io(dir, e))?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // 单个条目读取失败不影响整体清理
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains(TEMP_MARKER) && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.md");
        atomic_write(&target, "你好").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "你好");
    }

    #[test]
    fn overwrites_existing_file_completely() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.md");
        atomic_write(&target, "第一版内容很长很长").unwrap();
        atomic_write(&target, "新").unwrap();
        // 若实现有 truncate 遗漏，这里会看到旧内容的尾巴
        assert_eq!(fs::read_to_string(&target).unwrap(), "新");
    }

    #[test]
    fn leaves_no_temp_files_behind() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.md");
        atomic_write(&target, "内容").unwrap();
        let leftovers: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(TEMP_MARKER))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("manuscript/001-第一卷/001-第一章.md");
        atomic_write(&target, "正文").unwrap();
        assert!(target.exists());
    }

    #[test]
    fn temp_file_is_in_same_directory() {
        // 跨分区 rename 不是原子的，因此临时文件必须与目标同目录。
        // 这条测试锁死该约束，防止有人改成 std::env::temp_dir()。
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("deep/nested");
        fs::create_dir_all(&sub).unwrap();
        let target = sub.join("a.md");
        let tmp = temp_path_for(&target);
        assert_eq!(tmp.parent(), target.parent());
    }

    #[test]
    fn temp_name_is_unique_across_calls() {
        // 防并发保存互相踩踏
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.md");
        let a = temp_path_for(&target);
        let b = temp_path_for(&target);
        assert_ne!(a, b);
    }

    #[test]
    fn sweep_removes_only_temp_marked_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("chapter.md"), "用户内容").unwrap();
        fs::write(
            dir.path().join(format!("chapter.md{TEMP_MARKER}abc")),
            "垃圾",
        )
        .unwrap();
        fs::write(dir.path().join(format!("other.md{TEMP_MARKER}def")), "垃圾").unwrap();

        let removed = sweep_temp_files(dir.path()).unwrap();
        assert_eq!(removed, 2);
        // 用户文件必须还在
        assert!(dir.path().join("chapter.md").exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("chapter.md")).unwrap(),
            "用户内容"
        );
    }

    #[test]
    fn sweep_on_missing_directory_is_not_an_error() {
        // 空工作区或尚未创建 manuscript 目录时不应报错
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(sweep_temp_files(&dir.path().join("nope")).unwrap(), 0);
    }

    #[test]
    fn handles_utf8_content_with_bom_and_multibyte() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.md");
        let text = "\u{feff}开头有 BOM\n中文、emoji 之外的符号：※★☆";
        atomic_write(&target, text).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), text);
    }

    #[test]
    fn writes_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("empty.md");
        atomic_write(&target, "").unwrap();
        assert_eq!(fs::metadata(&target).unwrap().len(), 0);
    }

    #[test]
    fn sequential_writes_keep_last_value() {
        // 模拟自动保存连续触发
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.md");
        for i in 0..20 {
            atomic_write(&target, &format!("版本 {i}")).unwrap();
        }
        assert_eq!(fs::read_to_string(&target).unwrap(), "版本 19");
    }
}
