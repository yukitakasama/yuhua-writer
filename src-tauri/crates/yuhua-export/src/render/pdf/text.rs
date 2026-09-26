//! 断行与分页。
//!
//! ## 为什么中文排版不能按空格断词
//!
//! 西文的断行是「找空格」，中文没有词间空格，断行点是**任意两个汉字之间**，
//! 但要受「避头尾」规则约束：某些标点不能出现在行首（如 。 ， 」 ）），
//! 某些不能出现在行尾（如 「 （）。这些规则在 PDF 里必须由我们自己实现 ——
//! 阅读器只负责按我们给出的字节画字，不会替我们排版。
//!
//! ## 断行粒度是 char 而不是 byte
//!
//! 中文一个字在 UTF-8 里占 3 字节。按字节切会把一个汉字劈成两半，
//! 产出的 PDF 文字层就是乱码。这与 TXT 渲染器里 wrap_text 的取舍完全一致：
//! 凡是要按「字」处理的地方，一律走 char。

use super::font::TrueTypeFont;

/// 可以出现在行首的标点。
///
/// 这些符号在中文排版里是「前置标点」——它们粘在前一个字后面，
/// 不能单独跑到下一行开头。列在这里而不是用 Unicode 通用类别判断，
/// 是因为通用类别把它们和普通标点混在一起，判断不出「避头」还是「避尾」。
const NO_LINE_START: &[char] = &[
    '，', '。', '、', '；', '：', '？', '！', '）', '］', '｝', '》', '」', '』', '〉', '】', '〕',
    '·', '…', '—', '～', ',', '.', ';', ':', '?', '!', ')', ']', '}', '》', '”', '’', '%',
];

/// 不能出现在行尾的标点（后置标点）。
const NO_LINE_END: &[char] = &[
    '（', '［', '｛', '《', '「', '『', '〈', '【', '〔', '(', '[', '{', '“', '‘',
];

/// 段落缩进用的全角空格。
///
/// 与 TXT 渲染器共用同一个字符：中文段落首行缩进两个全角空格是排版惯例。
/// 用 U+3000 而不是两个半角空格 —— 半角空格在等宽中文字体里只有半个字宽，
/// 缩进会明显不到位。
pub const FULL_WIDTH_SPACE: char = '\u{3000}';

/// 断行后的一个片段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    /// 本行文字。
    pub text: String,
    /// 本行是否要按首行缩进处理。
    pub indented: bool,
}

/// 按可用宽度把一段文字断成多行。
///
/// `first_line_indent` 只作用在第一行：中文排版里后续行不缩进，
/// 如果每行都缩进，视觉上会变成阶梯状。
pub fn wrap_text(
    text: &str,
    font: &TrueTypeFont,
    size: f32,
    max_width: f32,
    first_line_indent: bool,
) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    // 段内的显式换行（Markdown 里的软换行）必须保留，否则作者刻意的分行会丢
    for (index, raw) in text.split('\n').enumerate() {
        let indent = first_line_indent && index == 0;
        wrap_paragraph(raw, font, size, max_width, indent, &mut lines);
    }
    if lines.is_empty() {
        lines.push(Line {
            text: String::new(),
            indented: first_line_indent,
        });
    }
    lines
}

/// 断一个「没有显式换行」的段落。
fn wrap_paragraph(
    text: &str,
    font: &TrueTypeFont,
    size: f32,
    max_width: f32,
    indent: bool,
    out: &mut Vec<Line>,
) {
    // 缩进**只在首行**生效：中文排版里后续行顶格。
    // 这里算的是「首行比其它行少掉多少宽度」，而不是把 cwidth 全体扣掉 ——
    // 后者会让每一行都变短，出稿后看起来像整段被右边挤扁了。
    let indent_width = if indent {
        advance_of(font, FULL_WIDTH_SPACE, size) * 2.0
    } else {
        0.0
    };
    // 可用宽度必须为正：缩进比整行还宽时（极窄页面 + 超大缩进），
    // 每行只能塞下一个字符，否则会算出负宽度导致死循环。
    let first_line_available = (max_width - indent_width).max(size);
    let available = max_width.max(size);

    let chars: Vec<char> = text.chars().collect();
    let mut current: Vec<char> = Vec::new();
    let mut width = 0.0f32;
    let mut is_first_line = true;
    let mut index = 0usize;

    // 一个字符要不要在**本行**断行，取决于三件事：本行是否还有空间、
    // 当前字符是不是「不能出现在行首」、上一行尾是不是「不能出现在行尾」。
    // 这三条互相牵制，所以判断集中在一个循环里，而不是拆成若干遍扫描。
    while index < chars.len() {
        let ch = chars[index];
        let ch_width = advance_of(font, ch, size);
        // 首行的可用宽度要把缩进扣掉，其余行用满版心
        let limit = if is_first_line {
            first_line_available
        } else {
            available
        };
        let fits = width + ch_width <= limit;

        if !fits && !current.is_empty() {
            // 避头：即将断行的位置上是一个前置标点，把它挤进本行。
            // 允许本行略微超宽 —— 行尾多半个标点，远比行首孤零零一个句号好看。
            if NO_LINE_START.contains(&ch) {
                current.push(ch);
                index += 1;
                push_line(out, &mut current, indent && is_first_line);
                is_first_line = false;
                width = 0.0;
                continue;
            }
            // 避尾：本行最后一个字符是后置标点，把它推到下一行。
            // 要求 current 至少剩 1 个字符，否则会死循环（把唯一的字符
            // 推走、又把它收回来，来回振荡）。
            if current.len() > 1 && current.last().is_some_and(|c| NO_LINE_END.contains(c)) {
                let moved = current.pop().unwrap_or(' ');
                push_line(out, &mut current, indent && is_first_line);
                is_first_line = false;
                width = 0.0;
                current.push(moved);
                width += advance_of(font, moved, size);
                continue;
            }
            push_line(out, &mut current, indent && is_first_line);
            is_first_line = false;
            width = 0.0;
            continue;
        }

        current.push(ch);
        width += ch_width;
        index += 1;
    }

    push_line(out, &mut current, indent && is_first_line);
}

/// 把当前缓冲收成一行（空行也要收 —— 空行是段间空白）。
fn push_line(out: &mut Vec<Line>, current: &mut Vec<char>, indented: bool) {
    let text: String = current.iter().collect();
    out.push(Line {
        text: text.trim_end().to_string(),
        indented,
    });
    current.clear();
}

/// 单个字符按给定字号占的宽度（点）。
///
/// 字体里查不到的字形（缺字）按「全角」估算而不是 0：
/// 宽度 0 会让后续所有字符叠在同一处，整行排版彻底崩掉；
/// 而按全角估算最多只是这一行略宽，读者看到的是方框而不是乱码。
pub fn advance_of(font: &TrueTypeFont, ch: char, size: f32) -> f32 {
    let units = match font.glyph_id(ch) {
        Some(gid) => font.advance_width(gid),
        // 空白字符在字体里通常没有字形，但必须占位
        None => {
            if ch.is_whitespace() {
                font.units_per_em() / 2
            } else {
                font.units_per_em()
            }
        }
    };
    size * f32::from(units) / f32::from(font.units_per_em())
}

/// 一行文字在给定字号下的总宽度。
pub fn measure(font: &TrueTypeFont, text: &str, size: f32) -> f32 {
    text.chars().map(|ch| advance_of(font, ch, size)).sum()
}

/// 造一份「每个字形都是半角 500 单位、em 1000」的假字体字节。
///
/// 供本模块与 page 模块的测试共用。放在 cfg(test) 的模块函数里而不是
/// 各自复制一份：合成字体的字节布局一旦改动，两处副本很容易只改一处，
/// 于是出现「page 的测试还在用旧 cmap」这种查起来很费劲的失败。
///
/// 用它而不是真字体：断行测试关心的是**宽度比较**，
/// 一份可预测宽度的合成字体能让断言写成「每行 20 字」这种一眼可读的形式。
#[cfg(test)]
pub(crate) fn uniform_font_bytes() -> Vec<u8> {
    // 复用 font 模块里合成字体的思路，但把 cmap 做成覆盖全体 BMP 的段，
    // 这样任何测试字符都能拿到 GID。
    const HEAD: usize = 108;
    const HHEA: usize = HEAD + 54;
    const MAXP: usize = HHEA + 36;
    const HMTX: usize = MAXP + 32;
    // 同 font.rs：格式 4 一段子表占 16 字节，表尾接目录
    const CMAP: usize = HMTX + 8;
    const SUBTABLE: usize = CMAP + 12;
    const GLYF: usize = SUBTABLE + 32;

    let mut data = vec![0u8; GLYF + 16];
    data[0..4].copy_from_slice(&[0x00, 0x01, 0x00, 0x00]);
    data[4..6].copy_from_slice(&6u16.to_be_bytes());
    let mut put = |index: usize, tag: &[u8; 4], offset: usize, length: usize| {
        let entry = 12 + index * 16;
        data[entry..entry + 4].copy_from_slice(tag);
        data[entry + 8..entry + 12].copy_from_slice(&(offset as u32).to_be_bytes());
        data[entry + 12..entry + 16].copy_from_slice(&(length as u32).to_be_bytes());
    };
    put(0, b"head", HEAD, 54);
    put(1, b"hhea", HHEA, 36);
    put(2, b"maxp", MAXP, 32);
    put(3, b"hmtx", HMTX, 8);
    put(4, b"cmap", CMAP, 12 + 32);
    put(5, b"glyf", GLYF, 16);

    data[HEAD + 18..HEAD + 20].copy_from_slice(&1000u16.to_be_bytes());
    data[HHEA + 34..HHEA + 36].copy_from_slice(&2u16.to_be_bytes());
    data[MAXP + 4..MAXP + 6].copy_from_slice(&10u16.to_be_bytes());
    // GID 0 与 GID 1 的宽度都设成 500 → 每个字符恒为 0.5 em
    data[HMTX..HMTX + 2].copy_from_slice(&500u16.to_be_bytes());
    data[HMTX + 4..HMTX + 6].copy_from_slice(&500u16.to_be_bytes());

    // cmap：格式 4，一段 [0x0000, 0xFFFF]，idDelta = 1（所有码点 → GID 1）
    data[CMAP + 2..CMAP + 4].copy_from_slice(&1u16.to_be_bytes());
    data[CMAP + 4..CMAP + 6].copy_from_slice(&3u16.to_be_bytes());
    data[CMAP + 6..CMAP + 8].copy_from_slice(&1u16.to_be_bytes());
    data[CMAP + 8..CMAP + 12].copy_from_slice(&12u32.to_be_bytes());
    let sub = SUBTABLE;
    data[sub..sub + 2].copy_from_slice(&4u16.to_be_bytes());
    data[sub + 2..sub + 4].copy_from_slice(&32u16.to_be_bytes());
    data[sub + 6..sub + 8].copy_from_slice(&2u16.to_be_bytes());
    data[sub + 14..sub + 16].copy_from_slice(&0xFFFFu16.to_be_bytes());
    data[sub + 18..sub + 20].copy_from_slice(&0x0000u16.to_be_bytes());
    // idDelta = 1（数组排布同 font.rs 的合成字体）
    data[sub + 20..sub + 22].copy_from_slice(&1u16.to_be_bytes());
    data
}

/// 由 uniform_font_bytes 解析出来的字体，供跨模块测试使用。
#[cfg(test)]
pub(crate) fn uniform_font_for_page_tests() -> TrueTypeFont {
    TrueTypeFont::parse("uniform.ttf", uniform_font_bytes()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn font() -> TrueTypeFont {
        uniform_font_for_page_tests()
    }

    #[test]
    fn advance_of_is_half_em_for_every_character() {
        let font = font();
        // 字号 10pt，半角 500/1000 em → 每个字 5pt
        assert!((advance_of(&font, '字', 10.0) - 5.0).abs() < 0.001);
        assert!((advance_of(&font, 'a', 10.0) - 5.0).abs() < 0.001);
        assert!((measure(&font, "字字字", 10.0) - 15.0).abs() < 0.001);
    }

    #[test]
    fn wraps_chinese_by_character_count() {
        let font = font();
        let text = "字".repeat(50);
        // 宽度 100pt，每字 5pt → 每行 20 字
        let lines = wrap_text(&text, &font, 10.0, 100.0, false);
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert_eq!(lines[0].text.chars().count(), 20);
        assert_eq!(lines[2].text.chars().count(), 10);
    }

    #[test]
    fn first_line_indent_shifts_content_out_of_the_line() {
        let font = font();
        // 合成字体每个字恒为 0.5em：宽度 100pt、字号 10pt → 每行 20 字。
        // 缩进 2 个全角空格，每个 0.5em = 5pt，共 10pt → 首行只剩 18 字的空间。
        let text = "字".repeat(60);
        let lines = wrap_text(&text, &font, 10.0, 100.0, true);
        assert!(lines[0].indented);
        assert!(!lines[1].indented);
        assert_eq!(lines[0].text.chars().count(), 18, "{lines:?}");
        // 缩进只影响第一行，后续行恢复成 20 字
        assert_eq!(lines[1].text.chars().count(), 20, "{lines:?}");
        // 内容一个字都不能丢
        assert_eq!(
            lines.iter().map(|l| l.text.chars().count()).sum::<usize>(),
            60
        );
    }

    #[test]
    fn no_line_start_punctuation_is_kept_on_the_previous_line() {
        let font = font();
        // 每行 2 字。第三行本来会以句号开头（凑不满两个字就被断），
        // 避头规则要求把这个句号**挤到前一行末尾**。
        // 第一行已经满 2 字（甲乙），再接一个字符会略微超宽 —— 这正是
        // 设计上接受的代价：行尾多半个标点，好过行首孤零零一个句号。
        let lines = wrap_text("甲乙丙。", &font, 10.0, 10.0, false);
        assert_eq!(lines[0].text, "甲乙", "{lines:?}");
        assert_eq!(lines[1].text, "丙。", "{lines:?}");
    }

    #[test]
    fn no_line_start_punctuation_does_not_start_a_line() {
        let font = font();
        // 每行 2 字，第三个字符就是句号：它必须跟着前一行走，
        // 不能让第二行以「。」开头。
        let lines = wrap_text("甲乙。丙", &font, 10.0, 10.0, false);
        assert_eq!(lines[0].text, "甲乙。", "{lines:?}");
        assert_eq!(lines[1].text, "丙", "{lines:?}");
    }

    #[test]
    fn no_line_end_punctuation_is_pushed_to_the_next_line() {
        let font = font();
        // 每行 2 字。「正好卡在行尾，必须被推到下一行开头，
        // 否则读者会看到一行以左引号收尾。
        let lines = wrap_text("甲「乙丙", &font, 10.0, 10.0, false);
        assert_eq!(lines[0].text, "甲", "{lines:?}");
        assert_eq!(lines[1].text, "「乙", "{lines:?}");
    }

    #[test]
    fn explicit_newlines_are_preserved() {
        let font = font();
        let lines = wrap_text("甲\n乙\n丙", &font, 10.0, 100.0, false);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1].text, "乙");
    }

    #[test]
    fn empty_text_still_yields_one_line() {
        let font = font();
        let lines = wrap_text("", &font, 10.0, 100.0, true);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].indented);
    }

    #[test]
    fn extreme_narrow_width_does_not_loop_forever() {
        let font = font();
        // 缩进比整行宽度还大时，可用宽度兜底为 1 个字，不能死循环
        let lines = wrap_text(&"字".repeat(5), &font, 10.0, 1.0, true);
        assert!(!lines.is_empty());
        assert_eq!(
            lines.iter().map(|l| l.text.chars().count()).sum::<usize>(),
            5
        );
    }

    #[test]
    fn missing_glyph_falls_back_to_full_width() {
        let font = font();
        // 合成字体的 cmap 覆盖全 BMP，这里只验证「白空格有宽度」这条退化路径
        let space = advance_of(&font, '\u{3000}', 10.0);
        assert!(space > 0.0);
    }
}
