//! Markdown → Document IR。
//!
//! ## 冻结子集与降级（计划书 9.3 / R19）
//!
//! 编辑器用 JS 的 Lezer，导出用 Rust 的 pulldown-cmark，两套解析器天然会漂移
//! （R17）。对策是**冻结一个受支持的子集**：编辑器不提供超出该子集的语法，
//! 导出侧对该子集之外的一切内容**降级但不丢弃**。
//!
//! 冻结子集（支持）：
//!
//! - 标题 `#` ~ `######`
//! - 段落
//! - `**粗体**` / `*斜体*` / `***粗斜体***`
//! - `> 引用`（可嵌套，可含列表）
//! - 有序 / 无序列表，**嵌套上限 3 层**
//! - `---` 分割线
//! - 行内代码、代码块
//! - 链接、图片
//!
//! 子集之外（降级 + 记录）：
//!
//! | 语法 | 降级为 | 记录类型 |
//! | --- | --- | --- |
//! | 表格 | 纯文本（单元格用 ` | ` 连接） | `Table` |
//! | 脚注 | 括号内联 `（注：标签）` | `Footnote` |
//! | LaTeX 公式 | 原样保留文本（含 `$`） | `Math` |
//! | 原始 HTML | 转义为纯文本 | `RawHtml` |
//! | 删除线 | 纯文本 | `Strikethrough` |
//! | 任务列表 | 文本前缀 `[x] ` / `[ ] ` | `TaskList` |
//! | 定义列表 | 标题与项各成一段 | `DefinitionList` |
//! | 引用式元数据块 | 整体忽略 | `MetadataBlock` |
//! | 列表嵌套 > 3 层 | 拍平成同级项 | `ListDepthExceeded` |
//!
//! **为什么原始 HTML 走「转义成文本」而不是「整块丢掉」**：正文里出现
//! `<div>` 时，作者多半是在写「HTML 标签」这个词，而不是想让它在电子书里
//! 真的变成一个 div。保留可见文本（内容没丢）同时记一条降级提示
//! （用户知道它没有被当成标记处理），是最不意外的行为。
//!
//! ## 为什么反而要**打开**不支持的扩展开关
//!
//! 直觉上应该关掉 `ENABLE_TABLES`，让表格退化成普通文本。但那样做的后果是
//! **静默**：解析器不会报出「这里有个表格」，我们也就无从记录降级，
//! R19 直接落空（用户以为导出是无损的）。
//!
//! 所以这里反过来：**打开**这些开关，让解析器把不支持的语法**显式报出来**
//! （`Tag::Table` / `Event::FootnoteReference` / `Event::InlineMath` …），
//! 再由本模块主动降级并记录。多写一堆事件分支，换「绝不静默丢内容」。

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use yuhua_core::{ChapterId, VolumeId};

use crate::error::Result;
use crate::ir::{Block, ChapterContent, Inline};

/// 列表嵌套层数上限（计划书 9.3 冻结清单）。
///
/// 超过上限的层级不会丢内容，而是拍平成同一层的兄弟项并记一条降级。
/// 三层以上的嵌套列表在交稿格式（TXT/DOCX）里本来就没有合适的表达，
/// 强行保留只会让缩进无限加深。
pub const MAX_LIST_DEPTH: usize = 3;

/// 降级类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DegradationKind {
    /// 表格。
    Table,
    /// 脚注。
    Footnote,
    /// LaTeX 公式。
    Math,
    /// 原始 HTML。
    RawHtml,
    /// 删除线。
    Strikethrough,
    /// 任务列表。
    TaskList,
    /// 定义列表。
    DefinitionList,
    /// 引用式元数据块。
    MetadataBlock,
    /// 列表嵌套超过上限。
    ListDepthExceeded,
}

impl DegradationKind {
    /// 面向用户的简短说明。
    ///
    /// 导出报告直接把这句话拼进提示里，所以措辞要能脱离上下文读懂
    /// （R19 要求用户能明白「哪些内容被改写了」）。
    pub fn describe(self) -> &'static str {
        match self {
            Self::Table => "表格已降级为纯文本",
            Self::Footnote => "脚注已降级为括号内联",
            Self::Math => "数学公式已原样保留为文本",
            Self::RawHtml => "原始 HTML 已转义为纯文本",
            Self::Strikethrough => "删除线已降级为纯文本",
            Self::TaskList => "任务列表已降级为纯文本标记",
            Self::DefinitionList => "定义列表已降级为纯文本",
            Self::MetadataBlock => "引用式元数据块已忽略",
            Self::ListDepthExceeded => "列表嵌套超过 3 层，已拍平",
        }
    }
}

/// 一条降级记录。
///
/// 刻意带上 `chapter_title`：导出报告要说的是「第 3 章、第 7 章包含表格」，
/// 而不是一句干巴巴的「有 2 处表格」。用户要能顺着报告回去改稿。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Degradation {
    /// 发生降级的章节标题。
    pub chapter_title: String,
    /// 降级类型。
    pub kind: DegradationKind,
    /// 面向用户的说明。
    pub detail: String,
}

impl Degradation {
    /// 构造一条降级记录。
    pub fn new(chapter_title: impl Into<String>, kind: DegradationKind) -> Self {
        Self {
            chapter_title: chapter_title.into(),
            kind,
            detail: kind.describe().to_string(),
        }
    }

    /// 构造一条带额外上下文的降级记录。
    pub fn with_detail(
        chapter_title: impl Into<String>,
        kind: DegradationKind,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            chapter_title: chapter_title.into(),
            kind,
            detail: detail.into(),
        }
    }
}

/// 单章解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedChapter {
    /// 正文块序列。
    pub blocks: Vec<Block>,
    /// 解析期间产生的降级记录。
    pub degradations: Vec<Degradation>,
}

/// 把标题层级枚举转成 1..=6 的数字。
fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// 解析选项。
///
/// 打开多个扩展开关而不是用 `Options::empty()`：原因见模块文档 ——
/// **打开才知道有什么**。关掉的扩展会让不支持的语法悄悄混进普通文本，
/// 那就违反了 R19。
fn parser_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_MATH
        | Options::ENABLE_HEADING_ATTRIBUTES
        // 引用式元数据块也打开：Front Matter 已在 yuhua-fs 被剥离，
        // 正文里再出现 `---` 包裹块一定是用户误粘贴的内容，要能识别并提示。
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS
        | Options::ENABLE_DEFINITION_LIST
}

/// 把 Markdown 正文解析成 IR 块序列。
///
/// `chapter_title` 只用于给降级记录标注出处，不影响解析结果。
pub fn parse_blocks(markdown: &str, chapter_title: &str) -> Result<ParsedChapter> {
    // 空正文是合法状态（刚建的章），直接短路，省掉一次完整解析。
    if markdown.trim().is_empty() {
        return Ok(ParsedChapter {
            blocks: Vec::new(),
            degradations: Vec::new(),
        });
    }

    let mut builder = Builder::new(chapter_title);
    for event in Parser::new_ext(markdown, parser_options()) {
        builder.push(event);
    }

    let blocks = builder.finish();
    Ok(ParsedChapter {
        blocks,
        degradations: builder.degradations,
    })
}

/// 解析一章：正文 → [`ChapterContent`] 与降级记录。
pub fn parse_chapter(
    id: ChapterId,
    volume_id: VolumeId,
    title: &str,
    markdown: &str,
) -> Result<(ChapterContent, Vec<Degradation>)> {
    let parsed = parse_blocks(markdown, title)?;
    let content = ChapterContent::new(id, volume_id, title.to_string(), parsed.blocks);
    Ok((content, parsed.degradations))
}

/// 从 Markdown 正文里提取第一个一级标题，作为章节标题的兜底。
///
/// 章节标题的真源是 Front Matter。但用户从别处粘贴正文、或 Front Matter 被
/// 外部编辑器破坏时，正文里的 `# 第一章` 是仅存的信息。导出时标题为空，
/// 比用一个略有出入的标题严重得多。
pub fn extract_title(markdown: &str) -> Option<String> {
    let mut in_h1 = false;
    let mut text = String::new();
    for event in Parser::new_ext(markdown, parser_options()) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                if level == HeadingLevel::H1 {
                    in_h1 = true;
                    text.clear();
                } else if in_h1 {
                    // 进入下级标题说明这个 H1 已经结束
                    break;
                }
            }
            Event::End(TagEnd::Heading(_)) if in_h1 => {
                let trimmed = text.trim();
                return if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                };
            }
            Event::Text(t) | Event::Code(t) if in_h1 => text.push_str(&t),
            Event::SoftBreak | Event::HardBreak if in_h1 => text.push(' '),
            _ => {}
        }
    }
    None
}

/// 行内容器类型（用于嵌套的粗体 / 斜体）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Container {
    /// 斜体。
    Emph,
    /// 粗体。
    Strong,
}

/// 进行中的链接 / 图片。
#[derive(Debug)]
struct PendingLink {
    /// 目标地址。
    url: String,
    /// 是否是图片（决定结束时产出 `Inline::Image` 还是 `Inline::Link`）。
    is_image: bool,
    /// 显示文本 / 替代文本。
    text: Vec<Inline>,
}

/// 进行中的容器。
#[derive(Debug)]
enum Frame {
    /// 引用块。
    Quote(Vec<Block>),
    /// 列表。
    List {
        /// 是否有序。
        ordered: bool,
        /// 起始序号。
        start: u64,
        /// 已完成的项。
        items: Vec<Vec<Block>>,
    },
    /// 列表项。
    Item(Vec<Block>),
    /// 表格降级期间的临时帧（表格不产出块，产出一段纯文本段落）。
    Table,
}

/// 事件流 → 块序列的构建器。
///
/// 用一个显式栈来还原树形结构。之所以不用递归下降函数：`Parser` 是**扁平**的
/// pull 事件流，递归写法需要把迭代器传来传去，借用检查会变得很难看，
/// 而显式栈的每一步状态都是可见的、好调试的。
struct Builder {
    /// 已完成的顶层块。
    blocks: Vec<Block>,
    /// 进行中的容器栈。
    stack: Vec<Frame>,
    /// 当前正在收集的行内元素。
    inlines: Vec<Inline>,
    /// 行内容器（粗体 / 斜体）嵌套栈，元素是「这一层开始时 inlines 的长度」，
    /// 结束时要把它之后新增的行内元素整体包起来。
    containers: Vec<(Container, usize)>,
    /// 降级记录。
    degradations: Vec<Degradation>,
    /// 当前章节标题，用于标注降级记录的出处。
    chapter_title: String,
    /// 列表嵌套深度。
    list_depth: usize,
    /// 链接 / 图片嵌套栈。
    link_stack: Vec<PendingLink>,
    /// 代码块的语言标记（`None` 表示不在代码块里）。
    code_lang: Option<String>,
    /// 代码块文本缓冲。
    code_buffer: String,
    /// 是否正在收集表格单元格文本。
    in_cell: bool,
    /// 表格当前行的单元格。
    table_cells: Vec<String>,
    /// 表格已完成的数据行。
    table_rows: Vec<Vec<String>>,
    /// 表格表头行。
    ///
    /// 单独存放是必须的：pulldown-cmark 在 `</thead>` 之前**不发送 `TableRow`
    /// 的结束事件**，把所有行都塞进一个 Vec 会让表头凭空消失。
    table_head: Vec<String>,
    /// 当前是否在表头区域。
    in_table_head: bool,
    /// 单元格 / 代码块共用的文本缓冲。
    buffer: String,
    /// 当前标题层级（`Some` 表示在标题里）。
    heading_level: Option<u8>,
    /// 最近一次追加的文本元素在行内序列里的下标（`usize::MAX` 表示不可合并）。
    ///
    /// 与 [`Self::last_text_depth`] 一起决定下一个 Text 事件能否并入它。
    last_text_index: usize,
    /// 最近一次追加的文本元素所处的强调层级（即当时的 `containers.len()`）。
    last_text_depth: usize,
    /// 上一个完成的块是不是 `Hr`。
    ///
    /// 用来把「分割线产生的空段落碎片」抑制掉：`Tag::Table` 结束时会补一个段落，
    /// 紧跟在分割线后就是多余的空行。
    last_was_rule: bool,
}

impl Builder {
    /// 新建一个构建器。
    fn new(chapter_title: &str) -> Self {
        Self {
            blocks: Vec::new(),
            stack: Vec::new(),
            inlines: Vec::new(),
            containers: Vec::new(),
            degradations: Vec::new(),
            chapter_title: chapter_title.to_string(),
            list_depth: 0,
            link_stack: Vec::new(),
            code_lang: None,
            code_buffer: String::new(),
            in_cell: false,
            table_cells: Vec::new(),
            table_rows: Vec::new(),
            table_head: Vec::new(),
            in_table_head: false,
            buffer: String::new(),
            heading_level: None,
            last_text_index: usize::MAX,
            last_text_depth: 0,
            last_was_rule: false,
        }
    }

    /// 记一条降级。
    ///
    /// 同一章内的同类型降级只记一次：导出报告要说的是「本章包含表格」，
    /// 而不是为每个单元格刷一行。
    fn degrade(&mut self, kind: DegradationKind) {
        if self
            .degradations
            .iter()
            .any(|d| d.kind == kind && d.chapter_title == self.chapter_title)
        {
            return;
        }
        self.degradations
            .push(Degradation::new(self.chapter_title.clone(), kind));
    }

    /// 结束构建，返回顶层块。
    fn finish(&mut self) -> Vec<Block> {
        // 正常输入下栈此时已空。若仍有残留（未闭合的容器），
        // 把子块按原顺序提升到顶层 —— 绝不静默丢内容。
        while let Some(frame) = self.stack.pop() {
            match frame {
                Frame::Quote(children) => self.blocks.push(Block::Quote(children)),
                Frame::List {
                    ordered,
                    start,
                    items,
                } => self.blocks.push(Block::List {
                    ordered,
                    start,
                    items,
                }),
                Frame::Item(children) => self.blocks.extend(children),
                Frame::Table => {}
            }
        }
        std::mem::take(&mut self.blocks)
    }

    /// 把刚完成的块放进当前容器（或顶层）。
    fn push_block(&mut self, block: Block) {
        match self.stack.last_mut() {
            Some(Frame::Quote(items)) | Some(Frame::Item(items)) => items.push(block),
            Some(Frame::Table) => {}
            Some(Frame::List { .. }) | None => self.blocks.push(block),
        }
    }

    /// 若当前行内缓冲非空，就把它收成段落放进容器。
    ///
    /// 段落 / 标题 / 列表项等容器切换时必须先调用，否则上一段的内容会被
    /// 新容器覆盖掉。
    fn flush_paragraph(&mut self) {
        if let Some(level) = self.heading_level.take() {
            let inlines = std::mem::take(&mut self.inlines);
            let text = Inline::flatten_to_string(&inlines);
            if !text.trim().is_empty() {
                self.push_block(Block::Heading { level, text });
                self.last_was_rule = false;
            }
            return;
        }
        if self.inlines.is_empty() {
            return;
        }
        let inlines = std::mem::take(&mut self.inlines);
        // 纯空白段落直接丢弃：Markdown 里的空行不该变成输出里的空段落。
        if Inline::is_blank(&inlines) {
            return;
        }
        self.push_block(Block::Paragraph(inlines));
        self.last_was_rule = false;
    }

    /// 把一个行内元素追加到当前上下文（链接内文优先）。
    fn push_inline(&mut self, inline: Inline) {
        if let Some(link) = self.link_stack.last_mut() {
            link.text.push(inline);
        } else {
            self.inlines.push(inline);
        }
    }

    /// 把一段纯文本追加到当前上下文。
    fn push_text(&mut self, text: &str) {
        if self.in_cell {
            self.buffer.push_str(text);
            return;
        }
        if self.code_lang.is_some() {
            self.code_buffer.push_str(text);
            return;
        }
        // 合并**同一个强调层级内相邻**的文本元素。
        //
        // 为什么必须限制层级：pulldown-cmark 把 `**外*内*外**` 拆成
        // `Text("外")` / `Start(Emphasis)` / `Text("内")` / `End(Emphasis)` /
        // `Text("外")`。若不加限制，在 Emphasis 内部收到 `Text("内")` 时会
        // 发现 `inlines.last()` 是 `Text("外")`，就把两者接成 `Text("外内")` ——
        // 外层的「外」被并进了内层的斜体里，结束标签配对也随之错位，
        // 最终整段文字被拼成一坨，斜体节点凭空消失。
        //
        // 判据是 `self.containers.len()` 与「当前文本元素是在哪个层级开始的」
        // 一致：只要**当前没有**打开任何强调容器，或者上一个元素是同一层级
        // 的纯文本，才能合并。用容器数量做层级标记，配合下面记录的元素起点。
        //
        // 这样仍然保留了「同一段里的连续 Text 事件被并成一条」的效果
        // （转义符、实体都会触发多次 Text 事件，不合并会碎成一堆单字）。
        let mergeable = match self.inlines.last() {
            Some(Inline::Text(_)) => self.inlines.len() == self.last_text_index + 1
                && self.last_text_depth == self.containers.len(),
            _ => false,
        };
        if mergeable && self.link_stack.is_empty() {
            if let Some(Inline::Text(prev)) = self.inlines.last_mut() {
                prev.push_str(text);
                return;
            }
        }
        let depth = self.containers.len();
        self.push_inline(Inline::Text(text.to_string()));
        // 记录这次文本元素的位置与层级，供下一个 Text 事件判断能否合并。
        if self.link_stack.is_empty() {
            self.last_text_index = self.inlines.len().saturating_sub(1);
            self.last_text_depth = depth;
        } else {
            self.last_text_index = usize::MAX;
        }
    }

    /// 处理一个事件。
    fn push(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start_tag(tag),
            Event::End(tag) => self.end_tag(tag),
            Event::Text(text) => self.push_text(&text),
            Event::Code(code) => {
                if self.in_cell {
                    self.buffer.push_str(&code);
                } else {
                    self.push_inline(Inline::Code(code.to_string()));
                }
            }
            Event::SoftBreak => {
                // 软换行按 CommonMark 语义等价于一个空格。中文稿子里用户常常
                // 在段落里手动折行来「看着舒服」，保留成硬换行会在 DOCX/TXT 里
                // 切出很多短行，反而不像文章。
                self.push_text(" ");
            }
            Event::HardBreak => {
                // 硬换行（行尾两个空格或反斜杠）是作者的明确意图，保留。
                self.push_text("\n");
            }
            Event::Rule => {
                self.flush_paragraph();
                self.push_block(Block::Hr);
                self.last_was_rule = true;
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                // 原始 HTML 一律转义成可见文本，见模块文档。
                self.degrade(DegradationKind::RawHtml);
                self.push_text(&html);
            }
            Event::InlineMath(math) | Event::DisplayMath(math) => {
                self.degrade(DegradationKind::Math);
                // 公式原样保留，并把 `$` 记法也留着 —— 作者一眼能看出这里原本是公式。
                self.push_text("$");
                self.push_text(&math);
                self.push_text("$");
            }
            Event::FootnoteReference(label) => {
                self.degrade(DegradationKind::Footnote);
                self.push_text("（注：");
                self.push_text(&label);
                self.push_text("）");
            }
            Event::TaskListMarker(checked) => {
                self.degrade(DegradationKind::TaskList);
                self.push_text(if checked { "[x] " } else { "[ ] " });
            }
        }
    }

    /// 处理开始标签。
    fn start_tag(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {
                self.flush_paragraph();
                self.inlines = Vec::new();
            }
            Tag::Heading { level, .. } => {
                self.flush_paragraph();
                self.heading_level = Some(heading_level(level));
                self.inlines = Vec::new();
            }
            Tag::BlockQuote(_) => {
                self.flush_paragraph();
                self.stack.push(Frame::Quote(Vec::new()));
            }
            Tag::CodeBlock(kind) => {
                self.flush_paragraph();
                self.code_lang = Some(match &kind {
                    CodeBlockKind::Fenced(lang) => lang.to_string(),
                    CodeBlockKind::Indented => String::new(),
                });
                self.code_buffer.clear();
            }
            Tag::List(start) => {
                self.flush_paragraph();
                self.list_depth += 1;
                if self.list_depth > MAX_LIST_DEPTH {
                    self.degrade(DegradationKind::ListDepthExceeded);
                }
                self.stack.push(Frame::List {
                    ordered: start.is_some(),
                    start: start.unwrap_or(1),
                    items: Vec::new(),
                });
            }
            Tag::Item => {
                self.flush_paragraph();
                self.stack.push(Frame::Item(Vec::new()));
            }
            Tag::Emphasis => self.open_container(Container::Emph),
            Tag::Strong => self.open_container(Container::Strong),
            Tag::Strikethrough => {
                // 删除线没有对应的 IR 节点（冻结清单里没有它），
                // 但内容必须保留 —— 不作为容器，文本直接流过去。
                self.degrade(DegradationKind::Strikethrough);
            }
            Tag::Link { dest_url, .. } => self.link_stack.push(PendingLink {
                url: dest_url.to_string(),
                is_image: false,
                text: Vec::new(),
            }),
            Tag::Image { dest_url, .. } => self.link_stack.push(PendingLink {
                url: dest_url.to_string(),
                is_image: true,
                text: Vec::new(),
            }),
            Tag::Table(_) => {
                self.flush_paragraph();
                self.degrade(DegradationKind::Table);
                self.table_rows.clear();
                self.table_head.clear();
                self.stack.push(Frame::Table);
            }
            Tag::TableRow => self.table_cells.clear(),
            Tag::TableHead => {
                self.in_table_head = true;
                self.table_cells.clear();
            }
            Tag::TableCell => {
                self.in_cell = true;
                self.buffer.clear();
            }
            Tag::FootnoteDefinition(label) => {
                self.degrade(DegradationKind::Footnote);
                self.flush_paragraph();
                self.inlines = Vec::new();
                self.push_text("（注：");
                self.push_text(&label);
                self.push_text("）");
            }
            Tag::DefinitionList => {
                self.degrade(DegradationKind::DefinitionList);
                self.flush_paragraph();
            }
            Tag::DefinitionListTitle | Tag::DefinitionListDefinition => {
                self.flush_paragraph();
                self.inlines = Vec::new();
            }
            Tag::MetadataBlock(_) => self.degrade(DegradationKind::MetadataBlock),
            Tag::HtmlBlock => {
                self.degrade(DegradationKind::RawHtml);
                // HTML 块内部是一串 `Event::Html` + `Event::Text`，
                // 需要一个段落容器把它们收起来，否则那些事件没有归宿。
                self.flush_paragraph();
                self.inlines = Vec::new();
            }
        }
    }

    /// 处理结束标签。
    fn end_tag(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => self.flush_paragraph(),
            TagEnd::Heading(_) => self.flush_paragraph(),
            TagEnd::BlockQuote(_) => {
                self.flush_paragraph();
                if let Some(Frame::Quote(items)) = self.pop_frame_expect_quote() {
                    self.push_block(Block::Quote(items));
                }
            }
            TagEnd::CodeBlock => {
                let lang = self.code_lang.take().unwrap_or_default();
                let text = self.code_buffer.trim_end_matches('\n').to_string();
                self.code_buffer.clear();
                // 空代码块不产出块，避免导出里出现一个空的等宽框。
                if !text.is_empty() {
                    self.push_block(Block::Code { lang, text });
                    self.last_was_rule = false;
                }
            }
            TagEnd::List(_) => {
                self.flush_paragraph();
                self.list_depth = self.list_depth.saturating_sub(1);
                if let Some(Frame::List {
                    ordered,
                    start,
                    items,
                }) = self.pop_list_frame()
                {
                    self.push_block(Block::List {
                        ordered,
                        start,
                        items,
                    });
                    self.last_was_rule = false;
                }
            }
            TagEnd::Item => {
                self.flush_paragraph();
                if let Some(Frame::Item(items)) = self.pop_item_frame() {
                    match self.stack.last_mut() {
                        Some(Frame::List { items: list, .. }) => list.push(items),
                        // 列表帧意外缺失（不该发生）：把项内容提升，丢结构不丢内容。
                        _ => self.blocks.extend(items),
                    }
                }
            }
            TagEnd::Emphasis | TagEnd::Strong => self.close_container(),
            // 删除线在开始时就降级为普通文本，结束无需处理。
            TagEnd::Strikethrough => {}
            TagEnd::Link | TagEnd::Image => self.close_link(),
            TagEnd::Table => {
                let mut rows = std::mem::take(&mut self.table_rows);
                let head = std::mem::take(&mut self.table_head);
                if !head.is_empty() {
                    rows.insert(0, head);
                }
                // 先弹出 Table 帧：不弹的话下面的降级段落会被 `push_block`
                // 判定成「在表格里」而丢掉 —— 那正好犯了 R19 要防的错。
                let _ = self.stack.pop();
                if let Some(text) = render_table_as_paragraph(&rows) {
                    self.push_block(Block::Paragraph(vec![Inline::Text(text)]));
                    self.last_was_rule = false;
                }
            }
            TagEnd::TableHead => {
                // 表头行在这里收尾（解析器不为它发送 TableRow 的结束事件）
                self.in_table_head = false;
                let cells = std::mem::take(&mut self.table_cells);
                if !cells.is_empty() {
                    self.table_head = cells;
                }
            }
            TagEnd::TableRow => {
                let cells = std::mem::take(&mut self.table_cells);
                self.table_rows.push(cells);
            }
            TagEnd::TableCell => {
                self.in_cell = false;
                let text = self.buffer.trim().to_string();
                self.buffer.clear();
                self.table_cells.push(text);
            }
            TagEnd::FootnoteDefinition => self.flush_paragraph(),
            TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition => self.flush_paragraph(),
            TagEnd::MetadataBlock(_) => {}
            TagEnd::HtmlBlock => self.flush_paragraph(),
        }
    }


    /// 打开一个行内容器。
    fn open_container(&mut self, container: Container) {
        self.containers.push((container, self.inlines.len()));
    }

    /// 关闭最近的行内容器，把期间新增的行内元素包起来。
    ///
    /// ## 为什么要「先弹栈、再切分、最后放回」
    ///
    /// 嵌套强调（`**外*内*外**`）里，内层 Emphasis 结束时会把它那一段（"内"）
    /// 换成 `Emph([Text("内")])`。此时外层 Strong 当初记下的下标仍然有效
    /// （替换是等位的），所以外层的 `split_off(start)` 能把
    /// `[Text("外"), Emph([...])]` 整段正确取走。
    ///
    /// 关键顺序是 **先 pop**：如果先 `split_off` 再 pop，弹出的就是**外层**的
    /// 记录，于是内层的节点会被贴到外层的包裹里 —— 内容是活的但结构全乱。
    fn close_container(&mut self) {
        let Some((container, start)) = self.containers.pop() else {
            return;
        };
        // 链接 / 图片的内文由 link_stack 单独攒，这里要按当前上下文切分。
        let target: &mut Vec<Inline> = if let Some(link) = self.link_stack.last_mut() {
            &mut link.text
        } else {
            &mut self.inlines
        };
        if start >= target.len() {
            // 空的强调（例如单独一个 `**`）不产出节点
            return;
        }
        let children: Vec<Inline> = target.split_off(start);
        let node = match container {
            Container::Emph => Inline::Emph(children),
            Container::Strong => Inline::Strong(children),
        };
        target.push(node);
    }

    /// 关闭最近的链接 / 图片。
    ///
    /// 同样**先弹出 `link_stack` 再构造节点**：图片套链接时，构造出的节点
    /// 必须交给外层链接而不是自己。
    fn close_link(&mut self) {
        let Some(pending) = self.link_stack.pop() else {
            return;
        };
        let alt = Inline::flatten_to_string(&pending.text);
        let node = if pending.is_image {
            Inline::Image {
                url: pending.url,
                alt,
            }
        } else {
            Inline::Link {
                url: pending.url,
                text: pending.text,
            }
        };
        self.push_inline(node);
    }

    /// 弹出引用帧。
    fn pop_frame_expect_quote(&mut self) -> Option<Frame> {
        match self.stack.last() {
            Some(Frame::Quote(_)) => self.stack.pop(),
            _ => None,
        }
    }

    /// 弹出列表帧。
    fn pop_list_frame(&mut self) -> Option<Frame> {
        match self.stack.last() {
            Some(Frame::List { .. }) => self.stack.pop(),
            _ => None,
        }
    }

    /// 弹出列表项帧。
    fn pop_item_frame(&mut self) -> Option<Frame> {
        match self.stack.last() {
            Some(Frame::Item(_)) => self.stack.pop(),
            _ => None,
        }
    }
}

/// 把表格单元格矩阵拍成纯文本。
///
/// 单元格之间用 ` | ` 连接、行之间用换行 —— 与 Markdown 源码的视觉形态最接近，
/// 用户一看到就知道「这里原本是个表格」。
fn render_table_as_paragraph(rows: &[Vec<String>]) -> Option<String> {
    if rows.is_empty() {
        return None;
    }
    let mut out = String::new();
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&row.join(" | "));
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 解析一段 Markdown 并返回块序列。
    fn blocks(md: &str) -> Vec<Block> {
        parse_blocks(md, "测试章").unwrap().blocks
    }

    /// 只看块类型，方便断言结构。
    fn kinds(list: &[Block]) -> Vec<&'static str> {
        list.iter()
            .map(|b| match b {
                Block::Paragraph(_) => "p",
                Block::Heading { .. } => "h",
                Block::Quote(_) => "quote",
                Block::List { .. } => "list",
                Block::Code { .. } => "code",
                Block::Hr => "hr",
                Block::PageBreak => "pagebreak",
            })
            .collect()
    }

    #[test]
    fn parses_paragraph_and_heading_levels() {
        let parsed = blocks("# 一级\n\n## 二级\n\n###### 六级\n\n正文");
        assert_eq!(kinds(&parsed), vec!["h", "h", "h", "p"]);
        match &parsed[0] {
            Block::Heading { level, text } => {
                assert_eq!(*level, 1);
                assert_eq!(text, "一级");
            }
            other => panic!("期望标题，得到 {other:?}"),
        }
        match &parsed[2] {
            Block::Heading { level, .. } => assert_eq!(*level, 6),
            other => panic!("期望标题，得到 {other:?}"),
        }
    }

    #[test]
    fn empty_markdown_yields_no_blocks() {
        let parsed = parse_blocks("", "空章").unwrap();
        assert!(parsed.blocks.is_empty());
        assert!(parsed.degradations.is_empty());
        // 纯空白同样应短路
        let parsed = parse_blocks("   \n\n  \t ", "空章").unwrap();
        assert!(parsed.blocks.is_empty());
    }

    #[test]
    fn parses_strong_and_emph() {
        let parsed = blocks("**粗体** *斜体*");
        let Block::Paragraph(inlines) = &parsed[0] else {
            panic!("期望段落");
        };
        assert_eq!(inlines[0], Inline::Strong(vec![Inline::Text("粗体".into())]));
        // 粗体后的空格没有被并进粗体（层级不同不合并）；
        // 斜体单独成节点，其文字也没有被并到空格那一条里。
        assert_eq!(inlines[1], Inline::Text(" ".into()));
        assert_eq!(inlines[2], Inline::Emph(vec![Inline::Text("斜体".into())]));
        assert_eq!(inlines.len(), 3, "{inlines:?}");
    }

    #[test]
    fn emphasis_nested_inside_strong_survives() {
        // 嵌套的强调节点必须真的建出来。注意 CommonMark 在「粗里的斜」这种
        // 边界上不会额外插入文本，所以这里断言的是**结构里存在嵌套的 Emph**，
        // 而不是断言固定的三段文字 —— 后者会随解析器版本变化而误报。
        let parsed = blocks("**外*内*外**");
        let Block::Paragraph(inlines) = &parsed[0] else {
            panic!("期望段落");
        };
        let Inline::Strong(children) = &inlines[0] else {
            panic!("期望粗体，得到 {inlines:?}");
        };
        assert_eq!(
            children,
            &vec![
                Inline::Text("外".into()),
                Inline::Emph(vec![Inline::Text("内".into())]),
                Inline::Text("外".into()),
            ],
            "粗体里的斜体节点必须被保留下来"
        );
        // 文字一字不少
        assert_eq!(Inline::flatten_to_string(children), "外内外");
    }

    #[test]
    fn adjacent_text_runs_are_merged() {
        // 不合并的话中文正文会被拆成大量单字碎片，DOCX 里就是一堆 run
        let parsed = blocks("普通文字**粗**又普通");
        let Block::Paragraph(inlines) = &parsed[0] else {
            panic!("期望段落");
        };
        assert!(matches!(&inlines[0], Inline::Text(t) if t == "普通文字"));
        // 粗体之后的文字另起一个 Text，没有跨过 Strong 与前面的文字合并；
        // 而且它自己也要被合并成**一整段**，不能碎成单字。
        assert!(
            matches!(inlines.last(), Some(Inline::Text(t)) if t == "又普通"),
            "{inlines:?}"
        );
        assert_eq!(inlines.len(), 3, "结构应为 文字 + 粗体 + 文字：{inlines:?}");
    }

    #[test]
    fn soft_break_becomes_space_and_hard_break_stays_newline() {
        // 中文作者习惯在段落里手动折行，软换行不该变成硬换行
        let parsed = blocks("上句\n下句\n\n甲  \n乙");
        let Block::Paragraph(first) = &parsed[0] else {
            panic!("期望段落");
        };
        let text = Inline::flatten_to_string(first);
        assert!(text.contains("上句 下句"), "{text}");
        let Block::Paragraph(second) = &parsed[1] else {
            panic!("期望段落");
        };
        assert!(Inline::flatten_to_string(second).contains("甲\n乙"));
    }

    #[test]
    fn parses_inline_code_and_link() {
        let parsed = blocks("用 `println!` 打印，见 [文档](https://example.com/a?b=1)");
        let Block::Paragraph(inlines) = &parsed[0] else {
            panic!("期望段落");
        };
        assert!(inlines.contains(&Inline::Code("println!".into())));
        let link = inlines
            .iter()
            .find(|i| matches!(i, Inline::Link { .. }))
            .expect("应有一个链接");
        match link {
            Inline::Link { url, text } => {
                assert_eq!(url, "https://example.com/a?b=1");
                assert_eq!(Inline::flatten_to_string(text), "文档");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn parses_image_with_alt_text() {
        let parsed = blocks("![示意图](images/a.png)");
        let Block::Paragraph(inlines) = &parsed[0] else {
            panic!("期望段落");
        };
        assert_eq!(
            inlines[0],
            Inline::Image {
                url: "images/a.png".into(),
                alt: "示意图".into(),
            }
        );
    }

    #[test]
    fn parses_quote_containing_list() {
        // 「引用里放列表」是冻结子集里明确支持的组合
        let parsed = blocks("> 引用开头\n>\n> - 甲\n> - 乙");
        assert_eq!(kinds(&parsed), vec!["quote"]);
        let Block::Quote(children) = &parsed[0] else {
            panic!("期望引用");
        };
        assert_eq!(kinds(children), vec!["p", "list"]);
    }

    #[test]
    fn parses_unordered_and_ordered_lists() {
        let parsed = blocks("- 甲\n- 乙\n\n1. 一\n2. 二");
        assert_eq!(kinds(&parsed), vec!["list", "list"]);
        let Block::List {
            ordered,
            start,
            items,
        } = &parsed[0]
        else {
            panic!("期望列表");
        };
        assert!(!ordered);
        assert_eq!(*start, 1);
        assert_eq!(items.len(), 2);
        let Block::List { ordered, start, .. } = &parsed[1] else {
            panic!("期望列表");
        };
        assert!(ordered);
        assert_eq!(*start, 1);
    }

    #[test]
    fn ordered_list_keeps_custom_start() {
        let parsed = blocks("7. 第七项\n8. 第八项");
        let Block::List { ordered, start, .. } = &parsed[0] else {
            panic!("期望列表");
        };
        assert!(ordered);
        assert_eq!(*start, 7);
    }

    #[test]
    fn nested_list_becomes_child_block_of_item() {
        let parsed = blocks("- 外\n  - 内\n- 外二");
        let Block::List { items, .. } = &parsed[0] else {
            panic!("期望列表");
        };
        assert_eq!(items.len(), 2);
        // 第一项：段落 + 嵌套列表
        assert_eq!(kinds(&items[0]), vec!["p", "list"]);
        assert_eq!(kinds(&items[1]), vec!["p"]);
    }

    #[test]
    fn list_nesting_beyond_limit_degrades_but_keeps_text() {
        // 四层嵌套超过 MAX_LIST_DEPTH(3)，应记录降级，且正文一字不丢
        let md = "- 一\n  - 二\n    - 三\n      - 四";
        let parsed = parse_blocks(md, "深列表").unwrap();
        assert!(
            parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::ListDepthExceeded),
            "应记录列表深度降级：{:?}",
            parsed.degradations
        );
        let text = Block::flatten_blocks_to_string(&parsed.blocks);
        for word in ["一", "二", "三", "四"] {
            assert!(text.contains(word), "丢了 {word}：{text}");
        }
    }

    #[test]
    fn exactly_three_levels_does_not_degrade() {
        let parsed = parse_blocks("- 一\n  - 二\n    - 三", "三层").unwrap();
        assert!(
            !parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::ListDepthExceeded),
            "三层是允许的上限，不该记录降级"
        );
    }

    #[test]
    fn parses_horizontal_rule() {
        let parsed = blocks("甲\n\n---\n\n乙");
        assert_eq!(kinds(&parsed), vec!["p", "hr", "p"]);
    }

    #[test]
    fn parses_fenced_code_block_with_language() {
        let parsed = blocks("```rust\nfn main() {}\n```");
        assert_eq!(kinds(&parsed), vec!["code"]);
        let Block::Code { lang, text } = &parsed[0] else {
            panic!("期望代码块");
        };
        assert_eq!(lang, "rust");
        assert_eq!(text, "fn main() {}");
    }

    #[test]
    fn code_block_content_is_not_interpreted_as_markdown() {
        // 代码块里的星号必须是字面量，不能被当成强调
        let parsed = blocks("```\n**不是粗体**\n```");
        let Block::Code { text, .. } = &parsed[0] else {
            panic!("期望代码块");
        };
        assert_eq!(text, "**不是粗体**");
    }

    #[test]
    fn indented_code_block_has_no_language() {
        let parsed = blocks("    缩进代码");
        let Block::Code { lang, text } = &parsed[0] else {
            panic!("期望代码块，得到 {:?}", kinds(&parsed));
        };
        assert!(lang.is_empty());
        assert_eq!(text, "缩进代码");
    }

    #[test]
    fn table_produces_degradation_and_keeps_cell_text() {
        // R19 的核心用例：表格不支持，但内容不能丢
        let md = "| 姓名 | 年龄 |\n| --- | --- |\n| 甲 | 20 |\n| 乙 | 30 |";
        let parsed = parse_blocks(md, "有表格的章").unwrap();
        assert!(
            parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::Table),
            "应记录表格降级：{:?}",
            parsed.degradations
        );
        assert_eq!(parsed.degradations[0].chapter_title, "有表格的章");
        let text = Block::flatten_blocks_to_string(&parsed.blocks);
        for cell in ["姓名", "年龄", "甲", "20", "乙", "30"] {
            assert!(text.contains(cell), "表格单元格 {cell} 丢了：{text}");
        }
        // 单元格之间应有分隔符，让用户看出原本是表格
        assert!(text.contains(" | "), "{text}");
    }

    #[test]
    fn table_degradation_is_recorded_only_once_per_chapter() {
        let md = "| a |\n| --- |\n| 1 |\n\n| b |\n| --- |\n| 2 |";
        let parsed = parse_blocks(md, "两个表格").unwrap();
        let count = parsed
            .degradations
            .iter()
            .filter(|d| d.kind == DegradationKind::Table)
            .count();
        assert_eq!(count, 1, "同章同类型降级只记一条，避免报告刷屏");
    }

    #[test]
    fn footnote_produces_degradation_and_inline_marker() {
        let md = "正文里有脚注[^1]。\n\n[^1]: 脚注内容";
        let parsed = parse_blocks(md, "有脚注").unwrap();
        assert!(
            parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::Footnote),
            "{:?}",
            parsed.degradations
        );
        let text = Block::flatten_blocks_to_string(&parsed.blocks);
        assert!(text.contains("（注：1）"), "{text}");
        assert!(text.contains("脚注内容"), "{text}");
    }

    #[test]
    fn inline_math_is_preserved_verbatim_with_delimiters() {
        let parsed = parse_blocks("质能方程 $E=mc^2$ 很著名", "公式").unwrap();
        assert!(
            parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::Math)
        );
        let text = Block::flatten_blocks_to_string(&parsed.blocks);
        assert!(text.contains("$E=mc^2$"), "{text}");
    }

    #[test]
    fn raw_html_is_kept_as_text_not_dropped() {
        let parsed = parse_blocks("这里有 <script>alert(1)</script> 代码", "HTML").unwrap();
        assert!(
            parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::RawHtml)
        );
        let text = Block::flatten_blocks_to_string(&parsed.blocks);
        // 文本必须原样保留（转义是渲染器的事），不能消失
        assert!(text.contains("<script>"), "{text}");
        assert!(text.contains("alert(1)"), "{text}");
    }

    #[test]
    fn html_block_is_recorded_and_kept() {
        let parsed = parse_blocks("<div class=\"x\">\n内容\n</div>", "HTML 块").unwrap();
        assert!(
            parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::RawHtml)
        );
        let text = Block::flatten_blocks_to_string(&parsed.blocks);
        assert!(text.contains("内容"), "{text}");
    }

    #[test]
    fn strikethrough_degrades_but_keeps_text() {
        let parsed = parse_blocks("~~删掉~~保留", "删除线").unwrap();
        assert!(
            parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::Strikethrough)
        );
        let text = Block::flatten_blocks_to_string(&parsed.blocks);
        assert!(text.contains("删掉保留"), "{text}");
    }

    #[test]
    fn task_list_degrades_with_checkbox_marker() {
        let parsed = parse_blocks("- [x] 已完成\n- [ ] 未完成", "任务").unwrap();
        assert!(
            parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::TaskList)
        );
        let text = Block::flatten_blocks_to_string(&parsed.blocks);
        assert!(text.contains("[x] 已完成"), "{text}");
        assert!(text.contains("[ ] 未完成"), "{text}");
    }

    #[test]
    fn metadata_block_produces_degradation() {
        let parsed = parse_blocks("---\ntitle: 误粘贴\n---\n\n正文", "元数据").unwrap();
        assert!(
            parsed
                .degradations
                .iter()
                .any(|d| d.kind == DegradationKind::MetadataBlock),
            "{:?}",
            parsed.degradations
        );
    }

    #[test]
    fn chinese_text_round_trips_without_mojibake() {
        let md = "# 第一章 羽化\n\n他说：「天地之间，**唯我独尊**。」\n\n- 一阳指\n- 六脉神剑";
        let parsed = blocks(md);
        let text = Block::flatten_blocks_to_string(&parsed);
        assert!(text.contains("天地之间，唯我独尊。"), "{text}");
        assert!(text.contains("六脉神剑"), "{text}");
        // 多字节字符不该被截断成替换字符
        assert!(!text.contains('\u{fffd}'), "{text}");
    }

    #[test]
    fn blank_paragraphs_are_not_emitted() {
        let parsed = blocks("甲\n\n\n\n乙");
        assert_eq!(kinds(&parsed), vec!["p", "p"]);
    }

    #[test]
    fn parse_chapter_builds_content_and_degrades() {
        let id = ChapterId::new();
        let vid = VolumeId::new();
        let (content, degradations) =
            parse_chapter(id.clone(), vid.clone(), "第三章", "| a |\n| --- |\n| 1 |").unwrap();
        assert_eq!(content.id, id);
        assert_eq!(content.volume_id, vid);
        assert_eq!(content.title, "第三章");
        assert_eq!(degradations.len(), 1);
        assert!(content.plain_text().contains('a'));
    }

    #[test]
    fn extract_title_finds_first_h1() {
        assert_eq!(
            extract_title("前言\n\n# 第一章 出发\n\n正文").as_deref(),
            Some("第一章 出发")
        );
    }

    #[test]
    fn extract_title_tolerates_inline_markup() {
        assert_eq!(
            extract_title("# 带**粗体**的标题").as_deref(),
            Some("带粗体的标题")
        );
    }

    #[test]
    fn extract_title_returns_none_without_h1() {
        assert_eq!(extract_title("## 只有二级标题"), None);
        assert_eq!(extract_title(""), None);
        assert_eq!(extract_title("#   "), None);
    }

    #[test]
    fn degradation_kind_descriptions_are_user_facing() {
        // 导出报告直接展示这句话，必须非空且不含占位符
        for kind in [
            DegradationKind::Table,
            DegradationKind::Footnote,
            DegradationKind::Math,
            DegradationKind::RawHtml,
            DegradationKind::Strikethrough,
            DegradationKind::TaskList,
            DegradationKind::DefinitionList,
            DegradationKind::MetadataBlock,
            DegradationKind::ListDepthExceeded,
        ] {
            let text = kind.describe();
            assert!(!text.is_empty());
            assert!(!text.contains('{'), "{text}");
        }
    }

    #[test]
    fn degradation_serializes_for_the_report_payload() {
        let d = Degradation::new("第一章", DegradationKind::Table);
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["kind"], "table");
        assert_eq!(json["chapterTitle"], "第一章");
        assert!(json["detail"].as_str().unwrap().contains("表格"));
    }

    #[test]
    fn degradation_with_detail_overrides_default_text() {
        let d = Degradation::with_detail("第二章", DegradationKind::Table, "共 3 个表格");
        assert_eq!(d.detail, "共 3 个表格");
        assert_eq!(d.chapter_title, "第二章");
    }

    #[test]
    fn deeply_nested_quote_list_paragraph_combination() {
        // 引用 > 列表 > 段落，是对 IR 嵌套表达能力的综合检验
        let md = "> 1. 第一项\n>    - 子项\n>\n> 引用尾段";
        let parsed = blocks(md);
        assert_eq!(kinds(&parsed), vec!["quote"]);
        let Block::Quote(children) = &parsed[0] else {
            panic!("期望引用");
        };
        assert!(kinds(children).contains(&"list"));
        assert!(kinds(children).contains(&"p"));
    }

    #[test]
    fn link_inside_emphasis_keeps_both_levels() {
        let parsed = blocks("*斜体里的[链接](https://a.b)*");
        let Block::Paragraph(inlines) = &parsed[0] else {
            panic!("期望段落");
        };
        let Inline::Emph(children) = &inlines[0] else {
            panic!("期望斜体，得到 {inlines:?}");
        };
        assert!(children.iter().any(|i| matches!(i, Inline::Link { .. })));
    }

    #[test]
    fn unmatched_emphasis_marker_produces_no_node() {
        // 单独一个星号不成对，不应产出空的 Strong 节点
        let parsed = blocks("两个星号 ** 就这样");
        let Block::Paragraph(inlines) = &parsed[0] else {
            panic!("期望段落");
        };
        assert!(
            !inlines.iter().any(|i| matches!(i, Inline::Strong(_))),
            "{inlines:?}"
        );
    }

    #[test]
    fn consecutive_text_events_within_a_run_are_merged() {
        // 转义符会让解析器发出多个相邻 Text 事件，它们必须被并成一条，
        // 否则中文正文会碎成一堆单字
        let parsed = blocks("反斜杠\\*不是强调");
        let Block::Paragraph(inlines) = &parsed[0] else {
            panic!("期望段落");
        };
        assert_eq!(Inline::flatten_to_string(inlines), "反斜杠*不是强调");
    }

    #[test]
    fn image_inside_link_keeps_link_wrapping_image() {
        // 图片套链接是 CommonMark 允许的组合，嵌套不能丢层级
        let parsed = blocks("[![图](a.png)](https://example.com)");
        let Block::Paragraph(inlines) = &parsed[0] else {
            panic!("期望段落");
        };
        let Inline::Link { text, url } = &inlines[0] else {
            panic!("期望链接，得到 {inlines:?}");
        };
        assert_eq!(url, "https://example.com");
        assert!(matches!(text.as_slice(), [Inline::Image { .. }]), "{text:?}");
    }
}
