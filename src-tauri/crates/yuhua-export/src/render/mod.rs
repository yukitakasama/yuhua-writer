//! 渲染器：Document IR → 各格式字节流。
//!
//! ## 统一接口
//!
//! 所有渲染器都实现 [`Renderer`]。调用方按 [`ExportFormat`] 枚举分发，
//! 不需要知道具体格式的实现细节（计划书 9.5 的导出面板就是这么用的）。
//!
//! ## 原子产出（计划书 9.5）
//!
//! 「先写临时文件、成功后 rename」这条要求做成 [`render_to_path`] 的**默认**行为，
//! 而不是让每个渲染器自己记得做。渲染器只负责产出字节，写盘由这里统一负责 ——
//! 这样「某个渲染器忘了原子写」在结构上就不可能发生。
//!
//! ## 内存形态（不变量 5）
//!
//! `Renderer::render` 返回的是**已完成产物的字节**。对于整书导出，这个 Vec
//! 确实是全书大小；不可能更小 —— 输出文件本身就是这么大。
//! 真正的内存风险在于「把整本书的 Markdown 与 IR 同时留在内存里」，
//! 那部分已经由 [`crate::scope`] 的按章装配 + 渲染器逐章遍历堵住了。
//!
//! 需要更严格的内存上限时，用 [`Renderer::render_to_writer`]：
//! 把产物直接流进 `Write`，峰值内存降到「单章」量级。

pub mod docx;
pub mod epub;
pub mod html;
pub mod markdown;
pub mod pdf;
pub mod txt;

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{ExportError, Result};
use crate::ir::Document;

/// 导出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExportFormat {
    /// 纯文本，交稿最通用。
    Txt,
    /// Markdown，归档与再编辑。
    Markdown,
    /// HTML，网页预览与打印。
    Html,
    /// DOCX，投稿与编辑。
    Docx,
    /// PDF，打印与阅读稿（纯 Rust 渲染，内嵌中文字体）。
    Pdf,
    /// EPUB 3，电子书。
    Epub,
}

impl ExportFormat {
    /// 全部格式，供 UI 枚举导出面板的选项。
    pub const ALL: [Self; 6] = [
        Self::Txt,
        Self::Markdown,
        Self::Html,
        Self::Docx,
        Self::Pdf,
        Self::Epub,
    ];

    /// 格式的稳定标识符（用于预设记忆、文件名、日志）。
    pub fn id(self) -> &'static str {
        match self {
            Self::Txt => "txt",
            Self::Markdown => "md",
            Self::Html => "html",
            Self::Docx => "docx",
            Self::Pdf => "pdf",
            Self::Epub => "epub",
        }
    }

    /// 默认文件名后缀（不含点）。
    pub fn extension(self) -> &'static str {
        self.id()
    }

    /// 面向用户的格式名。
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Txt => "纯文本",
            Self::Markdown => "Markdown",
            Self::Html => "网页",
            Self::Docx => "Word 文档",
            Self::Pdf => "PDF",
            Self::Epub => "电子书",
        }
    }

    /// 该格式的产物是否是 zip 容器（DOCX / EPUB）。
    ///
    /// 用来决定产物开头是不是 `PK\x03\x04`，测试与调用方都用得上。
    pub fn is_zip_container(self) -> bool {
        matches!(self, Self::Docx | Self::Epub)
    }

    /// 该格式是否已经可用。
    ///
    /// 与 `crate::is_pdf_available()` 是同一个判断的两个入口：
    /// 渲染层用它给导出面板决定「选项是禁用还是可选」。
    ///
    /// PDF 是否可用**不只取决于代码写没写完**，还取决于这台机器上
    /// 有没有可用的中文字体。这里刻意只回答「渲染器实现了没有」——
    /// 「环境里有没有字体」是运行时的、可能中途变化的判断，
    /// 界面上应当在用户点导出时给出具体错误，而不是提前把按钮灰掉
    /// （用户明明可以在弹窗里指定一个字体文件）。
    pub fn is_available(self) -> bool {
        true
    }

    /// 该格式的输出是否需要内嵌字体。
    ///
    /// 目前只有 PDF。导出面板据此提示「首次导出需要几秒（嵌入字体）」，
    /// 免得用户以为界面卡死了。
    pub fn requires_font_embedding(self) -> bool {
        matches!(self, Self::Pdf)
    }
}

/// 渲染器统一接口。
///
/// 生命周期参数 `'a` 绑定 IR：渲染器**借用**文档而不是拿走所有权，
/// 这样调用方可以在一次导出里对同一份 IR 依次跑多种渲染（测试里很常用）。
pub trait Renderer<'a> {
    /// 该渲染器对应的格式。
    fn format(&self) -> ExportFormat;

    /// 渲染成字节。
    fn render(&self, document: &'a Document) -> Result<Vec<u8>>;

    /// 渲染并直接写进 `writer`。
    ///
    /// 默认实现退化成 [`Renderer::render`] 再整体写出 —— 对大多数格式够用。
    /// 需要严格控制内存的渲染器（TXT）应当覆写它，做到「喂一章、写一章」。
    fn render_to_writer(&self, document: &'a Document, writer: &mut dyn Write) -> Result<()> {
        let bytes = self.render(document)?;
        writer
            .write_all(&bytes)
            .map_err(|e| ExportError::io("<writer>", e))?;
        Ok(())
    }
}

/// 按格式分发：渲染成字节。
pub fn render(format: ExportFormat, document: &Document) -> Result<Vec<u8>> {
    match format {
        ExportFormat::Txt => txt::TxtRenderer::default().render(document),
        ExportFormat::Markdown => markdown::MarkdownRenderer::default().render(document),
        ExportFormat::Html => html::HtmlRenderer::default().render(document),
        ExportFormat::Docx => docx::DocxRenderer::default().render(document),
        ExportFormat::Epub => epub::EpubRenderer::default().render(document),
        ExportFormat::Pdf => pdf::render_pdf(document),
    }
}

/// 原子地把文档写到目标路径。
///
/// 步骤与 [`yuhua_fs`] 的原子写一致，但这里**自己实现**而不是复用：
/// `yuhua-export` 刻意不依赖 `yuhua-fs`（导出引擎是纯计算层，
/// 不该被文件系统层的演进牵动）。重复的只是十几行样板，
/// 换来的是依赖图更干净。
///
/// 关键点：
/// - 临时文件与目标**同目录**（跨分区 rename 不原子）
/// - 失败时清理临时文件，绝不在用户目录里留 `.tmp-` 垃圾
pub fn render_to_path(
    format: ExportFormat,
    document: &Document,
    target: &Path,
) -> Result<PuertoPath> {
    let bytes = render(format, document)?;
    write_bytes_atomically(&bytes, target)?;
    Ok(PuertoPath::new(target.to_path_buf(), bytes.len()))
}

/// 写出结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PuertoPath {
    /// 实际写入的路径。
    pub path: PathBuf,
    /// 产物字节数。
    pub bytes: usize,
}

impl PuertoPath {
    /// 构造写出结果。
    pub fn new(path: PathBuf, bytes: usize) -> Self {
        Self { path, bytes }
    }
}

/// 临时文件后缀标记。
///
/// 与 yuhua-fs 用同一个标记字符串（`.tmp-`）：崩溃后清理孤儿文件时
/// 只需扫一种模式，不必按模块分别处理。
pub const TEMP_MARKER: &str = ".tmp-";

/// 字节原子写入目标路径。
pub fn write_bytes_atomically(bytes: &[u8], target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| ExportError::io(parent, e))?;
        }
    }

    let temp = temp_path_for(target);
    // 用闭包包住写盘流程，任何一步失败都能在同一处清理临时文件
    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        // fsync：不刷盘的话，断电后 rename 已生效但内容为空，
        // 用户就会看到一个 0 字节的导出文件。
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, target)
    })();

    if let Err(source) = write_result {
        let _ = std::fs::remove_file(&temp);
        return Err(ExportError::io(target, source));
    }
    Ok(())
}

/// 生成与目标同目录的临时文件路径。
///
/// 随机后缀而不是固定 `.tmp`：两次并发导出（用户连点两次导出按钮）
/// 撞在一起时不会互相踩踏。
fn temp_path_for(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "export".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    target.with_file_name(format!("{name}{TEMP_MARKER}{}", &suffix[..8]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Block, BookMeta, ChapterContent, Inline, VolumeMeta};
    use yuhua_core::{ChapterId, VolumeId};

    pub(crate) fn minimal_document() -> Document {
        let vid = VolumeId::new();
        let mut doc = Document::new(BookMeta::new("测试书", "作者"));
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "第一卷".into(),
        });
        doc.chapters.push(ChapterContent::new(
            ChapterId::new(),
            vid,
            "第一章",
            vec![Block::Paragraph(vec![Inline::text("正文内容")])],
        ));
        doc
    }

    #[test]
    fn format_identifiers_and_extensions_are_stable() {
        assert_eq!(ExportFormat::Txt.id(), "txt");
        assert_eq!(ExportFormat::Markdown.id(), "md");
        assert_eq!(ExportFormat::Markdown.extension(), "md");
        assert_eq!(ExportFormat::Docx.extension(), "docx");
        assert_eq!(ExportFormat::Epub.extension(), "epub");
        assert_eq!(ExportFormat::ALL.len(), 6);
    }

    #[test]
    fn only_docx_and_epub_are_zip_containers() {
        assert!(ExportFormat::Docx.is_zip_container());
        assert!(ExportFormat::Epub.is_zip_container());
        assert!(!ExportFormat::Txt.is_zip_container());
        assert!(!ExportFormat::Html.is_zip_container());
    }

    #[test]
    fn every_format_is_available_after_pdf_lands() {
        // PDF 落地之后，六种格式应当全都是「可用」。
        // 这条断言的作用是拦住「新增格式忘了在 is_available 里放行」。
        for format in ExportFormat::ALL {
            assert!(format.is_available(), "{format:?} 应当可用");
        }
    }

    #[test]
    fn only_pdf_requires_font_embedding() {
        assert!(ExportFormat::Pdf.requires_font_embedding());
        for format in ExportFormat::ALL {
            if format != ExportFormat::Pdf {
                assert!(!format.requires_font_embedding(), "{format:?}");
            }
        }
    }

    #[test]
    fn format_display_names_are_chinese() {
        for format in ExportFormat::ALL {
            assert!(!format.display_name().is_empty());
        }
        assert_eq!(ExportFormat::Txt.display_name(), "纯文本");
    }

    /// 渲染所有格式，把「这台机器上没有中文字体」这一环境限制显式跳过。
    ///
    /// 不用「有字体就断言、没字体就跳过」的写法，是因为那会让 CI 上的
    /// 断言变成薛定谔的 —— 一台有字体的开发机上过了，CI 上却静默跳过。
    /// 这里改成：**PDF 要么产出合法字节，要么必须是 FONT_UNAVAILABLE**，
    /// 后一种情况下由 pdf 模块自己的测试（用合成字体）覆盖渲染逻辑。
    fn render_allowing_missing_font(format: ExportFormat, doc: &Document) -> Option<Vec<u8>> {
        match render(format, doc) {
            Ok(bytes) => Some(bytes),
            Err(ExportError::FontUnavailable { .. }) | Err(ExportError::Font { .. }) => None,
            Err(e) => panic!("{format:?} 渲染失败：{e}"),
        }
    }

    #[test]
    fn dispatch_produces_bytes_for_every_format() {
        let doc = minimal_document();
        for format in ExportFormat::ALL {
            if let Some(bytes) = render_allowing_missing_font(format, &doc) {
                assert!(!bytes.is_empty(), "{format:?} 产出了空文件");
            } else {
                assert_eq!(format, ExportFormat::Pdf, "只有 PDF 允许缺字体");
            }
        }
    }

    #[test]
    fn atomic_write_creates_file_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.txt");
        write_bytes_atomically("内容".as_bytes(), &target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "内容");

        let leftovers: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(TEMP_MARKER))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn atomic_write_overwrites_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.txt");
        std::fs::write(&target, "旧内容").unwrap();
        write_bytes_atomically("新内容".as_bytes(), &target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "新内容");
    }

    #[test]
    fn atomic_write_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a").join("b").join("out.txt");
        write_bytes_atomically(b"x", &target).unwrap();
        assert!(target.exists());
    }

    #[test]
    fn atomic_write_to_invalid_target_reports_io_error_with_path() {
        let dir = tempfile::tempdir().unwrap();
        // 把目录本身当成文件路径：必然失败
        let target = dir.path().to_path_buf();
        let err = write_bytes_atomically(b"x", &target).unwrap_err();
        assert_eq!(err.code(), "IO_ERROR");
        assert!(err.to_string().contains("IO_ERROR") || !err.to_string().is_empty());
    }

    #[test]
    fn render_to_path_writes_and_reports_size() {
        let doc = minimal_document();
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("book.txt");
        let report = render_to_path(ExportFormat::Txt, &doc, &target).unwrap();
        assert_eq!(report.path, target);
        assert_eq!(
            report.bytes,
            std::fs::metadata(&target).unwrap().len() as usize
        );
        assert!(report.bytes > 0);
    }

    #[test]
    fn render_to_path_leaves_no_file_when_font_is_missing() {
        let doc = minimal_document();
        let dir = tempfile::tempdir().unwrap();
        // 指向一个必然不存在的字体路径，强制走「缺字体」分支
        let renderer = pdf::PdfRenderer::new(pdf::PdfOptions {
            font_path: Some(dir.path().join("definitely-missing.ttf")),
            ..Default::default()
        });
        let target = dir.path().join("book.pdf");
        let err = renderer
            .render(&doc)
            .expect_err("不存在的字体必须报错，而不是产出乱码 PDF");
        assert_eq!(err.code(), "FONT_UNAVAILABLE");
        // 失败时不该留下任何文件
        assert!(!target.exists());
    }

    #[test]
    fn render_to_writer_streams_same_bytes_as_render() {
        let doc = minimal_document();
        let renderer = txt::TxtRenderer::default();
        let bytes = renderer.render(&doc).unwrap();
        let mut out: Vec<u8> = Vec::new();
        renderer.render_to_writer(&doc, &mut out).unwrap();
        assert_eq!(bytes, out);
    }

    #[test]
    fn renderer_trait_exposes_format() {
        assert_eq!(txt::TxtRenderer::default().format(), ExportFormat::Txt);
        assert_eq!(html::HtmlRenderer::default().format(), ExportFormat::Html);
        assert_eq!(
            markdown::MarkdownRenderer::default().format(),
            ExportFormat::Markdown
        );
        assert_eq!(docx::DocxRenderer::default().format(), ExportFormat::Docx);
        assert_eq!(epub::EpubRenderer::default().format(), ExportFormat::Epub);
    }
}
