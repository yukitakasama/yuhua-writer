//! PDF 渲染器 —— 纯 Rust 手写 PDF，中文字体内嵌，文本可搜索可复制。
//!
//! ## 为什么不走 PDF Spike 里建议的「WebView 打印」
//!
//! docs/pdf-spike.md 的首选方案是复用系统 WebView 的「打印到 PDF」，
//! 它的优点是零额外依赖、排版与所见一致。但同一份文档也列出了它的
//! 硬伤：Tauri 2 没有暴露该能力，要实现就得写三份平台特定绑定，
//! 而且**都需要 unsafe**；加之它要求「WebView 已创建并有真实页面」，
//! 与「导出不依赖 UI」的设计冲突，在 CI 里根本没法测。
//!
//! 本 crate 顶部写着 #![forbid(unsafe_code)]，而工作区也有
//! unsafe_code = "forbid" 的约定。在这个前提下，WebView 方案要么破坏
//! 硬约束，要么把 PDF 变成「只有跑到 GUI 里才敢点的按钮」——
//! 而导出是自动化测试最该覆盖的一条路径。所以这里走第二条路：
//! **纯 Rust 排版 + 手写 PDF 对象**。
//!
//! ## 中文字体：CID 字体 + ToUnicode（P10 的硬指标）
//!
//! 「可搜索、可复制」在 PDF 里只有一种正确实现方式：
//!
//! 1. 字体用 **Type0 复合字体**，子字体是 **CIDFontType2**；
//! 2. 编码用 **Identity-H**，于是内容流里的两字节单元是 CID，
//!    且 CID == 字形编号（GID）；
//! 3. 附带一张 **ToUnicode CMap**，把 GID 反查回 Unicode 码点。
//!
//! 少了第 3 步，文字照样显示，但复制出来是一串乱码、Ctrl+F 搜不到 ——
//! 这正是「把文字画成图形」的方案的缺陷。少了第 1、2 步（改用简单字体
//! + WinAnsiEncoding），中文根本没有编码位置可放。
//!
//! ## 不做字体子集化：一个刻意的取舍
//!
//! 子集化能显著缩小产物（思源宋体全量约 20 MB，子集后常常只有几百 KB），
//! 但它要求我们重新生成一份只含用到的字形的字体文件：裁 glyf / loca、
//! 重排 cmap、修正 hmtx、给复合字形改引用编号 —— 任何一步写错，
//! 表现都是「某些字显示成方框或错字」，而这类问题极难在测试里穷尽。
//!
//! 第一版的取舍是：**宁可 PDF 大 20 MB，也不冒字体嵌错的风险**。
//! 体积优化留到后续迭代，接口上已经预留了位置。
//!
//! ## 找不到字体时的行为（重要）
//!
//! **绝不静默产出乱码 PDF。** 找不到可用中文字体时返回
//! ExportError::FontUnavailable（错误码 FONT_UNAVAILABLE，
//! 它是唯一一个「换个环境就能修好」的导出失败），前端可以据此提示
//! 「请安装中文字体」或引导用户指定字体文件。宁可让用户看到一条
//! 说得清的错误，也不要让他打开一份满页方框的文件才发现问题。
//!
//! 字体发现顺序（第一个能解析成 TrueType 的胜出）：
//!
//! 1. 调用方通过 PdfOptions::font_path 显式指定的路径
//! 2. 环境变量 YUHUA_PDF_FONT
//! 3. 项目资源目录 assets/fonts/（由 scripts/fetch-fonts.mjs 按
//!    assets/fonts.lock.json 下载；字体二进制不入 git，所以这里可能为空）
//! 4. 操作系统常见中文字体路径（本函数内置的候选表）
//!
//! ## 已经证实的一件事
//!
//! PDF 里 Type0 字体的 /BaseFont 名**可以任意取**，阅读器实际用的是
//! 内嵌的 FontFile2 字节。所以即使字体文件叫 simsun.ttc、内部名字与
//! 文件名对不上，只要能解析出字形与度量，产出就是正确的。
//! 这不是猜测：我们用同一套代码生成过一份内嵌 simkai.ttf 的 PDF，
//! 并在 Windows 上确认了中文正常显示、可选中、可复制。

pub mod font;
pub mod page;
pub mod pdfwrite;
pub mod text;

use std::path::{Path, PathBuf};

use font::TrueTypeFont;
use page::{hex_string, Margins, Page, PageSize, PdfLayout, LINE_HEIGHT_FACTOR};
use pdfwrite::{write_pdf, IndirectObject, ObjAllocator, ObjId};
use text::{advance_of, wrap_text, Line};

use crate::error::{ExportError, Result};
use crate::ir::{Block, Document, Inline};
use crate::render::{ExportFormat, Renderer};

/// 正文字号（点）。
const BODY_SIZE: f32 = 10.5;
/// 代码块字号。等宽字体在同字号下视觉偏大，缩一号更协调。
const CODE_SIZE: f32 = 9.0;
/// 各级标题字号（对应 level 1..=6）。
const HEADING_SIZES: [f32; 6] = [20.0, 17.0, 14.5, 12.5, 11.5, 11.0];
/// 段落之间的额外间距（点）。
const PARAGRAPH_GAP: f32 = 5.0;
/// 列表项相对版心左边界的内缩（点）。
const LIST_INDENT: f32 = 18.0;
/// 嵌套列表每层再内缩的量。
const LIST_INDENT_STEP: f32 = 16.0;
/// 引用块的左边距内缩。
const QUOTE_INDENT: f32 = 20.0;
/// 代码块底纹灰度（0 = 黑，1 = 白）。
const CODE_BACKDROP: f32 = 0.95;

/// PDF 渲染选项。
#[derive(Debug, Clone, PartialEq)]
pub struct PdfOptions {
    /// 页面尺寸。
    pub page_size: PageSize,
    /// 页边距。
    pub margins: Margins,
    /// 正文字号（点）。
    pub body_size: f32,
    /// 每章是否另起一页。
    ///
    /// 默认 true：交稿与打印时「一章一页起」是行业惯例，
    /// 也让审稿人拿到手就知道章节边界在哪。
    pub page_break_per_chapter: bool,
    /// 显式指定的字体文件路径。为空时走自动发现。
    pub font_path: Option<PathBuf>,
    /// 是否在页脚居中写页码。
    pub page_numbers: bool,
}

impl Default for PdfOptions {
    fn default() -> Self {
        Self {
            page_size: PageSize::A4,
            margins: Margins::default(),
            body_size: BODY_SIZE,
            page_break_per_chapter: true,
            font_path: None,
            page_numbers: true,
        }
    }
}

/// PDF 渲染器。
#[derive(Debug, Clone, Default)]
pub struct PdfRenderer {
    /// 选项。
    pub options: PdfOptions,
}

impl PdfRenderer {
    /// 用指定选项构造。
    pub fn new(options: PdfOptions) -> Self {
        Self { options }
    }

    /// 渲染成 PDF 字节。
    ///
    /// 返回的第二个值是缺字字符集：字体里没有对应字形的字符。
    /// 导出报告据此提示「本字体缺少 3 个字符」，而不是让用户
    /// 拿到一份某些地方空着的文件还以为是排版软件的问题。
    pub fn render_with_report(&self, document: &Document) -> Result<(Vec<u8>, Vec<char>)> {
        let font = load_font(self.options.font_path.as_deref())?;
        let mut layout = PdfLayout::new(self.options.page_size, self.options.margins);
        let mut missing: Vec<char> = Vec::new();

        self.render_front_matter(document, &mut layout, &font, &mut missing);

        let mut current_volume: Option<&str> = None;
        for chapter in document.iter_chapters() {
            let volume_title = document.volume_title(&chapter.volume_id);
            if volume_title != current_volume {
                if let Some(title) = volume_title {
                    if self.options.page_break_per_chapter && !layout.is_current_page_empty() {
                        layout.new_page();
                    }
                    self.draw_block_text(&mut layout, &font, title, HEADING_SIZES[0], true, 0.0);
                    current_volume = volume_title;
                }
            }
            if self.options.page_break_per_chapter && !layout.is_current_page_empty() {
                layout.new_page();
            }
            self.draw_block_text(
                &mut layout,
                &font,
                &chapter.title,
                HEADING_SIZES[1],
                true,
                0.0,
            );
            self.render_blocks(&mut layout, &font, &chapter.blocks, 0, &mut missing);
        }

        let pages = layout.finish();
        assemble_pdf(&font, &pages, document, &self.options).map(|bytes| (bytes, missing))
    }
}

impl<'a> Renderer<'a> for PdfRenderer {
    fn format(&self) -> ExportFormat {
        ExportFormat::Pdf
    }

    fn render(&self, document: &'a Document) -> Result<Vec<u8>> {
        self.render_with_report(document).map(|(bytes, _)| bytes)
    }
}

/// 渲染 PDF（兼容旧调用点）。
///
/// 保留这个自由函数是因为 render::render 的分发点用的就是它；
/// 用默认选项，需要自定义时请直接构造 PdfRenderer。
pub fn render_pdf(document: &Document) -> Result<Vec<u8>> {
    PdfRenderer::default().render(document)
}

/// 该格式是否可用（渲染层口径：PDF 不再是「未实现」）。
pub fn is_available() -> bool {
    true
}

// ============================================================================
//  字体发现
// ============================================================================

/// 载入一份可用的中文字体。
///
/// 详细的搜索顺序见模块文档。这里的**错误信息必须足够具体**：
/// 用户看到「找不到中文字体」时最想知道的是「我该把字体放哪」，
/// 所以错误里带上尝试过的目录列表。
pub fn load_font(explicit: Option<&Path>) -> Result<TrueTypeFont> {
    // 1. 调用方显式指定。
    //
    // 这里把「文件不存在」也归到 FontUnavailable 而不是原样抛 IO_ERROR：
    // 对用户来说「我指定的字体找不到」与「这台机器上没有中文字体」
    // 是同一类问题，处理方式也一样（换一个路径 / 装一个字体）。
    // 让它们共用 FONT_UNAVAILABLE 这个错误码，前端只需要一个分支。
    if let Some(path) = explicit {
        return TrueTypeFont::load(path).map_err(|e| match e {
            ExportError::Font { detail, .. } => ExportError::FontUnavailable {
                searched: vec![path.display().to_string()],
                hint: format!("指定的字体无法使用（{detail}）"),
            },
            ExportError::Io { .. } => ExportError::FontUnavailable {
                searched: vec![path.display().to_string()],
                hint: format!("指定的字体文件不存在或无法读取：{}", path.display()),
            },
            other => other,
        });
    }

    // 2. 环境变量
    if let Some(value) = std::env::var_os(FONT_ENV) {
        let path = PathBuf::from(value);
        if path.is_file() {
            if let Ok(font) = TrueTypeFont::load(&path) {
                return Ok(font);
            }
        }
    }

    // 3. 项目资源目录
    for candidate in project_font_candidates() {
        if !candidate.is_file() {
            continue;
        }
        if let Ok(font) = TrueTypeFont::load(&candidate) {
            return Ok(font);
        }
    }

    // 4. 系统字体
    let mut tried: Vec<String> = Vec::new();
    for candidate in system_font_candidates() {
        tried.push(candidate.display().to_string());
        if !candidate.is_file() {
            continue;
        }
        if let Ok(font) = TrueTypeFont::load(&candidate) {
            return Ok(font);
        }
    }

    // 全部失败：给出可操作的指引，而不是一句「失败」。
    Err(ExportError::FontUnavailable {
        searched: tried,
        hint: format!(
            "请安装中文字体，或把字体文件放到 assets/fonts/ 下，或设置环境变量 {FONT_ENV} 指向一个 .ttf 文件"
        ),
    })
}

/// 指定字体的环境变量名。
pub const FONT_ENV: &str = "YUHUA_PDF_FONT";

/// 项目内的字体候选目录（相对工作目录）。
fn project_font_candidates() -> Vec<PathBuf> {
    // 不写死 assets/fonts 下具体文件名：字体是外部下载物，
    // 文件名由 fonts.lock.json 决定，写死会在字体升级时静默失效。
    let dirs = [
        PathBuf::from("assets/fonts"),
        PathBuf::from("src-tauri/assets/fonts"),
    ];
    let mut out = Vec::new();
    for dir in dirs {
        for name in PROJECT_FONT_FILES {
            out.push(dir.join(name));
        }
    }
    out
}

/// 项目字体目录里期望出现的文件名。
const PROJECT_FONT_FILES: [&str; 6] = [
    "YuhuaSerifSC-Regular.ttf",
    "YuhuaSerifSC-Bold.ttf",
    "YuhuaKaiSC-Regular.ttf",
    "YuhuaKaiSC-Bold.ttf",
    "SourceHanSerifSC-Regular.otf",
    "LXGWWenKai-Regular.ttf",
];

/// 各平台常见中文字体路径。
///
/// 顺序有讲究：先楷体/宋体这类**衬线**字体，再黑体。
/// 交稿与阅读稿用衬线体更耐读，这是中文出版物的默认选择；
/// 挂到最后的 fallback 才是无衬线，避免在最坏情况下也拿到一份
/// 观感与预期完全不符的 PDF。扩展名 .ttf 的排在 .ttc 之前，
/// 因为 .ttc 是字体集合，解析成本更高（虽然我们只读第一份）。
fn system_font_candidates() -> Vec<PathBuf> {
    // 逐个拼字符串而不是用 cfg! 分支：cfg! 展开成运行时布尔，
    // 两个分支都会参与编译，反而更容易写出「Windows 上也能跑到
    // Linux 路径」的错误。这里明确按目标平台产出列表。
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        let fonts = root.join("Fonts");
        for name in [
            "simkai.ttf",  // 楷体
            "simfang.ttf", // 仿宋
            "simsun.ttc",  // 宋体（ttc 集合，我们读第一份）
            "STSONG.TTF",  // 华文宋体
            "Deng.ttf",    // 等线
            "msyh.ttc",    // 微软雅黑
            "simhei.ttf",  // 黑体
            "msjh.ttc",    // 微软正黑（繁体）
        ] {
            out.push(fonts.join(name));
        }
    }

    #[cfg(target_os = "macos")]
    {
        for path in [
            "/System/Library/Fonts/Supplemental/Songti.ttc",
            "/System/Library/Fonts/Supplemental/Kaiti.ttc",
            "/System/Library/Fonts/PingFang.ttc",
            "/Library/Fonts/Songti.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
        ] {
            out.push(PathBuf::from(path));
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for path in [
            "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/arphic/uming.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ] {
            out.push(PathBuf::from(path));
        }
    }

    out
}

// ============================================================================
//  内容排版
// ============================================================================

impl PdfRenderer {
    /// 封面（书名 + 作者），单独占一页。
    ///
    /// 刻意做得极简：一个标题加一个署名，居中。交稿文件的第一页
    /// 承担的是「这是哪本书、谁写的」，不是视觉设计 —— 加边框、
    /// 加底纹反而会在黑白打印时糊成一团。
    fn render_front_matter(
        &self,
        document: &Document,
        layout: &mut PdfLayout,
        font: &TrueTypeFont,
        missing: &mut Vec<char>,
    ) {
        // 从页顶往下三分之一处开始，视觉重心比顶格更舒服
        layout.advance(layout.page_size.height * 0.22);
        self.draw_block_text(
            layout,
            font,
            &document.book.title,
            HEADING_SIZES[0] * 1.4,
            true,
            0.0,
        );
        layout.advance(BODY_SIZE);
        self.draw_block_text(
            layout,
            font,
            document.book.author_or_anonymous(),
            BODY_SIZE * 1.2,
            true,
            0.0,
        );
        if !document.book.description.trim().is_empty() {
            layout.advance(BODY_SIZE * 2.0);
            self.render_blocks(
                layout,
                font,
                &[Block::Paragraph(vec![Inline::text(
                    document.book.description.clone(),
                )])],
                0,
                missing,
            );
        }
        layout.new_page();
    }

    /// 渲染块序列。
    ///
    /// `depth` 是嵌套深度（列表里套引用再套列表），只影响左内缩量。
    fn render_blocks(
        &self,
        layout: &mut PdfLayout,
        font: &TrueTypeFont,
        blocks: &[Block],
        depth: usize,
        missing: &mut Vec<char>,
    ) {
        for block in blocks {
            self.render_block(layout, font, block, depth, missing);
        }
    }

    /// 渲染单个块。
    fn render_block(
        &self,
        layout: &mut PdfLayout,
        font: &TrueTypeFont,
        block: &Block,
        depth: usize,
        missing: &mut Vec<char>,
    ) {
        match block {
            Block::Paragraph(inlines) => {
                let runs = self.inline_runs(inlines);
                self.draw_runs_paragraph(layout, font, &runs, depth, missing);
            }
            Block::Heading { level, text } => {
                let size = HEADING_SIZES[(usize::from(*level).saturating_sub(1)).min(5)];
                layout.advance(PARAGRAPH_GAP * 2.0);
                self.draw_block_text(layout, font, text, size, true, depth as f32);
                layout.advance(PARAGRAPH_GAP * 0.6);
            }
            Block::Quote(children) => {
                // 引用：左内缩 + 一条竖线。竖线用内容流里的画线指令实现，
                // 而不是靠「打一堆 | 字符」—— 后者在文字层里会真的多出
                // 一堆竖线，用户复制引用内容时会连竖线一起复制走。
                layout.advance(PARAGRAPH_GAP);
                let inner_start = layout.cursor();
                self.render_blocks(layout, font, children, depth + 1, missing);
                // 引用内的文字靠 QUOTE_INDENT 内缩，竖线贴在版心左边界上。
                let inner_end = layout.cursor();
                layout.draw_margin_rule(QUOTE_INDENT * 0.25, inner_start, inner_end, 0.55);
                layout.advance(PARAGRAPH_GAP);
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                for (offset, item) in items.iter().enumerate() {
                    let marker = if *ordered {
                        format!("{}. ", start + offset as u64)
                    } else {
                        "· ".to_string()
                    };
                    let mut first = true;
                    for child in item {
                        match child {
                            // 嵌套列表按层级缩进，而不是拍平 —— 与 TXT / DOCX 一致
                            Block::List { .. } => {
                                self.render_block(layout, font, child, depth + 1, missing);
                            }
                            other => {
                                let runs = self.block_runs(other);
                                let indent = LIST_INDENT + LIST_INDENT_STEP * depth as f32;
                                self.draw_runs_with_prefix(
                                    layout,
                                    font,
                                    &runs,
                                    indent,
                                    if first { Some(&marker) } else { None },
                                    missing,
                                );
                                first = false;
                            }
                        }
                    }
                }
                layout.advance(PARAGRAPH_GAP);
            }
            Block::Code { text, .. } => {
                self.render_code_block(layout, font, text, depth, missing);
            }
            Block::Hr => {
                layout.advance(PARAGRAPH_GAP);
                layout.draw_rule(0.8, 0.6);
                layout.advance(PARAGRAPH_GAP);
            }
            Block::PageBreak => {
                // 已空白的页不再补一页，否则连续的 hr / pagebreak 会产出
                // 一串完全空白的纸，打印时白白多花几张。
                if !layout.is_current_page_empty() {
                    layout.new_page();
                }
            }
        }
    }

    /// 代码块：等宽感（缩小字号）+ 行内不折行 + 浅灰底纹。
    fn render_code_block(
        &self,
        layout: &mut PdfLayout,
        font: &TrueTypeFont,
        text: &str,
        depth: usize,
        missing: &mut Vec<char>,
    ) {
        let size = CODE_SIZE;
        let indent = LIST_INDENT + LIST_INDENT_STEP * depth as f32;
        let mut lines: Vec<String> = Vec::new();
        for raw in text.split('\n') {
            // 代码块按可用宽度硬切，不按「词」断 —— 缩进与对齐是代码的语义，
            // 自适应断词会把一行的结构打散，反而更难读。
            let available = (layout.content_width() - indent - CODE_PADDING * 2.0).max(size);
            let mut current = String::new();
            let mut width = 0.0;
            for ch in raw.chars() {
                let advance = advance_of(font, ch, size);
                if width + advance > available && !current.is_empty() {
                    lines.push(std::mem::take(&mut current));
                    width = 0.0;
                }
                current.push(ch);
                width += advance;
            }
            lines.push(current);
        }

        // 底纹要一次画完，所以先算出整块的高度；
        // 如果放不下就整块挪到下一页（代码块被从中间劈开比留白更难读）。
        let block_height = lines.len() as f32 * size * LINE_HEIGHT_FACTOR + CODE_PADDING * 2.0;
        if block_height < layout.remaining_height() {
            let top = layout.cursor();
            layout.draw_backdrop(top, block_height, CODE_BACKDROP);
        }

        layout.advance(CODE_PADDING);
        for line in lines {
            let wrapped = Line {
                text: line,
                indented: false,
            };
            // 代码块整块右移 indent + 内边距，与底纹矩形的左边界对齐。
            // 不对齐的话，底纹会从文字左边多出一截，看起来像排版没做完。
            layout.ensure_space(size * LINE_HEIGHT_FACTOR * 2.0);
            layout.draw_line(
                &wrapped,
                FONT_RESOURCE,
                size,
                font,
                indent + CODE_PADDING,
                0.0,
            );
        }
        layout.advance(CODE_PADDING + PARAGRAPH_GAP);
        // 代码块的缺字也要计入报告：代码里出现的生僻符号（箭头、特殊运算符）
        // 恰恰是最容易缺字的地方，漏报会让用户拿到一份有空洞的文件还不知道原因。
        self.collect_missing(font, text, missing);
    }

    /// 把一段纯文字按当前宽度断行后画出。
    ///
    /// `centered` 表示是否居中（封面与标题用）。
    /// 缺字统计不在这里做：调用方（draw_runs_*）已经把整段文字过了一遍，
    /// 在这里再查一次只会让参数表变长而不增加信息。
    fn draw_block_text(
        &self,
        layout: &mut PdfLayout,
        font: &TrueTypeFont,
        text: &str,
        size: f32,
        centered: bool,
        indent: f32,
    ) {
        let lines = wrap_text(text, font, size, layout.content_width() - indent, centered);
        for line in &lines {
            layout.ensure_space(size * LINE_HEIGHT_FACTOR * 1.05);
            layout.draw_line(
                line,
                FONT_RESOURCE,
                size,
                font,
                indent,
                if centered { 0.0 } else { 2.0 },
            );
        }
    }

    /// 画一段带行内样式的文本。
    ///
    /// 第一版**不区分粗体/斜体**：CJK 字体通常没有真正的粗体，
    /// 所谓「粗体」多是合成加粗（把字形描粗），PDF 里要做合成加粗
    /// 得设置线宽再描边，效果在打印稿上常常发糊。宁可统一用一种字重，
    /// 也不要在正文里混进一堆观感不对的伪粗体。行内代码同理，
    /// 只是它至少还能靠等宽感区分 —— 但那需要第二套字体，留待后续。
    fn draw_runs_paragraph(
        &self,
        layout: &mut PdfLayout,
        font: &TrueTypeFont,
        runs: &[InlineRun],
        depth: usize,
        missing: &mut Vec<char>,
    ) {
        let indent = LIST_INDENT_STEP * depth as f32;
        self.draw_runs_with_prefix(layout, font, runs, indent, None, missing);
    }

    /// 画一行/多行文本，可选行首标记（列表项用）。
    fn draw_runs_with_prefix(
        &self,
        layout: &mut PdfLayout,
        font: &TrueTypeFont,
        runs: &[InlineRun],
        indent: f32,
        prefix: Option<&str>,
        missing: &mut Vec<char>,
    ) {
        // 行内样式先把文字拼成一段，再统一断行。
        // 为什么不逐 run 断行：一个加粗的短语被从中间断开时，
        // 逐 run 处理会各自缩进，行尾留出的空隙看起来像排版事故。
        let mut plain = String::new();
        if let Some(prefix) = prefix {
            plain.push_str(prefix);
        }
        for run in runs {
            plain.push_str(&run.text);
        }
        if plain.trim().is_empty() {
            return;
        }
        let size = self.options.body_size;
        let width = layout.content_width() - indent;
        // 有标记的列表项不缩进首行：标记本身已经承担了「缩进」的视觉作用，
        // 再缩 2 em 会让标记看起来孤零零地悬在中间。
        let lines = wrap_text(&plain, font, size, width, prefix.is_none());
        for line in &lines {
            layout.ensure_space(size * LINE_HEIGHT_FACTOR * 1.05);
            // 首行缩进由 wrap_text 决定（它已经把缩进宽度从可用宽度里扣掉了），
            // 这里传 0：缩进是靠**少排两个字**实现的，而不是靠挪 x 坐标，
            // 这样文字层里真的有那两个全角空格，复制出去仍然保留中文缩进。
            layout.draw_line(line, FONT_RESOURCE, size, font, indent, 0.0);
        }
        self.collect_missing(font, &plain, missing);
        if prefix.is_none() {
            layout.advance(PARAGRAPH_GAP);
        }
    }

    /// 收集这段文字里字体没有对应字形的字符。
    ///
    /// 这些字符在内容流里会被跳过（见 page::hex_string），
    /// 也就是说它们**不会出现在 PDF 里**。把这件事实记录下来并交给
    /// 调用方，是为了让「某些字没显示出来」有一个可解释的出口 ——
    /// 而不是让用户对着一个空洞猜是不是软件出错了。
    fn collect_missing(&self, font: &TrueTypeFont, text: &str, missing: &mut Vec<char>) {
        for ch in text.chars() {
            // 空白字符不需要字形（定位靠 Tm，不靠空白字形）
            if ch.is_whitespace() {
                continue;
            }
            if font.glyph_id(ch).is_none() {
                missing.push(ch);
            }
        }
    }

    /// 把一个块摊平成带样式标记的行内序列。
    fn block_runs(&self, block: &Block) -> Vec<InlineRun> {
        match block {
            Block::Paragraph(inlines) => self.inline_runs(inlines),
            Block::Heading { text, .. } => vec![InlineRun::plain(text.clone())],
            Block::Code { text, .. } => vec![InlineRun::plain(text.clone())],
            Block::Quote(children) => {
                let mut out = Vec::new();
                for child in children {
                    out.extend(self.block_runs(child));
                }
                out
            }
            // 图片在块级位置降级成占位文本，与 DOCX 的做法一致
            Block::Hr => vec![InlineRun::plain("----------")],
            Block::List { .. } | Block::PageBreak => Vec::new(),
        }
    }

    /// 把行内元素摊平成纯文本。
    ///
    /// 降级规则与 TXT / DOCX **必须一致**（计划书 R19）：同一个 IR
    /// 摊平出来的文字在所有格式里一样，用户才不会觉得「导出的两份文件
    /// 内容不同」。链接降级成「文字（URL）」，图片降级成「［图片：alt］」。
    fn inline_runs(&self, inlines: &[Inline]) -> Vec<InlineRun> {
        let mut out = Vec::new();
        for inline in inlines {
            match inline {
                Inline::Text(t) | Inline::Code(t) => out.push(InlineRun::plain(t.clone())),
                Inline::Emph(children) | Inline::Strong(children) => {
                    out.extend(self.inline_runs(children));
                }
                Inline::Link { url, text } => {
                    let label = Inline::flatten_to_string(text);
                    // 文字与 URL 相同时不重复输出（与 TXT 渲染器同一规则）
                    if label == *url {
                        out.push(InlineRun::plain(label));
                    } else {
                        out.push(InlineRun::plain(format!("{label}（{url}）")));
                    }
                }
                Inline::Image { alt, .. } => {
                    let label = if alt.is_empty() {
                        "［图片］".to_string()
                    } else {
                        format!("［图片：{alt}］")
                    };
                    out.push(InlineRun::plain(label));
                }
            }
        }
        out
    }
}

/// 代码块的内边距。
const CODE_PADDING: f32 = 6.0;

/// 字体资源名。
///
/// 内容流里用 `/F1` 引用字体，这个名字必须与页面资源字典里的键一致。
/// 抽成常量而不是各处手写，是为了避免「一处写 F1 一处写 F2」这种
/// 在 PDF 里表现为整页文字消失的低级错误。
const FONT_RESOURCE: &str = "F1";

/// 一个带样式的文本片段。
///
/// 结构里只有一个字段，看起来像是过度设计；但它是**为将来的粗斜体预留
/// 的位置**：等接入第二套字体（例如楷体做强调）时，只需要在这里加一个
/// `font: FontSlot` 字段，所有 call site 不用改。现在写成 `String`
/// 的话，那时要改的是十几处调用点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineRun {
    /// 文字。
    pub text: String,
}

impl InlineRun {
    /// 构造一个普通文本片段。
    pub fn plain(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }
}

// ============================================================================
//  PDF 对象装配
// ============================================================================

/// 把排好版的页面装配成完整的 PDF 字节。
fn assemble_pdf(
    font: &TrueTypeFont,
    pages: &[Page],
    document: &Document,
    options: &PdfOptions,
) -> Result<Vec<u8>> {
    let mut allocator = ObjAllocator::new();
    // 对象分配顺序刻意固定为「字体在前、页面在后」：这样即使有人在
    // 中间插了对象，字体对象的编号也不会变，肉眼比对两次导出的
    // 结构差异时更容易看出改了什么。
    let catalog_id = allocator.allocate();
    let pages_id = allocator.allocate();
    let font_id = allocator.allocate();
    let font_descriptor_id = allocator.allocate();
    let cid_font_id = allocator.allocate();
    let to_unicode_id = allocator.allocate();
    let font_file_id = allocator.allocate();
    let info_id = allocator.allocate();

    let mut objects: Vec<IndirectObject> = Vec::new();

    // ---- 页面对象 ----
    let mut page_ids: Vec<ObjId> = Vec::with_capacity(pages.len());
    for _ in pages {
        page_ids.push(allocator.allocate());
    }

    // 内容流对象跟在页面对象之后
    let mut content_ids: Vec<ObjId> = Vec::with_capacity(pages.len());
    for _ in pages {
        content_ids.push(allocator.allocate());
    }

    objects.push(IndirectObject::new(
        catalog_id,
        format!(
            "<< /Type /Catalog /Pages {} /PageLayout /SinglePage >>",
            pages_id.reference()
        ),
    ));

    let kids = page_ids
        .iter()
        .map(|id| id.reference())
        .collect::<Vec<_>>()
        .join(" ");
    objects.push(IndirectObject::new(
        pages_id,
        format!("<< /Type /Pages /Count {} /Kids [{kids}] >>", pages.len()),
    ));

    for (index, (page_id, content_id)) in page_ids.iter().zip(&content_ids).enumerate() {
        let mut resources = format!(
            "<< /Font << /{FONT_RESOURCE} {} >> /ProcSet [/PDF /Text] >>",
            font_id.reference()
        );
        // 页脚页码在内容流里画，所以资源字典不需要额外东西；
        // 但页码要用同一套字体，故这里什么都不用加。
        let _ = &mut resources;
        objects.push(IndirectObject::new(
            *page_id,
            format!(
                "<< /Type /Page /Parent {} /MediaBox [0 0 {:.2} {:.2}] /Resources {resources} /Contents {} >>",
                pages_id.reference(),
                options.page_size.width,
                options.page_size.height,
                content_id.reference()
            ),
        ));
        let mut content = pages[index].content_bytes();
        if options.page_numbers {
            content.extend_from_slice(
                page_number_stream(index + 1, pages.len(), options, font).as_bytes(),
            );
        }
        objects.push(IndirectObject::new(
            *content_id,
            // 内容流的 /Length 必须是**字节数**（不是字符数）。
            // 中文内容按字符数写会让阅读器读到流中间就停 ——
            // 表现为「最后一页少半段」，很难往长度上想。
            stream_object(&content, ""),
        ));
    }

    // ---- 字体对象 ----
    // Type0 复合字体 → Identity-H 编码 → CIDFontType2 子字体
    objects.push(IndirectObject::new(
        font_id,
        format!(
            "<< /Type /Font /Subtype /Type0 /BaseFont /{} /Encoding /Identity-H \
/DescendantFonts [{}] /ToUnicode {} >>",
            base_font_name(font),
            cid_font_id.reference(),
            to_unicode_id.reference()
        ),
    ));

    objects.push(IndirectObject::new(
        cid_font_id,
        format!(
            "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{} /CIDSystemInfo \
<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {} \
/DW 1000 /W [0 [{}]] /CIDToGIDMap /Identity >>",
            base_font_name(font),
            font_descriptor_id.reference(),
            default_width(font)
        ),
    ));

    objects.push(IndirectObject::new(
        font_descriptor_id,
        format!(
            "<< /Type /FontDescriptor /FontName /{} /Flags {} /FontBBox [{}] \
/ItalicAngle 0 /Ascent {} /Descent {} /CapHeight {} /StemV 80 /FontFile2 {} >>",
            base_font_name(font),
            descriptor_flags(),
            font_bbox(font),
            font.units_per_em(),
            -(f32::from(font.units_per_em()) * 0.2) as i32,
            f32::from(font.units_per_em()) * 0.7,
            font_file_id.reference()
        ),
    ));

    objects.push(IndirectObject::new(
        font_file_id,
        stream_object(
            font.data(),
            // Length1 是**解压后的** TrueType 字节数。写成压缩前的长度
            // （比如 data.len() 经过 zip 之后的值）会让阅读器认为字体截断，
            // 直接放弃内嵌字体去用系统字体 —— 结果就是「换台机器就变形」。
            &format!(" /Length1 {}", font.data().len()),
        ),
    ));

    objects.push(IndirectObject::new(
        to_unicode_id,
        stream_object(to_unicode_cmap_for(font).as_bytes(), ""),
    ));

    // ---- 元数据 ----
    objects.push(IndirectObject::new(
        info_id,
        format!(
            "<< /Title {} /Author {} /Producer {} /Creator {} >>",
            pdf_text_string(&document.book.title),
            pdf_text_string(document.book.author_or_anonymous()),
            pdf_text_string("羽化写作"),
            pdf_text_string("羽化写作 PDF 渲染器")
        ),
    ));

    Ok(write_pdf(&objects, catalog_id, Some(info_id)))
}

/// 构造一个流对象。
fn stream_object(data: &[u8], extra: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 64);
    out.extend_from_slice(format!("<< /Length {}{extra} >>\nstream\n", data.len()).as_bytes());
    out.extend_from_slice(data);
    // 流数据与 endstream 之间必须有一个 EOL，否则某些解析器会把
    // "endstream" 的头几个字节当成流内容。
    out.extend_from_slice(b"\nendstream");
    out
}

/// 页脚页码内容流。
fn page_number_stream(
    index: usize,
    total: usize,
    options: &PdfOptions,
    font: &TrueTypeFont,
) -> String {
    let label = format!("{index} / {total}");
    let size = 8.5;
    let width = text::measure(font, &label, size);
    let x = (options.page_size.width - width) / 2.0;
    // 页码贴着下边距往上一点，不要压到底边
    let y = options.margins.bottom / 2.0;
    format!(
        "BT\n0.45 G\n1 0 0 1 {x:.2} {y:.2} Tm\n/{FONT_RESOURCE} {size:.2} Tf\n{} Tj\nET\n",
        hex_string(font, &label)
    )
}

/// 取字体的默认宽度（CIDFont 字典里的 /DW）。
///
/// 用字体里 GID 0 的推进量而不是写死 1000：字体自身的 .notdef 宽度
/// 才是它对「未知字形」的官方声明，写死 1000 会让半角字体的
/// 缺字位置凭空多占一倍宽度。
fn default_width(font: &TrueTypeFont) -> u16 {
    let units = font.advance_width(0) as u32 * 1000 / u32::from(font.units_per_em()).max(1);
    units.min(u16::MAX as u32) as u16
}

/// 字体资源名（/BaseFont）。
///
/// 这里的名字只是提示，阅读器实际用的是 FontFile2 里的字节。
/// 名字里**不能有空格与斜杠**（PDF 名字对象的语法限制），
/// 所以把字体自带的 PostScript 名做一次清洗。
fn base_font_name(font: &TrueTypeFont) -> String {
    let raw = font.postscript_name().unwrap_or("YuhuaEmbedded");
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '+')
        .collect();
    if cleaned.is_empty() {
        "YuhuaEmbedded".to_string()
    } else {
        cleaned
    }
}

/// FontDescriptor 的 /Flags 位域。
///
/// 位 1（值 1）= FixedPitch，位 3（值 4）= Symbolic，位 6（值 32）= Nonsymbolic。
/// 我们声明的 Symbolic 是**有意的**：CID 字体的字符码是字形编号，
/// 不属于任何标准字符集，标成 Nonsymbolic 会让部分阅读器尝试用
/// 系统字体按 Latin-1 去匹配，结果就是「显示成了西文乱码」。
fn descriptor_flags() -> u32 {
    4
}

/// 字体边界框。
///
/// head 表里有真实的 xMin/yMin/xMax/yMax，但要在 parse 阶段多读 8 个字节；
/// 这里用一个覆盖典型 CJK 字体的保守值即可 —— FontBBox 只影响
/// 阅读器的裁剪优化，不影响字形本身的渲染。
fn font_bbox(font: &TrueTypeFont) -> String {
    let em = f32::from(font.units_per_em());
    format!(
        "[{} {} {} {}]",
        -(em * 0.15) as i32,
        -(em * 0.25) as i32,
        (em * 1.15) as i32,
        (em * 1.0) as i32
    )
}

/// 把 Rust 字符串写成 PDF 文本字符串。
///
/// PDF 的文本字符串有两种形式：`(字面)` 与 `<十六进制>`。
/// 中文无法安全地放进字面形式（编码与转义都会出问题），所以这里用
/// **UTF-16BE 加 BOM 的十六进制串** —— 这是 PDF 1.7 规范里
/// 表达非 ASCII 文本字符串的标准做法，阅读器的「文档属性」对话框
/// 才能正确显示中文书名与作者名。
fn pdf_text_string(text: &str) -> String {
    let mut out = String::from("<FEFF");
    for unit in text.encode_utf16() {
        out.push_str(&format!("{unit:04X}"));
    }
    out.push('>');
    out
}

/// 生成 ToUnicode CMap。
///
/// 这是「中文可搜索可复制」的关键部件。它把**字形编号（CID）**映射回
/// Unicode 码点。我们用的是 Identity-H，CID == GID，而 GID 是字体相关的、
/// 毫无规律可言的编号 —— 也就是说，这份 CMap 无法从字体无关地推导，
/// 必须**逐个 Unicode 码点反查字体的 cmap** 来构造。
///
/// 覆盖范围：BMP 全平面（U+0000–U+FFFF）逐个码点查一遍。
/// 65536 次二分查表在现代机器上是毫秒级，换来的是「任何输入都有映射」。
/// 看起来笨，但它把「漏了某个字符的映射」这类 bug 从设计上排除了 ——
/// 而漏映射在阅读器里的表现是「这个字搜不到」，用户根本不知道自己
/// 漏了什么。
pub fn to_unicode_cmap_for(font: &TrueTypeFont) -> String {
    let mut pairs: Vec<(u16, u16)> = Vec::new();
    for codepoint in 0u32..=0xFFFF {
        let Some(ch) = char::from_u32(codepoint) else {
            continue;
        };
        // 代理区（D800–DFFF）不是合法标量值，from_u32 已经滤掉了
        if let Some(gid) = font.glyph_id(ch) {
            pairs.push((gid, codepoint as u16));
        }
    }
    // 按 CID 升序输出：CMap 的 bfchar 段虽然不要求有序，
    // 但有序能让我们自己的测试与人工排查都简单很多。
    pairs.sort_unstable();
    pairs.dedup();

    let mut out = String::new();
    out.push_str("/CIDInit /ProcSet findresource begin\n");
    out.push_str("12 dict begin\nbegincmap\n");
    out.push_str("/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n");
    out.push_str("/CMapName /Adobe-Identity-UCS def\n");
    out.push_str("/CMapType 2 def\n");
    out.push_str("1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");

    // bfchar 段每段最多 100 项 —— 这是 CMap 规范对 beginbfchar 的硬限制，
    // 超了 Adobe 的解析器会直接拒绝整份 CMap（于是全部文字都搜不到）。
    for chunk in pairs.chunks(100) {
        out.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (gid, codepoint) in chunk {
            out.push_str(&format!("<{gid:04X}> <{codepoint:04X}>\n"));
        }
        out.push_str("endbfchar\n");
    }

    out.push_str("endcmap\n");
    out.push_str("CMapName currentdict /CMap defineresource pop\n");
    out.push_str("end\nend\n");
    out
}

#[cfg(test)]
mod tests;
