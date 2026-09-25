//! Document IR —— 导出管线的中间表示。
//!
//! ## 为什么要有 IR
//!
//! 计划书 9.2 节的架构是「单一 IR + 多渲染器」。如果不设 IR，而是让每个
//! 渲染器各自去解析一遍 Markdown，会立刻出现三个问题：
//!
//! 1. **行为漂移**：TXT 里表格降级成缩进、DOCX 里降级成普通段落，
//!    用户会认为「同一个文件导出了两份不同的东西」。
//! 2. **降级记录重复且不一致**：R19 要求「不支持的内容不能静默丢弃」，
//!    这条规则必须只写一遍。
//! 3. **测试成本翻五倍**：解析的正确性无法与渲染的正确性分开验证。
//!
//! 所以解析（[`crate::markdown`]）只做一次，产出 IR；五个渲染器只读 IR。
//!
//! ## 内存模型：绝不整书进内存（计划书不变量 5）
//!
//! IR 不是「一棵装下整本书的树」。它是**分块的**：
//!
//! - [`Document`] 里只有元数据与卷章结构，**没有任何正文**；
//! - 正文挂在 `Vec<ChapterContent>` 上，每章的正文独立成一个 blob。
//!
//! 渲染器因此可以**喂一章渲染一章**（见 [`crate::render`]），
//! 峰值内存 ≈ 单章体积 + 输出缓冲，与全书字数无关。
//! 这一点是被 M7 指标（100 万字 / 300 章整书内存 ≤ 120 MB 且不随书量增长）
//! 逼出来的设计，不是过度设计。
//!
//! ## 结构
//!
//! ```text
//! Document { book, volumes, chapters: Vec<ChapterContent> }
//!   ChapterContent { id, volume_id, title, blocks: Vec<Block> }
//!     Block { Paragraph(Vec<Inline>)
//!           | Heading { level, text }
//!           | Quote(Vec<Block>)
//!           | List { ordered, start, items: Vec<Vec<Block>> }
//!           | Code { lang, text }
//!           | Hr | PageBreak }
//!     Inline { Text | Emph(Vec<Inline>) | Strong(Vec<Inline>)
//!            | Code | Link { url, text } | Image { url, alt } }
//! ```
//!
//! `Quote` 与 `List` 装的是 `Vec<Block>` 而不是纯文本，
//! 因为 CommonMark 允许「引用里放列表、列表项里放多个段落」。如果这里退化成
//! 扁平文本，渲染器就没法把结构还原成 DOCX 的 `w:numPr` 或 HTML 的嵌套 `<ul>`，
//! 冻结子集里的嵌套列表直接就废了。

use yuhua_core::{BookId, ChapterId, VolumeId};

use crate::error::Result;

/// 行内元素。
///
/// `Emph` / `Strong` / `Link` 递归包含行内元素，是为了支持 `**加粗里的*斜体*`**
/// 这种嵌套 —— CommonMark 允许，且作者真的会这么写。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inline {
    /// 纯文本。所有不该被解释的字符（Markdown 标记、原始 HTML）都落到这里。
    Text(String),
    /// 斜体（`*x*`）。
    Emph(Vec<Inline>),
    /// 粗体（`**x**`）。
    Strong(Vec<Inline>),
    /// 行内代码（`x` 的反引号形式）。
    Code(String),
    /// 链接。`text` 是显示文本，`url` 是目标。
    Link {
        /// 链接目标。
        url: String,
        /// 链接显示文本。
        text: Vec<Inline>,
    },
    /// 图片。
    ///
    /// IR 只记录 URL 与替代文本，**不承载图片字节**：内嵌图片需要读磁盘，
    /// 属于渲染阶段的决定（DOCX/EPUB 要内嵌、TXT 要丢弃），
    /// 提前读进来会让 IR 的体积与图片数量挂钩。
    Image {
        /// 图片地址（相对路径或外链）。
        url: String,
        /// 替代文本（alt）。
        alt: String,
    },
}

impl Default for Inline {
    /// 默认是空文本。
    ///
    /// 手写而不是派生：`#[default]` 只能标在单元变体上，而 `Inline::Text`
    /// 带一个 String。绝大多数时候「没有内容的行内元素」就是空文本。
    fn default() -> Self {
        Self::Text(String::new())
    }
}

impl Inline {
    /// 构造一个纯文本行内元素。
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text(s.into())
    }

    /// 把行内序列摊平成纯文本。
    ///
    /// 这是**降级路径**的主力：TXT 渲染器、DOCX 的标题、以及「表格降级为纯文本」
    /// 都只需要文字。放在 IR 上而不是各渲染器里各写一遍，
    /// 保证「同一个 IR 摊平出来的文字在所有格式里一致」。
    pub fn flatten_to_string(inlines: &[Inline]) -> String {
        let mut out = String::new();
        Self::flatten_into(inlines, &mut out);
        out
    }

    /// 追加式摊平，避免递归时为每个子节点分配中间 String。
    fn flatten_into(inlines: &[Inline], out: &mut String) {
        for inline in inlines {
            match inline {
                Inline::Text(t) => out.push_str(t),
                Inline::Code(t) => out.push_str(t),
                Inline::Emph(children) | Inline::Strong(children) => {
                    Self::flatten_into(children, out);
                }
                Inline::Link { text, .. } => Self::flatten_into(text, out),
                // 裸图片没有可见文本：用 alt 顶替，纯文本格式里至少能看出「这里原本有张图」。
                Inline::Image { alt, .. } => out.push_str(alt),
            }
        }
    }

    /// 判断该行内序列摊平后是否没有任何可见文字。
    ///
    /// 用于渲染器决定是否跳过空段落（例如单张图片成段时，
    /// 纯文本格式里没必要留下一个空行）。
    pub fn is_blank(inlines: &[Inline]) -> bool {
        Self::flatten_to_string(inlines).trim().is_empty()
    }
}

/// 块级元素。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    /// 段落。
    Paragraph(Vec<Inline>),
    /// 标题。`level` 为 1..=6，与 Markdown 的 `#` 数量一致。
    Heading {
        /// 标题层级，1 为最高级。
        level: u8,
        /// 标题文字（已摊平 —— 标题里嵌套粗斜体没有排版意义，各格式都当纯文本处理）。
        text: String,
    },
    /// 引用块。内部是块序列，支持「引用里放列表」。
    Quote(Vec<Block>),
    /// 列表。
    List {
        /// 是否有序。
        ordered: bool,
        /// 有序列表的起始序号；无序列表无意义。
        start: u64,
        /// 每个列表项自身又是一个块序列，支持「列表项里有多个段落」。
        items: Vec<Vec<Block>>,
    },
    /// 代码块。不做语法高亮（计划书 9.3）。
    Code {
        /// 语言标记，可能为空。
        lang: String,
        /// 代码原文，保留其内部换行。
        text: String,
    },
    /// 分割线（`---`）。
    Hr,
    /// 强制分页。DOCX 的每章分页、TXT 的可选分页符、EPUB 的每章一文件都由它表达。
    PageBreak,
}

impl Block {
    /// 把任意块序列摊平成一段纯文本，段落之间用空行分隔。
    ///
    /// 表格降级（R19）与 TXT 渲染共用的底座。递归处理引用与列表，
    /// 列表项加 `- ` 前缀，让降级后的内容仍然读得懂结构。
    pub fn flatten_blocks_to_string(blocks: &[Block]) -> String {
        let mut out = String::new();
        Self::flatten_blocks_into(blocks, &mut out, 0);
        out.trim_end().to_string()
    }

    /// 递归摊平实现。`depth` 用于给嵌套列表做缩进。
    fn flatten_blocks_into(blocks: &[Block], out: &mut String, depth: usize) {
        for block in blocks {
            match block {
                Block::Paragraph(inlines) => {
                    out.push_str(&Inline::flatten_to_string(inlines));
                    out.push_str("\n\n");
                }
                Block::Heading { text, .. } => {
                    out.push_str(text);
                    out.push_str("\n\n");
                }
                Block::Quote(children) => {
                    let inner = Self::flatten_blocks_to_string(children);
                    for line in inner.lines() {
                        out.push_str("> ");
                        out.push_str(line);
                        out.push('\n');
                    }
                    out.push('\n');
                }
                Block::List {
                    ordered,
                    start,
                    items,
                } => {
                    let indent = "  ".repeat(depth);
                    for (offset, item) in items.iter().enumerate() {
                        // 把项里的**非列表**子块先摊平成文字，列表子块单独递归 ——
                        // 若直接整项摊平，内层列表已经带了 "- " 前缀，外层再加一次
                        // 就会得到 "- - 二" 这种重复标记。
                        let marker = if *ordered {
                            format!("{}. ", start + offset as u64)
                        } else {
                            "- ".to_string()
                        };
                        let mut first = true;
                        for child in item {
                            if let Block::List { .. } = child {
                                Self::flatten_blocks_into(
                                    std::slice::from_ref(child),
                                    out,
                                    depth + 1,
                                );
                                continue;
                            }
                            let text = Self::flatten_blocks_to_string(std::slice::from_ref(child));
                            for line in text.lines() {
                                if first {
                                    out.push_str(&indent);
                                    out.push_str(&marker);
                                    out.push_str(line);
                                    out.push('\n');
                                    first = false;
                                } else {
                                    out.push_str(&indent);
                                    out.push_str("   ");
                                    out.push_str(line);
                                    out.push('\n');
                                }
                            }
                        }
                    }
                    out.push('\n');
                }
                Block::Code { text, .. } => {
                    out.push_str(text);
                    out.push_str("\n\n");
                }
                Block::Hr => {
                    out.push_str("---\n\n");
                }
                Block::PageBreak => {
                    out.push('\u{0c}');
                    out.push('\n');
                }
            }
        }
    }

    /// 该块是否为空（渲染时可直接跳过）。
    pub fn is_blank(&self) -> bool {
        match self {
            Block::Paragraph(inlines) => Inline::is_blank(inlines),
            Block::Heading { text, .. } => text.trim().is_empty(),
            Block::Quote(children) => children.iter().all(Block::is_blank),
            Block::List { items, .. } => items.iter().all(|i| i.iter().all(Block::is_blank)),
            Block::Code { text, .. } => text.is_empty(),
            Block::Hr | Block::PageBreak => false,
        }
    }
}

/// 一章的正文（IR 视角）。
///
/// 刻意不直接复用 `yuhua_core::Chapter`：那个结构带 Front Matter 元数据、
/// 路径、哈希等导出用不上的字段，且 `body` 是原始 Markdown 字符串而非 IR。
/// 把「已经解析好的正文」单独建模，渲染器就不必再关心 Markdown 的存在。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChapterContent {
    /// 章 ID。
    pub id: ChapterId,
    /// 所属卷 ID。
    pub volume_id: VolumeId,
    /// 章标题（取自 Front Matter，而不是正文里的第一个 `#`）。
    pub title: String,
    /// 正文块序列。
    pub blocks: Vec<Block>,
}

impl ChapterContent {
    /// 新建一章正文。
    pub fn new(
        id: ChapterId,
        volume_id: VolumeId,
        title: impl Into<String>,
        blocks: Vec<Block>,
    ) -> Self {
        Self {
            id,
            volume_id,
            title: title.into(),
            blocks,
        }
    }

    /// 本章摊平后的纯文本。
    pub fn plain_text(&self) -> String {
        Block::flatten_blocks_to_string(&self.blocks)
    }
}

/// 导出用的书级元数据。
///
/// 只留渲染器真正要写进产物头部/元信息里的字段 —— 导出不该依赖
/// `yuhua_core::Book` 里的时间戳等与排版无关的数据。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BookMeta {
    /// 书 ID。
    pub id: Option<BookId>,
    /// 书名。
    pub title: String,
    /// 作者。EPUB / DOCX 的元数据要用。
    pub author: String,
    /// 简介。EPUB 的 `dc:description` 要用。
    pub description: String,
}

impl BookMeta {
    /// 构造一份书元数据。
    pub fn new(title: impl Into<String>, author: impl Into<String>) -> Self {
        Self {
            id: None,
            title: title.into(),
            author: author.into(),
            description: String::new(),
        }
    }

    /// 缺作者时的兜底显示名。
    ///
    /// 空作者会让 DOCX 的 `dc:creator` 与 EPUB 的 `dc:creator` 变成空元素，
    /// 部分阅读器会直接报错，所以统一兜底成「佚名」。
    pub fn author_or_anonymous(&self) -> &str {
        let trimmed = self.author.trim();
        if trimmed.is_empty() {
            "佚名"
        } else {
            trimmed
        }
    }
}

/// 导出用的卷级元数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeMeta {
    /// 卷 ID。
    pub id: VolumeId,
    /// 卷名。
    pub title: String,
}

/// 导出文档 IR。
///
/// 这是范围装配器（[`crate::scope`]）的产物，也是所有渲染器的输入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Document {
    /// 书级元数据。
    pub book: BookMeta,
    /// 参与导出的卷，按 `sort` 升序。
    pub volumes: Vec<VolumeMeta>,
    /// 参与导出的章正文，按 (卷顺序, 章 sort) 升序。
    pub chapters: Vec<ChapterContent>,
    /// 解析过程中产生的降级记录。
    ///
    /// 放在 IR 上而不是渲染器里：降级是**解析期**的事实（「这里有个表格，
    /// 冻结子集不支持」），与输出成什么格式无关。R19 要求导出报告能给出
    /// 「N 章包含表格」，所以记录必须带着章标题一路传到报告层。
    pub degradations: Vec<crate::markdown::Degradation>,
}

impl Document {
    /// 构造一份空 IR。
    pub fn new(book: BookMeta) -> Self {
        Self {
            book,
            volumes: Vec::new(),
            chapters: Vec::new(),
            degradations: Vec::new(),
        }
    }

    /// 章节总数。
    pub fn chapter_count(&self) -> usize {
        self.chapters.len()
    }

    /// 全书摊平后的纯文本（主要用于测试与报告）。
    ///
    /// 会一次性构造整本书的字符串，**不要在大书上调用** ——
    /// 渲染器一律走 `iter_chapters` 逐章处理。
    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        for chapter in &self.chapters {
            out.push_str(&chapter.title);
            out.push('\n');
            out.push_str(&chapter.plain_text());
            out.push('\n');
        }
        out
    }

    /// 按卷顺序迭代章节。
    ///
    /// 渲染器的主要入口。返回迭代器而不是切片，是为了让渲染器写成
    /// 「喂一章、写一章」的形态，将来换成从磁盘流式读入的实现时调用点不用改。
    pub fn iter_chapters(&self) -> impl Iterator<Item = &ChapterContent> {
        self.chapters.iter()
    }

    /// 查卷标题。
    pub fn volume_title(&self, id: &VolumeId) -> Option<&str> {
        self.volumes
            .iter()
            .find(|v| &v.id == id)
            .map(|v| v.title.as_str())
    }

    /// 轻量校验：保证卷引用完整、标题不乱。
    ///
    /// 与 `yuhua_core::Document::validate` 的分工是：那边管「磁盘上的书是否自洽」，
    /// 这边只管「交给渲染器的这份 IR 是否可用」。范围装配器可能会裁剪掉
    /// 部分卷，如果裁剪逻辑有 bug，这里会立刻炸出来，而不是让渲染器静默产出
    /// 一份缺卷的残稿 —— 交稿文件缺内容比报错严重得多。
    pub fn validate(&self) -> Result<()> {
        use crate::error::ExportError;

        if self.book.title.trim().is_empty() {
            return Err(ExportError::invalid("书名不能为空"));
        }
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for volume in &self.volumes {
            if !seen.insert(volume.id.as_str()) {
                return Err(ExportError::invalid(format!("卷 ID 重复：{}", volume.id)));
            }
        }
        for chapter in &self.chapters {
            if !seen.contains(chapter.volume_id.as_str()) {
                return Err(ExportError::invalid(format!(
                    "章「{}」引用了未参与导出的卷 {}",
                    chapter.title, chapter.volume_id
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_book() -> BookMeta {
        BookMeta::new("羽化笔记", "某作者")
    }

    #[test]
    fn flatten_inlines_handles_nesting() {
        let inlines = vec![
            Inline::text("前"),
            Inline::Strong(vec![Inline::text("粗"), Inline::Emph(vec![Inline::text("斜")])]),
            Inline::Code("code".into()),
            Inline::Link {
                url: "https://example.com".into(),
                text: vec![Inline::text("链接")],
            },
        ];
        assert_eq!(Inline::flatten_to_string(&inlines), "前粗斜code链接");
    }

    #[test]
    fn flatten_inlines_uses_alt_for_bare_image() {
        // 裸图片没有可见文字，用 alt 兜底，纯文本格式里不至于凭空少一段
        let inlines = vec![Inline::Image {
            url: "a.png".into(),
            alt: "插图一".into(),
        }];
        assert_eq!(Inline::flatten_to_string(&inlines), "插图一");
    }

    #[test]
    fn blank_detection_ignores_whitespace() {
        assert!(Inline::is_blank(&[Inline::text("   ")]));
        assert!(Inline::is_blank(&[]));
        assert!(!Inline::is_blank(&[Inline::text("x")]));
    }

    #[test]
    fn flatten_blocks_renders_nested_list_with_indent() {
        let blocks = vec![Block::List {
            ordered: false,
            start: 1,
            items: vec![
                vec![Block::Paragraph(vec![Inline::text("一")])],
                vec![Block::List {
                    ordered: false,
                    start: 1,
                    items: vec![vec![Block::Paragraph(vec![Inline::text("二")])]],
                }],
            ],
        }];
        let text = Block::flatten_blocks_to_string(&blocks);
        assert!(text.contains("- 一"), "{text}");
        assert!(text.contains("  - 二"), "{text}");
    }

    #[test]
    fn flatten_blocks_prefixes_quote_lines() {
        let blocks = vec![Block::Quote(vec![
            Block::Paragraph(vec![Inline::text("甲")]),
            Block::Paragraph(vec![Inline::text("乙")]),
        ])];
        let text = Block::flatten_blocks_to_string(&blocks);
        assert!(text.contains("> 甲"), "{text}");
        assert!(text.contains("> 乙"), "{text}");
    }

    #[test]
    fn flatten_blocks_keeps_code_verbatim() {
        let blocks = vec![Block::Code {
            lang: "rust".into(),
            text: "let a = 1;\nlet b = 2;".into(),
        }];
        let text = Block::flatten_blocks_to_string(&blocks);
        assert!(text.contains("let a = 1;\nlet b = 2;"), "{text}");
    }

    #[test]
    fn blank_block_detection_recurses() {
        assert!(Block::Paragraph(vec![Inline::text(" ")]).is_blank());
        assert!(Block::Quote(vec![Block::Paragraph(vec![Inline::text("")])]).is_blank());
        // 分割线永远不是空块，跳过它会让 --- 消失
        assert!(!Block::Hr.is_blank());
        assert!(!Block::PageBreak.is_blank());
    }

    #[test]
    fn author_falls_back_to_anonymous() {
        let meta = BookMeta::new("书", "   ");
        assert_eq!(meta.author_or_anonymous(), "佚名");
        let meta = BookMeta::new("书", "张三");
        assert_eq!(meta.author_or_anonymous(), "张三");
    }

    #[test]
    fn document_validate_rejects_empty_title() {
        let doc = Document::new(BookMeta::new("  ", "作者"));
        assert!(doc.validate().is_err());
    }

    #[test]
    fn document_validate_rejects_chapter_without_volume() {
        let mut doc = Document::new(sample_book());
        doc.chapters.push(ChapterContent::new(
            ChapterId::new(),
            VolumeId::new(),
            "孤儿章",
            vec![],
        ));
        let err = doc.validate().unwrap_err().to_string();
        assert!(err.contains("孤儿章"), "{err}");
    }

    #[test]
    fn document_validate_accepts_consistent_ir() {
        let mut doc = Document::new(sample_book());
        let vid = VolumeId::new();
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "第一卷".into(),
        });
        doc.chapters.push(ChapterContent::new(
            ChapterId::new(),
            vid,
            "第一章",
            vec![Block::Paragraph(vec![Inline::text("正文")])],
        ));
        assert!(doc.validate().is_ok());
        assert_eq!(doc.chapter_count(), 1);
        assert_eq!(doc.volume_title(&VolumeId::new()), None);
        assert_eq!(doc.iter_chapters().count(), 1);
        assert!(doc.plain_text().contains("正文"));
    }

    #[test]
    fn chapter_plain_text_joins_blocks() {
        let chapter = ChapterContent::new(
            ChapterId::new(),
            VolumeId::new(),
            "标题",
            vec![
                Block::Heading {
                    level: 1,
                    text: "小标题".into(),
                },
                Block::Paragraph(vec![Inline::text("段落")]),
            ],
        );
        let text = chapter.plain_text();
        assert!(text.contains("小标题"));
        assert!(text.contains("段落"));
    }
}
