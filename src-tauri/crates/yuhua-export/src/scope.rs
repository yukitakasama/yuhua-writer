//! 范围装配器：四种范围 → Document IR。
//!
//! 计划书 9.1 要求「任意格式均支持『当前章 / 选中章节 / 整卷 / 整书』四种范围」。
//! 本模块负责把「用户选了什么」翻译成「IR 里有哪些卷、哪些章」。
//!
//! ## 为什么范围选择要独立成模块
//!
//! 因为它是**唯一**会改变「用户拿到什么内容」的地方。渲染器只负责排版，
//! 装配器负责内容，两者分开之后，「选了三章却导出了整本」这类问题
//! 可以在单元测试里用纯数据结构验证，不需要真的跑一遍 DOCX 打包。
//!
//! ## 与内存不变量的关系
//!
//! 装配器会**按章读正文**（[`ChapterSource`]），一次只持有一章。
//! 整书导出 300 章时，瞬时内存仍然是「一章的 Markdown + 一章的 IR」，
//! 而不是「300 章的全部正文」。这正是计划书不变量 5 要求的形态：
//! 接口上就是流式的，后面换成「从磁盘按需读」也不用改签名。

use std::collections::HashSet;

use yuhua_core::{BookId, Chapter, ChapterId, Document as CoreDocument, VolumeId};

use crate::error::{ExportError, Result};
use crate::ir::{BookMeta, ChapterContent, Document, VolumeMeta};
use crate::markdown::{self, Degradation};

/// 导出范围。
///
/// 四种范围与计划书 9.1 一一对应。选中章节用**显式 ID 列表**而不是
/// 「区间」：UI 上是 Ctrl 点选，用户可能选中不连续的几章。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportScope {
    /// 当前章。
    Single(ChapterId),
    /// 选中章节。
    Selected(Vec<ChapterId>),
    /// 整卷。
    Volume(VolumeId),
    /// 整书。
    Whole,
}

impl ExportScope {
    /// 面向用户的描述，用于导出报告与日志。
    pub fn describe(&self) -> String {
        match self {
            Self::Single(_) => "当前章".to_string(),
            Self::Selected(ids) => format!("选中的 {} 章", ids.len()),
            Self::Volume(_) => "整卷".to_string(),
            Self::Whole => "整书".to_string(),
        }
    }
}

/// 章节正文来源。
///
/// 抽象成 trait 而不是直接吃 `CoreDocument`，理由有两条：
///
/// 1. **可测试**：单元测试可以喂一个内存实现，不必造完整的书；
/// 2. **可流式**：将来接前端命令层时，可以实现成「按需从磁盘读这一章」，
///    装配器与渲染器的代码一行都不用改。
pub trait ChapterSource {
    /// 取一章的正文（纯 Markdown，不含 Front Matter）。
    ///
    /// 返回 `None` 表示该章在数据源里不存在（例如刚被删除）。
    fn body_of(&self, id: &ChapterId) -> Option<String>;
}

/// 已把全部正文载入内存的实现。
///
/// 用于测试与「书不大」的场景。生产路径应当优先使用
/// [`crate::scope::assemble_with`] 配合一个按需读取的实现。
#[derive(Debug)]
pub struct InMemorySource<'a> {
    document: &'a CoreDocument,
}

impl<'a> InMemorySource<'a> {
    /// 由领域文档构造。
    pub fn new(document: &'a CoreDocument) -> Self {
        Self { document }
    }
}

impl ChapterSource for InMemorySource<'_> {
    fn body_of(&self, id: &ChapterId) -> Option<String> {
        self.document
            .find_chapter(id)
            .map(|chapter| chapter.body.clone())
    }
}

/// 从领域文档装配 IR。
///
/// 这是最常用的入口：正文已在 `CoreDocument` 里。
pub fn assemble(document: &CoreDocument, scope: &ExportScope) -> Result<Document> {
    assemble_with(document, &InMemorySource::new(document), scope)
}

/// 用自定义正文来源装配 IR。
///
/// `metadata` 提供卷章结构与元数据，`source` 提供正文。
/// 两者分开是为了支持「元数据来自索引库、正文按需从磁盘读」的生产形态。
pub fn assemble_with(
    metadata: &CoreDocument,
    source: &dyn ChapterSource,
    scope: &ExportScope,
) -> Result<Document> {
    // 书级元数据总是整本带上：导出文件的作者、书名与选了哪几章无关。
    let mut book = BookMeta::new(&metadata.book.title, &metadata.book.author);
    book.id = Some(metadata.book.id.clone());
    book.description = metadata.book.description.clone();

    let chapter_ids = resolve_chapter_ids(metadata, scope)?;
    if chapter_ids.is_empty() {
        return Err(ExportError::invalid(match scope {
            ExportScope::Selected(_) => "没有选中任何章节".to_string(),
            ExportScope::Volume(_) => "该卷下没有章节".to_string(),
            _ => "没有可导出的章节".to_string(),
        }));
    }

    // 先按书的顺序过滤出待导出的章节，保证输出顺序始终是「卷序 → 章序」，
    // 而不是用户在界面上点选的顺序 —— 交稿文件的章节顺序错了是致命的。
    let ordered: Vec<&Chapter> = metadata
        .chapters
        .iter()
        .filter(|c| chapter_ids.contains(c.meta.id.as_str()))
        .collect();

    // 只保留真正有章节参与的卷，避免导出里出现一个空卷标题。
    let mut volumes: Vec<VolumeMeta> = Vec::new();
    for volume in {
        let mut sorted = metadata.volumes.clone();
        sorted.sort_by_key(|v| v.sort);
        sorted
    } {
        if ordered.iter().any(|c| c.volume_id == volume.id) {
            volumes.push(VolumeMeta {
                id: volume.id.clone(),
                title: volume.title.clone(),
            });
        }
    }

    let mut chapters: Vec<ChapterContent> = Vec::with_capacity(ordered.len());
    let mut degradations: Vec<Degradation> = Vec::new();
    for chapter in ordered {
        let Some(body) = source.body_of(&chapter.meta.id) else {
            // 数据源里找不到正文：这通常是「索引还在、文件已被外部删除」。
            // 静默跳过会让用户以为内容都在，所以明确报错。
            return Err(ExportError::Incomplete(format!(
                "章「{}」的正文不存在（文件可能已被外部删除）",
                chapter.meta.title
            )));
        };
        // 章节标题以 Front Matter 为准；为空时回退到正文里的第一个一级标题，
        // 再不行才用占位名 —— 导出的标题为空比「略有出入」严重得多。
        let title = resolve_title(&chapter.meta.title, &body);
        let parsed = markdown::parse_blocks(&body, &title)?;
        degradations.extend(parsed.degradations);
        chapters.push(ChapterContent::new(
            chapter.meta.id.clone(),
            chapter.volume_id.clone(),
            title,
            parsed.blocks,
        ));
    }

    let doc = Document {
        book,
        volumes,
        chapters,
        degradations,
    };
    doc.validate()?;
    Ok(doc)
}

/// 章节标题兜底链：Front Matter → 正文第一个 H1 → 占位名。
fn resolve_title(front_matter_title: &str, body: &str) -> String {
    let trimmed = front_matter_title.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    if let Some(from_body) = markdown::extract_title(body) {
        return from_body;
    }
    "未命名章节".to_string()
}

/// 把范围解析成一组章节 ID。
fn resolve_chapter_ids<'a>(
    metadata: &'a CoreDocument,
    scope: &'a ExportScope,
) -> Result<HashSet<&'a str>> {
    let mut ids: HashSet<&str> = HashSet::new();
    match scope {
        ExportScope::Whole => {
            ids.extend(metadata.chapters.iter().map(|c| c.meta.id.as_str()));
        }
        ExportScope::Volume(volume_id) => {
            // 卷不存在要报错而不是产出空文件：用户点的是「导出本卷」，
            // 得到一个 0 字节的文件只会让他以为软件坏了。
            if metadata.find_volume(volume_id).is_none() {
                return Err(ExportError::invalid(format!("卷不存在：{volume_id}")));
            }
            ids.extend(
                metadata
                    .chapters
                    .iter()
                    .filter(|c| &c.volume_id == volume_id)
                    .map(|c| c.meta.id.as_str()),
            );
        }
        ExportScope::Single(chapter_id) => {
            if metadata.find_chapter(chapter_id).is_none() {
                return Err(ExportError::invalid(format!("章不存在：{chapter_id}")));
            }
            ids.insert(chapter_id.as_str());
        }
        ExportScope::Selected(selected) => {
            // 选中列表里出现了书中没有的 ID：可能是前端拿到的是过期数据。
            // 报错而不是忽略，避免用户以为「选了三章导了三章」。
            for chapter_id in selected {
                if metadata.find_chapter(chapter_id).is_none() {
                    return Err(ExportError::invalid(format!("章不存在：{chapter_id}")));
                }
            }
            ids.extend(selected.iter().map(ChapterId::as_str));
        }
    }
    Ok(ids)
}

/// 便捷构造：整书范围。
pub fn whole_book() -> ExportScope {
    ExportScope::Whole
}

/// 便捷构造：单章范围。
pub fn single_chapter(id: ChapterId) -> ExportScope {
    ExportScope::Single(id)
}

/// 便捷构造：整卷范围。
pub fn volume(id: VolumeId) -> ExportScope {
    ExportScope::Volume(id)
}

/// 便捷构造：选中章节范围。
pub fn selected(ids: Vec<ChapterId>) -> ExportScope {
    ExportScope::Selected(ids)
}

/// 便捷访问：书 ID（用于导出文件名兜底）。
pub fn book_id(metadata: &CoreDocument) -> BookId {
    metadata.book.id.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;

    fn now() -> DateTime<chrono::FixedOffset> {
        DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00").unwrap()
    }

    /// 造一本两卷四章的书。
    fn sample() -> (CoreDocument, Vec<VolumeId>, Vec<ChapterId>) {
        let mut doc = CoreDocument::new("羽化笔记", now());
        doc.book.author = "张三".into();
        doc.book.description = "一本测试书".into();
        let v1 = doc.volumes[0].id.clone();
        let v2 = {
            let vol = yuhua_core::Volume::new(&doc.book.id, "第二卷", 1, now());
            let id = vol.id.clone();
            doc.volumes.push(vol);
            id
        };
        let mut chapter_ids = Vec::new();
        let mut sort_v1 = 0;
        let mut sort_v2 = 0;
        for (index, (volume, _body)) in [
            (&v1, "# 一\n\n第一章正文"),
            (&v1, "# 二\n\n第二章正文"),
            (&v2, "# 三\n\n第三章正文"),
            (&v2, "# 四\n\n第四章正文"),
        ]
        .into_iter()
        .enumerate()
        {
            let is_first = index < 2;
            let chapter = Chapter::new(
                &doc.book.id,
                volume,
                format!("第{}章", index + 1),
                format!("manuscript/{:03}.md", index),
                if is_first { sort_v1 } else { sort_v2 },
                now(),
            );
            if is_first {
                sort_v1 += 1;
            } else {
                sort_v2 += 1;
            }
            chapter_ids.push(chapter.meta.id.clone());
            doc.chapters.push(chapter);
        }
        doc.chapters[0].body = "# 一\n\n第一章正文".into();
        doc.chapters[1].body = "# 二\n\n第二章正文".into();
        doc.chapters[2].body = "# 三\n\n第三章正文".into();
        doc.chapters[3].body = "# 四\n\n第四章正文".into();
        (doc, vec![v1, v2], chapter_ids)
    }

    #[test]
    fn whole_book_includes_every_chapter_and_volume() {
        let (doc, volumes, _) = sample();
        let ir = assemble(&doc, &ExportScope::Whole).unwrap();
        assert_eq!(ir.chapter_count(), 4);
        assert_eq!(ir.volumes.len(), 2);
        assert_eq!(ir.volumes[0].id, volumes[0]);
        assert_eq!(ir.book.title, "羽化笔记");
        assert_eq!(ir.book.author, "张三");
        assert_eq!(ir.book.description, "一本测试书");
    }

    #[test]
    fn single_chapter_keeps_only_that_chapter() {
        let (doc, volumes, chapters) = sample();
        let ir = assemble(&doc, &ExportScope::Single(chapters[2].clone())).unwrap();
        assert_eq!(ir.chapter_count(), 1);
        assert_eq!(ir.chapters[0].title, "第3章");
        // 只留下第二卷：第一章所在的卷不该出现
        assert_eq!(ir.volumes.len(), 1);
        assert_eq!(ir.volumes[0].id, volumes[1]);
    }

    #[test]
    fn selected_chapters_are_ordered_by_book_order_not_selection_order() {
        let (doc, _, chapters) = sample();
        // 逆序选择，输出必须是书里的顺序
        let scope = ExportScope::Selected(vec![chapters[3].clone(), chapters[0].clone()]);
        let ir = assemble(&doc, &scope).unwrap();
        let titles: Vec<&str> = ir.chapters.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["第1章", "第4章"]);
    }

    #[test]
    fn volume_scope_keeps_chapters_of_that_volume_only() {
        let (doc, volumes, _) = sample();
        let ir = assemble(&doc, &ExportScope::Volume(volumes[1].clone())).unwrap();
        assert_eq!(ir.chapter_count(), 2);
        assert_eq!(ir.volumes.len(), 1);
        assert!(ir
            .chapters
            .iter()
            .all(|c| c.title.contains('3') || c.title.contains('4')));
    }

    #[test]
    fn empty_volume_is_rejected_with_clear_message() {
        let (mut doc, _, _) = sample();
        let empty = yuhua_core::Volume::new(&doc.book.id, "空卷", 5, now());
        let id = empty.id.clone();
        doc.volumes.push(empty);
        let err = assemble(&doc, &ExportScope::Volume(id)).unwrap_err();
        assert!(err.to_string().contains("没有章节"), "{err}");
    }

    #[test]
    fn missing_volume_is_rejected() {
        let (doc, _, _) = sample();
        let err = assemble(&doc, &ExportScope::Volume(VolumeId::new())).unwrap_err();
        assert!(err.to_string().contains("卷不存在"), "{err}");
    }

    #[test]
    fn missing_chapter_is_rejected() {
        let (doc, _, _) = sample();
        let err = assemble(&doc, &ExportScope::Single(ChapterId::new())).unwrap_err();
        assert!(err.to_string().contains("章不存在"), "{err}");
        let err = assemble(&doc, &ExportScope::Selected(vec![ChapterId::new()])).unwrap_err();
        assert!(err.to_string().contains("章不存在"), "{err}");
    }

    #[test]
    fn empty_selection_is_rejected() {
        let (doc, _, _) = sample();
        let err = assemble(&doc, &ExportScope::Selected(vec![])).unwrap_err();
        assert!(err.to_string().contains("没有选中"), "{err}");
    }

    #[test]
    fn missing_body_reports_incomplete_instead_of_silently_skipping() {
        let (doc, _, chapters) = sample();

        // 一个「正文都取不到」的来源，模拟索引在、文件被外部删除
        struct Empty;
        impl ChapterSource for Empty {
            fn body_of(&self, _id: &ChapterId) -> Option<String> {
                None
            }
        }

        let err =
            assemble_with(&doc, &Empty, &ExportScope::Single(chapters[0].clone())).unwrap_err();
        assert!(err.to_string().contains("正文不存在"), "{err}");
    }

    #[test]
    fn title_falls_back_to_body_h1_when_front_matter_is_blank() {
        let (mut doc, _, chapters) = sample();
        doc.chapters[0].meta.title = "   ".into();
        doc.chapters[0].body = "# 正文里的一级标题\n\n内容".into();
        let ir = assemble(&doc, &ExportScope::Single(chapters[0].clone())).unwrap();
        assert_eq!(ir.chapters[0].title, "正文里的一级标题");
    }

    #[test]
    fn title_falls_back_to_placeholder_when_nothing_available() {
        let (mut doc, _, chapters) = sample();
        doc.chapters[0].meta.title = String::new();
        doc.chapters[0].body = "没有标题的正文".into();
        let ir = assemble(&doc, &ExportScope::Single(chapters[0].clone())).unwrap();
        assert_eq!(ir.chapters[0].title, "未命名章节");
    }

    #[test]
    fn degradations_are_collected_across_chapters() {
        let (mut doc, _, _) = sample();
        doc.chapters[0].body = "| a |\n| --- |\n| 1 |".into();
        doc.chapters[1].body = "$x^2$".into();
        let ir = assemble(&doc, &ExportScope::Whole).unwrap();
        assert_eq!(ir.degradations.len(), 2);
        // 降级记录必须带上是哪一章，用户才能回去改
        assert_eq!(ir.degradations[0].chapter_title, "第1章");
        assert_eq!(ir.degradations[1].chapter_title, "第2章");
    }

    #[test]
    fn scope_descriptions_are_human_readable() {
        let (doc, volumes, chapters) = sample();
        let _ = doc;
        assert_eq!(ExportScope::Whole.describe(), "整书");
        assert_eq!(
            ExportScope::Single(chapters[0].clone()).describe(),
            "当前章"
        );
        assert_eq!(ExportScope::Volume(volumes[0].clone()).describe(), "整卷");
        assert_eq!(
            ExportScope::Selected(chapters.clone()).describe(),
            "选中的 4 章"
        );
    }

    #[test]
    fn helper_constructors_build_expected_variants() {
        let (doc, volumes, chapters) = sample();
        assert_eq!(whole_book(), ExportScope::Whole);
        assert_eq!(
            volume(volumes[0].clone()),
            ExportScope::Volume(volumes[0].clone())
        );
        assert_eq!(
            single_chapter(chapters[0].clone()),
            ExportScope::Single(chapters[0].clone())
        );
        assert_eq!(selected(chapters.clone()), ExportScope::Selected(chapters));
        assert_eq!(book_id(&doc), doc.book.id);
    }

    #[test]
    fn empty_body_is_valid_and_yields_no_blocks() {
        let (mut doc, _, chapters) = sample();
        doc.chapters[0].body = String::new();
        let ir = assemble(&doc, &ExportScope::Single(chapters[0].clone())).unwrap();
        assert!(ir.chapters[0].blocks.is_empty());
        assert_eq!(ir.degradations.len(), 0);
    }

    #[test]
    fn chapters_carry_their_volume_id() {
        let (doc, volumes, _) = sample();
        let ir = assemble(&doc, &ExportScope::Whole).unwrap();
        assert_eq!(ir.chapters[0].volume_id, volumes[0]);
        assert_eq!(ir.chapters[3].volume_id, volumes[1]);
        // 卷标题可查
        assert_eq!(ir.volume_title(&volumes[1]).unwrap(), "第二卷");
    }
}
