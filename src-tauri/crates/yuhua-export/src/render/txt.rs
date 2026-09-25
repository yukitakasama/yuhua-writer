//! TXT 渲染器 —— 交稿最通用的格式。
//!
//! 计划书 9.4 的要求：逐个章流式写出、可配置换行宽度（默认 0 = 不硬换行）、
//! 首行缩进（默认 2 个全角空格）、可选章间分页符、可配置章节标题格式。
//!
//! ## 为什么这个渲染器值得单独写「流式」
//!
//! TXT 是最可能被用来导出**整套百万字长篇**的格式（网文作者交稿给平台，
//! 平台要的就是一个 txt）。如果实现成「先拼出整本书的 String 再返回」，
//! 100 万字光 UTF-8 文本就是 3 MB，加上中间的格式化副本轻松到十几 MB，
//! 而且这些内存**必须同时在场**。
//!
//! 所以这里把 `render_to_writer` 实现成真正的逐章写出，
//! 峰值内存只有「当前章 + 一行」的量级。

use std::io::Write;

use crate::error::{ExportError, Result};
use crate::ir::{Block, ChapterContent, Document, Inline};
use crate::render::{ExportFormat, Renderer};

/// 首行缩进用的全角空格。
///
/// 中文排版惯例是两个全角空格。用 `\u{3000}` 而不是两个半角空格：
/// 半角空格在中文全角字体下宽度只有半个字，缩进看起来会不到位，
/// 交稿时平台审稿人会直接看出来。
pub const FULL_WIDTH_SPACE: &str = "\u{3000}";

/// TXT 渲染选项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxtOptions {
    /// 硬换行宽度（按字符计）。0 表示不硬换行。
    ///
    /// 默认 0：交稿平台通常自己按显示宽度折行，我们硬插换行反而会
    /// 破坏段落（平台把它当成真正的段落分隔）。
    pub wrap_width: usize,
    /// 每个自然段首行缩进的全角空格数。
    pub indent: usize,
    /// 是否在每章之间插入分页符 `\f`。
    pub page_break_between_chapters: bool,
    /// 章标题的格式模板，`{n}` 是章序号（从 1 开始），`{title}` 是标题。
    pub title_format: String,
    /// 是否输出卷标题。
    pub include_volume_titles: bool,
}

impl Default for TxtOptions {
    fn default() -> Self {
        Self {
            wrap_width: 0,
            indent: 2,
            page_break_between_chapters: false,
            title_format: "{title}".to_string(),
            include_volume_titles: true,
        }
    }
}

/// TXT 渲染器。
#[derive(Debug, Clone, Default)]
pub struct TxtRenderer {
    /// 排版选项。
    pub options: TxtOptions,
}

impl TxtRenderer {
    /// 用指定选项构造。
    pub fn new(options: TxtOptions) -> Self {
        Self { options }
    }

    /// 渲染一章。
    fn render_chapter(
        &self,
        out: &mut dyn Write,
        chapter: &ChapterContent,
        index: usize,
    ) -> Result<()> {
        let title = self.format_title(chapter, index);
        // 章标题行自身不缩进：缩进的标题在交稿里显得很不专业。
        self.write_line(out, &title, false)?;
        self.write_line(out, "", false)?;

        for block in &chapter.blocks {
            self.render_block(out, block, 0)?;
        }
        Ok(())
    }

    /// 套用标题模板。
    fn format_title(&self, chapter: &ChapterContent, index: usize) -> String {
        self.options
            .title_format
            .replace("{n}", &(index + 1).to_string())
            .replace("{title}", &chapter.title)
    }

    /// 渲染一个块。
    fn render_block(&self, out: &mut dyn Write, block: &Block, depth: usize) -> Result<()> {
        match block {
            Block::Paragraph(inlines) => {
                let text = self.render_inlines(inlines);
                // 空段落不产出空行：Markdown 的空行本来就是排版噪音。
                if text.trim().is_empty() {
                    return Ok(());
                }
                for line in text.split('\n') {
                    self.write_line(out, line, true)?;
                }
                self.write_line(out, "", false)?;
            }
            Block::Heading { level, text } => {
                // TXT 里没有「字号」概念，用行首标记来表达层级：
                // 一级标题独立成行，二三级加缩进的 `#` 前缀，四级以下不再加标记。
                let prefix = match level {
                    1 => String::new(),
                    2 => "# ".to_string(),
                    3 => "## ".to_string(),
                    _ => "### ".to_string(),
                };
                self.write_line(out, &format!("{prefix}{text}"), false)?;
                self.write_line(out, "", false)?;
            }
            Block::Quote(children) => {
                // 引用按计划书 9.1 的要求转成 `> ` 前缀
                for child in children {
                    let rendered = Block::flatten_blocks_to_string(std::slice::from_ref(child));
                    for line in rendered.lines() {
                        self.write_line(out, &format!("> {line}"), false)?;
                    }
                }
                self.write_line(out, "", false)?;
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                let indent = "  ".repeat(depth);
                for (offset, item) in items.iter().enumerate() {
                    let marker = if *ordered {
                        format!("{}. ", start + offset as u64)
                    } else {
                        "- ".to_string()
                    };
                    let mut first = true;
                    for child in item {
                        match child {
                            // 列表项里的嵌套列表要按层级渲染，而不是拍平
                            Block::List { .. } => self.render_block(out, child, depth + 1)?,
                            other => {
                                let text = self.render_block_to_string(other);
                                for line in text.trim_end().lines() {
                                    if first {
                                        self.write_line(
                                            out,
                                            &format!("{indent}{marker}{line}"),
                                            false,
                                        )?;
                                        first = false;
                                    } else {
                                        self.write_line(out, &format!("{indent}   {line}"), false)?;
                                    }
                                }
                            }
                        }
                    }
                }
                self.write_line(out, "", false)?;
            }
            Block::Code { text, .. } => {
                for line in text.lines() {
                    self.write_line(out, &format!("    {line}"), false)?;
                }
                self.write_line(out, "", false)?;
            }
            Block::Hr => {
                self.write_line(out, "----------", false)?;
                self.write_line(out, "", false)?;
            }
            Block::PageBreak => {
                out.write_all("\u{0c}\n".as_bytes())
                    .map_err(|e| ExportError::io("<txt>", e))?;
            }
        }
        Ok(())
    }

    /// 把一个块渲染成不带缩进的字符串（列表项内文用）。
    fn render_block_to_string(&self, block: &Block) -> String {
        let mut buf: Vec<u8> = Vec::new();
        // 内层渲染关掉缩进，缩进由列表逻辑统一控制
        let plain = TxtRenderer::new(TxtOptions {
            indent: 0,
            ..self.options.clone()
        });
        let _ = plain.render_block(&mut buf, block, 0);
        String::from_utf8_lossy(&buf).to_string()
    }

    /// 按选项缩进并可选硬换行地写出一行。
    fn write_line(&self, out: &mut dyn Write, text: &str, indent: bool) -> Result<()> {
        let prefix = if indent {
            FULL_WIDTH_SPACE.repeat(self.options.indent)
        } else {
            String::new()
        };
        if self.options.wrap_width == 0 || text.chars().count() <= self.options.wrap_width {
            let line = format!("{prefix}{text}\n");
            out.write_all(line.as_bytes())
                .map_err(|e| ExportError::io("<txt>", e))?;
            return Ok(());
        }
        // 硬换行：续行不缩进，避免出现「缩进 + 缩进」的阶梯。
        for (index, chunk) in wrap_text(text, self.options.wrap_width)
            .into_iter()
            .enumerate()
        {
            let line = if index == 0 {
                format!("{prefix}{chunk}\n")
            } else {
                format!("{chunk}\n")
            };
            out.write_all(line.as_bytes())
                .map_err(|e| ExportError::io("<txt>", e))?;
        }
        Ok(())
    }

    /// 把行内元素渲染成纯文本。
    ///
    /// 粗体 / 斜体在 TXT 里无法表达（计划书 9.1：TXT 的粗斜体「忽略」），
    /// 但**文字必须保留**。链接降级成「文字（URL）」，比只留其一信息更全。
    fn render_inlines(&self, inlines: &[Inline]) -> String {
        let mut out = String::new();
        for inline in inlines {
            match inline {
                Inline::Text(t) => out.push_str(t),
                Inline::Code(t) => out.push_str(t),
                Inline::Emph(children) | Inline::Strong(children) => {
                    out.push_str(&self.render_inlines(children));
                }
                Inline::Link { url, text } => {
                    let label = self.render_inlines(text);
                    out.push_str(&label);
                    // 文字与 URL 相同时不重复输出，否则 `[https://a](https://a)`
                    // 会变成「https://a（https://a）」这种啰嗦样子。
                    if label != *url {
                        out.push('（');
                        out.push_str(url);
                        out.push('）');
                    }
                }
                Inline::Image { alt, .. } => {
                    // 计划书 9.1：TXT 丢弃图片。但不能连占位都没有 ——
                    // 作者需要知道这里原本有张图，排版时才知道漏了什么。
                    out.push_str("［图片");
                    if !alt.is_empty() {
                        out.push('：');
                        out.push_str(alt);
                    }
                    out.push('］');
                }
            }
        }
        out
    }
}

impl<'a> Renderer<'a> for TxtRenderer {
    fn format(&self) -> ExportFormat {
        ExportFormat::Txt
    }

    fn render(&self, document: &'a Document) -> Result<Vec<u8>> {
        let mut buf: Vec<u8> = Vec::new();
        self.render_to_writer(document, &mut buf)?;
        Ok(buf)
    }

    /// 逐章写出，不在内存里拼接整本书。
    fn render_to_writer(&self, document: &'a Document, writer: &mut dyn Write) -> Result<()> {
        let mut index = 0usize;
        let mut last_volume: Option<&str> = None;
        for chapter in document.iter_chapters() {
            // 卷标题只在卷切换时输出一次。用「上一章属于哪个卷」判断，
            // 而不是按卷循环 —— 后者会为了分组而把章节重新遍历一遍。
            let volume_title = document.volume_title(&chapter.volume_id);
            if self.options.include_volume_titles {
                if let Some(title) = volume_title {
                    if last_volume != Some(title) {
                        if last_volume.is_some() {
                            writer
                                .write_all(b"\n")
                                .map_err(|e| ExportError::io("<txt>", e))?;
                        }
                        self.write_line(writer, title, false)?;
                        self.write_line(writer, "", false)?;
                        last_volume = Some(title);
                    }
                }
            }
            self.render_chapter(writer, chapter, index)?;
            index += 1;
            if self.options.page_break_between_chapters && index < document.chapter_count() {
                writer
                    .write_all("\u{0c}\n".as_bytes())
                    .map_err(|e| ExportError::io("<txt>", e))?;
            }
        }
        Ok(())
    }
}

/// 按字符数硬换行。
///
/// 用 `chars()` 而不是 `len()`：中文一个字在 UTF-8 里占 3 字节，
/// 按字节切会把一个汉字劈成两半，产出乱码。
pub fn wrap_text(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![text.to_string()];
    }
    let chars: Vec<char> = text.chars().collect();
    chars
        .chunks(width)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{BookMeta, VolumeMeta};
    use yuhua_core::{ChapterId, VolumeId};

    /// 造一份单章文档。
    fn single_chapter_doc(blocks: Vec<Block>) -> Document {
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

    /// 造一份两卷三章的文档。
    fn multi_chapter_doc() -> Document {
        let mut doc = Document::new(BookMeta::new("测试书", "作者"));
        let v1 = VolumeId::new();
        let v2 = VolumeId::new();
        doc.volumes.push(VolumeMeta {
            id: v1.clone(),
            title: "上卷".into(),
        });
        doc.volumes.push(VolumeMeta {
            id: v2.clone(),
            title: "下卷".into(),
        });
        doc.chapters.push(ChapterContent::new(
            ChapterId::new(),
            v1.clone(),
            "第一章",
            vec![Block::Paragraph(vec![Inline::text("甲")])],
        ));
        doc.chapters.push(ChapterContent::new(
            ChapterId::new(),
            v1,
            "第二章",
            vec![Block::Paragraph(vec![Inline::text("乙")])],
        ));
        doc.chapters.push(ChapterContent::new(
            ChapterId::new(),
            v2,
            "第三章",
            vec![Block::Paragraph(vec![Inline::text("丙")])],
        ));
        doc
    }

    fn render_to_string(doc: &Document, options: TxtOptions) -> String {
        let renderer = TxtRenderer::new(options);
        let bytes = renderer.render(doc).unwrap();
        String::from_utf8(bytes).expect("TXT 产物必须是合法 UTF-8")
    }

    #[test]
    fn renders_title_and_indented_paragraph() {
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![Inline::text("正文")])]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("第一章"), "{text}");
        // 默认 2 个全角空格缩进
        assert!(text.contains("\u{3000}\u{3000}正文"), "{text:?}");
    }

    #[test]
    fn indent_is_configurable() {
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![Inline::text("正文")])]);
        let text = render_to_string(
            &doc,
            TxtOptions {
                indent: 0,
                ..Default::default()
            },
        );
        assert!(text.contains("\n正文\n"), "{text:?}");
        assert!(!text.contains('\u{3000}'));
    }

    #[test]
    fn no_hard_wrap_by_default() {
        let long = "字".repeat(200);
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![Inline::text(long.clone())])]);
        let text = render_to_string(&doc, TxtOptions::default());
        // 整段应当在同一行里
        assert!(
            text.lines().any(|l| l.trim().chars().count() == 200),
            "默认不该硬换行"
        );
    }

    #[test]
    fn wrap_width_splits_long_lines() {
        let long = "字".repeat(25);
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![Inline::text(long)])]);
        let text = render_to_string(
            &doc,
            TxtOptions {
                wrap_width: 10,
                indent: 0,
                ..Default::default()
            },
        );
        // 25 个字按 10 折行 → 10 / 10 / 5
        let body_lines: Vec<&str> = text.lines().filter(|l| l.starts_with('字')).collect();
        assert_eq!(body_lines.len(), 3, "{text}");
        assert_eq!(body_lines[0].chars().count(), 10);
        assert_eq!(body_lines[2].chars().count(), 5);
    }

    #[test]
    fn wrap_never_splits_a_chinese_character() {
        // 按字节切会把汉字劈成乱码，这里必须按字符切
        let text = wrap_text("你好世界再见", 3);
        assert_eq!(text, vec!["你好世", "界再见"]);
        for chunk in &text {
            assert!(!chunk.contains('\u{fffd}'));
        }
    }

    #[test]
    fn wrap_with_zero_width_is_identity() {
        assert_eq!(wrap_text("任意文字", 0), vec!["任意文字"]);
    }

    #[test]
    fn title_format_template_is_applied() {
        let doc = single_chapter_doc(vec![]);
        let text = render_to_string(
            &doc,
            TxtOptions {
                title_format: "第 {n} 章 {title}".into(),
                ..Default::default()
            },
        );
        assert!(text.contains("第 1 章 第一章"), "{text}");
    }

    #[test]
    fn page_break_between_chapters_is_optional() {
        let doc = multi_chapter_doc();
        let without = render_to_string(&doc, TxtOptions::default());
        assert!(!without.contains('\u{0c}'));

        let with = render_to_string(
            &doc,
            TxtOptions {
                page_break_between_chapters: true,
                ..Default::default()
            },
        );
        // 3 章之间 2 个分页符，结尾不加
        assert_eq!(with.matches('\u{0c}').count(), 2, "{with:?}");
    }

    #[test]
    fn volume_titles_are_printed_once_per_volume() {
        let doc = multi_chapter_doc();
        let text = render_to_string(&doc, TxtOptions::default());
        assert_eq!(text.matches("上卷").count(), 1, "{text}");
        assert_eq!(text.matches("下卷").count(), 1, "{text}");
    }

    #[test]
    fn volume_titles_can_be_disabled() {
        let doc = multi_chapter_doc();
        let text = render_to_string(
            &doc,
            TxtOptions {
                include_volume_titles: false,
                ..Default::default()
            },
        );
        assert!(!text.contains("上卷"));
        assert!(!text.contains("下卷"));
    }

    #[test]
    fn headings_keep_level_markers() {
        let doc = single_chapter_doc(vec![
            Block::Heading {
                level: 1,
                text: "一级".into(),
            },
            Block::Heading {
                level: 2,
                text: "二级".into(),
            },
            Block::Heading {
                level: 3,
                text: "三级".into(),
            },
        ]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("\n一级\n"), "{text:?}");
        assert!(text.contains("# 二级"), "{text}");
        assert!(text.contains("## 三级"), "{text}");
    }

    #[test]
    fn inline_markup_is_flattened_without_markers() {
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![
            Inline::Strong(vec![Inline::text("粗")]),
            Inline::Emph(vec![Inline::text("斜")]),
            Inline::Code("code".into()),
        ])]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("粗斜code"), "{text}");
        assert!(!text.contains("**"), "TXT 不该出现 Markdown 标记");
    }

    #[test]
    fn link_becomes_text_with_url_in_parentheses() {
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![Inline::Link {
            url: "https://example.com".into(),
            text: vec![Inline::text("站点")],
        }])]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("站点（https://example.com）"), "{text}");
    }

    #[test]
    fn link_with_matching_text_is_not_duplicated() {
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![Inline::Link {
            url: "https://example.com".into(),
            text: vec![Inline::text("https://example.com")],
        }])]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert_eq!(text.matches("https://example.com").count(), 1, "{text}");
    }

    #[test]
    fn images_become_placeholders_with_alt() {
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![Inline::Image {
            url: "a.png".into(),
            alt: "示意图".into(),
        }])]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("［图片：示意图］"), "{text}");
    }

    #[test]
    fn lists_use_dash_and_number_prefixes() {
        let doc = single_chapter_doc(vec![
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
                start: 1,
                items: vec![
                    vec![Block::Paragraph(vec![Inline::text("一")])],
                    vec![Block::Paragraph(vec![Inline::text("二")])],
                ],
            },
        ]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("- 甲"), "{text}");
        assert!(text.contains("- 乙"), "{text}");
        assert!(text.contains("1. 一"), "{text}");
        assert!(text.contains("2. 二"), "{text}");
    }

    #[test]
    fn ordered_list_respects_custom_start() {
        let doc = single_chapter_doc(vec![Block::List {
            ordered: true,
            start: 5,
            items: vec![
                vec![Block::Paragraph(vec![Inline::text("五")])],
                vec![Block::Paragraph(vec![Inline::text("六")])],
            ],
        }]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("5. 五"), "{text}");
        assert!(text.contains("6. 六"), "{text}");
    }

    #[test]
    fn nested_list_is_indented() {
        let doc = single_chapter_doc(vec![Block::List {
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
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("- 外"), "{text}");
        assert!(text.contains("  - 内"), "{text}");
    }

    #[test]
    fn quote_is_prefixed_with_angle_bracket() {
        let doc = single_chapter_doc(vec![Block::Quote(vec![Block::Paragraph(vec![
            Inline::text("引用内容"),
        ])])]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("> 引用内容"), "{text}");
    }

    #[test]
    fn horizontal_rule_becomes_dashes() {
        let doc = single_chapter_doc(vec![Block::Hr]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("----------"), "{text}");
    }

    #[test]
    fn code_block_is_indented_verbatim() {
        let doc = single_chapter_doc(vec![Block::Code {
            lang: "rust".into(),
            text: "fn main() {}\nlet x = 1;".into(),
        }]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("    fn main() {}"), "{text}");
        assert!(text.contains("    let x = 1;"), "{text}");
    }

    #[test]
    fn output_is_utf8_and_keeps_chinese_intact() {
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![Inline::text(
            "天地玄黄，宇宙洪荒。",
        )])]);
        let bytes = TxtRenderer::default().render(&doc).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("天地玄黄，宇宙洪荒。"));
        assert!(!text.contains('\u{fffd}'));
    }

    #[test]
    fn russian_and_emoji_free_multibyte_text_round_trips() {
        // 非中文的多字节内容同样不能被截断
        let doc = single_chapter_doc(vec![Block::Paragraph(vec![Inline::text("Привет мир")])]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains("Привет мир"), "{text}");
    }

    #[test]
    fn empty_document_renders_to_empty_output() {
        let doc = Document::new(BookMeta::new("空书", "作者"));
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.is_empty(), "{text:?}");
    }

    #[test]
    fn blank_paragraph_produces_no_stray_blank_lines() {
        let doc = single_chapter_doc(vec![
            Block::Paragraph(vec![Inline::text("甲")]),
            Block::Paragraph(vec![Inline::text("   ")]),
            Block::Paragraph(vec![Inline::text("乙")]),
        ]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(!text.contains("\n\n\n"), "不该出现连续空行：{text:?}");
    }

    #[test]
    fn explicit_page_break_block_is_emitted() {
        let doc = single_chapter_doc(vec![Block::PageBreak]);
        let text = render_to_string(&doc, TxtOptions::default());
        assert!(text.contains('\u{0c}'), "{text:?}");
    }
}
