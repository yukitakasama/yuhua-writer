//! HTML 渲染器 —— 网页预览与打印。
//!
//! 计划书 9.4：`pulldown-cmark` → 正文 HTML + 内置模板 + 排版 CSS。
//!
//! ## 安全：所有文本必须转义
//!
//! 正文里出现 `<script>` 时，如果直接拼进 HTML，产出的就是一个**可执行的**
//! 文件。用户会把它发给自己、发给编辑，甚至挂到网上 —— 一个写作软件的导出
//! 功能不该成为注入通道。所以这里**手写转义**而不是复用 IR 里的 `flatten`：
//! 转义是渲染器的责任，IR 里的文字始终是「事实」。
//!
//! 属性值（链接 target、图片 alt）走同一套转义，并且额外做了 URL 协议白名单
//! 检查 —— `javascript:` 伪协议是另一条常见的注入路径。
//!
//! ## 为什么 CSS 内联而不是外链
//!
//! 计划书要求「零外链」：单文件 HTML 必须能离线打开、能被编辑直接双击查看。
//! 因此模板、CSS 全部内联，字体只用系统字体名（不引入字体文件）。

use std::fmt::Write as _;

use crate::error::Result;
use crate::ir::{Block, Document, Inline};
use crate::render::{ExportFormat, Renderer};

/// HTML 渲染选项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HtmlOptions {
    /// 是否输出 `<!DOCTYPE html>` 与 `<html>`/`<head>` 完整文档。
    ///
    /// 关掉时只产出片段，供 Tauri 的打印视图内嵌使用（T7.10 的 PDF 前置步骤）。
    pub full_document: bool,
    /// 正文最大宽度。默认 720px —— 中文长文的舒适行宽在 30~40 字之间，
    /// 720px 配 17px 字号大致就是这段区间。
    pub max_width_px: u32,
    /// 每章是否用 `<section class="chapter">` 包裹（便于打印分页与锚点跳转）。
    pub section_per_chapter: bool,
}

impl Default for HtmlOptions {
    fn default() -> Self {
        Self {
            full_document: true,
            max_width_px: 720,
            section_per_chapter: true,
        }
    }
}

/// HTML 渲染器。
#[derive(Debug, Clone, Default)]
pub struct HtmlRenderer {
    /// 选项。
    pub options: HtmlOptions,
}

impl HtmlRenderer {
    /// 用指定选项构造。
    pub fn new(options: HtmlOptions) -> Self {
        Self { options }
    }

    /// 渲染正文（不含文档骨架）。
    fn render_body(&self, document: &Document) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            "<header class=\"book\"><h1 class=\"book-title\">{}</h1>",
            escape_html(&document.book.title)
        );
        if !document.book.author.trim().is_empty() {
            let _ = writeln!(
                out,
                "<p class=\"book-author\">{}</p>",
                escape_html(document.book.author_or_anonymous())
            );
        }
        out.push_str("</header>\n");

        let mut current_volume: Option<&str> = None;
        for chapter in document.iter_chapters() {
            let volume_title = document.volume_title(&chapter.volume_id);
            if volume_title != current_volume {
                if let Some(title) = volume_title {
                    let _ = writeln!(
                        out,
                        "<section class=\"volume\"><h2 class=\"volume-title\">{}</h2></section>",
                        escape_html(title)
                    );
                    current_volume = volume_title;
                }
            }
            if self.options.section_per_chapter {
                let _ = writeln!(
                    out,
                    "<section class=\"chapter\" id=\"{}\" data-chapter=\"{}\" data-volume=\"{}\" data-title=\"{}\" data-ends-after-pagebreak=\"{}\">",
                    escape_html(&slugify(&chapter.title)),
                    escape_html(&chapter.title),
                    escape_html(&chapter.volume_id.to_string()),
                    escape_html(&chapter.title),
                    "",
                );
            }
            let _ = writeln!(
                out,
                "<h3 class=\"chapter-title\">{}</h3>",
                escape_html(&chapter.title)
            );
            let mut buffer = String::new();
            self.render_blocks(&chapter.blocks, &mut buffer, 0);
            out.push_str(&buffer);
            if self.options.section_per_chapter {
                out.push_str("</section>\n");
            }
        }
        out
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
                // 章标题用 h3，正文一级标题顺推到 h4，避免出现双 h1
                let level = (*level as usize + 3).clamp(1, 6);
                // 每种级别的标题都生成锚点 id，便于 nav 与目录跳转
                let _ = writeln!(
                    out,
                    "<h{level} id=\"{}\" class=\"heading heading-{level}\">{}</h{level}>",
                    escape_html(&slugify(text)),
                    escape_html(text)
                );
            }
            Block::Quote(children) => {
                out.push_str("<blockquote>\n");
                let mut inner = String::new();
                self.render_blocks(children, &mut inner, depth);
                out.push_str(&inner);
                out.push_str("</blockquote>\n");
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                let tag = if *ordered { "ol" } else { "ul" };
                if *ordered && *start != 1 {
                    let _ = writeln!(out, "<{tag} start=\"{start}\">");
                } else {
                    let _ = writeln!(out, "<{tag}>");
                }
                for item in items {
                    out.push_str("<li>");
                    // 单一段落的列表项不包 <p>，与 CommonMark 的「紧凑列表」一致
                    if item.len() == 1 {
                        if let Block::Paragraph(inlines) = &item[0] {
                            let text = self.render_inlines(inlines);
                            out.push_str(&text);
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
                    out.push_str("</li>\n");
                }
                let _ = writeln!(out, "</{tag}>");
            }
            Block::Code { lang, text } => {
                if lang.is_empty() {
                    out.push_str("<pre><code>");
                } else {
                    let _ = write!(out, "<pre><code class=\"language-{}\"", escape_html(lang));
                    out.push('>');
                }
                out.push_str(&escape_html(text));
                out.push_str("</code></pre>\n");
            }
            Block::Hr => out.push_str("<hr>\n"),
            Block::PageBreak => {
                // 用带样式的空 div 而不是 <hr>：打印时 `page-break-after`
                // 需要一个块级元素承载。
                out.push_str("<div class=\"page-break\"></div>\n");
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
                        let _ = write!(
                            out,
                            "<a href=\"{}\" rel=\"noopener noreferrer\">{label}</a>",
                            escape_html(url)
                        );
                    } else {
                        // 不安全的协议只保留文字，不让它变成可点击的链接
                        out.push_str(&label);
                    }
                }
                Inline::Image { url, alt } => {
                    if is_safe_url(url) {
                        let _ = write!(
                            out,
                            "<img src=\"{}\" alt=\"{}\" loading=\"lazy\">",
                            escape_html(url),
                            escape_html(alt)
                        );
                    } else {
                        // 不安全或无法解析的图片地址：降级成替代文本，
                        // 至少让读者知道这里原本有图。
                        let _ = write!(out, "<span class=\"image-fallback\">{}</span>", escape_html(alt));
                    }
                }
            }
        }
        out
    }

    /// 内置排版 CSS。
    ///
    /// 用 CSS 自定义属性把「正文宽度」参数化，这样模板字符串只需要替换一个值。
    fn stylesheet(&self) -> String {
        let width = self.options.max_width_px;
        format!(
            r#":root {{
  --content-width: {width}px;
  --ink: #1f2328;
  --ink-soft: #57606a;
  --rule: #d8dee4;
  --accent: #8a5a2b;
  --paper: #fdfdfb;
}}
* {{ box-sizing: border-box; }}
html {{ -webkit-text-size-adjust: 100%; }}
body {{
  margin: 0;
  padding: 48px 24px 96px;
  background: var(--paper);
  color: var(--ink);
  font-family: "Songti SC", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif;
  font-size: 17px;
  line-height: 1.8;
  text-align: justify;
  text-justify: inter-ideograph;
  word-wrap: break-word;
  overflow-wrap: break-word;
}}
main {{ max-width: var(--content-width); margin: 0 auto; }}
header.book {{ text-align: center; margin-bottom: 56px; }}
h1.book-title {{
  font-size: 2em;
  letter-spacing: 0.06em;
  margin: 0 0 12px;
  font-weight: 600;
}}
p.book-author {{ color: var(--ink-soft); margin: 0; letter-spacing: 0.1em; }}
section.volume {{ margin: 64px 0 32px; text-align: center; }}
h2.volume-title {{
  display: inline-block;
  font-size: 1.4em;
  font-weight: 600;
  letter-spacing: 0.14em;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--accent);
}}
section.chapter {{ margin-bottom: 56px; }}
h3.chapter-title {{
  font-size: 1.35em;
  font-weight: 600;
  letter-spacing: 0.08em;
  margin: 0 0 28px;
}}
h4, h5, h6 {{ line-height: 1.5; margin: 32px 0 12px; font-weight: 600; }}
p {{ margin: 0 0 1.1em; text-indent: 2em; }}
blockquote {{
  margin: 1.4em 0;
  padding: 0.2em 0 0.2em 1.2em;
  border-left: 3px solid var(--rule);
  color: var(--ink-soft);
  font-style: italic;
}}
blockquote p:last-child {{ margin-bottom: 0; }}
ul, ol {{ margin: 0 0 1.1em; padding-left: 2em; }}
li {{ margin: 0.35em 0; }}
li > p {{ text-indent: 0; margin-bottom: 0.4em; }}
code {{
  font-family: "Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace;
  font-size: 0.9em;
  background: #f2f3f5;
  padding: 0.15em 0.35em;
  border-radius: 3px;
}}
pre {{
  background: #f6f7f9;
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 14px 16px;
  overflow-x: auto;
  line-height: 1.6;
}}
pre code {{ background: none; padding: 0; font-size: 0.88em; }}
hr {{ border: 0; border-top: 1px solid var(--rule); margin: 2.4em 0; }}
img {{ max-width: 100%; height: auto; display: block; margin: 1.6em auto; }}
a {{ color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(138, 90, 43, 0.35); }}
a:hover {{ border-bottom-color: var(--accent); }}
div.page-break {{ page-break-after: always; break-after: page; height: 0; }}
@media (max-width: 640px) {{
  body {{ padding: 28px 16px 64px; font-size: 16px; }}
  h1.book-title {{ font-size: 1.6em; }}
}}
@media print {{
  body {{ background: #fff; padding: 0; font-size: 11pt; }}
  main {{ max-width: none; }}
  section.chapter {{ page-break-before: always; break-before: page; }}
  section.chapter:first-of-type {{ page-break-before: avoid; break-before: auto; }}
  a {{ color: inherit; border-bottom: none; }}
}}"#
        )
    }
}

impl<'a> Renderer<'a> for HtmlRenderer {
    fn format(&self) -> ExportFormat {
        ExportFormat::Html
    }

    fn render(&self, document: &'a Document) -> Result<Vec<u8>> {
        let body = self.render_body(document);
        if !self.options.full_document {
            return Ok(body.into_bytes());
        }
        let mut out = String::new();
        out.push_str("<!DOCTYPE html>\n");
        let _ = writeln!(
            out,
            "<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">"
        );
        let _ = writeln!(
            out,
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        );
        let _ = writeln!(out, "<title>{}</title>", escape_html(&document.book.title));
        let _ = writeln!(
            out,
            "<meta name=\"author\" content=\"{}\">",
            escape_html(document.book.author_or_anonymous())
        );
        if !document.book.description.trim().is_empty() {
            let _ = writeln!(
                out,
                "<meta name=\"description\" content=\"{}\">",
                escape_html(&document.book.description)
            );
        }
        let _ = writeln!(out, "<style>\n{}\n</style>\n</head>\n<body>", self.stylesheet());
        out.push_str("<main>\n");
        out.push_str(&body);
        out.push_str("</main>\n</body>\n</html>\n");
        Ok(out.into_bytes())
    }
}

/// HTML 文本转义。
///
/// 转义 `& < > " '` 五个字符。`'` 也转是因为属性值可能用单引号包裹，
/// 少转一个就多一条注入路径。
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// 判断 URL 是否可以安全地放进 `href` / `src`。
///
/// 拦掉 `javascript:` / `data:`（非图片）这类伪协议。允许的数据：
/// - 相对路径（章节里的图片大多是相对工作区的路径）
/// - `http` / `https` / `mailto` / `tel`
/// - `data:image/...`（内嵌图片）
pub fn is_safe_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return false;
    }
    // 相对路径没有协议部分，直接放行
    let Some((scheme, _)) = trimmed.split_once(':') else {
        return true;
    };
    // 冒号出现在第一个斜杠之后，说明不是协议（例如 "a/b:c"）
    if let Some(slash) = trimmed.find('/') {
        if slash < trimmed.find(':').unwrap_or(usize::MAX) {
            return true;
        }
    }
    let scheme = scheme.to_ascii_lowercase();
    match scheme.as_str() {
        "http" | "https" | "mailto" | "tel" => true,
        "data" => trimmed
            .to_ascii_lowercase()
            .starts_with("data:image/"),
        _ => false,
    }
}

/// 由标题生成锚点 id。
///
/// 保留中日韩文字（它们本身就是合法且可读的锚点），
/// 其余字符折叠成连字符。空标题返回 `section` 前缀，避免生成空白 id。
pub fn slugify(text: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "section".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{BookMeta, ChapterContent, VolumeMeta};
    use yuhua_core::{ChapterId, VolumeId};

    fn doc_with(blocks: Vec<Block>) -> Document {
        let vid = VolumeId::new();
        let mut doc = Document::new(BookMeta::new("测试书", "作者"));
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "第一卷".into(),
        });
        doc.chapters
            .push(ChapterContent::new(ChapterId::new(), vid, "第一章", blocks));
        doc
    }

    fn render_to_string(doc: &Document) -> String {
        let bytes = HtmlRenderer::default().render(doc).unwrap();
        String::from_utf8(bytes).expect("HTML 产物必须是合法 UTF-8")
    }

    #[test]
    fn produces_full_html_document() {
        let text = render_to_string(&doc_with(vec![Block::Paragraph(vec![Inline::text(
            "正文",
        )])]));
        assert!(text.starts_with("<!DOCTYPE html>"), "{text}");
        assert!(text.contains("<html lang=\"zh-CN\">"), "{text}");
        assert!(text.contains("<meta charset=\"utf-8\">"), "{text}");
        assert!(text.trim_end().ends_with("</html>"), "{text}");
    }

    #[test]
    fn fragment_mode_omits_document_skeleton() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text("正文")])]);
        let renderer = HtmlRenderer::new(HtmlOptions {
            full_document: false,
            ..Default::default()
        });
        let text = String::from_utf8(renderer.render(&doc).unwrap()).unwrap();
        assert!(!text.contains("<!DOCTYPE"), "{text}");
        assert!(!text.contains("<style>"), "{text}");
        assert!(text.contains("正文"), "{text}");
    }

    #[test]
    fn script_tag_in_body_is_escaped() {
        // 最重要的安全用例：正文里的 <script> 不能变成真脚本
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text(
            "<script>alert('xss')</script>",
        )])]);
        let text = render_to_string(&doc);
        assert!(
            !text.contains("<script>alert"),
            "未转义的脚本标签出现在产物里：{text}"
        );
        assert!(text.contains("&lt;script&gt;"), "{text}");
        assert!(text.contains("&#39;xss&#39;"), "{text}");
    }

    #[test]
    fn ampersand_and_angle_brackets_are_escaped() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text("a & b < c > d")])]);
        let text = render_to_string(&doc);
        assert!(text.contains("a &amp; b &lt; c &gt; d"), "{text}");
    }

    #[test]
    fn double_quotes_in_text_are_escaped() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text("他说\"你好\"")])]);
        let text = render_to_string(&doc);
        assert!(text.contains("&quot;你好&quot;"), "{text}");
    }

    #[test]
    fn title_and_author_are_escaped_in_head() {
        let vid = VolumeId::new();
        let mut doc = Document::new(BookMeta::new("<危险书名>", "a\"b"));
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "卷".into(),
        });
        doc.chapters
            .push(ChapterContent::new(ChapterId::new(), vid, "章", vec![]));
        let text = render_to_string(&doc);
        assert!(text.contains("&lt;危险书名&gt;"), "{text}");
        assert!(!text.contains("<危险书名>"), "{text}");
    }

    #[test]
    fn javascript_url_in_link_is_neutralized() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::Link {
            url: "javascript:alert(1)".into(),
            text: vec![Inline::text("点我")],
        }])]);
        let text = render_to_string(&doc);
        assert!(!text.contains("href=\"javascript:"), "{text}");
        // 文字仍然保留，用户看得见内容
        assert!(text.contains("点我"), "{text}");
    }

    #[test]
    fn data_image_url_is_allowed_but_other_data_urls_are_not() {
        assert!(is_safe_url("data:image/png;base64,AAAA"));
        assert!(!is_safe_url("data:text/html;base64,AAAA"));
        assert!(is_safe_url("https://a.b/c.png"));
        assert!(is_safe_url("images/a.png"));
        assert!(is_safe_url("./a.png"));
        assert!(is_safe_url("mailto:a@b.c"));
        assert!(!is_safe_url("javascript:void(0)"));
        assert!(!is_safe_url(""));
    }

    #[test]
    fn images_are_rendered_with_escaped_alt() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::Image {
            url: "a.png".into(),
            alt: "图 \"一\"".into(),
        }])]);
        let text = render_to_string(&doc);
        assert!(text.contains("<img src=\"a.png\""), "{text}");
        assert!(text.contains("alt=\"图 &quot;一&quot;\""), "{text}");
        assert!(text.contains("loading=\"lazy\""), "{text}");
    }

    #[test]
    fn unsafe_image_url_degrades_to_alt_text() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::Image {
            url: "javascript:alert(1)".into(),
            alt: "示意图".into(),
        }])]);
        let text = render_to_string(&doc);
        assert!(!text.contains("<img"), "{text}");
        assert!(text.contains("示意图"), "{text}");
    }

    #[test]
    fn emphasis_and_strong_and_code_use_semantic_tags() {
        let doc = doc_with(vec![Block::Paragraph(vec![
            Inline::Strong(vec![Inline::text("粗")]),
            Inline::Emph(vec![Inline::text("斜")]),
            Inline::Code("let a = 1 < 2".into()),
        ])]);
        let text = render_to_string(&doc);
        assert!(text.contains("<strong>粗</strong>"), "{text}");
        assert!(text.contains("<em>斜</em>"), "{text}");
        assert!(text.contains("<code>let a = 1 &lt; 2</code>"), "{text}");
    }

    #[test]
    fn headings_get_anchor_ids() {
        let doc = doc_with(vec![Block::Heading {
            level: 1,
            text: "场景 一".into(),
        }]);
        let text = render_to_string(&doc);
        assert!(text.contains("id=\"场景-一\""), "{text}");
    }

    #[test]
    fn lists_are_rendered_semantically() {
        let doc = doc_with(vec![
            Block::List {
                ordered: false,
                start: 1,
                items: vec![vec![Block::Paragraph(vec![Inline::text("甲")])]],
            },
            Block::List {
                ordered: true,
                start: 3,
                items: vec![vec![Block::Paragraph(vec![Inline::text("三")])]],
            },
        ]);
        let text = render_to_string(&doc);
        assert!(text.contains("<ul>"), "{text}");
        assert!(text.contains("<li>甲</li>"), "{text}");
        assert!(text.contains("<ol start=\"3\">"), "{text}");
        assert!(text.contains("<li>三</li>"), "{text}");
    }

    #[test]
    fn nested_list_produces_nested_tags() {
        let doc = doc_with(vec![Block::List {
            ordered: false,
            start: 1,
            items: vec![
                vec![Block::Paragraph(vec![Inline::text("外")])],
                vec![Block::List {
                    ordered: false,
                    start: 1,
                    items: vec![vec![Block::Paragraph(vec![Inline::text("内")])]],
                }],
            ],
        }]);
        let text = render_to_string(&doc);
        let outer = text.find("<ul>").unwrap();
        let inner = text.rfind("<ul>").unwrap();
        assert!(inner > outer, "内层列表应在之后出现：{text}");
        assert!(text.contains("<li>内</li>"), "{text}");
    }

    #[test]
    fn quote_becomes_blockquote() {
        let doc = doc_with(vec![Block::Quote(vec![Block::Paragraph(vec![
            Inline::text("引用"),
        ])])]);
        let text = render_to_string(&doc);
        assert!(text.contains("<blockquote>"), "{text}");
        assert!(text.contains("<p>引用</p>"), "{text}");
        assert!(text.contains("</blockquote>"), "{text}");
    }

    #[test]
    fn code_block_escapes_content_and_marks_language() {
        let doc = doc_with(vec![Block::Code {
            lang: "html".into(),
            text: "<div>标签</div>".into(),
        }]);
        let text = render_to_string(&doc);
        assert!(text.contains("class=\"language-html\""), "{text}");
        assert!(text.contains("&lt;div&gt;标签&lt;/div&gt;"), "{text}");
        assert!(!text.contains("<div>标签"), "{text}");
    }

    #[test]
    fn horizontal_rule_and_page_break_are_rendered() {
        let doc = doc_with(vec![Block::Hr, Block::PageBreak]);
        let text = render_to_string(&doc);
        assert!(text.contains("<hr>"), "{text}");
        assert!(text.contains("class=\"page-break\""), "{text}");
    }

    #[test]
    fn stylesheet_contains_required_typography_rules() {
        let text = render_to_string(&doc_with(vec![]));
        // 计划书要求：正文最大宽度 720px、行高 1.8
        assert!(text.contains("--content-width: 720px"), "{text}");
        assert!(text.contains("line-height: 1.8"), "{text}");
        assert!(text.contains("@media (max-width: 640px)"), "应含响应式断点：{text}");
        assert!(text.contains("@media print"), "应含打印样式：{text}");
    }

    #[test]
    fn max_width_option_is_reflected_in_css() {
        let doc = doc_with(vec![]);
        let renderer = HtmlRenderer::new(HtmlOptions {
            max_width_px: 900,
            ..Default::default()
        });
        let text = String::from_utf8(renderer.render(&doc).unwrap()).unwrap();
        assert!(text.contains("--content-width: 900px"), "{text}");
        assert!(!text.contains("720px"), "{text}");
    }

    #[test]
    fn no_external_references_in_output() {
        // 零外链：产物里不能有 http(s) 资源引用
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text("正文")])]);
        let text = render_to_string(&doc);
        assert!(!text.contains("<link "), "不该有外链样式：{text}");
        assert!(!text.contains("src=\"http"), "{text}");
        assert!(!text.contains("cdn."), "{text}");
    }

    #[test]
    fn chapter_section_carries_metadata_attributes() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text("正文")])]);
        let text = render_to_string(&doc);
        assert!(text.contains("class=\"chapter\""), "{text}");
        assert!(text.contains("data-chapter=\"第一章\""), "{text}");
    }

    #[test]
    fn volume_title_is_rendered_once() {
        let text = render_to_string(&doc_with(vec![]));
        // 只看 <body> 之后的内容：样式表里本来就有 .volume-title 规则，
        // 拿整份文档数会因为 CSS 而误报。
        let body = text.split("<body>").nth(1).unwrap_or(&text);
        assert_eq!(
            body.matches("class=\"volume-title\"").count(),
            1,
            "{body}"
        );
    }

    #[test]
    fn chinese_text_is_preserved_verbatim() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text(
            "「天地玄黄，宇宙洪荒。」",
        )])]);
        let text = render_to_string(&doc);
        assert!(text.contains("「天地玄黄，宇宙洪荒。」"), "{text}");
        assert!(!text.contains('\u{fffd}'));
    }

    #[test]
    fn slugify_handles_chinese_and_spaces() {
        assert_eq!(slugify("第一章 出发"), "第一章-出发");
        assert_eq!(slugify("   "), "section");
        assert_eq!(slugify("a/b/c"), "a-b-c");
        assert_eq!(slugify("!!!:::"), "section");
        assert_eq!(slugify("混合 Mix 123"), "混合-Mix-123");
    }

    #[test]
    fn empty_document_still_produces_valid_html() {
        let doc = Document::new(BookMeta::new("空书", "作者"));
        let text = render_to_string(&doc);
        assert!(text.contains("<!DOCTYPE html>"), "{text}");
        assert!(text.contains("空书"), "{text}");
        assert!(text.contains("</html>"), "{text}");
    }
}
