//! 领域模型：书 / 卷 / 章。
//!
//! ## 结构
//!
//! ```text
//! Book（一本书 = 一个工作区）
//!  └─ Volume（卷，有序）
//!      └─ Chapter（章，有序）
//! ```
//!
//! 卷下可以没有章（刚建的空卷是合法状态），但**章不能没有卷**：
//! 网文作者的心智模型里章节总是属于某一卷，若允许「游离章节」，
//! 卷章树就要处理一个额外的顶层容器，交互复杂度大幅上升。
//! 新建书时自动创建一个默认卷，用户无感知。
//!
//! ## 不变量是什么、为什么要有
//!
//! 不变量是「任何时刻都必须成立」的约束。把它们集中成 [`Document::validate`]
//! 一处实现，好处是：
//!
//! - 数据库读回来的、从磁盘扫描出来的、前端传过来的数据，都走同一套校验
//! - 出现数据错乱时能明确报出是哪一条约束被破坏
//! - 单元测试可以直接针对不变量写，不需要构造复杂场景
//!
//! 当前不变量清单：
//!
//! 1. 书标题非空
//! 2. 同一本书内 ID 唯一（卷 ID 唯一、章 ID 唯一）
//! 3. 每章的 `volume_id` 必须指向本书中真实存在的卷
//! 4. 章路径在书内唯一（两个章不能指向同一个 .md 文件）
//! 5. 卷内章节的 `sort` 不与同卷其它章重复

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};

use crate::count::{count_words, CountMode, WordCount};
use crate::error::{Result, YuhuaError};
use crate::ids::{BookId, ChapterId, VolumeId};
use crate::meta::{ChapterMeta, ChapterStatus};

/// 一本书。
///
/// 第一阶段「一本书 = 一个工作区」：工作区目录里的 `manuscript/` 即本书正文。
/// 保留 `Book` 这个层级是为第二阶段「多书工作区」预留 —— 届时只需让
/// `Document` 持有多个 `Book`，卷章模型无需改动。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    /// 书 ID。
    pub id: BookId,
    /// 书名。
    pub title: String,
    /// 作者名（导出 EPUB / DOCX 元数据用）。
    pub author: String,
    /// 一句话简介。
    pub description: String,
    /// 创建时间。
    pub created: DateTime<FixedOffset>,
    /// 最后修改时间。
    pub updated: DateTime<FixedOffset>,
}

impl Book {
    /// 新建一本书。标题会做 trim，防止出现「看起来是空的」书名。
    pub fn new(title: impl Into<String>, now: DateTime<FixedOffset>) -> Self {
        Self {
            id: BookId::new(),
            title: title.into().trim().to_string(),
            author: String::new(),
            description: String::new(),
            created: now,
            updated: now,
        }
    }
}

/// 一卷。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    /// 卷 ID。
    pub id: VolumeId,
    /// 所属书 ID。
    pub book_id: BookId,
    /// 卷名。
    pub title: String,
    /// 卷内排序序号，从 0 开始。
    pub sort: i32,
    /// 创建时间。
    pub created: DateTime<FixedOffset>,
}

impl Volume {
    /// 新建一卷。
    pub fn new(book_id: &BookId, title: impl Into<String>, sort: i32, now: DateTime<FixedOffset>) -> Self {
        Self {
            id: VolumeId::new(),
            book_id: book_id.clone(),
            title: title.into().trim().to_string(),
            sort,
            created: now,
        }
    }
}

/// 一章。
///
/// `body` 只在「已载入正文」时非空。列表场景（卷章树、大纲）用
/// [`ChapterSummary`] 就够，避免为了显示树而把几十万字全部读进内存 ——
/// 这是计划书不变量 4「UI 线程不做重活」与内存指标 M2 的直接要求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    /// 章节元数据（Front Matter 的真源）。
    #[serde(flatten)]
    pub meta: ChapterMeta,
    /// 所属书 ID。
    pub book_id: BookId,
    /// 所属卷 ID。
    pub volume_id: VolumeId,
    /// **相对于工作区根**的 Markdown 文件路径（统一用 `/` 分隔）。
    ///
    /// 用相对路径的理由同 [`crate::trash::TrashEntry::original_path`]：
    /// 工作区整体移动或云盘同步后仍然有效。
    pub path: String,
    /// 卷内排序序号，从 0 开始。
    pub sort: i32,
    /// 正文（不含 Front Matter）。空字符串表示「未载入」或「确实为空」，
    /// 需要区分时看 `body_loaded`。
    pub body: String,
    /// 正文是否已载入。
    pub body_loaded: bool,
    /// 文件最后修改时间（Unix 毫秒），用于增量索引判断。
    pub mtime: i64,
    /// 正文内容哈希，用于增量索引跳过未变章节。
    pub content_hash: String,
}

impl Chapter {
    /// 新建一章（正文为空）。
    pub fn new(
        book_id: &BookId,
        volume_id: &VolumeId,
        title: impl Into<String>,
        path: impl Into<String>,
        sort: i32,
        now: DateTime<FixedOffset>,
    ) -> Self {
        Self {
            meta: ChapterMeta::new(title, now),
            book_id: book_id.clone(),
            volume_id: volume_id.clone(),
            path: path.into(),
            sort,
            body: String::new(),
            body_loaded: true,
            mtime: now.timestamp_millis(),
            content_hash: String::new(),
        }
    }

    /// 本章字数（三口径统计）。
    ///
    /// 只统计正文，不含 Front Matter —— 元数据不是「写出来的字」。
    pub fn word_count(&self) -> WordCount {
        count_words(&self.body)
    }

    /// 按指定口径取本章字数。
    pub fn word_count_in(&self, mode: CountMode) -> u32 {
        self.word_count().get(mode)
    }

    /// 转为轻量摘要（不含正文），供卷章树 / 大纲使用。
    pub fn to_summary(&self) -> ChapterSummary {
        ChapterSummary {
            id: self.meta.id.clone(),
            volume_id: self.volume_id.clone(),
            title: self.meta.title.clone(),
            status: self.meta.status,
            sort: self.sort,
            path: self.path.clone(),
            word_count: self.word_count_in(CountMode::default()),
            word_goal: self.meta.word_goal,
            summary: self.meta.summary.clone(),
            updated: self.meta.updated,
        }
    }
}

/// 章节摘要 —— 卷章树、大纲、字数面板的通用载荷。
///
/// 刻意不包含 `body`：列表视图渲染 300 章时，这个结构的内存占用
/// 必须与书籍总字数无关。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSummary {
    /// 章 ID。
    pub id: ChapterId,
    /// 所属卷 ID。
    pub volume_id: VolumeId,
    /// 章标题。
    pub title: String,
    /// 写作状态。
    pub status: ChapterStatus,
    /// 卷内排序。
    pub sort: i32,
    /// 相对路径。
    pub path: String,
    /// 字数（默认口径）。
    pub word_count: u32,
    /// 目标字数，0 表示未设置。
    pub word_goal: u32,
    /// 一句话摘要。
    pub summary: String,
    /// 最后修改时间。
    pub updated: DateTime<FixedOffset>,
}

/// 大纲节点 —— 卷 + 其下章节摘要的聚合视图。
///
/// 计划书 T6.3 要求「大纲视图：卷章摘要聚合、可跳转」。
/// 单独给一个结构而不是让前端自己 group：这样卷级字数可以直接由
/// Rust 侧一次算好返回，前端不需要遍历全部章节再求和。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineNode {
    /// 卷 ID。
    pub volume_id: VolumeId,
    /// 卷名。
    pub title: String,
    /// 卷内排序。
    pub sort: i32,
    /// 本卷章节摘要。
    pub chapters: Vec<ChapterSummary>,
    /// 本卷总字数。
    pub word_count: u32,
    /// 本卷章节数。
    pub chapter_count: usize,
}

/// 一份完整文稿（书 + 卷 + 章）的内存视图。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    /// 书。
    pub book: Book,
    /// 卷列表（应按 `sort` 排序）。
    pub volumes: Vec<Volume>,
    /// 章列表（应按 (volume_id, sort) 排序）。
    pub chapters: Vec<Chapter>,
}

impl Document {
    /// 创建一份只含默认卷的空文稿。
    ///
    /// 自动建一个「第一卷」而不是留空：见模块文档中「章不能没有卷」的说明。
    pub fn new(title: impl Into<String>, now: DateTime<FixedOffset>) -> Self {
        let book = Book::new(title, now);
        let first_volume = Volume::new(&book.id, "第一卷", 0, now);
        Self {
            book,
            volumes: vec![first_volume],
            chapters: Vec::new(),
        }
    }

    /// 按 ID 找卷。
    pub fn find_volume(&self, id: &VolumeId) -> Option<&Volume> {
        self.volumes.iter().find(|v| &v.id == id)
    }

    /// 按 ID 找章。
    pub fn find_chapter(&self, id: &ChapterId) -> Option<&Chapter> {
        self.chapters.iter().find(|c| &c.meta.id == id)
    }

    /// 按 ID 找章（可变引用）。
    pub fn find_chapter_mut(&mut self, id: &ChapterId) -> Option<&mut Chapter> {
        self.chapters.iter_mut().find(|c| &c.meta.id == id)
    }

    /// 取某一卷下的全部章节，按 `sort` 升序。
    pub fn chapters_in_volume(&self, volume_id: &VolumeId) -> Vec<&Chapter> {
        let mut v: Vec<&Chapter> = self
            .chapters
            .iter()
            .filter(|c| &c.volume_id == volume_id)
            .collect();
        v.sort_by_key(|c| c.sort);
        v
    }

    /// 全书总字数（默认口径）。
    pub fn word_count(&self, mode: CountMode) -> u32 {
        self.chapters
            .iter()
            .map(|c| c.word_count_in(mode))
            .fold(0u32, u32::saturating_add)
    }

    /// 完整的三口径字数统计。
    pub fn word_count_all(&self) -> WordCount {
        WordCount::sum(self.chapters.iter().map(|c| c.word_count()))
    }

    /// 生成大纲：按卷聚合章节摘要与字数。
    pub fn outline(&self) -> Vec<OutlineNode> {
        let mut nodes: Vec<OutlineNode> = self
            .volumes
            .iter()
            .map(|vol| {
                let chapters: Vec<ChapterSummary> = self
                    .chapters_in_volume(&vol.id)
                    .into_iter()
                    .map(|c| c.to_summary())
                    .collect();
                let word_count = chapters.iter().map(|c| c.word_count).sum();
                OutlineNode {
                    volume_id: vol.id.clone(),
                    title: vol.title.clone(),
                    sort: vol.sort,
                    chapter_count: chapters.len(),
                    chapters,
                    word_count,
                }
            })
            .collect();
        nodes.sort_by_key(|n| n.sort);
        nodes
    }

    /// 全量不变量校验。
    ///
    /// 返回**第一个**违反的约束。选择快速失败而不是收集所有错误：
    /// 不变量一旦被破坏，后续检查的结论往往不可信（比如卷 ID 都不存在了，
    /// 再检查章路径唯一性没有意义）。
    pub fn validate(&self) -> Result<()> {
        // 不变量 1：书名非空
        if self.book.title.trim().is_empty() {
            return Err(YuhuaError::Invariant("书名不能为空".into()));
        }

        // 不变量 2：卷 ID 唯一
        let mut volume_ids: HashSet<&str> = HashSet::new();
        for vol in &self.volumes {
            if !volume_ids.insert(vol.id.as_str()) {
                return Err(YuhuaError::Invariant(format!("卷 ID 重复：{}", vol.id)));
            }
            if vol.book_id != self.book.id {
                return Err(YuhuaError::Invariant(format!(
                    "卷 {} 属于其它书（{} != {}）",
                    vol.id, vol.book_id, self.book.id
                )));
            }
            if vol.title.trim().is_empty() {
                return Err(YuhuaError::Invariant(format!("卷 {} 的标题为空", vol.id)));
            }
        }

        // 不变量 2 续：章 ID 唯一
        let mut chapter_ids: HashSet<&str> = HashSet::new();
        // 不变量 4：章路径唯一
        let mut paths: HashSet<&str> = HashSet::new();
        // 不变量 5：卷内 sort 唯一 —— key 是 (volume_id, sort)
        let mut volume_sorts: HashMap<(&str, i32), &str> = HashMap::new();

        for ch in &self.chapters {
            let cid = ch.meta.id.as_str();
            if !chapter_ids.insert(cid) {
                return Err(YuhuaError::Invariant(format!("章 ID 重复：{cid}")));
            }

            // 不变量 3：章所属卷必须存在
            if !volume_ids.contains(ch.volume_id.as_str()) {
                return Err(YuhuaError::Invariant(format!(
                    "章 {cid} 引用了不存在的卷 {}",
                    ch.volume_id
                )));
            }

            if ch.book_id != self.book.id {
                return Err(YuhuaError::Invariant(format!(
                    "章 {cid} 属于其它书（{} != {}）",
                    ch.book_id, self.book.id
                )));
            }

            // 不变量 4：路径唯一
            if !paths.insert(ch.path.as_str()) {
                return Err(YuhuaError::Invariant(format!(
                    "章节路径重复：{}（章 {cid}）",
                    ch.path
                )));
            }

            // 路径必须是相对路径，且不能向上逃逸出工作区
            if ch.path.starts_with('/') || ch.path.contains(':') {
                return Err(YuhuaError::Invariant(format!(
                    "章 {cid} 的路径必须是相对路径：{}",
                    ch.path
                )));
            }
            if ch.path.split('/').any(|seg| seg == "..") {
                return Err(YuhuaError::Invariant(format!(
                    "章 {cid} 的路径不能包含 ..：{}",
                    ch.path
                )));
            }

            // 不变量 5：卷内 sort 唯一
            let key = (ch.volume_id.as_str(), ch.sort);
            if let Some(prev) = volume_sorts.insert(key, cid) {
                return Err(YuhuaError::Invariant(format!(
                    "卷 {} 内排序号 {} 重复：章 {} 与章 {}",
                    ch.volume_id, ch.sort, prev, cid
                )));
            }

            // 元数据自身的约束（标题非空等）
            ch.meta
                .validate()
                .map_err(|e| YuhuaError::Invariant(format!("章 {cid}：{e}")))?;
        }

        Ok(())
    }

    /// 把某一卷内的章节 `sort` 重排为连续 0..n。
    ///
    /// 拖拽排序、删除章节后都需要归一化。刻意**不保留空洞**：
    /// 若删除后留 sort 空洞，文件名序号前缀会出现跳号，
    /// 用户用文件管理器看会觉得别扭。
    pub fn renumber_volume(&mut self, volume_id: &VolumeId) {
        let mut ids: Vec<(i32, ChapterId)> = self
            .chapters
            .iter()
            .filter(|c| &c.volume_id == volume_id)
            .map(|c| (c.sort, c.meta.id.clone()))
            .collect();
        ids.sort_by_key(|(s, _)| *s);
        for (new_sort, (_, cid)) in ids.into_iter().enumerate() {
            if let Some(ch) = self.find_chapter_mut(&cid) {
                ch.sort = new_sort as i32;
            }
        }
    }

    /// 把卷的 `sort` 重排为连续 0..n。
    pub fn renumber_volumes(&mut self) {
        let mut ids: Vec<(i32, VolumeId)> = self
            .volumes
            .iter()
            .map(|v| (v.sort, v.id.clone()))
            .collect();
        ids.sort_by_key(|(s, _)| *s);
        for (new_sort, (_, vid)) in ids.into_iter().enumerate() {
            if let Some(vol) = self.volumes.iter_mut().find(|v| v.id == vid) {
                vol.sort = new_sort as i32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00").unwrap()
    }

    fn doc_with_one_chapter() -> (Document, VolumeId) {
        let mut d = Document::new("测试书", now());
        let vid = d.volumes[0].id.clone();
        let ch = Chapter::new(&d.book.id, &vid, "第一章", "manuscript/001/001-第一章.md", 0, now());
        d.chapters.push(ch);
        (d, vid)
    }

    #[test]
    fn new_document_has_book_and_default_volume() {
        let d = Document::new("我的小说", now());
        assert_eq!(d.book.title, "我的小说");
        assert_eq!(d.volumes.len(), 1);
        assert_eq!(d.volumes[0].title, "第一卷");
        assert_eq!(d.volumes[0].sort, 0);
        assert!(d.chapters.is_empty());
        assert!(d.validate().is_ok());
    }

    #[test]
    fn book_title_is_trimmed() {
        let d = Document::new("  我的小说  ", now());
        assert_eq!(d.book.title, "我的小说");
    }

    #[test]
    fn empty_book_title_fails_validation() {
        let mut d = Document::new("x", now());
        d.book.title = "   ".into();
        let err = d.validate().unwrap_err();
        assert_eq!(err.code(), "INVARIANT_VIOLATION");
        assert!(err.to_string().contains("书名"));
    }

    #[test]
    fn duplicate_volume_id_is_rejected() {
        let mut d = Document::new("书", now());
        let dup = d.volumes[0].clone();
        d.volumes.push(dup);
        assert!(d.validate().unwrap_err().to_string().contains("卷 ID 重复"));
    }

    #[test]
    fn duplicate_chapter_id_is_rejected() {
        let (mut d, vid) = doc_with_one_chapter();
        let mut dup = d.chapters[0].clone();
        // 路径不同，确保失败原因是 ID 而不是路径
        dup.path = "manuscript/001/002-另一章.md".into();
        dup.sort = 1;
        d.chapters.push(dup);
        let _ = vid;
        assert!(d.validate().unwrap_err().to_string().contains("章 ID 重复"));
    }

    #[test]
    fn chapter_referencing_missing_volume_is_rejected() {
        let (mut d, _) = doc_with_one_chapter();
        // 造一个不存在的卷 ID
        let ghost = VolumeId::new();
        d.chapters[0].volume_id = ghost;
        let err = d.validate().unwrap_err().to_string();
        assert!(err.contains("不存在的卷"), "got {err}");
    }

    #[test]
    fn duplicate_chapter_path_is_rejected() {
        let (mut d, vid) = doc_with_one_chapter();
        let mut second = Chapter::new(&d.book.id, &vid, "第二章", "manuscript/001/001-第一章.md", 1, now());
        second.meta.id = ChapterId::new();
        d.chapters.push(second);
        assert!(d.validate().unwrap_err().to_string().contains("路径重复"));
    }

    #[test]
    fn absolute_chapter_path_is_rejected() {
        let (mut d, _) = doc_with_one_chapter();
        d.chapters[0].path = "D:/ws/manuscript/a.md".into();
        assert!(d.validate().is_err());
    }

    #[test]
    fn path_escaping_workspace_is_rejected() {
        let (mut d, _) = doc_with_one_chapter();
        d.chapters[0].path = "manuscript/../../etc/passwd".into();
        let err = d.validate().unwrap_err().to_string();
        assert!(err.contains(".."), "got {err}");
    }

    #[test]
    fn duplicate_sort_within_volume_is_rejected() {
        let (mut d, vid) = doc_with_one_chapter();
        let second = Chapter::new(&d.book.id, &vid, "第二章", "manuscript/001/002.md", 0, now());
        d.chapters.push(second);
        let err = d.validate().unwrap_err().to_string();
        assert!(err.contains("排序号"), "got {err}");
    }

    #[test]
    fn same_sort_in_different_volumes_is_fine() {
        // 不同卷之间序号互不干涉，两卷都从 0 开始是正常的
        let (mut d, vid) = doc_with_one_chapter();
        let vol2 = Volume::new(&d.book.id, "第二卷", 1, now());
        let vid2 = vol2.id.clone();
        d.volumes.push(vol2);
        d.chapters.push(Chapter::new(&d.book.id, &vid2, "新卷第一章", "manuscript/002/001.md", 0, now()));
        let _ = vid;
        assert!(d.validate().is_ok());
    }

    #[test]
    fn empty_volume_title_is_rejected() {
        let mut d = Document::new("书", now());
        d.volumes[0].title = "  ".into();
        assert!(d.validate().is_err());
    }

    #[test]
    fn chapter_in_other_book_is_rejected() {
        let (mut d, _) = doc_with_one_chapter();
        d.chapters[0].book_id = BookId::new();
        let err = d.validate().unwrap_err().to_string();
        assert!(err.contains("属于其它书"), "got {err}");
    }

    #[test]
    fn chapters_in_volume_are_sorted() {
        let mut d = Document::new("书", now());
        let vid = d.volumes[0].id.clone();
        for (i, title) in ["第三章", "第一章", "第二章"].iter().enumerate() {
            let mut c = Chapter::new(&d.book.id, &vid, *title, format!("manuscript/00{i}.md"), 0, now());
            // 刻意给乱序的 sort 值
            c.sort = match *title {
                "第一章" => 2,
                "第二章" => 1,
                _ => 0,
            };
            d.chapters.push(c);
        }
        let ordered: Vec<&str> = d
            .chapters_in_volume(&vid)
            .iter()
            .map(|c| c.meta.title.as_str())
            .collect();
        assert_eq!(ordered, vec!["第三章", "第二章", "第一章"]);
    }

    #[test]
    fn renumber_volume_closes_gaps() {
        let (mut d, vid) = doc_with_one_chapter();
        // 制造空洞：追加两章但 sort 是 5 和 9
        d.chapters.push(Chapter::new(&d.book.id, &vid, "二", "manuscript/002.md", 5, now()));
        d.chapters.push(Chapter::new(&d.book.id, &vid, "三", "manuscript/003.md", 9, now()));
        d.renumber_volume(&vid);
        let sorts: Vec<i32> = d.chapters_in_volume(&vid).iter().map(|c| c.sort).collect();
        assert_eq!(sorts, vec![0, 1, 2]);
        assert!(d.validate().is_ok());
    }

    #[test]
    fn renumber_volumes_closes_gaps() {
        let mut d = Document::new("书", now());
        d.volumes.push(Volume::new(&d.book.id, "第二卷", 7, now()));
        d.volumes.push(Volume::new(&d.book.id, "第三卷", 7, now())); // 重复 sort 也允许被修复
        d.renumber_volumes();
        let sorts: Vec<i32> = d.volumes.iter().map(|v| v.sort).collect();
        assert_eq!(sorts, vec![0, 1, 2]);
    }

    #[test]
    fn word_count_aggregates_over_chapters() {
        let (mut d, vid) = doc_with_one_chapter();
        d.chapters[0].body = "你好世界".into(); // 4 字
        d.chapters.push({
            let mut c = Chapter::new(&d.book.id, &vid, "二", "manuscript/002.md", 1, now());
            c.body = "再见".into(); // 2 字
            c
        });
        assert_eq!(d.word_count(CountMode::WithoutPunctuation), 6);
        let all = d.word_count_all();
        assert_eq!(all.han_chars, 6);
    }

    #[test]
    fn word_count_excludes_front_matter() {
        // Chapter.body 只装正文，元数据在 meta 里，因此计数天然不含 Front Matter
        let (mut d, _) = doc_with_one_chapter();
        d.chapters[0].meta.summary = "这段摘要不该被计入字数".into();
        d.chapters[0].body = "正文".into();
        assert_eq!(d.word_count(CountMode::WithoutPunctuation), 2);
    }

    #[test]
    fn chapter_summary_omits_body() {
        let (mut d, _) = doc_with_one_chapter();
        // 「很长的正文」是 5 个汉字，重复 100 次即 500 字
        d.chapters[0].body = "很长的正文".repeat(100);
        let s = d.chapters[0].to_summary();
        let json = serde_json::to_string(&s).unwrap();
        // 摘要结构里绝不能出现正文，否则卷章树会把整本书读进内存
        assert!(!json.contains("很长的正文"), "摘要包含了正文：{}", &json[..80.min(json.len())]);
        assert_eq!(s.word_count, 500);
    }

    #[test]
    fn outline_groups_chapters_by_volume_with_totals() {
        let (mut d, vid) = doc_with_one_chapter();
        d.chapters[0].body = "一二三".into();
        d.chapters.push({
            let mut c = Chapter::new(&d.book.id, &vid, "二", "manuscript/002.md", 1, now());
            c.body = "四五六七".into();
            c
        });
        let vol2 = Volume::new(&d.book.id, "第二卷", 1, now());
        d.volumes.push(vol2);

        let outline = d.outline();
        assert_eq!(outline.len(), 2);
        assert_eq!(outline[0].chapter_count, 2);
        assert_eq!(outline[0].word_count, 7);
        assert_eq!(outline[1].chapter_count, 0);
        assert_eq!(outline[1].word_count, 0);
    }

    #[test]
    fn outline_is_sorted_by_volume_sort() {
        let mut d = Document::new("书", now());
        d.volumes[0].sort = 5;
        d.volumes.push(Volume::new(&d.book.id, "靠前的卷", 1, now()));
        let titles: Vec<String> = d.outline().iter().map(|n| n.title.clone()).collect();
        assert_eq!(titles[0], "靠前的卷");
    }

    #[test]
    fn document_survives_json_roundtrip() {
        // IPC 与测试夹具都依赖这个性质
        let (d, _) = doc_with_one_chapter();
        let json = serde_json::to_string(&d).unwrap();
        let back: Document = serde_json::from_str(&json).unwrap();
        assert_eq!(d, back);
    }

    #[test]
    fn find_helpers_locate_entities() {
        let (d, vid) = doc_with_one_chapter();
        assert!(d.find_volume(&vid).is_some());
        assert!(d.find_volume(&VolumeId::new()).is_none());
        let cid = d.chapters[0].meta.id.clone();
        assert!(d.find_chapter(&cid).is_some());
        assert!(d.find_chapter(&ChapterId::new()).is_none());
    }
}
