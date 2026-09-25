//! 章节元数据（Front Matter）。
//!
//! ## 为什么元数据放在文件里而不是数据库里
//!
//! 对应不变量 1「文件是真源，索引是缓存」：Front Matter 是元数据的真源，
//! SQLite 只是它的缓存。删掉索引库后应用必须能完全重建且用户无感 ——
//! 前提就是元数据没丢在数据库里。
//!
//! ## 宽容解析原则
//!
//! 用户在文件管理器里手改 .md 是常态。因此**缺失字段一律给默认值**，
//! 未知字段**原样保留**（`extra`），不因为多了一行就报错、也不在回写时丢数据。

use std::collections::BTreeMap;

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};

use crate::ids::ChapterId;

/// 章节写作状态。
///
/// 序列化为小写字符串（`draft` / `done` / `revising`），
/// 与计划书 4.2 节的 Front Matter 示例一致，保证文件可读性。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChapterStatus {
    /// 草稿：正在写，尚未定稿。
    #[default]
    Draft,
    /// 已完成：本章已定稿。
    Done,
    /// 修订中：定稿后又回来改。
    Revising,
}

impl ChapterStatus {
    /// 用户界面上的中文名。
    pub fn label(self) -> &'static str {
        match self {
            Self::Draft => "草稿",
            Self::Done => "已完成",
            Self::Revising => "修订中",
        }
    }

    /// 解析用户输入的字符串，大小写不敏感。
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "draft" => Some(Self::Draft),
            "done" => Some(Self::Done),
            "revising" => Some(Self::Revising),
            _ => None,
        }
    }

    /// 全部取值，供前端渲染下拉框。
    pub fn all() -> [Self; 3] {
        [Self::Draft, Self::Done, Self::Revising]
    }
}

/// 章节元数据，对应 Markdown 文件顶部的 Front Matter 区块。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChapterMeta {
    /// 章节唯一 ID。
    pub id: ChapterId,
    /// 章节标题（不含卷名）。
    pub title: String,
    /// 写作状态。
    #[serde(default)]
    pub status: ChapterStatus,
    /// 本章目标字数。0 表示未设置。
    #[serde(default, rename = "wordGoal")]
    pub word_goal: u32,
    /// 创建时间。
    pub created: DateTime<FixedOffset>,
    /// 最后修改时间。
    pub updated: DateTime<FixedOffset>,
    /// 标签。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 一句话摘要，用于大纲视图。
    #[serde(default)]
    pub summary: String,
    /// 作者给自己的便签（不导出）。
    #[serde(default)]
    pub notes: String,
    /// 未知字段的暂存区。
    ///
    /// 用户或未来版本可能写入我们不认识的键。存下来并在回写时原样吐出去，
    /// 这样「用新版本编辑过、再用旧版本打开」不会悄悄吃掉数据。
    /// 用 BTreeMap 而非 HashMap：保证序列化顺序稳定，文件 diff 不至于每次都变。
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl ChapterMeta {
    /// 创建一份全新的章节元数据。
    ///
    /// `now` 由调用方传入而不是内部取当前时间：这样单元测试可以注入
    /// 固定时间点，也让「同一批创建的多章共用同一时间戳」成为可能。
    pub fn new(title: impl Into<String>, now: DateTime<FixedOffset>) -> Self {
        Self {
            id: ChapterId::new(),
            title: title.into(),
            status: ChapterStatus::Draft,
            word_goal: 0,
            created: now,
            updated: now,
            tags: Vec::new(),
            summary: String::new(),
            notes: String::new(),
            extra: BTreeMap::new(),
        }
    }

    /// 校验元数据的领域不变量。
    ///
    /// 目前只有一条硬规则：标题不能为空（否则卷章树里会出现无法点击的空条目）。
    /// 注意这里**不做 trim 后写回**，只在判断时 trim —— 保留用户原始输入习惯。
    pub fn validate(&self) -> Result<(), String> {
        if self.title.trim().is_empty() {
            return Err("章节标题不能为空".to_string());
        }
        if self.title.len() > 200 {
            return Err(format!("章节标题过长（{} 字符，上限 200）", self.title.len()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts() -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00").unwrap()
    }

    #[test]
    fn new_meta_has_sane_defaults() {
        let m = ChapterMeta::new("第一章 落羽", ts());
        assert_eq!(m.status, ChapterStatus::Draft);
        assert_eq!(m.word_goal, 0);
        assert!(m.tags.is_empty());
        assert!(m.extra.is_empty());
        assert!(m.validate().is_ok());
    }

    #[test]
    fn empty_title_is_rejected() {
        let mut m = ChapterMeta::new("第一章", ts());
        m.title = "   ".into();
        assert!(m.validate().unwrap_err().contains("不能为空"));
    }

    #[test]
    fn status_parses_case_insensitively() {
        assert_eq!(ChapterStatus::parse("DRAFT"), Some(ChapterStatus::Draft));
        assert_eq!(ChapterStatus::parse(" Done "), Some(ChapterStatus::Done));
        assert_eq!(ChapterStatus::parse("revising"), Some(ChapterStatus::Revising));
        assert_eq!(ChapterStatus::parse("unknown"), None);
    }

    #[test]
    fn status_roundtrips_as_lowercase_in_json() {
        // 必须与计划书 4.2 节的 Front Matter 写法一致，保证文件可读
        let json = serde_json::to_string(&ChapterStatus::Revising).unwrap();
        assert_eq!(json, "\"revising\"");
    }

    #[test]
    fn missing_optional_fields_fall_back_to_defaults() {
        // 用户在编辑器里删掉了 status / tags 等行，不应导致解析失败
        let json = r#"{
            "id": "ch_0192f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
            "title": "手改过的章节",
            "created": "2026-01-01T09:00:00+08:00",
            "updated": "2026-01-02T10:00:00+08:00"
        }"#;
        let m: ChapterMeta = serde_json::from_str(json).unwrap();
        assert_eq!(m.status, ChapterStatus::Draft);
        assert_eq!(m.word_goal, 0);
        assert_eq!(m.summary, "");
    }

    #[test]
    fn unknown_fields_survive_roundtrip() {
        // 关键防数据丢失测试：不认识的键必须原样保留
        let json = r#"{
            "id": "ch_0192f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
            "title": "带自定义字段的章节",
            "created": "2026-01-01T09:00:00+08:00",
            "updated": "2026-01-02T10:00:00+08:00",
            "futureFeature": { "nested": [1, 2, 3] }
        }"#;
        let m: ChapterMeta = serde_json::from_str(json).unwrap();
        assert!(m.extra.contains_key("futureFeature"));

        let back = serde_json::to_string(&m).unwrap();
        assert!(back.contains("futureFeature"), "回写时丢失了未知字段：{back}");
        assert!(back.contains("[1,2,3]"));
    }

    #[test]
    fn extra_field_order_is_stable() {
        // BTreeMap 保证多次序列化结果完全一致，避免无意义的文件 diff
        let mut m = ChapterMeta::new("x", ts());
        m.extra.insert("zeta".into(), serde_json::json!(1));
        m.extra.insert("alpha".into(), serde_json::json!(2));
        let a = serde_json::to_string(&m).unwrap();
        let b = serde_json::to_string(&m).unwrap();
        assert_eq!(a, b);
        assert!(a.find("alpha").unwrap() < a.find("zeta").unwrap());
    }
}
