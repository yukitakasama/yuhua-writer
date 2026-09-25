//! 崩溃恢复日志。
//!
//! 对应计划书 4.4 节：「保存前写待提交记录，成功后清除」，
//! 解决的问题是「崩溃后可提示恢复」。
//!
//! ## 工作方式
//!
//! ```text
//! 保存一章：
//!   1. 写 journal 条目  →  { path, tmp_path, kind: "begin" }
//!   2. 原子写目标文件
//!   3. 删除 journal 条目
//! ```
//!
//! 若在步骤 2 中途崩溃，重启后 journal 里仍留着条目，
//! 说明「上次保存没走完」。此时提示用户，并指出哪些章节需要检查。
//!
//! ## 有了原子写，为什么还需要 journal
//!
//! 原子写保证**单个文件**不会出现半截内容。但一次操作可能涉及多个文件
//! （例如保存章节 + 更新索引 + 记录统计）。journal 记录的是
//! **一次多文件操作的整体状态**，两者解决的不是同一个问题。
//!
//! 另外，journal 让「崩溃后主动提示」成为可能：没有它，应用
//! 只能默默地打开工作区，用户不知道上次发生了什么。

use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize};
use yuhua_core::{Result, YuhuaError};

/// 一次待提交操作的类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalKind {
    /// 章节保存。
    ChapterSave,
    /// 章节删除（移入回收站）。
    ChapterDelete,
    /// 章节恢复。
    ChapterRestore,
    /// 结构变更（新建 / 重命名 / 排序）。
    Structure,
}

impl JournalKind {
    /// 用户可读说明。
    pub fn label(self) -> &'static str {
        match self {
            Self::ChapterSave => "保存章节",
            Self::ChapterDelete => "删除章节",
            Self::ChapterRestore => "恢复章节",
            Self::Structure => "调整结构",
        }
    }
}

/// 一条崩溃日志记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    /// 记录 ID（也是文件名的一部分）。
    pub id: String,
    /// 操作类型。
    pub kind: JournalKind,
    /// 涉及的相对路径（可能多个）。
    pub paths: Vec<String>,
    /// 操作开始时间。
    pub started_at: DateTime<FixedOffset>,
    /// 人类可读的操作描述，用于崩溃后的提示文案。
    pub description: String,
}

/// 崩溃日志管理器。
///
/// 每条记录是 `journal/` 下的一个独立 JSON 文件。
/// 用「一操作一文件」而不是「单一追加日志」，好处是：
///
/// - 完成时删除对应文件即可，不需要重写整个日志
/// - 多个操作并发时互不干扰（各自写自己的文件）
/// - 残留文件天然就是「未完成的操作」列表，扫描即可得到结论
#[derive(Debug, Clone)]
pub struct Journal {
    dir: PathBuf,
}

impl Journal {
    /// 在给定目录建立日志管理器。
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// 日志目录。
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 记录一次操作的开始。
    ///
    /// 返回记录 ID，完成后传给 [`Journal::commit`] 清除。
    pub fn begin(
        &self,
        kind: JournalKind,
        paths: Vec<String>,
        description: impl Into<String>,
    ) -> Result<String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| YuhuaError::io(&self.dir, e))?;

        let entry = JournalEntry {
            id: uuid::Uuid::new_v4().simple().to_string(),
            kind,
            paths,
            started_at: Utc::now().with_timezone(&local_offset()),
            description: description.into(),
        };

        let path = self.entry_path(&entry.id);
        let json = serde_json::to_string_pretty(&entry).map_err(|e| YuhuaError::Parse {
            context: "journal",
            message: e.to_string(),
        })?;
        std::fs::write(&path, json).map_err(|e| YuhuaError::io(&path, e))?;
        Ok(entry.id)
    }

    /// 标记操作已成功完成，清除记录。
    ///
    /// 删除失败不报错：残留的记录只会在下次启动时多提示一次，
    /// 比让保存操作本身失败要好得多。
    pub fn commit(&self, id: &str) -> Result<()> {
        let path = self.entry_path(id);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        Ok(())
    }

    /// 列出所有未完成的记录（按开始时间升序）。
    ///
    /// 应用启动时调用。非空说明上次是异常退出。
    pub fn pending(&self) -> Vec<JournalEntry> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e != "json").unwrap_or(true) {
                continue;
            }
            // 读不出来的记录直接跳过：它本身可能就是崩溃时写坏的
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(parsed) = serde_json::from_str::<JournalEntry>(&text) {
                out.push(parsed);
            }
        }
        out.sort_by_key(|e| e.started_at);
        out
    }

    /// 清空所有未完成记录。
    ///
    /// 用户确认「我已检查过，不需要恢复」后调用。
    pub fn clear(&self) -> Result<usize> {
        let mut n = 0;
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && std::fs::remove_file(&path).is_ok() {
                    n += 1;
                }
            }
        }
        Ok(n)
    }

    /// 一条记录的存放路径。
    fn entry_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }
}

/// 取本地时区偏移（与 chapter_io 保持一致的口径）。
fn local_offset() -> FixedOffset {
    *chrono::Local::now().offset()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> (tempfile::TempDir, Journal) {
        let dir = tempfile::tempdir().unwrap();
        let j = Journal::new(dir.path().join("journal"));
        (dir, j)
    }

    #[test]
    fn begin_creates_pending_entry() {
        let (_d, j) = journal();
        let id = j
            .begin(
                JournalKind::ChapterSave,
                vec!["manuscript/a.md".into()],
                "保存第一章",
            )
            .unwrap();
        let pending = j.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].kind, JournalKind::ChapterSave);
        assert_eq!(pending[0].description, "保存第一章");
    }

    #[test]
    fn commit_clears_entry() {
        let (_d, j) = journal();
        let id = j.begin(JournalKind::ChapterSave, vec![], "保存").unwrap();
        assert_eq!(j.pending().len(), 1);
        j.commit(&id).unwrap();
        assert!(j.pending().is_empty(), "成功提交后不应残留记录");
    }

    #[test]
    fn commit_on_missing_entry_is_ok() {
        // 幂等：重复提交、或提交不存在的 ID 都不应报错
        let (_d, j) = journal();
        j.commit("不存在的-id").unwrap();
    }

    #[test]
    fn pending_is_empty_on_fresh_journal() {
        let (_d, j) = journal();
        assert!(j.pending().is_empty());
    }

    #[test]
    fn pending_on_missing_directory_is_empty() {
        // 首次启动时 journal 目录还不存在
        let dir = tempfile::tempdir().unwrap();
        let j = Journal::new(dir.path().join("never-created"));
        assert!(j.pending().is_empty());
    }

    #[test]
    fn multiple_entries_survive_and_sort_by_time() {
        let (_d, j) = journal();
        let a = j
            .begin(JournalKind::ChapterSave, vec!["a.md".into()], "第一")
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = j
            .begin(JournalKind::ChapterDelete, vec!["b.md".into()], "第二")
            .unwrap();

        let pending = j.pending();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].id, a);
        assert_eq!(pending[1].id, b);

        // 提交其中一个，另一个仍在
        j.commit(&a).unwrap();
        let pending = j.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, b);
    }

    #[test]
    fn clear_removes_everything() {
        let (_d, j) = journal();
        j.begin(JournalKind::ChapterSave, vec![], "1").unwrap();
        j.begin(JournalKind::Structure, vec![], "2").unwrap();
        assert_eq!(j.clear().unwrap(), 2);
        assert!(j.pending().is_empty());
    }

    #[test]
    fn corrupt_entry_is_skipped_not_fatal() {
        // 崩溃时可能写下半截 JSON，扫描必须能容忍
        let (_d, j) = journal();
        std::fs::create_dir_all(j.dir()).unwrap();
        std::fs::write(j.dir().join("broken.json"), "{ 这不是合法 JSON").unwrap();
        j.begin(JournalKind::ChapterSave, vec![], "正常记录")
            .unwrap();

        let pending = j.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].description, "正常记录");
    }

    #[test]
    fn non_json_files_are_ignored() {
        let (_d, j) = journal();
        std::fs::create_dir_all(j.dir()).unwrap();
        std::fs::write(j.dir().join("readme.txt"), "无关文件").unwrap();
        assert!(j.pending().is_empty());
    }

    #[test]
    fn entry_roundtrips_through_json() {
        let (_d, j) = journal();
        j.begin(
            JournalKind::ChapterRestore,
            vec!["manuscript/a.md".into(), "manuscript/b.md".into()],
            "恢复两章",
        )
        .unwrap();
        let e = j.pending().remove(0);
        let json = serde_json::to_string(&e).unwrap();
        let back: JournalEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(e, back);
        assert_eq!(back.paths.len(), 2);
    }

    #[test]
    fn entries_use_independent_files() {
        // 并发安全的前提：每条记录一个文件，互不干扰
        let (_d, j) = journal();
        let a = j.begin(JournalKind::ChapterSave, vec![], "a").unwrap();
        let b = j.begin(JournalKind::ChapterSave, vec![], "b").unwrap();
        assert_ne!(a, b);
        assert!(j.dir().join(format!("{a}.json")).exists());
        assert!(j.dir().join(format!("{b}.json")).exists());
    }
}
