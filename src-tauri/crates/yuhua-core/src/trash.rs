//! 回收站条目模型。
//!
//! 删除章节时**不真正删除文件**，而是移动到工作区内的 `.trash/` 目录
//! （计划书 4.4 节「回收站：删除即移动到 .trash/，保留 30 天」）。
//!
//! 为什么用「移动」而不是「打标记」：用户可能直接用文件管理器翻工作区，
//! 打标记会让已删除的内容继续出现在 manuscript 目录里，反而更混乱。
//! 移动之后，manuscript 目录严格等于「当前有效的稿件」。

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};

/// 一条回收站记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// 删除前的 ID（书 / 卷 / 章）。
    pub original_id: String,
    /// 原始显示名（章节标题或卷名），用于回收站列表展示。
    pub original_title: String,
    /// **相对于工作区根**的原始路径。
    ///
    /// 存相对路径而不是绝对路径：工作区整个文件夹被移动或放进云盘后，
    /// 绝对路径会全部失效，而相对路径仍然有效 —— 这是恢复功能可用的前提。
    pub original_path: String,
    /// 在 `.trash/` 中的存放目录名（带时间戳，避免同名覆盖）。
    pub trash_dir_name: String,
    /// 删除时间。
    pub deleted_at: DateTime<FixedOffset>,
    /// 条目类型：`chapter` / `volume` / `book`。
    pub kind: String,
}

impl TrashEntry {
    /// 默认保留天数（计划书 4.4 节：保留 30 天）。
    pub const RETENTION_DAYS: i64 = 30;

    /// 该条目是否已超过保留期，可以被清理。
    ///
    /// `now` 由调用方注入，便于测试与批量清理时保持时间基准一致。
    pub fn is_expired(&self, now: DateTime<FixedOffset>) -> bool {
        now.signed_duration_since(self.deleted_at).num_days() >= Self::RETENTION_DAYS
    }

    /// 距离过期还剩多少天（用于「还有 N 天被清理」的提示）。
    ///
    /// 已过期返回 0，不会返回负数 —— UI 不需要处理负天数这种无意义状态。
    pub fn days_remaining(&self, now: DateTime<FixedOffset>) -> i64 {
        let elapsed = now.signed_duration_since(self.deleted_at).num_days();
        (Self::RETENTION_DAYS - elapsed).max(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).unwrap()
    }

    fn entry(deleted_at: &str) -> TrashEntry {
        TrashEntry {
            original_id: "ch_abc".into(),
            original_title: "第一章".into(),
            original_path: "manuscript/001-第一卷/001-第一章.md".into(),
            trash_dir_name: "20260101-090000-ch_abc".into(),
            deleted_at: t(deleted_at),
            kind: "chapter".into(),
        }
    }

    #[test]
    fn fresh_entry_is_not_expired() {
        let e = entry("2026-01-01T00:00:00+08:00");
        assert!(!e.is_expired(t("2026-01-10T00:00:00+08:00")));
    }

    #[test]
    fn entry_expires_at_thirty_days() {
        let e = entry("2026-01-01T00:00:00+08:00");
        // 第 29 天还在
        assert!(!e.is_expired(t("2026-01-30T00:00:00+08:00")));
        // 第 30 天到期
        assert!(e.is_expired(t("2026-01-31T00:00:00+08:00")));
    }

    #[test]
    fn days_remaining_counts_down_and_floors_at_zero() {
        let e = entry("2026-01-01T00:00:00+08:00");
        assert_eq!(e.days_remaining(t("2026-01-01T00:00:00+08:00")), 30);
        assert_eq!(e.days_remaining(t("2026-01-11T00:00:00+08:00")), 20);
        // 过期后不给负数
        assert_eq!(e.days_remaining(t("2026-06-01T00:00:00+08:00")), 0);
    }

    #[test]
    fn original_path_is_relative_not_absolute() {
        // 断言这条设计约束，防止将来有人改成绝对路径
        let e = entry("2026-01-01T00:00:00+08:00");
        assert!(!e.original_path.contains(":\\"), "必须是相对路径");
        assert!(e.original_path.starts_with("manuscript/"));
    }
}
