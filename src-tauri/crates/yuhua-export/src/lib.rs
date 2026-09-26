//! # yuhua-export — 羽化写作导出引擎
//!
//! 本 crate 把 Markdown 稿子翻译成六种交付格式。对应计划书第 9 章与里程碑 M7。
//!
//! ## 架构：单一 IR + 多渲染器（计划书 9.2）
//!
//! ```text
//! Markdown 文件（真源）
//!       │
//!       ▼  pulldown-cmark（冻结子集，9.3）
//!    Document IR（ir.rs）
//!       │
//!    ┌──┴──┬──────┬───────┬───────┬───────┐
//!    ▼     ▼      ▼       ▼       ▼       ▼
//!   TXT   MD    HTML    DOCX    EPUB     PDF
//! ```
//!
//! 解析只做一次（[`markdown`]），六个渲染器只读 IR。这样做的三个理由
//! 写在 [`ir`] 的模块文档里，核心是「降级规则只写一遍」（R19）。
//!
//! ## 模块地图
//!
//! | 模块 | 职责 | 对应计划书 |
//! | --- | --- | --- |
//! | [`error`]    | 导出层细分错误，可收敛回 `YuhuaError` | — |
//! | [`ir`]       | Document IR：Block / Inline 与嵌套表达能力 | T7.1 |
//! | [`markdown`] | Markdown → IR，冻结子集 + 降级记录 | T7.2 |
//! | [`scope`]    | 单章 / 选中 / 整卷 / 整书 四种范围 | T7.3 |
//! | [`render`]   | 渲染器统一接口、格式枚举、原子产出 | T7.5–T7.14 |
//!
//! ## 内存不变量（计划书不变量 5）
//!
//! **绝不整书载入内存**。体现在三处：
//!
//! 1. [`scope::ChapterSource`] 把「正文从哪来」抽象出来，一次只取一章；
//! 2. 渲染器走 [`ir::Document::iter_chapters`]，喂一章渲染一章；
//! 3. [`render::Renderer::render_to_writer`] 允许产物直接流进 `Write`，
//!    不要求在内存里攒出整本书。
//!
//! ## 快速上手
//!
//! ```no_run
//! use yuhua_export::{render_to_path, ExportFormat, ExportScope};
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let core_document: yuhua_core::Document = unimplemented!();
//! // 1. 装配 IR（只读元数据 + 按章取正文）
//! let ir = yuhua_export::scope::assemble(&core_document, &ExportScope::Whole)?;
//! // 2. 渲染并原子写盘
//! let report = render_to_path(ExportFormat::Docx, &ir, "交稿.docx".as_ref())?;
//! println!("写出 {} 字节", report.bytes);
//! // 3. 降级提示（R19：不能静默丢弃）
//! for d in &ir.degradations {
//!     println!("{}：{}", d.chapter_title, d.detail);
//! }
//! # Ok(())
//! # }
//! ```

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod error;
pub mod ir;
pub mod markdown;
pub mod render;
pub mod scope;

pub use error::{ExportError, Result};
pub use ir::{Block, BookMeta, ChapterContent, Document, Inline, VolumeMeta};
pub use markdown::{Degradation, DegradationKind, ParsedChapter};
pub use render::{
    render, render_to_path, write_bytes_atomically, ExportFormat, PuertoPath, Renderer, TEMP_MARKER,
};
pub use scope::{ChapterSource, ExportScope, InMemorySource};

/// 渲染 PDF（T7.10–T7.12）。
///
/// 用默认选项（A4、2.5cm/3cm 页边距、10.5pt 正文、每章另起一页）。
/// 需要自定义版式时直接构造 [`render::pdf::PdfRenderer`]。
///
/// ## 缺字体时的行为
///
/// 找不到可用的中文字体时返回 [`ExportError::FontUnavailable`]
/// （错误码 `FONT_UNAVAILABLE`），**绝不产出乱码 PDF**。
/// 前端可以据此提示用户安装字体，或让用户在导出面板里指定字体文件。
pub fn render_pdf(document: &Document) -> Result<Vec<u8>> {
    render::pdf::render_pdf(document)
}

/// PDF 导出是否已可用。
///
/// 返回 `true`：渲染器已经实现（T7.10–T7.12）。
///
/// 注意这个判断回答的是「**代码**里有没有 PDF 渲染器」，不是
/// 「**这台机器**上能不能导出成功」—— 后者取决于有没有可用的中文字体，
/// 是一个运行时的、可能中途变化的判断（用户可以边开着应用边装字体）。
/// 把它做成「提前灰掉按钮」会让用户失去「在弹窗里指定字体文件」的机会，
/// 所以这里统一返回 true，把环境问题留到点击导出时用具体错误说明。
pub fn is_pdf_available() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;

    fn sample_ir() -> Document {
        let vid = yuhua_core::VolumeId::new();
        let mut doc = Document::new(BookMeta::new("羽化笔记", "张三"));
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "第一卷".into(),
        });
        doc.chapters.push(ChapterContent::new(
            yuhua_core::ChapterId::new(),
            vid,
            "第一章",
            vec![Block::Paragraph(vec![Inline::text("正文")])],
        ));
        doc
    }

    /// PDF 要么产出合法字节，要么是「缺字体」这一条可恢复的错误。
    ///
    /// 这是全 crate 唯一允许「不产出字节」的情形，所以断言写得很死：
    /// 任何别的错误（Panic 之外的 ExportError）都会在这里炸出来。
    #[test]
    fn pdf_renders_or_reports_missing_font() {
        match render_pdf(&sample_ir()) {
            Ok(bytes) => {
                assert!(bytes.starts_with(b"%PDF-1.7"), "PDF 头不对");
                assert!(bytes.ends_with(b"%%EOF\n") || bytes.ends_with(b"%%EOF"));
            }
            Err(ExportError::FontUnavailable { hint, .. }) => {
                // 缺字体的提示必须包含可操作信息，不能只是一句「失败」
                assert!(hint.contains("字体"), "{hint}");
            }
            Err(other) => panic!("PDF 渲染返回了意外错误：{other}"),
        }
    }

    #[test]
    fn pdf_is_reported_available() {
        // 渲染器已实现，导出面板不该再把它当「即将推出」
        assert!(is_pdf_available());
        assert!(ExportFormat::Pdf.is_available());
    }

    #[test]
    fn public_api_re_exports_are_usable() {
        // 防止有人改动导出列表导致下游（命令层）编译失败
        let doc = sample_ir();
        let format = ExportFormat::Txt;
        assert!(format.is_available());
        let bytes = render(format, &doc).unwrap();
        assert!(!bytes.is_empty());
        assert_eq!(TEMP_MARKER, ".tmp-");
    }

    #[test]
    fn end_to_end_assemble_and_render_all_implemented_formats() {
        let mut core = yuhua_core::Document::new(
            "整书测试",
            DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00").unwrap(),
        );
        core.book.author = "李四".into();
        let vid = core.volumes[0].id.clone();
        for (index, body) in [
            "# 一\n\n第一章**正文**",
            "# 二\n\n第二章正文\n\n| a |\n| --- |\n| 1 |",
        ]
        .into_iter()
        .enumerate()
        {
            let mut chapter = yuhua_core::Chapter::new(
                &core.book.id,
                &vid,
                format!("第{}章", index + 1),
                format!("manuscript/{index}.md"),
                index as i32,
                DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00").unwrap(),
            );
            chapter.body = body.into();
            core.chapters.push(chapter);
        }

        let ir = scope::assemble(&core, &ExportScope::Whole).unwrap();
        assert_eq!(ir.chapter_count(), 2);
        // 第二章含表格，必须留下降级记录
        assert_eq!(ir.degradations.len(), 1);
        assert_eq!(ir.degradations[0].kind, DegradationKind::Table);

        for format in ExportFormat::ALL {
            match render(format, &ir) {
                Ok(bytes) => assert!(!bytes.is_empty(), "{format:?} 产出为空"),
                // PDF 依赖本机中文字体；没装字体的机器上只允许这一种失败。
                Err(ExportError::FontUnavailable { .. }) => {
                    assert_eq!(format, ExportFormat::Pdf, "只有 PDF 依赖字体");
                }
                Err(e) => panic!("{format:?}：{e}"),
            }
        }
    }

    #[test]
    fn zip_formats_start_with_pk_signature() {
        // 容器格式的魔数校验：DXOZ/EPUB 都必须是合法 zip
        let doc = sample_ir();
        for format in [ExportFormat::Docx, ExportFormat::Epub] {
            let bytes = render(format, &doc).unwrap();
            assert_eq!(
                &bytes[..4],
                b"PK\x03\x04",
                "{format:?} 不是 zip 容器（开头应为 PK\\x03\\x04）"
            );
        }
    }
}
