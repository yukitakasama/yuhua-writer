//! FTS5 中文二元组分词器。
//!
//! ## 为什么是二元组
//!
//! 中文不像英文有空格分词。可选的方案有三类：
//!
//! | 方案 | 优点 | 缺点 |
//! | --- | --- | --- |
//! | 整句当作一个 token | 实现最简单 | **完全不可用**，搜任何词都命中不了 |
//! | 词典分词（jieba 等） | 召回精确 | 引入词典体积；新词 / 人名 / 功法名切不准 |
//! | **二元组（本方案）** | 无需词典、任意两字词必中 | 索引体积约翻倍 |
//!
//! 对写作软件来说，**召回比精确更重要**：作者搜「羽化」时，
//! 哪怕多召回几段含「化羽」的文字，也比搜不到强得多。二元组是
//! 「绝不出豆腐块」在检索侧的对应选择。
//!
//! ## 切分规则
//!
//! ```text
//! 输入：羽化写作 hello world 123
//!
//! CJK 部分（连续的中日韩字符）：
//!   羽化写作 → 羽化 / 化写 / 写作
//!   单字「羽」→ 羽          （保留单字，供单字查询命中）
//!
//! 非 CJK 部分（连续的字母数字）：
//!   hello → hello           （整词小写）
//!   123   → 123
//!
//! 标点与空白：作为分隔符，不产生 token
//! ```
//!
//! ## 与查询的配合
//!
//! 查询串走**同一套切分**，因此：
//!
//! - 查「羽化」→ 切出 `羽化` → 精确命中索引里的 `羽化`
//! - 查「羽化写作」→ 切出 `羽化` `化写` `写作` → 短语查询可要求三者相邻
//! - 查「羽」→ 切出 `羽` → 需要配合前缀匹配才能命中 `羽化`
//!
//! 最后一条由 [`super::search`] 负责展开（详见该模块说明）。

use std::collections::HashSet;

/// 判断是否为需要按二元组切分的 CJK 字符。
///
/// 与 yuhua-core::count 里的判定保持一致的口径：中日韩统一表意文字
/// （含扩展 A–G）、日文假名、韩文音节。这样「字数统计」与「检索」
/// 对「什么是一个中文字」的理解不会分裂。
pub fn is_cjk(c: char) -> bool {
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

/// 把一段文本切分成检索 token。
///
/// 这是分词器的**纯函数核心**，不依赖 SQLite，因此可以被单元测试
/// 完整覆盖。FTS5 的 C 回调只是它的一个适配层。
///
/// 返回值可能包含重复 token（例如正文里「羽化」出现多次）。
/// 调用方若需要去重，自行处理（FTS5 索引器本身会处理词频）。
pub fn bigram_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();

    // 用 Peekable 以便向前看一个字符，实现相邻二字组合
    let mut chars = text.chars().peekable();

    while let Some(&c) = chars.peek() {
        if is_cjk(c) {
            // ---- CJK 游程：连续收集 CJK 字符，再按相邻二字切分 ----
            let mut run: Vec<char> = Vec::new();
            while let Some(&next) = chars.peek() {
                if is_cjk(next) {
                    run.push(next);
                    chars.next();
                } else {
                    break;
                }
            }

            if run.len() == 1 {
                // 单字自成 token：保证搜单个字（如姓名里的「曦」）能命中
                out.push(run[0].to_string());
            } else {
                // 相邻二字滑动窗口
                for window in run.windows(2) {
                    out.push(window.iter().collect::<String>());
                }
                // 游程末尾的单字也单独保留。
                // 理由：切出「羽化写作」后，若只保留 羽化/化写/写作，
                // 那么正文末尾的字（这里是「作」）就永远无法被单字查询命中。
                if let Some(&last) = run.last() {
                    out.push(last.to_string());
                }
            }
        } else if c.is_alphanumeric() {
            // ---- 拉丁 / 数字游程：整词作为一个 token，小写化 ----
            let mut word = String::new();
            while let Some(&next) = chars.peek() {
                if next.is_alphanumeric() && !is_cjk(next) {
                    word.push(next);
                    chars.next();
                } else {
                    break;
                }
            }
            out.push(word.to_lowercase());
        } else {
            // 标点 / 空白：分隔符，不产生 token
            chars.next();
        }
    }

    out
}

/// 切分并去重，保持首次出现的顺序。
///
/// 用于查询串解析：同一个词重复出现在查询里没有意义，
/// 去重可以显著缩短生成的 SQL。
pub fn unique_tokens(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for t in bigram_tokens(text) {
        if seen.insert(t.clone()) {
            out.push(t);
        }
    }
    out
}

/// 把查询串切成**用于检索**的 token。
///
/// 与 [`unique_tokens`] 的区别：丢掉「游程末尾补位的单字」。
///
/// 判定方法：重建输入串的游程结构，只有「处于二元组窗口内」的 token 才是
/// 真正的词成分。实现上更简单的等价做法是——**看该 token 是否由相邻两字构成**：
/// 我们直接对输入重新做一次「不含末尾补位」的切分。
///
/// 这样：
///
/// | 查询串 | query_tokens | 说明 |
/// | --- | --- | --- |
/// | 羽化 | `["羽化"]` | 真正的词 |
/// | 羽化写作 | `["羽化","化写","写作"]` | 三个二元组，全部必须命中 |
/// | 羽 | `["羽"]` | 单字查询，保留 |
/// | hello | `["hello"]` | 整词 |
pub fn query_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    let mut chars = text.chars().peekable();
    while let Some(&c) = chars.peek() {
        if is_cjk(c) {
            // 收集整个 CJK 游程，但**不做末尾补位**
            let mut run: Vec<char> = Vec::new();
            while let Some(&next) = chars.peek() {
                if is_cjk(next) {
                    run.push(next);
                    chars.next();
                } else {
                    break;
                }
            }
            if run.len() == 1 {
                push_unique(&mut out, &mut seen, run[0].to_string());
            } else {
                for w in run.windows(2) {
                    push_unique(&mut out, &mut seen, w.iter().collect::<String>());
                }
            }
        } else if c.is_alphanumeric() {
            let mut word = String::new();
            while let Some(&next) = chars.peek() {
                if next.is_alphanumeric() && !is_cjk(next) {
                    word.push(next);
                    chars.next();
                } else {
                    break;
                }
            }
            push_unique(&mut out, &mut seen, word.to_lowercase());
        } else {
            chars.next();
        }
    }

    out
}

/// 去重插入辅助。
fn push_unique(out: &mut Vec<String>, seen: &mut HashSet<String>, token: String) {
    if seen.insert(token.clone()) {
        out.push(token);
    }
}

/// FTS5 分词器（适配层）。
///
/// ## 为什么这个结构体几乎是空的
///
/// FTS5 的 tokenizer 需要注册一组 C 函数指针（xCreate / xTokenize / xDestroy），
/// 而这套注册 API 在 `rusqlite` 中并没有安全的封装。因此本 crate 采取的策略是：
///
/// 1. **分词逻辑**由上面纯 Rust 的 [`bigram_tokens`] 承担，
///    可被完整单元测试覆盖、零 unsafe
/// 2. **索引与查询**不走 FTS5 的自定义 tokenizer，
///    而是由本 crate 在写入前对文本调用 [`bigram_tokens`] 生成分词结果，
///    以**普通 FTS5 表 + 空格分隔的预分词文本**方式存储
///
/// 之所以这样取舍：FTS5 的 `unicode61` 分词器把空格当作分隔符，
/// 因此「预先用二元组切好并用空格连接」的文本，经 `unicode61` 入库后
/// 得到的 token 集合，**与直接注册二元组分词器完全一致**。
///
/// 好处是：
/// - 零 unsafe 代码（符合工作区 `unsafe_code = "forbid"` 的约定）
/// - 分词逻辑可测试、可调试（能直接打印切分结果）
/// - 避开 rusqlite 对自定义 tokenizer 的支持版本差异
///
/// 代价是多一次字符串分配。相对于索引本身的开销可以忽略。
#[derive(Debug, Clone, Copy, Default)]
pub struct BigramTokenizer;

impl BigramTokenizer {
    /// 把文本转成 FTS5 可索引的形式：二元组 token 用空格连接。
    ///
    /// 同一个 token 只保留一次，避免长文档里高频词把字符串撑大。
    pub fn tokenize(&self, text: &str) -> String {
        unique_tokens(text).join(" ")
    }

    /// 为查询串生成 FTS5 MATCH 表达式。
    ///
    /// ## 为什么不能直接用 unique_tokens 的结果
    ///
    /// [`bigram_tokens`] 为了保证**召回**，会在每个 CJK 游程的末尾
    /// 额外补一个单字 token（见该函数说明）。这个单字是给「单字查询」
    /// 用的索引侧辅助，**不是词的一部分**。
    ///
    /// 若查询时把它也当作必要条件，就会出问题。例如搜「羽化」：
    ///
    /// ```text
    /// unique_tokens("羽化") = ["羽化", "化"]
    /// 张成的表达式："羽化" AND "化"
    ///
    /// 但正文「羽化写作」入库的 token 是：
    ///   羽化 / 化写 / 写作 / 作
    /// 其中并没有独立的 "化"！于是查询必然落空。
    /// ```
    ///
    /// 正确做法是：**查询只用真正的二元组**（长度为 2 且同为 CJK 的 token），
    /// 丢掉末尾补位的单字。这样「羽化」只要求 `"羽化"` 命中，符合直觉。
    ///
    /// 只有当查询串本身就只有单个 CJK 字时（例如搜「羽」），
    /// 才保留那个单字 —— 此时配合前缀匹配扩大召回。
    pub fn match_expression(&self, query: &str) -> Option<String> {
        let tokens = query_tokens(query);
        if tokens.is_empty() {
            return None;
        }
        let parts: Vec<String> = tokens.iter().map(|t| escape_fts_token(t)).collect();
        Some(parts.join(" AND "))
    }

    /// 为「前缀匹配」生成表达式，用于单字查询。
    ///
    /// 中文里单字查询很常见（搜一个人名里的字）。索引里存的二元组
    /// `羽化` 以 `羽` 开头，因此前缀匹配 `"羽"*` 能命中它。
    ///
    /// **注意**：前缀匹配下不能再叠加「末尾单字」条件，
    /// 否则又会退化成 [`Self::match_expression`] 说明里那个落空的查询。
    pub fn prefix_expression(&self, query: &str) -> Option<String> {
        let tokens = query_tokens(query);
        if tokens.is_empty() {
            return None;
        }
        let parts: Vec<String> = tokens
            .iter()
            .map(|t| format!("{}*", escape_fts_token(t)))
            .collect();
        Some(parts.join(" AND "))
    }
}

/// 转义 FTS5 查询里的特殊字符。
///
/// FTS5 的查询语法里 `"` 用于短语、`*` 用于前缀。token 由我们的分词器
/// 产生，理论上只含汉字与字母数字，但**用户输入不可信**，
/// 因此统一包成双引号字符串字面量，杜绝语法注入导致的查询报错。
fn escape_fts_token(token: &str) -> String {
    format!("\"{}\"", token.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_chinese_splits_into_bigrams() {
        let t = bigram_tokens("羽化写作");
        // 3 个二元组 + 末尾单字
        assert_eq!(t, vec!["羽化", "化写", "写作", "作"]);
    }

    #[test]
    fn two_char_chinese_gives_one_bigram_plus_last_char() {
        let t = bigram_tokens("羽化");
        assert_eq!(t, vec!["羽化", "化"]);
    }

    #[test]
    fn single_chinese_char_stays_whole() {
        assert_eq!(bigram_tokens("羽"), vec!["羽"]);
    }

    #[test]
    fn empty_input_yields_no_tokens() {
        assert!(bigram_tokens("").is_empty());
    }

    #[test]
    fn english_words_are_kept_whole_and_lowercased() {
        assert_eq!(bigram_tokens("Hello"), vec!["hello"]);
        assert_eq!(bigram_tokens("HelloWorld"), vec!["helloworld"]);
    }

    #[test]
    fn digits_form_their_own_tokens() {
        assert_eq!(bigram_tokens("123"), vec!["123"]);
    }

    #[test]
    fn punctuation_separates_without_producing_tokens() {
        let t = bigram_tokens("你好，世界。");
        assert_eq!(t, vec!["你好", "好", "世界", "界"]);
    }

    #[test]
    fn mixed_script_splits_at_script_boundary() {
        let t = bigram_tokens("羽化hello写作");
        assert_eq!(t, vec!["羽化", "化", "hello", "写作", "作"]);
    }

    #[test]
    fn whitespace_is_a_separator() {
        let t = bigram_tokens("羽化 写作");
        assert_eq!(t, vec!["羽化", "化", "写作", "作"]);
    }

    #[test]
    fn japanese_kana_is_tokenized_as_cjk() {
        let t = bigram_tokens("ひらがな");
        assert_eq!(t, vec!["ひら", "らが", "がな", "な"]);
    }

    #[test]
    fn korean_hangul_is_tokenized_as_cjk() {
        let t = bigram_tokens("한국어");
        assert_eq!(t, vec!["한국", "국어", "어"]);
    }

    #[test]
    fn rare_cjk_extension_is_handled() {
        // 扩展 B 区生僻字（小说人名常用）必须能参与分词
        let s = "\u{20000}\u{20001}";
        let t = bigram_tokens(s);
        assert_eq!(t.len(), 2, "got {t:?}");
    }

    #[test]
    fn long_run_yields_n_tokens_for_n_chars() {
        // n 个字符的游程 -> (n-1) 个二元组 + 1 个末尾单字 = n 个 token
        let s = "一二三四五六七八九十";
        let t = bigram_tokens(s);
        assert_eq!(t.len(), 10, "got {t:?}");
        assert_eq!(t[0], "一二");
        assert_eq!(t[1], "二三");
        assert_eq!(t[8], "九十");
        assert_eq!(t[9], "十");
    }

    #[test]
    fn any_two_char_substring_is_searchable() {
        // 这是二元组方案的核心价值主张，必须成立的契约
        let text = "羽化写作是一款中文长篇小说创作软件";
        let tokens: HashSet<String> = bigram_tokens(text).into_iter().collect();
        // 任取几个真实的两字词，都必须出现在 token 集合里
        for probe in ["羽化", "写作", "小说", "创作", "软件", "中文"] {
            assert!(
                tokens.contains(probe),
                "两字词「{probe}」无法被检索到，token 集合：{tokens:?}"
            );
        }
    }

    #[test]
    fn unique_tokens_dedupes_preserving_order() {
        let t = unique_tokens("羽化羽化羽化");
        // bigram: 羽化/化羽/羽化/化羽/羽化/化  -> 去重后 羽化, 化羽, 化
        assert_eq!(t, vec!["羽化", "化羽", "化"]);
    }

    #[test]
    fn tokenize_joins_with_spaces() {
        let s = BigramTokenizer.tokenize("羽化写作");
        assert_eq!(s, "羽化 化写 写作 作");
    }

    #[test]
    fn tokenize_is_idempotent_on_repeated_words() {
        // 长文档里同一个词出现很多次，不应把索引串撑大
        let a = BigramTokenizer.tokenize("羽化");
        let b = BigramTokenizer.tokenize("羽化 羽化 羽化 羽化");
        assert_eq!(a, b);
    }

    #[test]
    fn match_expression_ands_all_bigrams() {
        // 查询侧只用真正的二元组，不含末尾补位单字「作」
        let e = BigramTokenizer.match_expression("羽化写作").unwrap();
        assert_eq!(e, "\"羽化\" AND \"化写\" AND \"写作\"");
    }

    #[test]
    fn query_tokens_drops_trailing_padding_char() {
        // 这是修复「搜两字词落空」的核心契约
        assert_eq!(query_tokens("羽化"), vec!["羽化"]);
        assert_eq!(query_tokens("落羽"), vec!["落羽"]);
        // 单字查询必须保留
        assert_eq!(query_tokens("羽"), vec!["羽"]);
        // 整串查询保留全部二元组
        assert_eq!(query_tokens("羽化写作"), vec!["羽化", "化写", "写作"]);
    }

    #[test]
    fn query_tokens_matches_indexed_bigrams() {
        // 契约测试：查询串产生的每个 token，都必须在
        // 「正文分词结果的 token 集合」里存在，否则检索必然落空。
        let body = "羽化写作是一款中文长篇小说创作软件";
        let indexed: std::collections::HashSet<String> = bigram_tokens(body).into_iter().collect();
        for probe in ["羽化", "写作", "小说", "创作", "软件", "中文", "羽化写作"] {
            for tok in query_tokens(probe) {
                assert!(
                    indexed.contains(&tok),
                    "查询「{probe}」产生的 token「{tok}」不在索引中，检索会落空"
                );
            }
        }
    }

    #[test]
    fn match_expression_returns_none_for_punctuation_only() {
        assert!(BigramTokenizer.match_expression("，。！").is_none());
        assert!(BigramTokenizer.match_expression("   ").is_none());
    }

    #[test]
    fn match_expression_handles_single_char_query() {
        let e = BigramTokenizer.match_expression("羽").unwrap();
        assert_eq!(e, "\"羽\"");
    }

    #[test]
    fn prefix_expression_appends_star() {
        let e = BigramTokenizer.prefix_expression("羽").unwrap();
        assert_eq!(e, "\"羽\"*");
    }

    #[test]
    fn prefix_expression_returns_none_for_empty() {
        assert!(BigramTokenizer.prefix_expression("").is_none());
    }

    #[test]
    fn tokens_are_escaped_against_fts_syntax_injection() {
        // 用户输入的引号不能让 FTS5 查询语法被破坏
        let e = BigramTokenizer.match_expression("a\"b").unwrap();
        assert!(!e.is_empty());
        // 转义后每个 token 都被包裹，内部引号被替换
        assert!(e.starts_with('"'));
    }

    #[test]
    fn very_long_input_does_not_panic() {
        let s = "字".repeat(10_000);
        let t = bigram_tokens(&s);
        assert_eq!(t.len(), 10_000);
    }

    #[test]
    fn is_cjk_matches_expected_ranges() {
        assert!(is_cjk('羽'));
        assert!(is_cjk('あ'));
        assert!(is_cjk('한'));
        assert!(!is_cjk('a'));
        assert!(!is_cjk('1'));
        assert!(!is_cjk('，'));
    }
}
