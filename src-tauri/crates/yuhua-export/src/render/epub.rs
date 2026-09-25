//! EPUB 3 渲染器 —— 电子书 / 多平台。
//!
//! 计划书 9.4 的结构要求：
//!
//! ```text
//! mimetype                 必须【无压缩】且是 zip 里的【第一个】条目
//! META-INF/container.xml   告诉阅读器去哪找 OPF
//! OEBPS/content.opf        包文档：元数据 + 清单 + 阅读顺序
//! OEBPS/nav.xhtml          EPUB 3 的导航文档（目录）
//! OEBPS/chapter-*.xhtml    每章一个文件
//! ```
//!
//! ## 为什么 mimetype 这么讲究
//!
//! EPUB 是用「文件是不是 zip + 第一个条目是不是无压缩的 mimetype」来嗅探的。
//! 内容分发方（阅读器、书店、`epubcheck`）在读文件头部的几十个字节后就要
//! 判定「这不是普通 zip，是 EPUB」，然后才去读 zip 的中央目录。
//! 所以：
//!
//! - 它必须是**第一个**写入的条目；
//! - 它必须用 **Stored（不压缩）**，否则头部字节是压缩流的魔数，嗅探失败；
//! - 内容必须**恰好**是 `application/octet-stream` 之外的
//!   `application/epub+zip`，**末尾不能有换行**（多一个 \n 就让长度对不上，
//!   严格的校验器会报错）。
//!
//! ## 每章一个 XHTML 文件
//!
//! 这不是过度拆分：EPUB 阅读器按「文档」分页与缓存，单章一文件才能让
//! 十万字的书在低端阅读器上翻页不卡。同时每章一文件也天然对应
//! 「一章一个 page-break」的语义。

use std::fmt::Write as _;
use std::io::{Cursor, Write};

use crate::error::{ExportError, Result};
use crate::ir::{Block, Document, Inline};
use crate::render::html::escape_html;
use crate::render::{ExportFormat, Renderer};

/// mimetype 条目的内容。
///
/// **不能有任何前后空白或换行**，见模块文档。
pub const MIMETYPE_CONTENT: &str = "application/epub+zip";

/// EPUB 渲染选项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpubOptions {
    /// 语言标签（BCP 47）。中文稿子默认 `zh`。
    pub language: String,
    /// 书籍 UUID。为 `None` 时由书 ID 派生，保证同一本书每次导出 UUID 稳定 ——
    /// 每次随机会让阅读器把「同一本书的两个版本」当成两本不同的书。
    pub identifier: Option<String>,
    /// 出版商。
    pub publisher: String,
    /// 是否在每章开头插入分页（`page-break-before`）。
    pub page_break_per_chapter: bool,
}

impl Default for EpubOptions {
    fn default() -> Self {
        Self {
            language: "zh".to_string(),
            identifier: None,
            publisher: String::new(),
            page_break_per_chapter: true,
        }
    }
}

/// EPUB 渲染器。
#[derive(Debug, Clone, Default)]
pub struct EpubRenderer {
    /// 选项。
    pub options: EpubOptions,
}

impl EpubRenderer {
    /// 用指定选项构造。
    pub fn new(options: EpubOptions) -> Self {
        Self { options }
    }

    /// 解析书籍标识符。
    ///
    /// 优先用调用方给的；否则由书 ID 派生一个**稳定**的 URN：同一本书
    /// 反复导出得到同一个 UUID，阅读器才能正确识别为「同一本书的新版本」。
    fn identifier(&self, document: &Document) -> String {
        if let Some(id) = &self.options.identifier {
            if !id.trim().is_empty() {
                return id.clone();
            }
        }
        if let Some(book_id) = &document.book.id {
            // 书 ID 形如 bk_<32 位十六进制>，取主体部分拼成 UUID 形态
            let raw = book_id.as_str().trim_start_matches("bk_");
            if raw.len() >= 32 {
                let hex = &raw[..32];
                let formatted = format!(
                    "urn:uuid:{}-{}-{}-{}-{}",
                    &hex[0..8],
                    &hex[8..12],
                    &hex[12..16],
                    &hex[16..20],
                    &hex[20..32]
                );
                return formatted;
            }
            return format!("urn:uuid:{raw}");
        }
        // 连书 ID 都没有：用书名 + 作者做确定性哈希，仍然保持「同书同 ID」
        let seed = format!("{}\u{1}{}", document.book.title, document.book.author);
        let digest = blake3_like(&seed);
        format!(
            "urn:uuid:{}-{}-{}-{}-{}",
            &digest[0..8],
            &digest[8..12],
            &digest[12..16],
            &digest[16..20],
            &digest[20..32]
        )
    }

    /// 生成 `META-INF/container.xml`。
    fn container_xml(&self) -> String {
        let mut out = String::from(XML_DECLARATION);
        out.push_str("<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">");
        out.push_str("<rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles>");
        out.push_str("</container>");
        out
    }

    /// 生成 `OEBPS/content.opf`。
    fn content_opf(&self, document: &Document, modified: &str) -> String {
        let mut out = String::from(XML_DECLARATION);
        out.push_str("<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"pub-id\" xml:lang=\"");
        out.push_str(&escape_html(&self.options.language));
        out.push_str("\">");

        // ---- 元数据 ----
        out.push_str("<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">");
        let _ = write!(
            out,
            "<dc:identifier id=\"pub-id\">{}</dc:identifier>",
            escape_html(&self.identifier(document))
        );
        let _ = write!(
            out,
            "<dc:title>{}</dc:title>",
            escape_html(&document.book.title)
        );
        let _ = write!(
            out,
            "<dc:language>{}</dc:language>",
            escape_html(&self.options.language)
        );
        let _ = write!(
            out,
            "<dc:creator id=\"creator\">{}</dc:creator>",
            escape_html(document.book.author_or_anonymous())
        );
        // role=aut 表示「作者」。EPUB 3 要求 role 走 refines 而不是属性
        out.push_str("<meta refines=\"#creator\" property=\"role\" scheme=\"marc:relators\">aut</meta>");
        if !document.book.description.trim().is_empty() {
            let _ = write!(
                out,
                "<dc:description>{}</dc:description>",
                escape_html(&document.book.description)
            );
        }
        if !self.options.publisher.trim().is_empty() {
            let _ = write!(
                out,
                "<dc:publisher>{}</dc:publisher>",
                escape_html(&self.options.publisher)
            );
        }
        // dcterms:modified 是 EPUB 3 **必填**项，缺少会被 epubcheck 判 error
        let _ = write!(
            out,
            "<meta property=\"dcterms:modified\">{modified}</meta>"
        );
        out.push_str("</metadata>");

        // ---- 清单 ----
        out.push_str("<manifest>");
        out.push_str("<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>");
        out.push_str("<item id=\"style\" href=\"style.css\" media-type=\"text/css\"/>");
        for (index, chapter) in document.iter_chapters().enumerate() {
            let _ = write!(
                out,
                "<item id=\"c{index}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>",
                chapter_file_name(index, &chapter.title)
            );
        }
        out.push_str("</manifest>");

        // ---- 阅读顺序 ----
        out.push_str("<spine>");
        for index in 0..document.chapter_count() {
            let _ = write!(out, "<itemref idref=\"c{index}\"/>");
        }
        out.push_str("</spine>");

        out.push_str("</package>");
        out
    }

    /// 生成 `OEBPS/nav.xhtml`（目录）。
    fn nav_xhtml(&self, document: &Document) -> String {
        let mut out = String::from(XML_DECLARATION);
        out.push_str("<!DOCTYPE html>");
        out.push_str("<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"");
        out.push_str(&escape_html(&self.options.language));
        out.push_str("\"><head><title>目录</title><meta charset=\"utf-8\"/>");
        out.push_str("<link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/></head><body>");
        out.push_str("<nav epub:type=\"toc\" id=\"toc\"><h1>目录</h1><ol>");

        let mut current_volume: Option<&str> = None;
        let mut open_volume = false;
        for (index, chapter) in document.iter_chapters().enumerate() {
            let volume_title = document.volume_title(&chapter.volume_id);
            if volume_title != current_volume {
                // 关掉上一个卷的嵌套列表
                if open_volume {
                    out.push_str("</ol></li>");
                }
                if let Some(title) = volume_title {
                    let _ = write!(out, "<li><span>{}</span><ol>", escape_html(title));
                    open_volume = true;
                    current_volume = volume_title;
                } else {
                    open_volume = false;
                }
            }
            let _ = write!(
                out,
                "<li><a href=\"{}\">{}</a></li>",
                chapter_file_name(index, &chapter.title),
                escape_html(&chapter.title)
            );
        }
        if open_volume {
            out.push_str("</ol></li>");
        }
        out.push_str("</ol></nav></body></html>");
        out
    }

    /// 生成一页 XHTML。
    fn chapter_xhtml(&self, chapter: &crate::ir::ChapterContent, index: usize) -> String {
        let mut body = String::new();
        if self.options.page_break_per_chapter && index > 0 {
            let _ = write!(
                body,
                "<section class=\"chapter\" epub:type=\"chapter\" style=\"page-break-before: always;\">"
            );
        } else {
            let _ = write!(body, "<section class=\"chapter\" epub:type=\"chapter\">");
        }
        let _ = writeln!(body, "<h1 class=\"chapter-title\">{}</h1>", escape_html(&chapter.title));
        self.render_blocks(&chapter.blocks, &mut body, 0);
        body.push_str("</section>");

        let mut out = String::from(XML_DECLARATION);
        out.push_str("<!DOCTYPE html>");
        out.push_str("<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"");
        out.push_str(&escape_html(&self.options.language));
        out.push_str("\"><head><title>");
        out.push_str(&escape_html(&chapter.title));
        out.push_str("</title><meta charset=\"utf-8\"/>");
        out.push_str("<link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/></head><body>");
        out.push_str(&body);
        out.push_str("</body></html>");
        out
    }

    /// 内置 CSS。
    ///
    /// 电子墨水屏上衬线体 + 1.8 行高最耐读；字号用相对单位 `em`，
    /// 让阅读器的「字号调节」能整体生效 —— 写死 px 会让用户的设置失效。
    fn style_css(&self) -> String {
        r#"html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0 5%;
  font-family: "Songti SC", "SimSun", "Noto Serif CJK SC", serif;
  line-height: 1.8;
  text-align: justify;
  word-wrap: break-word;
}
h1.chapter-title { font-size: 1.5em; margin: 1.2em 0 1em; text-align: center; }
h2, h3, h4, h5, h6 { line-height: 1.5; margin: 1.4em 0 0.6em; }
p { margin: 0 0 0.9em; text-indent: 2em; }
blockquote {
  margin: 1em 0;
  padding-left: 0.9em;
  border-left: 3px solid #bbb;
  font-style: italic;
}
ul, ol { margin: 0 0 1em; padding-left: 1.6em; }
li > p { text-indent: 0; }
code { font-family: monospace; font-size: 0.9em; }
pre { background: #f4f4f4; padding: 0.7em; overflow-x: auto; line-height: 1.5; }
hr { border: 0; border-top: 1px solid #ccc; margin: 1.6em 0; }
img { max-width: 100%; height: auto; }
a { color: inherit; text-decoration: none; }
"#
        .to_string()
    }

    /// 渲染块序列。
    fn render_blocks(&self, blocks: &[Block], out: &mut String, depth: usize) {
        for block in blocks {
            self.render_block(block, out, depth);
        }
    }

    /// 渲染单个块。
    fn render_block(&self, block: &Block, out: &mut String, depth: usize) {
        match block {
            Block::Paragraph(inlines) => {
                let text = self.render_inlines(inlines);
                if text.trim().is_empty() {
                    return;
                }
                let _ = writeln!(out, "<p>{text}</p>");
            }
            Block::Heading { level, text } => {
                // 章标题已占用 h1，正文标题顺推但不低于 h6
                let level = (*level as usize + 1).clamp(2, 6);
                let _ = writeln!(out, "<h{level}>{}</h{level}>", escape_html(text));
            }
            Block::Quote(children) => {
                out.push_str("<blockquote>");
                let mut inner = String::new();
                self.render_blocks(children, &mut inner, depth);
                out.push_str(&inner);
                out.push_str("</blockquote>");
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                let tag = if *ordered { "ol" } else { "ul" };
                if *ordered && *start != 1 {
                    let _ = write!(out, "<{tag} start=\"{start}\">");
                } else {
                    let _ = write!(out, "<{tag}>");
                }
                for item in items {
                    out.push_str("<li>");
                    if item.len() == 1 {
                        if let Block::Paragraph(inlines) = &item[0] {
                            out.push_str(&self.render_inlines(inlines));
                        } else {
                            let mut inner = String::new();
                            self.render_blocks(item, &mut inner, depth + 1);
                            out.push_str(&inner);
                        }
                    } else {
                        let mut inner = String::new();
                        self.render_blocks(item, &mut inner, depth + 1);
                        out.push_str(&inner);
                    }
                    out.push_str("</li>");
                }
                let _ = write!(out, "</{tag}>");
            }
            Block::Code { text, .. } => {
                // XHTML 里没有 lang 属性，代码块用 <pre><code>
                let _ = write!(out, "<pre><code>{}</code></pre>", escape_html(text));
            }
            Block::Hr => out.push_str("<hr/>"),
            Block::PageBreak => {
                // EPUB 里章与章本来就是不同文档，文档内的分页用带样式的空 div 表达
                out.push_str("<div class=\"page-break\" style=\"page-break-after: always;\"></div>");
            }
        }
    }

    /// 渲染行内元素。
    fn render_inlines(&self, inlines: &[Inline]) -> String {
        let mut out = String::new();
        for inline in inlines {
            match inline {
                Inline::Text(t) => out.push_str(&escape_html(t)),
                Inline::Code(t) => {
                    let _ = write!(out, "<code>{}</code>", escape_html(t));
                }
                Inline::Emph(children) => {
                    let _ = write!(out, "<em>{}</em>", self.render_inlines(children));
                }
                Inline::Strong(children) => {
                    let _ = write!(out, "<strong>{}</strong>", self.render_inlines(children));
                }
                Inline::Link { url, text } => {
                    let label = self.render_inlines(text);
                    if is_safe_url(url) {
                        let _ = write!(out, "<a href=\"{}\">{label}</a>", escape_html(url));
                    } else {
                        out.push_str(&label);
                    }
                }
                Inline::Image { url, alt } => {
                    if is_safe_url(url) {
                        let _ = write!(
                            out,
                            "<img src=\"{}\" alt=\"{}\"/>",
                            escape_html(url),
                            escape_html(alt)
                        );
                    } else {
                        let _ = write!(
                            out,
                            "<span class=\"image-fallback\">{}</span>",
                            escape_html(alt)
                        );
                    }
                }
            }
        }
        out
    }
}

impl<'a> Renderer<'a> for EpubRenderer {
    fn format(&self) -> ExportFormat {
        ExportFormat::Epub
    }

    fn render(&self, document: &'a Document) -> Result<Vec<u8>> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);

            // ---- 1. mimetype：必须第一个、必须 Stored、内容不含换行 ----
            let stored: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("mimetype", stored)
                .map_err(|e| ExportError::Package(format!("写入 mimetype 失败：{e}")))?;
            zip.write_all(MIMETYPE_CONTENT.as_bytes())
                .map_err(|e| ExportError::Package(format!("写入 mimetype 失败：{e}")))?;

            // ---- 其余条目一律 deflate ----
            let deflated: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            let modified = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

            let write_part = |zip: &mut zip::ZipWriter<&mut Cursor<Vec<u8>>>,
                                  name: &str,
                                  content: String|
             -> Result<()> {
                zip.start_file(name, deflated)
                    .map_err(|e| ExportError::Package(format!("写入 {name} 失败：{e}")))?;
                zip.write_all(content.as_bytes())
                    .map_err(|e| ExportError::Package(format!("写入 {name} 失败：{e}")))?;
                Ok(())
            };

            write_part(&mut zip, "META-INF/container.xml", self.container_xml())?;
            write_part(&mut zip, "OEBPS/content.opf", self.content_opf(document, &modified))?;
            write_part(&mut zip, "OEBPS/nav.xhtml", self.nav_xhtml(document))?;
            write_part(&mut zip, "OEBPS/style.css", self.style_css())?;
            for (index, chapter) in document.iter_chapters().enumerate() {
                let name = format!("OEBPS/{}", chapter_file_name(index, &chapter.title));
                write_part(&mut zip, &name, self.chapter_xhtml(chapter, index))?;
            }

            zip.finish()
                .map_err(|e| ExportError::Package(format!("收尾 zip 失败：{e}")))?;
        }
        Ok(buffer.into_inner())
    }
}

/// XML 声明。
const XML_DECLARATION: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";

/// 章节文件名。
///
/// **只用序号，不带标题**。理由：EPUB 内的文件路径必须能安全地放进
/// `content.opf` 的 `href` 属性，而中文标题里可能有引号、斜杠、空格。
/// 序号方案既稳定又永远合法，标题信息由 nav.xhtml 承载。
fn chapter_file_name(index: usize, _title: &str) -> String {
    format!("chapter-{:04}.xhtml", index + 1)
}

/// 判断 URL 是否可安全用于 `href` / `src`（与 HTML 渲染器同一套规则）。
fn is_safe_url(url: &str) -> bool {
    crate::render::html::is_safe_url(url)
}

/// 由字符串派生 32 位十六进制摘要。
///
/// 刻意**不引入 blake3 依赖**：这里只需要一个「同一输入得到同一输出」的
/// 稳定伪随机值，用来给没有书 ID 的书派生 UUID。用一个简单的 FNV-1a 展开
/// 成 128 位就够，还能少一个依赖（计划书要求依赖最小化）。
fn blake3_like(seed: &str) -> String {
    // 四个不同初值的 FNV-1a，拼成 128 位
    let mut out = String::with_capacity(32);
    for salt in 0u64..4 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325 ^ salt.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        for byte in seed.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        out.push_str(&format!("{hash:016x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{BookMeta, ChapterContent, VolumeMeta};
    use std::collections::HashMap;
    use std::io::Read;
    use yuhua_core::{BookId, ChapterId, VolumeId};

    fn doc_with(blocks: Vec<Block>) -> Document {
        let vid = VolumeId::new();
        let mut doc = Document::new(BookMeta::new("测试书", "作者"));
        doc.book.id = Some(BookId::new());
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "第一卷".into(),
        });
        doc.chapters
            .push(ChapterContent::new(ChapterId::new(), vid, "第一章", blocks));
        doc
    }

    /// 解压成「条目名 → (是否无压缩, 文本)」。
    fn unzip(bytes: &[u8]) -> Vec<(String, bool, String)> {
        let mut archive =
            zip::ZipArchive::new(Cursor::new(bytes.to_vec())).expect("EPUB 必须是合法 zip");
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_string();
            let stored = entry.compression() == zip::CompressionMethod::Stored;
            let mut content = String::new();
            entry.read_to_string(&mut content).unwrap();
            entries.push((name, stored, content));
        }
        entries
    }

    fn parts_map(bytes: &[u8]) -> HashMap<String, String> {
        unzip(bytes)
            .into_iter()
            .map(|(name, _, content)| (name, content))
            .collect()
    }

    fn render_doc(doc: &Document) -> Vec<u8> {
        EpubRenderer::default().render(doc).unwrap()
    }

    #[test]
    fn mimetype_is_the_first_entry() {
        let entries = unzip(&render_doc(&doc_with(vec![])));
        assert_eq!(entries[0].0, "mimetype", "第一个条目必须是 mimetype");
    }

    #[test]
    fn mimetype_is_stored_uncompressed() {
        let entries = unzip(&render_doc(&doc_with(vec![])));
        assert!(entries[0].1, "mimetype 必须无压缩（Stored）");
    }

    #[test]
    fn mimetype_content_is_exact_without_newline() {
        let entries = unzip(&render_doc(&doc_with(vec![])));
        assert_eq!(entries[0].2, "application/epub+zip");
        assert!(!entries[0].2.ends_with('\n'), "mimetype 不能带换行");
        assert_eq!(entries[0].2.len(), MIMETYPE_CONTENT.len());
    }

    #[test]
    fn mimetype_is_the_only_stored_entry() {
        // 其它条目压缩存放：EPUB 体积才有意义
        let entries = unzip(&render_doc(&doc_with(vec![])));
        let stored: Vec<&str> = entries
            .iter()
            .filter(|(name, stored, _)| *stored && name != "mimetype")
            .map(|(name, _, _)| name.as_str())
            .collect();
        assert!(stored.is_empty(), "这些条目不该是无压缩的：{stored:?}");
    }

    #[test]
    fn produces_all_required_epub_parts() {
        let parts = parts_map(&render_doc(&doc_with(vec![])));
        for name in [
            "mimetype",
            "META-INF/container.xml",
            "OEBPS/content.opf",
            "OEBPS/nav.xhtml",
            "OEBPS/style.css",
            "OEBPS/chapter-0001.xhtml",
        ] {
            assert!(parts.contains_key(name), "缺少 {name}，实际有 {:?}", parts.keys());
        }
    }

    #[test]
    fn container_points_at_the_opf() {
        let parts = parts_map(&render_doc(&doc_with(vec![])));
        let container = &parts["META-INF/container.xml"];
        assert!(container.contains("full-path=\"OEBPS/content.opf\""), "{container}");
        assert!(
            container.contains("application/oebps-package+xml"),
            "{container}"
        );
    }

    #[test]
    fn opf_declares_epub3_package_and_metadata() {
        let parts = parts_map(&render_doc(&doc_with(vec![])));
        let opf = &parts["OEBPS/content.opf"];
        assert!(opf.contains("version=\"3.0\""), "{opf}");
        assert!(opf.contains("<dc:title>测试书</dc:title>"), "{opf}");
        assert!(opf.contains("<dc:language>zh</dc:language>"), "{opf}");
        assert!(opf.contains("<dc:creator id=\"creator\">作者</dc:creator>"), "{opf}");
        assert!(opf.contains("property=\"dcterms:modified\""), "EPUB3 必填项：{opf}");
    }

    #[test]
    fn opf_contains_a_stable_uuid_identifier() {
        let doc = doc_with(vec![]);
        let first = parts_map(&render_doc(&doc))["OEBPS/content.opf"].clone();
        let second = parts_map(&render_doc(&doc))["OEBPS/content.opf"].clone();
        // 同一本书两次导出，UUID 必须一致，否则阅读器会当成两本书
        assert_eq!(first, second);
        assert!(first.contains("urn:uuid:"), "{first}");
        assert!(first.contains("unique-identifier=\"pub-id\""), "{first}");
    }

    #[test]
    fn identifier_option_overrides_derived_uuid() {
        let doc = doc_with(vec![]);
        let renderer = EpubRenderer::new(EpubOptions {
            identifier: Some("urn:isbn:9787000000000".into()),
            ..Default::default()
        });
        let parts = parts_map(&renderer.render(&doc).unwrap());
        assert!(parts["OEBPS/content.opf"].contains("urn:isbn:9787000000000"));
    }

    #[test]
    fn language_is_configurable() {
        let doc = doc_with(vec![]);
        let renderer = EpubRenderer::new(EpubOptions {
            language: "en".into(),
            ..Default::default()
        });
        let parts = parts_map(&renderer.render(&doc).unwrap());
        assert!(parts["OEBPS/content.opf"].contains("<dc:language>en</dc:language>"));
    }

    #[test]
    fn manifest_and_spine_cover_every_chapter() {
        let vid = VolumeId::new();
        let mut doc = Document::new(BookMeta::new("书", "作者"));
        doc.book.id = Some(BookId::new());
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "卷".into(),
        });
        for title in ["第一章", "第二章", "第三章"] {
            doc.chapters.push(ChapterContent::new(
                ChapterId::new(),
                vid.clone(),
                title,
                vec![],
            ));
        }
        let bytes = render_doc(&doc);
        let parts = parts_map(&bytes);
        let opf = &parts["OEBPS/content.opf"];
        for index in 0..3 {
            assert!(opf.contains(&format!("id=\"c{index}\"")), "{opf}");
            assert!(opf.contains(&format!("idref=\"c{index}\"")), "{opf}");
        }
        // 每章一个文件
        for index in 1..=3 {
            let name = format!("OEBPS/chapter-{index:04}.xhtml");
            assert!(parts.contains_key(&name), "缺少 {name}");
        }
    }

    #[test]
    fn nav_lists_all_chapters_and_volumes() {
        let parts = parts_map(&render_doc(&doc_with(vec![])));
        let nav = &parts["OEBPS/nav.xhtml"];
        assert!(nav.contains("epub:type=\"toc\""), "{nav}");
        assert!(nav.contains(">第一章</a>"), "{nav}");
        assert!(nav.contains("第一卷"), "{nav}");
        assert!(nav.contains("href=\"chapter-0001.xhtml\""), "{nav}");
    }

    #[test]
    fn nav_is_xhtml_with_epub_namespace() {
        let parts = parts_map(&render_doc(&doc_with(vec![])));
        let nav = &parts["OEBPS/nav.xhtml"];
        assert!(nav.contains("<!DOCTYPE html>"), "{nav}");
        assert!(nav.contains("http://www.w3.org/1999/xhtml"), "{nav}");
        assert!(nav.ends_with("</html>"), "{nav}");
    }

    #[test]
    fn chapter_xhtml_contains_escaped_body_text() {
        let parts = parts_map(&render_doc(&doc_with(vec![Block::Paragraph(vec![
            Inline::text("正文内容"),
        ])])));
        let chapter = &parts["OEBPS/chapter-0001.xhtml"];
        assert!(chapter.contains("正文内容"), "{chapter}");
        assert!(chapter.contains("<h1 class=\"chapter-title\">第一章</h1>"), "{chapter}");
    }

    #[test]
    fn script_tag_is_escaped_in_chapter() {
        let parts = parts_map(&render_doc(&doc_with(vec![Block::Paragraph(vec![
            Inline::text("<script>alert(1)</script>"),
        ])])));
        let chapter = &parts["OEBPS/chapter-0001.xhtml"];
        assert!(!chapter.contains("<script>alert"), "{chapter}");
        assert!(chapter.contains("&lt;script&gt;"), "{chapter}");
    }

    #[test]
    fn xhtml_uses_self_closing_void_elements() {
        // XHTML 里 <hr> 会让 XML 解析失败，必须是 <hr/>
        let parts = parts_map(&render_doc(&doc_with(vec![Block::Hr])));
        let chapter = &parts["OEBPS/chapter-0001.xhtml"];
        assert!(chapter.contains("<hr/>"), "{chapter}");
        assert!(!chapter.contains("<hr>"), "{chapter}");
    }

    #[test]
    fn images_are_self_closing() {
        let parts = parts_map(&render_doc(&doc_with(vec![Block::Paragraph(vec![
            Inline::Image {
                url: "a.png".into(),
                alt: "图".into(),
            },
        ])])));
        let chapter = &parts["OEBPS/chapter-0001.xhtml"];
        assert!(chapter.contains("<img src=\"a.png\" alt=\"图\"/>"), "{chapter}");
    }

    #[test]
    fn javascript_url_is_neutralized() {
        let parts = parts_map(&render_doc(&doc_with(vec![Block::Paragraph(vec![
            Inline::Link {
                url: "javascript:alert(1)".into(),
                text: vec![Inline::text("点我")],
            },
        ])])));
        let chapter = &parts["OEBPS/chapter-0001.xhtml"];
        assert!(!chapter.contains("javascript:"), "{chapter}");
        assert!(chapter.contains("点我"), "{chapter}");
    }

    #[test]
    fn style_css_is_embedded_and_relative() {
        let parts = parts_map(&render_doc(&doc_with(vec![])));
        let css = &parts["OEBPS/style.css"];
        assert!(css.contains("line-height: 1.8"), "{css}");
        // 零外链：CSS 里不能引用网络资源
        assert!(!css.contains("http"), "{css}");
        // 样式表通过相对路径被引用
        let chapter = &parts["OEBPS/chapter-0001.xhtml"];
        assert!(chapter.contains("href=\"style.css\""), "{chapter}");
    }

    #[test]
    fn blocks_are_rendered_with_semantic_xhtml() {
        let parts = parts_map(&render_doc(&doc_with(vec![
            Block::Quote(vec![Block::Paragraph(vec![Inline::text("引用")])]),
            Block::List {
                ordered: true,
                start: 1,
                items: vec![vec![Block::Paragraph(vec![Inline::text("一")])]],
            },
            Block::Code {
                lang: "rust".into(),
                text: "let a = 1;".into(),
            },
            Block::Paragraph(vec![Inline::Strong(vec![Inline::text("粗")])]),
        ])));
        let chapter = &parts["OEBPS/chapter-0001.xhtml"];
        assert!(chapter.contains("<blockquote>"), "{chapter}");
        assert!(chapter.contains("<ol>"), "{chapter}");
        assert!(chapter.contains("<pre><code>let a = 1;</code></pre>"), "{chapter}");
        assert!(chapter.contains("<strong>粗</strong>"), "{chapter}");
    }

    #[test]
    fn only_first_chapter_skips_the_page_break() {
        let vid = VolumeId::new();
        let mut doc = Document::new(BookMeta::new("书", "作者"));
        doc.book.id = Some(BookId::new());
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "卷".into(),
        });
        for title in ["第一章", "第二章"] {
            doc.chapters.push(ChapterContent::new(
                ChapterId::new(),
                vid.clone(),
                title,
                vec![],
            ));
        }
        let parts = parts_map(&render_doc(&doc));
        let first = &parts["OEBPS/chapter-0001.xhtml"];
        let second = &parts["OEBPS/chapter-0002.xhtml"];
        assert!(!first.contains("page-break-before"), "{first}");
        assert!(second.contains("page-break-before"), "{second}");
    }

    #[test]
    fn chinese_text_round_trips_through_zip() {
        let parts = parts_map(&render_doc(&doc_with(vec![Block::Paragraph(vec![
            Inline::text("「天地玄黄，宇宙洪荒。」"),
        ])])));
        assert!(parts["OEBPS/chapter-0001.xhtml"].contains("「天地玄黄，宇宙洪荒。」"));
    }

    #[test]
    fn empty_document_still_produces_valid_epub() {
        let mut doc = Document::new(BookMeta::new("空书", "作者"));
        doc.book.id = Some(BookId::new());
        let bytes = render_doc(&doc);
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        let entries = unzip(&bytes);
        assert_eq!(entries[0].0, "mimetype");
        let parts: HashMap<String, String> = entries
            .into_iter()
            .map(|(n, _, c)| (n, c))
            .collect();
        assert!(parts.contains_key("OEBPS/content.opf"));
    }

    #[test]
    fn derived_uuid_without_book_id_is_still_stable_and_wellformed() {
        let doc = Document::new(BookMeta::new("无 ID 的书", "作者"));
        let renderer = EpubRenderer::default();
        let a = renderer.identifier(&doc);
        let b = renderer.identifier(&doc);
        assert_eq!(a, b, "没有书 ID 时也要保持稳定");
        assert!(a.starts_with("urn:uuid:"), "{a}");
        // 形态检查：8-4-4-4-12
        let body = a.trim_start_matches("urn:uuid:");
        let groups: Vec<usize> = body.split('-').map(|s| s.len()).collect();
        assert_eq!(groups, vec![8, 4, 4, 4, 12], "{a}");
    }

    #[test]
    fn chapter_file_names_are_index_based_and_safe() {
        assert_eq!(chapter_file_name(0, "第一章"), "chapter-0001.xhtml");
        assert_eq!(chapter_file_name(41, "任意标题"), "chapter-0042.xhtml");
        // 不该混入标题里的特殊字符
        let name = chapter_file_name(0, "带/斜杠与\"引号\"的标题");
        assert!(!name.contains('/'), "{name}");
        assert!(!name.contains('"'), "{name}");
    }
}
