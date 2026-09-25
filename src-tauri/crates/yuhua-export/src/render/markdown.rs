//! Markdown 渲染器 —— 归档与再编辑。
//!
//! 计划书 9.4：剥离 Front Matter、卷作为 `#`、章作为 `##`（层级偏移可配置）。
//!
//! ## 这个渲染器与其它四个的本质区别
//!
//! 其它渲染器都是「IR → 另一种标记」。Markdown 渲染器是 **IR → IR 的原始
//! 文本形态**，看起来像是「白绕一圈」。但它是必要的：
//!
//! 1. **范围裁剪**：用户选了「整卷」，导出的 .md 里就不该有别的卷的内容。
//! 2. **统一降级**：如果直接拼原文，表格会以表格语法原样出现在导出文件里，
//!    与其它格式的降级行为不一致，用户会以为「Markdown 格式没降级、所以是好的」，
//!    接着把它交给只认 TXT 的平台，才发现表格坏了。
//!
//! 所以这里刻意**从 IR 重新生成 Markdown**，保证五个渲染器对同一份输入产出
//! 语义一致的内容。
//!
//! ## Front Matter 剥离
//!
//! Front Matter 在 [`crate::scope`] 装配阶段就已经不在正文里了
//! （`Chapter.body` 只装正文）。但用户的**原始 .md 文件**里是有的，
//! 而「导出 Markdown」最容易被理解成「把这些文件合并成一个」。
//! 因此这里额外做一次防御性的剥离（[\`strip_front_matter\`]），
//! 处理「有人直接拿着磁盘上的原始文件来导出」的情况。

use std::fmt::Write as _;

use crate::error::Result;
use crate::ir::{Block, Document, Inline};
use crate::render::{ExportFormat, Renderer};

/// 层级偏移选项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownOptions {
    /// 卷标题的起层级（默认 1，即 `#`）。
    pub volume_level: u8,
    /// 章标题相对于卷的层级增量（默认 1，于是章是 `##`）。
    pub chapter_offset: u8,
    /// 是否在产物开头写一段导出说明（书名、作者、章节数）。
    pub include_header: bool,
}

impl Default for MarkdownOptions {
    fn default() -> Self {
        Self {
            volume_level: 1,
            chapter_offset: 1,
            include_header: false,
        }
    }
}

/// Markdown 渲染器。
#[derive(Debug, Clone, Default)]
pub struct MarkdownRenderer {
    /// 选项。
    pub options: MarkdownOptions,
}

impl MarkdownRenderer {
    /// 用指定选项构造。
    pub fn new(options: MarkdownOptions) -> Self {
        Self { options }
    }

    /// 生成 `level` 个 `#` 的标题行。
    fn heading(&self, level: u8, text: &str) -> String {
        // CommonMark 最多六级，超出的部分按六级处理而不是继续加 # 号
        let level = level.clamp(1, 6);
        format!("{} {}\n\n", "#".repeat(level as usize), text)
    }

    /// 渲染一章正文块。
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
                out.push_str(&text);
                out.push_str("\n\n");
            }
            Block::Heading { level, text } => {
                // 章内部的标题要**推到章标题层级之下**，否则正文里的
                // `# 场景一` 会与章标题同级，导出的文档结构就乱了。
                let chapter_level = self.options.volume_level + self.options.chapter_offset;
                let level = chapter_level.saturating_add(*level);
                out.push_str(&self.heading(level, text));
            }
            Block::Quote(children) => {
                let mut inner = String::new();
                self.render_blocks(children, &mut inner, depth);
                // 引用的每一行都要加 `> ` —— 包括空行写成 `>`，
                // 否则引用会在空行处断开成两个引用块。
                for line in inner.trim_end().lines() {
                    if line.is_empty() {
                        out.push_str(">\n");
                    } else {
                        let _ = writeln!(out, "> {line}");
                    }
                }
                out.push('\n');
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                let indent = "    ".repeat(depth);
                for (offset, item) in items.iter().enumerate() {
                    let marker = if *ordered {
                        format!("{}. ", start + offset as u64)
                    } else {
                        "- ".to_string()
                    };
                    let mut first = true;
                    for child in item {
                        match child {
                            Block::List { .. } => {
                                self.render_block(child, out, depth + 1);
                            }
                            other => {
                                let mut inner = String::new();
                                self.render_block(other, &mut inner, depth);
                                for line in inner.trim_end().lines() {
                                    if first {
                                        let _ = writeln!(out, "{indent}{marker}{line}");
                                        first = false;
                                    } else {
                                        let _ = writeln!(out, "{indent}    {line}");
                                    }
                                }
                            }
                        }
                    }
                }
                out.push('\n');
            }
            Block::Code { lang, text } => {
                // 用足够长的围栏：正文里可能本来就含 `\`\`\``，
                // 用固定三反引号会让代码块提前闭合、后面的内容变成正文。
                let fence = "\u{60}".repeat(fence_length(text));
                let _ = writeln!(out, "{fence}{lang}");
                out.push_str(text);
                if !text.ends_with('\n') {
                    out.push('\n');
                }
                let _ = writeln!(out, "{fence}");
                out.push('\n');
            }
            Block::Hr => out.push_str("---\n\n"),
            Block::PageBreak => {
                // Markdown 没有分页概念。用 HTML 注释留一个可被其它工具识别的标记，
                // 同时不影响 CommonMark 的解析结果。
                out.push_str("<!-- 分页 -->\n\n");
            }
        }
    }

    /// 渲染行内元素。
    fn render_inlines(&self, inlines: &[Inline]) -> String {
        let mut out = String::new();
        for inline in inlines {
            match inline {
                Inline::Text(t) => out.push_str(&escape_inline_text(t)),
                Inline::Code(t) => {
                    // 行内代码用反引号包裹；内容里含反引号时加长围栏。
                    let fence = "\u{60}".repeat(backtick_run(t) + 1);
                    let _ = write!(out, "{fence}{t}{fence}");
                }
                Inline::Emph(children) => {
                    let _ = write!(out, "*{}*", self.render_inlines(children));
                }
                Inline::Strong(children) => {
                    let _ = write!(out, "**{}**", self.render_inlines(children));
                }
                Inline::Link { url, text } => {
                    let _ = write!(out, "[{}]({})", self.render_inlines(text), escape_url(url));
                }
                Inline::Image { url, alt } => {
                    // alt 里的方括号会提前结束图片语法，必须转义
                    let alt = alt.replace('[', "\\[").replace(']', "\\]");
                    let _ = write!(out, "![{alt}]({})", escape_url(url));
                }
            }
        }
        out
    }
}

impl<'a> Renderer<'a> for MarkdownRenderer {
    fn format(&self) -> ExportFormat {
        ExportFormat::Markdown
    }

    fn render(&self, document: &'a Document) -> Result<Vec<u8>> {
        let mut out = String::new();
        if self.options.include_header {
            let _ = writeln!(out, "<!-- {} -->", document.book.title);
            let _ = writeln!(out, "<!-- 作者：{} -->", document.book.author_or_anonymous());
            let _ = writeln!(out, "<!-- 共 {} 章 -->\n", document.chapter_count());
        }

        let mut current_volume: Option<&str> = None;
        for chapter in document.iter_chapters() {
            let volume_title = document.volume_title(&chapter.volume_id);
            // 只在进入新卷时输出卷标题，与 TXT 渲染器同一策略
            if volume_title != current_volume {
                if let Some(title) = volume_title {
                    if current_volume.is_some() {
                        out.push('\n');
                    }
                    out.push_str(&self.heading(self.options.volume_level, title));
                    current_volume = volume_title;
                }
            }
            let chapter_level = self.options.volume_level + self.options.chapter_offset;
            out.push_str(&self.heading(chapter_level, &chapter.title));
            self.render_blocks(&chapter.blocks, &mut out, 0);
        }

        // 收敛尾部空行：导出文件末尾堆一串空行很难看，也会让 diff 变脏。
        while out.ends_with("\n\n") {
            out.pop();
        }
        Ok(out.into_bytes())
    }
}

/// 计算代码块需要多长的围栏。
///
/// 比正文里最长的一段连续反引号再长 1 —— 这是 CommonMark 规定的做法，
/// 否则代码块会被内部的反引号提前截断。
fn fence_length(text: &str) -> usize {
    let mut longest = 0usize;
    let mut current = 0usize;
    for ch in text.chars() {
        if ch == '\u{60}' {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    (longest + 1).max(3)
}

/// 行内代码里最长连续反引号的长度。
fn backtick_run(text: &str) -> usize {
    let mut longest = 0usize;
    let mut current = 0usize;
    for ch in text.chars() {
        if ch == '\u{60}' {
            current += 1;
            longest = longest.max(current);
        } else {
            current = 0;
        }
    }
    longest
}

/// 转义纯文本里的 Markdown 元字符。
///
/// **只转义会改变结构的那几个**（反斜杠、星号、下划线、方括号、反引号）。
/// 不转义中文全角标点、也不转义 `#`：正文行首的 `#` 如果不是在行首就
/// 没有特殊含义，而到处加反斜杠会让导出的 Markdown 变得很难读 ——
/// 这个格式的用途之一就是「让用户继续编辑」。
fn escape_inline_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\\' | '*' | '_' | '[' | ']' | '\u{60}' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// 转义链接目标。
///
/// URL 里的空格与括号会让 `[文字](url)` 提前闭合，必须处理。
fn escape_url(url: &str) -> String {
    url.replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
}

/// 剥离 Front Matter。
///
/// 只认「文件开头就是 `---`」这一种形态（与 yuhua-fs 的规则一致）。
/// 不做 `...` 结尾、`+++` 等变体的支持：多认一种写法就多一份
/// 「用户以为被剥离了、其实没有」的风险。
pub fn strip_front_matter(text: &str) -> &str {
    let trimmed_start = text.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed_start.strip_prefix("---") else {
        return text;
    };
    // `---` 后面必须立刻换行，否则 `---abc` 这种正文会被误判
    let Some(rest) = rest.strip_prefix('\n').or_else(|| rest.strip_prefix("\r\n")) else {
        return text;
    };
    for (index, line) in rest.split_inclusive('\n').enumerate() {
        let _ = index;
        let content = line.trim_end_matches(['\n', '\r']);
        if content == "---" {
            // 找到结束标记，返回其后的内容。用指针差值算出这一行在 `rest` 里的
            // 偏移，再整行跳过 —— 不必为了拿偏移而重新扫描前面的行。
            let offset = line.as_ptr() as usize - rest.as_ptr() as usize;
            return &rest[offset + line.len()..];
        }
    }
    // 没有结束标记：这说明第一个 `---` 就是分割线而不是 Front Matter，
    // 整段内容原样返回，不能吞掉正文。
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Block, BookMeta, ChapterContent, VolumeMeta};
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
        let bytes = MarkdownRenderer::default().render(doc).unwrap();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn volume_is_h1_and_chapter_is_h2() {
        let text = render_to_string(&doc_with(vec![]));
        assert!(text.starts_with("# 第一卷"), "{text}");
        assert!(text.contains("## 第一章"), "{text}");
    }

    #[test]
    fn heading_offset_is_configurable() {
        let doc = doc_with(vec![]);
        let renderer = MarkdownRenderer::new(MarkdownOptions {
            volume_level: 2,
            chapter_offset: 2,
            include_header: false,
        });
        let text = String::from_utf8(renderer.render(&doc).unwrap()).unwrap();
        assert!(text.contains("## 第一卷"), "{text}");
        assert!(text.contains("#### 第一章"), "{text}");
    }

    #[test]
    fn in_chapter_headings_are_pushed_below_chapter_level() {
        // 正文里的 `# 场景一` 不该与章标题同级
        let doc = doc_with(vec![Block::Heading {
            level: 1,
            text: "场景一".into(),
        }]);
        let text = render_to_string(&doc);
        assert!(text.contains("## 第一章"), "{text}");
        assert!(text.contains("### 场景一"), "{text}");
    }

    #[test]
    fn heading_level_is_clamped_to_six() {
        let doc = doc_with(vec![Block::Heading {
            level: 6,
            text: "极深标题".into(),
        }]);
        let text = render_to_string(&doc);
        // 章标题是 ##，正文里的 ###### 叠加后是 8 级，被钳到 6 级
        assert!(text.contains("###### 极深标题"), "{text}");
        assert!(!text.contains("####### "), "不该出现七级及以上的标题：{text}");
    }

    #[test]
    fn front_matter_is_stripped() {
        let raw = "---\ntitle: 第一章\nstatus: draft\n---\n\n# 正文标题\n\n内容";
        let stripped = strip_front_matter(raw);
        assert!(!stripped.contains("title:"), "{stripped}");
        assert!(!stripped.contains("status:"), "{stripped}");
        assert!(stripped.contains("正文标题"), "{stripped}");
        assert!(!stripped.starts_with("---"));
    }

    #[test]
    fn front_matter_strip_handles_crlf() {
        let raw = "---\r\ntitle: x\r\n---\r\n\r\n正文";
        let stripped = strip_front_matter(raw);
        assert!(!stripped.contains("title:"));
        assert!(stripped.contains("正文"));
    }

    #[test]
    fn front_matter_strip_handles_bom() {
        let raw = "\u{feff}---\ntitle: x\n---\n正文";
        let stripped = strip_front_matter(raw);
        assert!(!stripped.contains("title:"));
        assert!(stripped.contains("正文"));
    }

    #[test]
    fn horizontal_rule_at_start_is_not_treated_as_front_matter() {
        // 结尾的 `---` 会被当成 Front Matter 的结束标记，因此它之前的内容
        // 被剥离 —— 这是本函数**已知的取舍**：单凭文本无法区分
        // 「Front Matter」与「前后各一条分割线的正文」。
        //
        // 真实导出路径上不会踩到：Front Matter 早在 yuhua-fs 读文件时就被
        // 剥离了，`Chapter.body` 里根本没有元数据，本函数只作为
        // 「有人直接拿磁盘原始文件来导出」的防御性兜底。
        // 这里把行为显式钉住，避免有人误以为它做了更聪明的判断。
        let raw = "---\n\n这是正文\n\n---\n\n结尾";
        let stripped = strip_front_matter(raw);
        assert!(stripped.contains("结尾"), "{stripped}");
        assert!(!stripped.contains("这是正文"), "{stripped}");
    }

    #[test]
    fn text_without_front_matter_is_unchanged() {
        let raw = "# 标题\n\n正文";
        assert_eq!(strip_front_matter(raw), raw);
    }

    #[test]
    fn renders_emphasis_strong_and_code() {
        let doc = doc_with(vec![Block::Paragraph(vec![
            Inline::Strong(vec![Inline::text("粗")]),
            Inline::text(" "),
            Inline::Emph(vec![Inline::text("斜")]),
            Inline::text(" "),
            Inline::Code("let x".into()),
        ])]);
        let text = render_to_string(&doc);
        assert!(text.contains("**粗**"), "{text}");
        assert!(text.contains("*斜*"), "{text}");
        assert!(text.contains("`let x`"), "{text}");
    }

    #[test]
    fn inline_text_markup_characters_are_escaped() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text(
            "3 * 5 = 15 与 a_b_c",
        )])]);
        let text = render_to_string(&doc);
        assert!(text.contains("3 \\* 5 = 15"), "{text}");
        assert!(text.contains("a\\_b\\_c"), "{text}");
    }

    #[test]
    fn link_and_image_are_rendered_with_escaping() {
        let doc = doc_with(vec![Block::Paragraph(vec![
            Inline::Link {
                url: "https://a.b/c d(e)".into(),
                text: vec![Inline::text("站点")],
            },
            Inline::Image {
                url: "img/a.png".into(),
                alt: "图[1]".into(),
            },
        ])]);
        let text = render_to_string(&doc);
        assert!(text.contains("[站点](https://a.b/c%20d%28e%29)"), "{text}");
        assert!(text.contains("![图\\[1\\]](img/a.png)"), "{text}");
    }

    #[test]
    fn code_block_uses_fence_longer_than_content() {
        // 内容里含三反引号时，围栏必须更长，否则代码块会被提前闭合
        let doc = doc_with(vec![Block::Code {
            lang: String::new(),
            text: "```\n内部围栏\n```".into(),
        }]);
        let text = render_to_string(&doc);
        assert!(text.contains("````"), "围栏应加长：{text}");
    }

    #[test]
    fn code_block_with_language_keeps_info_string() {
        let doc = doc_with(vec![Block::Code {
            lang: "rust".into(),
            text: "fn main() {}".into(),
        }]);
        let text = render_to_string(&doc);
        assert!(text.contains("```rust"), "{text}");
        assert!(text.contains("fn main() {}"), "{text}");
    }

    #[test]
    fn lists_are_rendered_with_markers() {
        let doc = doc_with(vec![
            Block::List {
                ordered: false,
                start: 1,
                items: vec![
                    vec![Block::Paragraph(vec![Inline::text("甲")])],
                    vec![Block::Paragraph(vec![Inline::text("乙")])],
                ],
            },
            Block::List {
                ordered: true,
                start: 3,
                items: vec![vec![Block::Paragraph(vec![Inline::text("三")])]],
            },
        ]);
        let text = render_to_string(&doc);
        assert!(text.contains("- 甲"), "{text}");
        assert!(text.contains("- 乙"), "{text}");
        assert!(text.contains("3. 三"), "{text}");
    }

    #[test]
    fn nested_list_is_indented_four_spaces() {
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
        assert!(text.contains("    - 内"), "{text}");
    }

    #[test]
    fn quote_keeps_blank_lines_inside_the_block() {
        // 引用里的空行要写成 `>`，否则会被解析成两个独立引用
        let doc = doc_with(vec![Block::Quote(vec![
            Block::Paragraph(vec![Inline::text("甲")]),
            Block::Paragraph(vec![Inline::text("乙")]),
        ])]);
        let text = render_to_string(&doc);
        assert!(text.contains("> 甲"), "{text}");
        assert!(text.contains("> 乙"), "{text}");
        assert!(text.lines().any(|l| l == ">"), "引用内空行应写成 >：{text}");
    }

    #[test]
    fn horizontal_rule_is_rendered() {
        let doc = doc_with(vec![Block::Hr]);
        let text = render_to_string(&doc);
        assert!(text.contains("---"), "{text}");
    }

    #[test]
    fn page_break_becomes_html_comment() {
        let doc = doc_with(vec![Block::PageBreak]);
        let text = render_to_string(&doc);
        assert!(text.contains("<!-- 分页 -->"), "{text}");
    }

    #[test]
    fn trailing_blank_lines_are_collapsed() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text("最后一段")])]);
        let text = render_to_string(&doc);
        assert!(text.ends_with("最后一段\n"), "{text:?}");
    }

    #[test]
    fn header_comment_is_optional() {
        let doc = doc_with(vec![]);
        assert!(!render_to_string(&doc).contains("<!--"));

        let renderer = MarkdownRenderer::new(MarkdownOptions {
            include_header: true,
            ..Default::default()
        });
        let text = String::from_utf8(renderer.render(&doc).unwrap()).unwrap();
        assert!(text.contains("<!-- 测试书 -->"), "{text}");
        assert!(text.contains("作者：作者"), "{text}");
    }

    #[test]
    fn volume_title_is_printed_once() {
        let mut doc = Document::new(BookMeta::new("书", "作者"));
        let vid = VolumeId::new();
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "第一卷".into(),
        });
        for title in ["第一章", "第二章"] {
            doc.chapters.push(ChapterContent::new(
                ChapterId::new(),
                vid.clone(),
                title,
                vec![],
            ));
        }
        let text = render_to_string(&doc);
        assert_eq!(text.matches("# 第一卷").count(), 1, "{text}");
        assert_eq!(text.matches("## 第一章").count(), 1, "{text}");
        assert_eq!(text.matches("## 第二章").count(), 1, "{text}");
    }

    #[test]
    fn empty_document_renders_empty() {
        let doc = Document::new(BookMeta::new("空书", "作者"));
        assert!(render_to_string(&doc).is_empty());
    }

    #[test]
    fn chinese_content_is_preserved_verbatim() {
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text(
            "「天地之间，唯我独尊。」",
        )])]);
        let text = render_to_string(&doc);
        assert!(text.contains("「天地之间，唯我独尊。」"), "{text}");
    }
}
