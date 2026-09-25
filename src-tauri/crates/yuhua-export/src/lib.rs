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
//!    ┌──┴───┬───────┬────────┬───────┐
//!    ▼      ▼       ▼        ▼       ▼
//!   TXT    MD    HTML     DOCX    EPUB     （PDF 待 WebView 接线）
//! ```
//!
//! 解析只做一次（[\`markdown\`]），五个渲染器只读 IR。这样做的三个理由
//! 写在 [\`ir\`] 的模块文档里，核心是「降级规则只写一遍」（R19）。
//!
//! ## 模块地图
//!
//! | 模块 | 职责 | 对应计划书 |
//! | --- | --- | --- |
//! | [\`error\`]    | 导出层细分错误，可收敛回 \`YuhuaError\` | — |
//! | [\`ir\`]       | Document IR：Block / Inline 与嵌套表达能力 | T7.1 |
//! | [\`markdown\`] | Markdown → IR，冻结子集 + 降级记录 | T7.2 |
//! | [\`scope\`]    | 单章 / 选中 / 整卷 / 整书 四种范围 | T7.3 |
//! | [\`render\`]   | 渲染器统一接口、格式枚举、原子产出 | T7.5–T7.14 |
//!
//! ## 内存不变量（计划书不变量 5）
//!
//! **绝不整书载入内存**。体现在三处：
//!
//! 1. [\`scope::ChapterSource\`] 把「正文从哪来」抽象出来，一次只取一章；
//! 2. 渲染器走 [\`ir::Document::iter_chapters\`]，喂一章渲染一章；
//! 3. [\`render::Renderer::render_to_writer\`] 允许产物直接流进 \`Write\`，
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
    ExportFormat, PuertoPath, Renderer, TEMP_MARKER, render, render_to_path, write_bytes_atomically,
};
pub use scope::{ChapterSource, ExportScope, InMemorySource};

/// 渲染 PDF（T7.10–T7.12）。
///
/// ## 为什么现在只留一个占位
///
/// 计划书 9.4 把 PDF 定成「技术风险最高」的一项：首选方案是复用系统
/// WebView 的「打印到 PDF」，需要 WebView2 / WKWebView / WebKitGTK 的平台绑定，
/// 属于 **Tauri 应用层** 的接线工作，不是纯 Rust 计算层能完成的。
///
/// 明确返回 [\`ExportError::Unimplemented\`] 而不是「产出一个空 PDF」或
/// 「悄悄退化成 HTML」：用户点「导出 PDF」却拿到别的东西，比报一个明确的
/// 错误糟糕得多。错误码 \`UNIMPLEMENTED\` 让前端可以提示「PDF 导出即将推出」，
/// 而不是弹一个语焉不详的失败。
pub fn render_pdf(document: &Document) -> Result<Vec<u8>> {
    render::pdf::render_pdf(document)
}

/// PDF 导出是否已可用。
///
/// 导出面板据此决定 PDF 选项是禁用还是可选。把这个判断放在领域层而不是
/// 前端硬编码，是为了「接线完成后只需改这一处」。
pub fn is_pdf_available() -> bool {
    false
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

    #[test]
    fn pdf_placeholder_returns_unimplemented_with_stable_code() {
        let err = render_pdf(&sample_ir()).unwrap_err();
        assert!(matches!(err, ExportError::Unimplemented(_)));
        assert_eq!(err.code(), "UNIMPLEMENTED");
        // 错误信息要能让用户看懂，而不是「error 500」
        assert!(err.to_string().contains("尚未实现"), "{err}");
    }

    #[test]
    fn pdf_is_reported_unavailable() {
        assert!(!is_pdf_available());
        assert!(!ExportFormat::Pdf.is_available());
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
            if !format.is_available() {
                continue;
            }
            let bytes = render(format, &ir).unwrap_or_else(|e| panic!("{format:?}：{e}"));
            assert!(!bytes.is_empty(), "{format:?} 产出为空");
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

#[cfg(test)]
mod artifact_dump {
    use super::*;

    #[test]
    fn dump_artifacts_for_external_verification() {
        let vid = yuhua_core::VolumeId::new();
        let mut doc = Document::new(BookMeta::new("羽化笔记", "张三"));
        doc.book.id = Some(yuhua_core::BookId::new());
        doc.book.description = "一本用于核验的书".into();
        doc.volumes.push(VolumeMeta { id: vid.clone(), title: "第一卷".into() });
        doc.chapters.push(ChapterContent::new(
            yuhua_core::ChapterId::new(),
            vid,
            "第一章 羽化",
            vec![
                Block::Paragraph(vec![Inline::text("正文里有 </w:t> 与 & <script> 等危险字符。")]),
                Block::List { ordered: false, start: 1, items: vec![vec![Block::Paragraph(vec![Inline::text("甲")])]] },
            ],
        ));
        let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR"));
        for fmt in [ExportFormat::Epub, ExportFormat::Docx, ExportFormat::Html, ExportFormat::Txt, ExportFormat::Markdown] {
            let bytes = render(fmt, &doc).unwrap();
            std::fs::write(dir.join(format!("verify.{}", fmt.extension())), bytes).unwrap();
        }
        println!("ARTIFACT_DIR={}", dir.display());
    }
}
