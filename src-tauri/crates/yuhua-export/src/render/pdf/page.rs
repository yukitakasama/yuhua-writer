//! 页面排版：内容流指令、页面尺寸、页高计算。
//!
//! ## 坐标系
//!
//! PDF 的原点在**页面左下角**，y 轴向上；而排版的直觉是「从页顶往下走」。
//! 这个转换只做一次（在 PdfLayout 里把光标从页高往下减），
//! 不要在每处 draw 里各减一遍 —— 那种写法会让「行距算错」这类问题
//! 变成全局搜索才能定位的 bug。
//!
//! ## 长度单位
//!
//! PDF 的用户空间单位是 **1/72 英寸**，所以「10 号字」= 10 个单位，
//! A4 = 595.28 × 841.89 单位。中文出版物惯用「磅」这个词，含义相同。
//!
//! ## 为什么内容流里写的是字形编号
//!
//! 用 Type0 / Identity-H 编码时，字符串里的每个两字节单元是 **CID**，
//! 而 Identity-H 规定 CID == GID（字形编号）。所以内容流里
//! `<4E00>` 这种十六进制串是「字形编号 0x4E00」而不是「U+4E00」。
//! 阅读器不知道这是哪个字，它靠 ToUnicode CMap 反查 —— 这正是
//! 「可搜索、可复制」的实现机制。

use super::font::TrueTypeFont;
use super::text::{Line, FULL_WIDTH_SPACE};

/// 显示/隐藏文本操作符的配对。
///
/// 每一行都用一对 BT / ET 包起来而不是把整页放在一对里：
/// PDF 里 Tf 设置的字体对**所有**跟随的 Tj 生效，而我们的排版会有
/// 多套字号（正文 / 标题 / 代码），把整页塞进一个 BT 块，
/// 任何一个字号恢复写错，后面整页都会跟着错。每行独立，
/// 出错的影响面就被限制在一行之内。
const BT: &str = "BT\n";
const ET: &str = "ET\n";

/// 页面尺寸（单位：1/72 英寸）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSize {
    /// 宽度。
    pub width: f32,
    /// 高度。
    pub height: f32,
}

impl PageSize {
    /// A4 竖排。
    ///
    /// 595.28 × 841.89 是 A4 的精确值（210mm × 297mm）。
    /// 用精确值而不是取整的 595 × 842：取整会在某些打印驱动上
    /// 触发放大/缩小，正文被裁掉几毫米是很难排查的交稿事故。
    pub const A4: Self = Self {
        width: 595.28,
        height: 841.89,
    };

    /// Letter 竖排。
    pub const LETTER: Self = Self {
        width: 612.0,
        height: 792.0,
    };
}

/// 页边距（单位：1/72 英寸）。
///
/// 默认取「2.5cm 上下 / 3cm 左右」的常见中文书稿版心，换算成点是
/// 70.87 / 85.04。上下窄、左右宽，是给审稿人留批注空间的惯例。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Margins {
    /// 上边距。
    pub top: f32,
    /// 下边距。
    pub bottom: f32,
    /// 左边距。
    pub left: f32,
    /// 右边距。
    pub right: f32,
}

impl Default for Margins {
    fn default() -> Self {
        Self {
            top: 70.87,
            bottom: 70.87,
            left: 85.04,
            right: 85.04,
        }
    }
}

/// 一个 PDF 页面：只有内容流，尺寸由文档级统一决定（第一版不做混排页面）。
#[derive(Debug, Clone, Default)]
pub struct Page {
    /// 内容流指令。
    pub content: String,
}

impl Page {
    /// 内容流字节。
    pub fn content_bytes(&self) -> Vec<u8> {
        self.content.clone().into_bytes()
    }
}

/// 排版光标：内容流缓冲 + 版面参数 + 当前 y 位置。
///
#[derive(Debug)]
/// 把「当前页 / 当前 y / 是否已分页」收在一个结构里，
/// 而不是让每个渲染函数都接收 `(&mut Page, &mut f32)` 两个参数 ——
/// 后者一旦漏改一个地方就会出现「文字画到了页面外面」这种静默错误。
pub struct PdfLayout {
    /// 页面尺寸。
    pub page_size: PageSize,
    /// 页边距。
    pub margins: Margins,
    /// 已完成的页面。
    pages: Vec<Page>,
    /// 当前页的内容流。
    current: String,
    /// 当前行基线距页顶的距离（点）。
    cursor_from_top: f32,
}

impl PdfLayout {
    /// 新建排版器，并开启第一页。
    pub fn new(page_size: PageSize, margins: Margins) -> Self {
        Self {
            page_size,
            margins,
            pages: Vec::new(),
            current: String::new(),
            cursor_from_top: margins.top,
        }
    }

    /// 版心宽度。
    pub fn content_width(&self) -> f32 {
        (self.page_size.width - self.margins.left - self.margins.right).max(1.0)
    }

    /// 版心底部距页顶的距离。
    fn bottom_limit(&self) -> f32 {
        (self.page_size.height - self.margins.bottom).max(self.margins.top + 1.0)
    }

    /// 当前页已经写了多少内容。
    pub fn is_current_page_empty(&self) -> bool {
        self.current.is_empty()
    }

    /// 剩余竖直空间（点）。
    pub fn remaining_height(&self) -> f32 {
        (self.bottom_limit() - self.cursor_from_top).max(0.0)
    }

    /// 当前光标位置换算成 PDF 坐标（从页底算起）。
    fn baseline_y(&self) -> f32 {
        self.page_size.height - self.cursor_from_top
    }

    /// 内容流里追加一条原始指令。
    pub fn push_raw(&mut self, text: &str) {
        self.current.push_str(text);
    }

    /// 结束当前页，开启新页。
    pub fn new_page(&mut self) {
        self.pages.push(Page {
            content: std::mem::take(&mut self.current),
        });
        self.cursor_from_top = self.margins.top;
    }

    /// 如果剩余空间不足 `needed` 就换页。返回是否发生了换页。
    ///
    /// 用「预测 + 换页」而不是「写完发现溢出再挪」：后者要把已经写进
    /// 内容流的指令撤回来，而内容流是纯字符串缓冲，撤回等于重新渲染一遍。
    pub fn ensure_space(&mut self, needed: f32) -> bool {
        if self.remaining_height() < needed && !self.is_current_page_empty() {
            self.new_page();
            return true;
        }
        false
    }

    /// 画一行文字。
    ///
    /// `font_resource` 是页面资源字典里那个字体资源的名字（例如 `F1`）。
    /// `inset` 是相对版心左边界的额外内缩（点），列表嵌套、代码块、引用都用它。
    /// `indent_em` 是首行缩进量（单位 em），0 表示不缩进。
    ///
    /// 两个「缩进」参数分开是因为它们语义不同：inset 是**整块**的左侧偏移
    /// （每一行都要缩），indent_em 是**首行**的两个全角空格（中文段落惯例）。
    /// 混成一个参数就得在调用点自己判断「这是第几行」，很容易写错。
    pub fn draw_line(
        &mut self,
        line: &Line,
        font_resource: &str,
        size: f32,
        font: &TrueTypeFont,
        inset: f32,
        indent_em: f32,
    ) {
        // 先推进光标再画：这样「换行后 y 是多少」与「画在哪」用的是同一个值，
        // 不会出现两者差一行的经典错误。
        self.cursor_from_top += size * LINE_HEIGHT_FACTOR;
        let y = self.baseline_y();
        let mut x = self.margins.left + inset;
        let mut text = line.text.clone();
        if line.indented && indent_em > 0.0 {
            // 缩进用真实的空格字形推进，而不是挪 x 坐标：这样文字层里
            // 确实有那两个全角空格，复制出去仍然保留中文段落缩进。
            let spaces = FULL_WIDTH_SPACE.to_string().repeat(indent_em as usize);
            x += indent_em * size;
            text = format!("{spaces}{text}");
        }
        self.current.push_str(BT);
        self.current
            .push_str(&format!("1 0 0 1 {x:.2} {y:.2} Tm\n"));
        self.current
            .push_str(&format!("/{font_resource} {size:.2} Tf\n"));
        self.current.push_str(&hex_string(font, &text));
        self.current.push_str(" Tj\n");
        self.current.push_str(ET);
    }

    /// 在指定的纵向区间上沿版心左边界画一条竖线（引用块用）。
    ///
    /// 参数是从页顶量的两个纵坐标，因为调用方（渲染器）只知道光标位置，
    /// 而 PDF 坐标要翻转。翻转只在这里做一次，调用点不必各自记住这个转换。
    pub fn draw_margin_rule(&mut self, inset: f32, top: f32, bottom: f32, gray: f32) {
        if bottom <= top {
            return;
        }
        let x = self.margins.left + inset;
        let y_top = self.page_size.height - top;
        let y_bottom = self.page_size.height - bottom;
        self.current.push_str(&format!("{gray:.3} G 1.2 w\n"));
        self.current
            .push_str(&format!("{x:.2} {y_bottom:.2} m {x:.2} {y_top:.2} l S\n"));
    }

    /// 画一条水平分隔线。
    pub fn draw_rule(&mut self, thickness: f32, gray: f32) {
        self.ensure_space(thickness * 6.0);
        self.cursor_from_top += thickness * 3.0;
        let y = self.baseline_y();
        let left = self.margins.left;
        let right = self.page_size.width - self.margins.right;
        self.current
            .push_str(&format!("{gray:.3} G {thickness:.2} w\n"));
        self.current
            .push_str(&format!("{left:.2} {y:.2} m {right:.2} {y:.2} l S\n"));
        self.cursor_from_top += thickness * 3.0;
    }

    /// 画一个浅灰底纹矩形（代码块背景用）。
    pub fn draw_backdrop(&mut self, top: f32, height: f32, gray: f32) {
        let y_top = self.page_size.height - top;
        let y_bottom = y_top - height;
        let left = self.margins.left;
        let right = self.page_size.width - self.margins.right;
        self.current.push_str(&format!("{gray:.3} g\n"));
        self.current.push_str(&format!(
            "{left:.2} {y_bottom:.2} {:.2} {height:.2} re f\n",
            right - left
        ));
        self.current.push_str("0 g\n");
    }

    /// 推进光标（不画字），用于段间距。
    pub fn advance(&mut self, amount: f32) {
        self.cursor_from_top += amount;
    }

    /// 当前光标距页顶的距离，供代码块画底纹时记录上边界。
    pub fn cursor(&self) -> f32 {
        self.cursor_from_top
    }

    /// 收尾：返回全部页面。
    ///
    /// 两条规则：
    ///
    /// 1. **绝不留下一个空的尾页**。渲染流程末尾总会有一次 new_page
    ///    （每章开始前换页、封面之后换页），如果无脑收尾，每本书最后
    ///    都会多出一张白纸 —— 打印时白白多花一张，交稿时审稿人也会问
    ///    「最后一页怎么是空的」。
    /// 2. **空文档至少产出一页**。一个零页的 PDF 在多数阅读器里会被判为
    ///    「文件损坏」，而用户只是想导出一本还没写内容的新书。
    pub fn finish(mut self) -> Vec<Page> {
        if !self.current.is_empty() || self.pages.is_empty() {
            self.pages.push(Page {
                content: std::mem::take(&mut self.current),
            });
        }
        self.pages
    }
}

/// 行距倍数。
///
/// 1.5 倍是中文正文的舒适值：宋体的字面率高，单倍行距读起来会挤。
/// 这个值同时被 harness 用来算「一页放得下多少行」，
/// 和内容流里的实际推进必须用同一个常量，否则会出现在页底画半行的情况。
pub const LINE_HEIGHT_FACTOR: f32 = 1.5;

/// 把一段文字编码成 Identity-H 的十六进制字符串。
///
/// 每个字符查一次 cmap 拿 GID，写成 4 位十六进制。查不到字形的字符
/// **跳过而不是写 GID 0**：GID 0 是 .notdef，多数阅读器会画一个空心方框，
/// 看起来像乱码；跳过至少不会在正文里插进一串方框。
/// 我们会在渲染阶段统计缺字并在导出报告里提示（见 pdf.rs）。
pub fn hex_string(font: &TrueTypeFont, text: &str) -> String {
    let mut out = String::with_capacity(text.chars().count() * 4 + 2);
    out.push('<');
    for ch in text.chars() {
        if let Some(gid) = font.glyph_id(ch) {
            out.push_str(&format!("{gid:04X}"));
        }
    }
    out.push('>');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a4_dimensions_are_exact() {
        // 取整到 595×842 会在部分打印驱动上触发放大缩小
        assert!((PageSize::A4.width - 595.28).abs() < 0.01);
        assert!((PageSize::A4.height - 841.89).abs() < 0.01);
    }

    #[test]
    fn content_width_subtracts_margins() {
        let layout = PdfLayout::new(PageSize::A4, Margins::default());
        let expected = 595.28 - 85.04 * 2.0;
        assert!((layout.content_width() - expected).abs() < 0.01);
    }

    #[test]
    fn finish_always_produces_at_least_one_page() {
        let layout = PdfLayout::new(PageSize::A4, Margins::default());
        let pages = layout.finish();
        assert_eq!(pages.len(), 1);
        assert!(pages[0].content.is_empty());
    }

    #[test]
    fn new_page_moves_previous_content_out() {
        let mut layout = PdfLayout::new(PageSize::A4, Margins::default());
        layout.push_raw("1 0 0 1 10 10 Tm\n");
        layout.new_page();
        layout.push_raw("1 0 0 1 20 20 Tm\n");
        let pages = layout.finish();
        assert_eq!(pages.len(), 2);
        assert!(pages[0].content.contains("10 10"));
        assert!(pages[1].content.contains("20 20"));
    }

    #[test]
    fn finish_drops_a_trailing_empty_page() {
        // 渲染流程末尾几乎总会多出一次 new_page，
        // 无脑收尾会让每本书最后都多一张白纸。
        let mut layout = PdfLayout::new(PageSize::A4, Margins::default());
        layout.push_raw("x\n");
        layout.new_page();
        assert_eq!(layout.finish().len(), 1);
    }

    #[test]
    fn ensure_space_breaks_only_when_page_has_content() {
        let mut layout = PdfLayout::new(PageSize::A4, Margins::default());
        // 空页即使要求再高也不换页，否则会产出无限多的空白页
        assert!(!layout.ensure_space(10_000.0));
        layout.push_raw("x\n");
        assert!(layout.ensure_space(10_000.0));
    }

    #[test]
    fn cursor_moves_down_as_content_is_appended() {
        let mut layout = PdfLayout::new(PageSize::A4, Margins::default());
        let start = layout.cursor();
        layout.advance(12.0);
        assert!(layout.cursor() > start);
        assert!((layout.remaining_height() - (841.89 - 70.87 - start - 12.0)).abs() < 0.01);
    }

    #[test]
    fn hex_string_uses_four_digit_gids() {
        // 合成字体的 cmap 只有一段 [0x0000, 0xFFFF] 且 idDelta = 1，
        // 所以 GID = 码点 + 1。这里断言的是**内容流里确实是字形编号**，
        // 而不是 Unicode 码点本身 —— 两者的差 1 正好能证明这一点。
        let font = crate::render::pdf::text::uniform_font_for_page_tests();
        assert_eq!(hex_string(&font, "甲乙"), "<75334E5A>");
    }

    #[test]
    fn hex_string_skips_unmapped_characters() {
        let font = crate::render::pdf::text::uniform_font_for_page_tests();
        // 合成字体的 cmap 只覆盖 BMP，用增补平面字符制造「查不到」的情况。
        // 缺字必须被跳过（而不是写 GID 0），否则会画出一排方框。
        assert_eq!(hex_string(&font, "\u{20000}"), "<>");
    }
}
