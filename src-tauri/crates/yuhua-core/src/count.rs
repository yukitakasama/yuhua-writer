//! 字数统计引擎 —— **三套口径**。
//!
//! 计划书第 17 节确认：字数统计提供三档可切换的口径，默认「不含标点」。
//! 为什么必须做三套？因为不同平台对「字数」的定义不同，网文作者投稿时
//! 需要跟平台对齐：
//!
//! | 口径 | 规则 | 典型场景 |
//! | --- | --- | --- |
//! | CountMode::WithPunctuation | 汉字 + 字母数字 + 标点 | 按字符计数的平台 |
//! | CountMode::WithoutPunctuation | 汉字 + 字母数字，标点与空白不计 | **默认** |
//! | CountMode::WordsForEnglish | 汉字逐字计，连续英文单词整体算 1 | 中英混排 |
//!
//! ## 实现要点
//!
//! - 标注为 CJK 的字符**逐字计数**（中文里一个字就是一个「字」）
//! - 连续 ASCII 字母数字在「按词」口径下聚合成一个词
//! - **不跳过** Markdown 语法标记：字数统计面向「作者写了多少」，
//!   编辑器显示的字数应与用户看到的正文一致，Markdown 符号也是敲出来的字符。

use serde::{Deserialize, Serialize};

/// 字数统计口径。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CountMode {
    /// 含标点：所有非空白字符都算，全角标点算 1 个。
    WithPunctuation,
    /// 不含标点：标点与空白都不计入。**默认口径。**
    #[default]
    WithoutPunctuation,
    /// 英文按词：中文逐字，连续英文 / 数字聚合为一个词。
    WordsForEnglish,
}

impl CountMode {
    /// 用户界面上的中文名。
    pub fn label(self) -> &'static str {
        match self {
            Self::WithPunctuation => "含标点",
            Self::WithoutPunctuation => "不含标点",
            Self::WordsForEnglish => "英文按词",
        }
    }

    /// 全部取值，供前端渲染切换控件。
    pub fn all() -> [Self; 3] {
        [
            Self::WithPunctuation,
            Self::WithoutPunctuation,
            Self::WordsForEnglish,
        ]
    }
}

/// 一次统计的完整结果。
///
/// 三个口径**一次算完**并同时返回，而不是让调用方选一个：
/// 遍历成本几乎相同，一次算完可让前端切换口径时零延迟，
/// 也避免「切换口径要重扫全文」的性能陷阱。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordCount {
    /// 含标点字数。
    pub with_punctuation: u32,
    /// 不含标点字数。
    pub without_punctuation: u32,
    /// 中文逐字 + 英文按词。
    pub words_for_english: u32,
    /// 汉字个数（用于统计页展示纯中文体量）。
    pub han_chars: u32,
    /// 段落数（按连续非空行分组）。
    pub paragraphs: u32,
}

impl WordCount {
    /// 按指定口径取数。
    pub fn get(&self, mode: CountMode) -> u32 {
        match mode {
            CountMode::WithPunctuation => self.with_punctuation,
            CountMode::WithoutPunctuation => self.without_punctuation,
            CountMode::WordsForEnglish => self.words_for_english,
        }
    }

    /// 把另一份统计累加到自身（用于「本卷 / 全书」聚合）。
    ///
    /// paragraphs 也是相加的：跨章聚合时段落数应当是各章之和。
    pub fn merge(&mut self, other: &WordCount) {
        self.with_punctuation += other.with_punctuation;
        self.without_punctuation += other.without_punctuation;
        self.words_for_english += other.words_for_english;
        self.han_chars += other.han_chars;
        self.paragraphs += other.paragraphs;
    }

    /// 从迭代器聚合。
    ///
    /// 用 `Borrow<WordCount>` 而不是 `&WordCount`：调用方既能直接传
    /// `count_words(t)` 产出的拥有所有权的值，也能传 `&wc` 引用，
    /// 省掉在调用点写 `\&x` 的噪音。
    pub fn sum<I, B>(items: I) -> WordCount
    where
        I: IntoIterator<Item = B>,
        B: std::borrow::Borrow<WordCount>,
    {
        let mut acc = WordCount::default();
        for it in items {
            acc.merge(it.borrow());
        }
        acc
    }
}

/// 判断是否为需要逐字计数的 CJK 字符。
///
/// 覆盖范围比「汉字」更宽：中日韩统一表意文字（含扩展 A–G）、
/// 日文假名、韩文音节、半角片假名。
///
/// 这样做的理由：小说里出现假名、韩文、扩展区生僻字都很常见，
/// 若只认基本区，这些字会掉进「按英文词处理」的分支导致字数严重偏低。
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF     // 日文平假名 / 片假名
        | 0x31F0..=0x31FF   // 片假名语音扩展
        | 0x3400..=0x4DBF   // CJK 扩展 A
        | 0x4E00..=0x9FFF   // CJK 基本区
        | 0xF900..=0xFAFF   // CJK 兼容表意文字
        | 0xFF66..=0xFF9F   // 半角片假名
        | 0xAC00..=0xD7AF   // 韩文音节
        | 0x1100..=0x11FF   // 韩文字母
        | 0x20000..=0x2FA1F // CJK 扩展 B–F
        | 0x30000..=0x3134F // CJK 扩展 G
    )
}

/// 判断是否为「文字类」字符（字母或数字，且非 CJK）。
///
/// 用 char::is_alphanumeric 覆盖所有 Unicode 字母数字，
/// 因此俄文、希腊文、阿拉伯文等同样会被正确计数，不会静默丢弃。
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() && !is_cjk(c)
}

/// 判断是否为标点（非空白、非字母数字、非 CJK）。
fn is_punctuation(c: char) -> bool {
    !c.is_whitespace() && !c.is_alphanumeric() && !is_cjk(c)
}

/// 统计文本字数，一次产出三套口径的结果。
///
/// 单次遍历完成全部统计，时间复杂度 O(n)、额外空间 O(1)（不含输入本身），
/// 因此在长文档上可以放心频繁调用。
pub fn count_words(text: &str) -> WordCount {
    let mut out = WordCount::default();

    // 当前是否处于一个英文 / 数字词内部。
    // 用状态机而不是先 split 再判断，好处是不产生任何中间 Vec 分配。
    let mut in_latin_word = false;
    // 段落计数：空行是段落分隔符，需要记住当前段落是否已有内容
    let mut has_content_in_paragraph = false;

    for c in text.chars() {
        // ---- 段落统计 ----
        if c == '\n' {
            if has_content_in_paragraph {
                out.paragraphs += 1;
                has_content_in_paragraph = false;
            }
            in_latin_word = false;
            continue;
        }

        if !c.is_whitespace() {
            has_content_in_paragraph = true;
        }

        // ---- 计数 ----
        if is_cjk(c) {
            // 汉字：三套口径都逐字计入
            out.han_chars += 1;
            out.with_punctuation += 1;
            out.without_punctuation += 1;
            out.words_for_english += 1;
            in_latin_word = false;
        } else if is_word_char(c) {
            // 字母 / 数字：含标点与不含标点口径都逐字符计入
            out.with_punctuation += 1;
            out.without_punctuation += 1;
            // 按词口径：只在「词的开头」计一次
            if !in_latin_word {
                out.words_for_english += 1;
                in_latin_word = true;
            }
        } else if is_punctuation(c) {
            // 标点：只有含标点口径计入
            out.with_punctuation += 1;
            in_latin_word = false;
        } else {
            // 空白：任何口径都不计入，且打断英文词
            in_latin_word = false;
        }
    }

    // 收尾：最后一行若没有以换行结束，仍算一个段落
    if has_content_in_paragraph {
        out.paragraphs += 1;
    }

    out
}

/// 只取某一个口径的字数（便捷函数）。
///
/// 内部仍走完整统计。若在热点循环里反复调用同一段文本的不同口径，
/// 应当先调 count_words 拿完整结果再 WordCount::get。
pub fn count_in_mode(text: &str, mode: CountMode) -> u32 {
    count_words(text).get(mode)
}

/// 一次性返回三套口径的统计结果，便于直接塞进 IPC 返回值。
pub fn count_words_all_modes(text: &str) -> WordCount {
    count_words(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_chinese_counts_each_char() {
        let c = count_words("羽化写作");
        assert_eq!(c.han_chars, 4);
        assert_eq!(c.with_punctuation, 4);
        assert_eq!(c.without_punctuation, 4);
        assert_eq!(c.words_for_english, 4);
    }

    #[test]
    fn chinese_punctuation_only_counts_in_with_punctuation() {
        let c = count_words("你好，世界。");
        assert_eq!(c.han_chars, 4);
        assert_eq!(c.with_punctuation, 6); // 4 汉字 + ，+ 。
        assert_eq!(c.without_punctuation, 4); // 标点被排除
        assert_eq!(c.words_for_english, 4);
    }

    #[test]
    fn english_words_aggregate_in_words_mode() {
        let c = count_words("hello world");
        assert_eq!(c.han_chars, 0);
        assert_eq!(c.with_punctuation, 10); // 10 个字母，空格不计
        assert_eq!(c.without_punctuation, 10);
        assert_eq!(c.words_for_english, 2); // hello + world
    }

    #[test]
    fn mixed_cjk_and_english() {
        let c = count_words("羽化 hello 写作 world");
        assert_eq!(c.han_chars, 4);
        assert_eq!(c.words_for_english, 6); // 4 汉字 + 2 英文词
        assert_eq!(c.without_punctuation, 14); // 4 汉字 + 10 字母
    }

    #[test]
    fn whitespace_never_counted() {
        let c = count_words("a \t\n  b");
        assert_eq!(c.with_punctuation, 2);
        assert_eq!(c.without_punctuation, 2);
        assert_eq!(c.words_for_english, 2);
    }

    #[test]
    fn english_punctuation_breaks_word() {
        // "don't" 在按词口径下算 2 个词（don + t），因为单引号是标点。
        // 这是有意的简化：不做英文词形还原，规则保持可预测。
        let c = count_words("don't");
        assert_eq!(c.words_for_english, 2);
        assert_eq!(c.with_punctuation, 5);
        assert_eq!(c.without_punctuation, 4);
    }

    #[test]
    fn digits_count_as_words() {
        let c = count_words("第 3 章");
        assert_eq!(c.han_chars, 2);
        assert_eq!(c.words_for_english, 3); // 第 + 3 + 章
    }

    #[test]
    fn japanese_kana_counts_per_char() {
        // 假名必须走 CJK 分支逐字计数，不能掉进英文词分支
        let c = count_words("ひらがな");
        assert_eq!(c.han_chars, 4);
        assert_eq!(c.words_for_english, 4);
    }

    #[test]
    fn korean_hangul_counts_per_char() {
        let c = count_words("한국어");
        assert_eq!(c.han_chars, 3);
        assert_eq!(c.words_for_english, 3);
    }

    #[test]
    fn rare_cjk_extension_counts() {
        // CJK 扩展 B 区生僻字（小说人名地名常见），必须被计入
        let c = count_words("\u{20000}");
        assert_eq!(c.han_chars, 1);
        assert_eq!(c.words_for_english, 1);
    }

    #[test]
    fn paragraphs_are_split_by_newline() {
        let c = count_words("第一段\n第二段\n\n第三段");
        assert_eq!(c.paragraphs, 3);
    }

    #[test]
    fn blank_lines_do_not_create_paragraphs() {
        let c = count_words("\n\n\n");
        assert_eq!(c.paragraphs, 0);
        assert_eq!(c.with_punctuation, 0);
    }

    #[test]
    fn trailing_newline_does_not_add_paragraph() {
        assert_eq!(count_words("一段").paragraphs, 1);
        assert_eq!(count_words("一段\n").paragraphs, 1);
    }

    #[test]
    fn windows_crlf_is_handled() {
        // 读文件时虽然会归一 CRLF，但统计函数本身也不该把 \r 当标点算进去
        let c = count_words("第一段\r\n第二段");
        assert_eq!(c.paragraphs, 2);
        assert_eq!(c.han_chars, 6);
    }

    #[test]
    fn empty_text_yields_zero() {
        assert_eq!(count_words(""), WordCount::default());
    }

    #[test]
    fn merge_accumulates_all_fields() {
        let mut a = count_words("你好");
        a.merge(&count_words("hello world"));
        assert_eq!(a.han_chars, 2);
        assert_eq!(a.words_for_english, 4); // 2 + 2
        assert_eq!(a.without_punctuation, 12); // 2 + 10
    }

    #[test]
    fn sum_over_iterator_matches_manual_add() {
        let texts = ["你好", "hello world", "第三段文本"];
        let total = WordCount::sum(texts.iter().map(|t| count_words(t)));
        let expected: u32 = texts.iter().map(|t| count_words(t).han_chars).sum();
        assert_eq!(total.han_chars, expected);
    }

    #[test]
    fn mode_getters_return_matching_fields() {
        let c = count_words("你好，world");
        assert_eq!(c.get(CountMode::WithPunctuation), c.with_punctuation);
        assert_eq!(c.get(CountMode::WithoutPunctuation), c.without_punctuation);
        assert_eq!(c.get(CountMode::WordsForEnglish), c.words_for_english);
    }

    #[test]
    fn default_mode_is_without_punctuation() {
        // 计划书第 17 节确认：默认口径是「不含标点」
        assert_eq!(CountMode::default(), CountMode::WithoutPunctuation);
    }

    #[test]
    fn count_in_mode_matches_full_count() {
        let t = "你好，world！";
        assert_eq!(
            count_in_mode(t, CountMode::WithPunctuation),
            count_words(t).with_punctuation
        );
    }
}
