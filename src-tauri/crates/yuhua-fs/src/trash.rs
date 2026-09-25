//! 回收站：软删除、恢复、过期清理。
//!
//! 对应计划书 4.4 节：「删除即移动到 `.trash/`，保留 30 天」，
//! 解决的问题是「误删可救」。
//!
//! ## 目录布局
//!
//! ```text
//! .trash/
//!  ├─ 20260101-090000-ch_abc123/
//!  │   ├─ entry.json          # 元数据（原路径、标题、删除时间）
//!  │   └─ 001-第一章.md       # 原始文件内容，原样保存
//!  └─ 20260102-143000-vol_xyz/
//!      ├─ entry.json
//!      └─ 001-第一卷/          # 删除整卷时保留整个子树
//! ```
//!
//! **每一次删除占一个带时间戳的独立目录**。为什么不用统一目录 + 索引文件：
//!
//! - 删除「整卷」和删除「单章」在文件层面差异很大，独立目录让两者统一
//! - 同名章节重复删除时不会互相覆盖
//! - 用户可以直接用文件管理器翻 `.trash/`，看到时间戳就知道是什么时候删的
//! - 恢复只需把目录内容搬回去，不需要解析任何索引
//!
//! ## 为什么不记录「绝对路径」的恢复目标
//!
//! 见 [`TrashItem`] 的说明：工作区可能被整体移动或放进云盘，
//! 只有相对路径在那些场景下仍然有效。

use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Utc};
use yuhua_core::trash::TrashEntry;
use yuhua_core::{Result, YuhuaError};

use crate::layout::WorkspaceLayout;

/// 回收站目录下的元数据文件名。
const ENTRY_FILE: &str = "entry.json";

/// 回收站中的一项（元数据 + 磁盘位置）。
#[derive(Debug, Clone, PartialEq)]
pub struct TrashItem {
    /// 元数据。
    pub entry: TrashEntry,
    /// 在 `.trash/` 下的实际目录。
    pub dir: PathBuf,
}

impl TrashItem {
    /// 原始文件的绝对路径（在工作区内的位置）。
    ///
    /// 注意这是**恢复后的目标位置**，可能已经有别的文件占了。
    pub fn original_absolute(&self, layout: &WorkspaceLayout) -> Result<PathBuf> {
        layout.resolve(&self.entry.original_path)
    }

    /// 在回收站目录中，原始内容所在的路径。
    ///
    /// 单章：`<trash_dir>/<文件名>`
    /// 整卷：`<trash_dir>/<卷目录名>/`
    pub fn content_path(&self) -> PathBuf {
        let name = self
            .entry
            .original_path
            .rsplit('/')
            .next()
            .unwrap_or("content");
        self.dir.join(name)
    }
}

/// 回收站管理器。
#[derive(Debug, Clone)]
pub struct TrashManager {
    layout: WorkspaceLayout,
}

impl TrashManager {
    /// 绑定到某个工作区。
    pub fn new(layout: WorkspaceLayout) -> Self {
        Self { layout }
    }

    /// 回收站根目录。
    pub fn dir(&self) -> PathBuf {
        self.layout.trash_dir()
    }

    /// 把一个文件或目录移入回收站。
    ///
    /// `relative_path` 是相对于工作区的路径；
    /// `kind` 取 `chapter` / `volume` / `book`。
    ///
    /// 返回创建的条目。**原文件会被移走**（不是复制）。
    pub fn move_to_trash(
        &self,
        relative_path: &str,
        original_title: &str,
        original_id: &str,
        kind: &str,
    ) -> Result<TrashItem> {
        let source = self.layout.resolve(relative_path)?;
        if !source.exists() {
            return Err(YuhuaError::NotFound {
                kind: "path",
                id: relative_path.to_string(),
            });
        }

        let now = now_local();
        // 目录名带上原始 ID，避免同一秒内删除多个同名条目时碰撞
        let dir_name = format!(
            "{}-{}",
            now.format("%Y%m%d-%H%M%S"),
            sanitize_component(original_id)
        );
        let trash_dir = self.dir().join(&dir_name);
        // 极端情况下（同一秒删两次同一个 ID）加后缀避让，绝不覆盖已有回收站项
        let trash_dir = unique_dir(trash_dir);

        std::fs::create_dir_all(&trash_dir).map_err(|e| YuhuaError::io(&trash_dir, e))?;

        let entry = TrashEntry {
            original_id: original_id.to_string(),
            original_title: original_title.to_string(),
            original_path: relative_path.to_string(),
            trash_dir_name: trash_dir
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| dir_name.clone()),
            deleted_at: now,
            kind: kind.to_string(),
        };

        // 先写元数据再搬内容：万一搬运失败，回收站里会留下一个
        // 「有记录但没内容」的条目，比「有内容但没记录」更容易诊断，
        // 而且不会让文件凭空消失（搬运失败时源文件仍在原处）。
        let meta_path = trash_dir.join(ENTRY_FILE);
        let json = serde_json::to_string_pretty(&entry).map_err(|e| YuhuaError::Parse {
            context: "trash entry",
            message: e.to_string(),
        })?;
        std::fs::write(&meta_path, json).map_err(|e| YuhuaError::io(&meta_path, e))?;

        // 搬内容
        let dest = trash_dir.join(
            source
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("content")),
        );
        if let Err(e) = std::fs::rename(&source, &dest) {
            // rename 跨卷会失败，退化为「复制 + 删除」
            if e.raw_os_error().is_some() {
                copy_recursive(&source, &dest)?;
                if source.is_dir() {
                    let _ = std::fs::remove_dir_all(&source);
                } else {
                    let _ = std::fs::remove_file(&source);
                }
            } else {
                // 搬运失败：清掉刚写的元数据，保持一致
                let _ = std::fs::remove_file(&meta_path);
                return Err(YuhuaError::io(&source, e));
            }
        }

        Ok(TrashItem {
            entry,
            dir: trash_dir,
        })
    }

    /// 列出回收站中的全部条目（按删除时间降序，最近删的在前）。
    pub fn list(&self) -> Vec<TrashItem> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(self.dir()) else {
            return out;
        };
        for e in entries.flatten() {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            let meta = dir.join(ENTRY_FILE);
            let Ok(text) = std::fs::read_to_string(&meta) else {
                continue; // 读不出元数据的条目跳过，不猜
            };
            if let Ok(entry) = serde_json::from_str::<TrashEntry>(&text) {
                out.push(TrashItem { entry, dir });
            }
        }
        // 按删除时间降序：最近删的排在前面（Reverse 包一层即可）
        out.sort_by_key(|i| std::cmp::Reverse(i.entry.deleted_at));
        out
    }

    /// 按 `trash_dir_name` 找条目。
    pub fn find(&self, trash_dir_name: &str) -> Option<TrashItem> {
        self.list()
            .into_iter()
            .find(|i| i.entry.trash_dir_name == trash_dir_name)
    }

    /// 恢复一个条目到它原来的位置。
    ///
    /// 若目标位置已被占用，**拒绝恢复并报错**，不覆盖现有文件。
    /// 这是刻意的：宁可让用户手动处理，也不能悄悄吃掉现在的内容。
    pub fn restore(&self, trash_dir_name: &str) -> Result<PathBuf> {
        let item = self.find(trash_dir_name).ok_or_else(|| YuhuaError::NotFound {
            kind: "trash item",
            id: trash_dir_name.to_string(),
        })?;

        let target = self.layout.resolve(&item.entry.original_path)?;
        if target.exists() {
            return Err(YuhuaError::InvalidInput(format!(
                "原位置已被占用，无法自动恢复：{}。请先改名或移走该文件。",
                item.entry.original_path
            )));
        }

        // 确保父目录存在（原来的卷可能也被删了）
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| YuhuaError::io(parent, e))?;
        }

        let content = item.content_path();
        if content.exists() {
            if let Err(e) = std::fs::rename(&content, &target) {
                if e.raw_os_error().is_some() {
                    copy_recursive(&content, &target)?;
                } else {
                    return Err(YuhuaError::io(&content, e));
                }
            }
        }

        // 清理回收站条目目录
        let _ = std::fs::remove_dir_all(&item.dir);
        Ok(target)
    }

    /// 永久删除一个条目（**不可恢复**）。
    pub fn purge(&self, trash_dir_name: &str) -> Result<()> {
        let item = self.find(trash_dir_name).ok_or_else(|| YuhuaError::NotFound {
            kind: "trash item",
            id: trash_dir_name.to_string(),
        })?;
        std::fs::remove_dir_all(&item.dir).map_err(|e| YuhuaError::io(&item.dir, e))?;
        Ok(())
    }

    /// 清空回收站。
    pub fn empty(&self) -> Result<usize> {
        let items = self.list();
        let mut n = 0;
        for item in items {
            if std::fs::remove_dir_all(&item.dir).is_ok() {
                n += 1;
            }
        }
        Ok(n)
    }

    /// 清理超过保留期（30 天）的条目，返回清理数量。
    ///
    /// 应用启动时调用一次。**只清理确实过期的**，
    /// 绝不对「读取失败」或「时间异常」的条目动手。
    pub fn purge_expired(&self) -> Result<usize> {
        let now = now_local();
        let mut n = 0;
        for item in self.list() {
            if item.entry.is_expired(now) && std::fs::remove_dir_all(&item.dir).is_ok() {
                n += 1;
            }
        }
        Ok(n)
    }

    /// 统计回收站占用空间（字节）与条目数。
    pub fn stats(&self) -> (usize, u64) {
        let items = self.list();
        let bytes = items.iter().map(|i| dir_size(&i.dir)).sum();
        (items.len(), bytes)
    }
}

/// 递归复制文件或目录。
fn copy_recursive(from: &Path, to: &Path) -> Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to).map_err(|e| YuhuaError::io(to, e))?;
        let entries = std::fs::read_dir(from).map_err(|e| YuhuaError::io(from, e))?;
        for entry in entries.flatten() {
            let src = entry.path();
            let dst = to.join(entry.file_name());
            copy_recursive(&src, &dst)?;
        }
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| YuhuaError::io(parent, e))?;
        }
        std::fs::copy(from, to).map_err(|e| YuhuaError::io(from, e))?;
    }
    Ok(())
}

/// 递归计算目录大小。
fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// 若目录已存在，追加 `-2`、`-3` … 直到找到空位。
fn unique_dir(base: PathBuf) -> PathBuf {
    if !base.exists() {
        return base;
    }
    let parent = base.parent().map(PathBuf::from).unwrap_or_default();
    let name = base
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    for n in 2..1000 {
        let candidate = parent.join(format!("{name}-{n}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    base
}

/// 清洗目录名组件。
fn sanitize_component(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .take(40)
        .collect()
}

/// 取本地时区偏移。
fn local_offset() -> FixedOffset {
    *chrono::Local::now().offset()
}

/// 当前本地时间。
fn now_local() -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&local_offset())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::WorkspaceLayout;

    fn setup() -> (tempfile::TempDir, TrashManager) {
        let dir = tempfile::tempdir().unwrap();
        let layout = WorkspaceLayout::new(dir.path());
        layout.ensure_structure().unwrap();
        (dir, TrashManager::new(layout))
    }

    fn write_chapter(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn moves_file_into_trash() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "manuscript/001/001-第一章.md", "正文");

        let item = tm
            .move_to_trash("manuscript/001/001-第一章.md", "第一章", "ch_abc", "chapter")
            .unwrap();

        // 原文件必须已被移走
        assert!(!dir.path().join("manuscript/001/001-第一章.md").exists());
        // 内容必须在回收站里完好
        assert_eq!(std::fs::read_to_string(item.content_path()).unwrap(), "正文");
        assert_eq!(item.entry.original_path, "manuscript/001/001-第一章.md");
        assert_eq!(item.entry.kind, "chapter");
    }

    #[test]
    fn list_returns_items_newest_first() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "a.md", "A");
        write_chapter(dir.path(), "b.md", "B");
        tm.move_to_trash("a.md", "A", "ch_a", "chapter").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100)); // 时间戳精度到秒
        tm.move_to_trash("b.md", "B", "ch_b", "chapter").unwrap();

        let items = tm.list();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].entry.original_title, "B");
    }

    #[test]
    fn restore_puts_file_back() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "manuscript/001/001-第一章.md", "正文");

        let item = tm
            .move_to_trash("manuscript/001/001-第一章.md", "第一章", "ch_abc", "chapter")
            .unwrap();
        let name = item.entry.trash_dir_name.clone();

        let restored = tm.restore(&name).unwrap();
        assert_eq!(restored, dir.path().join("manuscript/001/001-第一章.md"));
        assert_eq!(std::fs::read_to_string(&restored).unwrap(), "正文");
        // 回收站条目应已清掉
        assert!(tm.list().is_empty());
    }

    #[test]
    fn restore_refuses_to_overwrite_existing_file() {
        // 关键安全行为：绝不覆盖现在的内容
        let (dir, tm) = setup();
        write_chapter(dir.path(), "a.md", "被删的版本");
        let item = tm.move_to_trash("a.md", "A", "ch_a", "chapter").unwrap();

        // 用户在原位置新建了同名文件
        write_chapter(dir.path(), "a.md", "新写的内容");

        let err = tm.restore(&item.entry.trash_dir_name).unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(err.to_string().contains("已被占用"));
        // 新文件绝不能被覆盖
        assert_eq!(std::fs::read_to_string(dir.path().join("a.md")).unwrap(), "新写的内容");
    }

    #[test]
    fn restore_recreates_missing_parent_directories() {
        // 原卷被删掉后再恢复章节，父目录要自动重建
        let (dir, tm) = setup();
        write_chapter(dir.path(), "manuscript/001/001-第一章.md", "正文");
        let item = tm.move_to_trash("manuscript/001/001-第一章.md", "第一章", "ch_a", "chapter").unwrap();
        std::fs::remove_dir_all(dir.path().join("manuscript")).unwrap();

        tm.restore(&item.entry.trash_dir_name).unwrap();
        assert!(dir.path().join("manuscript/001/001-第一章.md").exists());
    }

    #[test]
    fn moves_directory_into_trash() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "manuscript/001-第一卷/001-第一章.md", "一");
        write_chapter(dir.path(), "manuscript/001-第一卷/002-第二章.md", "二");

        let item = tm
            .move_to_trash("manuscript/001-第一卷", "第一卷", "vol_x", "volume")
            .unwrap();

        assert!(!dir.path().join("manuscript/001-第一卷").exists());
        // 整卷内容应完整保存在回收站里
        let content = item.content_path();
        assert!(content.is_dir());
        assert!(content.join("001-第一章.md").exists());
        assert!(content.join("002-第二章.md").exists());
    }

    #[test]
    fn restore_directory_works() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "manuscript/001-第一卷/001-第一章.md", "一");
        let item = tm
            .move_to_trash("manuscript/001-第一卷", "第一卷", "vol_x", "volume")
            .unwrap();

        tm.restore(&item.entry.trash_dir_name).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("manuscript/001-第一卷/001-第一章.md")).unwrap(),
            "一"
        );
    }

    #[test]
    fn missing_source_is_rejected() {
        let (_dir, tm) = setup();
        let err = tm.move_to_trash("nope.md", "X", "ch_x", "chapter").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn path_escaping_workspace_is_rejected() {
        let (_dir, tm) = setup();
        assert!(tm.move_to_trash("../../secret.txt", "X", "ch_x", "chapter").is_err());
    }

    #[test]
    fn purge_removes_item_permanently() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "a.md", "A");
        let item = tm.move_to_trash("a.md", "A", "ch_a", "chapter").unwrap();
        let trash_path = item.dir.clone();

        tm.purge(&item.entry.trash_dir_name).unwrap();
        assert!(!trash_path.exists());
        assert!(tm.list().is_empty());
        let _ = dir;
    }

    #[test]
    fn empty_clears_everything() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "a.md", "A");
        write_chapter(dir.path(), "b.md", "B");
        tm.move_to_trash("a.md", "A", "ch_a", "chapter").unwrap();
        tm.move_to_trash("b.md", "B", "ch_b", "chapter").unwrap();

        assert_eq!(tm.empty().unwrap(), 2);
        assert!(tm.list().is_empty());
        let _ = dir;
    }

    #[test]
    fn purge_expired_keeps_fresh_items() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "a.md", "A");
        tm.move_to_trash("a.md", "A", "ch_a", "chapter").unwrap();

        // 刚删的没到期，不该被清理
        assert_eq!(tm.purge_expired().unwrap(), 0);
        assert_eq!(tm.list().len(), 1);
        let _ = dir;
    }

    #[test]
    fn purge_expired_removes_old_items() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "a.md", "A");
        let item = tm.move_to_trash("a.md", "A", "ch_a", "chapter").unwrap();

        // 手动把元数据里的删除时间改成 40 天前
        let meta_path = item.dir.join(ENTRY_FILE);
        let mut entry: TrashEntry =
            serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
        entry.deleted_at = now_local() - chrono::Duration::days(40);
        std::fs::write(&meta_path, serde_json::to_string_pretty(&entry).unwrap()).unwrap();

        assert_eq!(tm.purge_expired().unwrap(), 1);
        assert!(tm.list().is_empty());
        let _ = dir;
    }

    #[test]
    fn entry_metadata_is_readable_json() {
        // 用户可以直接打开 .trash 下的 entry.json 看懂发生了什么
        let (dir, tm) = setup();
        write_chapter(dir.path(), "a.md", "A");
        let item = tm.move_to_trash("a.md", "章节标题", "ch_abc", "chapter").unwrap();

        let text = std::fs::read_to_string(item.dir.join(ENTRY_FILE)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["originalTitle"], "章节标题");
        assert_eq!(v["kind"], "chapter");
        assert!(v["originalPath"].as_str().unwrap().contains("a.md"));
        let _ = dir;
    }

    #[test]
    fn deleting_same_file_twice_does_not_collide() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "a.md", "第一次");
        let first = tm.move_to_trash("a.md", "A", "ch_a", "chapter").unwrap();

        write_chapter(dir.path(), "a.md", "第二次");
        let second = tm.move_to_trash("a.md", "A", "ch_a", "chapter").unwrap();

        assert_ne!(first.dir, second.dir, "两次删除不能落到同一个目录");
        assert_eq!(tm.list().len(), 2);
        // 两份内容都要能读到
        assert_eq!(std::fs::read_to_string(first.content_path()).unwrap(), "第一次");
        assert_eq!(std::fs::read_to_string(second.content_path()).unwrap(), "第二次");
    }

    #[test]
    fn stats_reports_count_and_size() {
        let (dir, tm) = setup();
        write_chapter(dir.path(), "a.md", "十二个字节的内容吧");
        tm.move_to_trash("a.md", "A", "ch_a", "chapter").unwrap();

        let (count, bytes) = tm.stats();
        assert_eq!(count, 1);
        assert!(bytes > 0);
        let _ = dir;
    }

    #[test]
    fn truncated_entries_are_skipped() {
        // 手工在 .trash 里放一个没有 entry.json 的目录，不应导致 list 崩溃
        let (_dir, tm) = setup();
        std::fs::create_dir_all(tm.dir().join("垃圾目录")).unwrap();
        assert!(tm.list().is_empty());
    }

    #[test]
    fn find_returns_none_for_unknown_name() {
        let (_dir, tm) = setup();
        assert!(tm.find("不存在").is_none());
    }
}
