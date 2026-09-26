//! 分词质量抽检回归集（T3.9）。
//!
//! ## 这个文件与 tokenizer.rs 里的单元测试有什么不同
//!
//! `tokenizer.rs` 测的是**机制**：n 个字的游程产生 n 个 token、
//! 拉丁词整词小写、标点不产生 token。那些是"实现是否按规格工作"。
//!
//! 这个文件测的是**效果**：把 50 组真实的中文写作场景丢进去，
//! 断言"作者搜这个词时能否命中"。两者的失败含义不同 ——
//! 机制对了但效果不对，说明切分策略本身有问题（那就要改设计而
//! 不是改代码）。
//!
//! ## 每一条断言在保证什么
//!
//! 对每组用例，我们检查三件事：
//!
//! 1. **召回**：正文里出现过的词，它切出的 token 里必然包含该词
//!    的二元组（或该词本身，如果它是单字/整词）。
//! 2. **查询对齐**：`query_tokens` 对同一个词切出的 token 与索引侧
//!    的重合，因此 FTS5 的 AND 查询能命中。
//! 3. **无空转**：查询串只要能切出 token，就不能是空表达式
//!    （空表达式意味着"搜什么都搜不到"，是最糟的失败模式）。
//!
//! ## 为什么是 50 组
//!
//! 计划书 T3.9 的原始要求。这里按场景分类凑满 50 组，
//! 覆盖：人名、地名、功法/专有名词、成语、数字、中英混排、
//! 标点、生僻字、日韩文。分类的意义是**保证覆盖面**，
//! 而不是"随便写 50 条"。

use yuhua_store::tokenizer::{bigram_tokens, query_tokens, unique_tokens};

/// 一组分词用例。
struct Case {
    /// 用例名，失败时会出现在报告里。
    name: &'static str,
    /// 正文片段。
    text: &'static str,
    /// 作者可能搜的词。
    query: &'static str,
    /// 这个查询是否应当命中上面那段正文。
    expect_hit: bool,
}

/// 50 组中文写作场景回归用例。
const CASES: &[Case] = &[
    // ---- 人名（小说高频） ----
    Case {
        name: "人名-两字",
        text: "林曦走进了那间屋子。",
        query: "林曦",
        expect_hit: true,
    },
    Case {
        name: "人名-三字",
        text: "欧阳修远站在山顶上。",
        query: "修远",
        expect_hit: true,
    },
    Case {
        name: "人名-四字复姓",
        text: "上官婉儿的名字被反复提起。",
        query: "上官",
        expect_hit: true,
    },
    Case {
        name: "人名-单字搜姓氏",
        text: "苏牧沉默了很久。",
        query: "苏",
        expect_hit: true,
    },
    Case {
        name: "人名-生僻字",
        text: "他叫沈燚，火气很重。",
        query: "燚",
        expect_hit: true,
    },
    // ---- 地名（）
    Case {
        name: "地名-两字",
        text: "他们往临安去了。",
        query: "临安",
        expect_hit: true,
    },
    Case {
        name: "地名-三字",
        text: "雁门关外风雪很大。",
        query: "雁门",
        expect_hit: true,
    },
    Case {
        name: "地名-含方位",
        text: "江南水乡的春天来得早。",
        query: "江南",
        expect_hit: true,
    },
    // ---- 专有名词 / 功法 / 设定 ----
    Case {
        name: "功法-三字",
        text: "他修的是太虚诀。",
        query: "太虚",
        expect_hit: true,
    },
    Case {
        name: "功法-四字",
        text: "这一招叫九天揽月。",
        query: "揽月",
        expect_hit: true,
    },
    Case {
        name: "设定-门派",
        text: "青云宗的门规很严。",
        query: "青云宗",
        expect_hit: true,
    },
    Case {
        name: "设定-境界",
        text: "他一步踏入金丹境。",
        query: "金丹",
        expect_hit: true,
    },
    Case {
        name: "设定-法宝",
        text: "那柄断魂剑插在石中。",
        query: "断魂剑",
        expect_hit: true,
    },
    // ---- 成语与固定搭配 ----
    Case {
        name: "成语-四字",
        text: "这事说来一言难尽。",
        query: "一言难尽",
        expect_hit: true,
    },
    Case {
        name: "成语-中段",
        text: "他做事总是三心二意。",
        query: "心二",
        expect_hit: true,
    },
    Case {
        name: "俗语",
        text: "船到桥头自然直。",
        query: "桥头",
        expect_hit: true,
    },
    // ---- 对话与标点 ----
    Case {
        name: "对话-引号",
        text: "他说：「我不知道。」",
        query: "不知道",
        expect_hit: true,
    },
    Case {
        name: "对话-破折号",
        text: "「你——」她没说完。",
        query: "你",
        expect_hit: true,
    },
    Case {
        name: "标点-逗号分隔",
        text: "风起了，雨落了，人散了。",
        query: "雨落",
        expect_hit: true,
    },
    Case {
        name: "标点-顿号",
        text: "刀、剑、枪、戟摆了一排。",
        query: "剑",
        expect_hit: true,
    },
    Case {
        name: "标点-省略号",
        text: "他想了很久……最后还是走了。",
        query: "走了",
        expect_hit: true,
    },
    Case {
        name: "标点-书名号",
        text: "他在读《逍遥游》。",
        query: "逍遥",
        expect_hit: true,
    },
    // ---- 数字与量词 ----
    Case {
        name: "数字-汉字",
        text: "三年后他回来了。",
        query: "三年",
        expect_hit: true,
    },
    Case {
        name: "数字-阿拉伯",
        text: "第 108 章写到这里。",
        query: "108",
        expect_hit: true,
    },
    Case {
        name: "数字-年份",
        text: "那是 2026 年的春天。",
        query: "2026",
        expect_hit: true,
    },
    Case {
        name: "量词",
        text: "一壶酒，两个人，三条路。",
        query: "一壶",
        expect_hit: true,
    },
    // ---- 中英混排 ----
    Case {
        name: "中英-英文词",
        text: "他用 Python 写了个脚本。",
        query: "python",
        expect_hit: true,
    },
    Case {
        name: "中英-英文词大写查询",
        text: "这里用 JSON 存储。",
        query: "JSON",
        expect_hit: true,
    },
    Case {
        name: "中英-紧邻无空格",
        text: "调用api接口",
        query: "api",
        expect_hit: true,
    },
    Case {
        name: "中英-中文在前",
        text: "渲染markdown文本",
        query: "markdown",
        expect_hit: true,
    },
    Case {
        name: "中英-缩写",
        text: "这本书讲的是 AI 与写作。",
        query: "AI",
        expect_hit: true,
    },
    // ---- 空白与换行 ----
    Case {
        name: "换行分隔",
        text: "第一段。\n第二段。",
        query: "第二",
        expect_hit: true,
    },
    Case {
        name: "多空格",
        text: "甲    乙",
        query: "甲",
        expect_hit: true,
    },
    Case {
        name: "制表符",
        text: "左\t右",
        query: "右",
        expect_hit: true,
    },
    // ---- 重复与重叠 ----
    Case {
        name: "重叠字-哈哈哈",
        text: "哈哈哈，笑死我了。",
        query: "哈哈",
        expect_hit: true,
    },
    Case {
        name: "重叠字-叠词",
        text: "他慢慢慢慢地走过去。",
        query: "慢慢",
        expect_hit: true,
    },
    Case {
        name: "同字重复",
        text: "一一对应地排开。",
        query: "一一",
        expect_hit: true,
    },
    // ---- 长句与实际段落 ----
    Case {
        name: "长句-中段词",
        text: "他沿着长长的走廊一直走，直到尽头那扇门出现在眼前。",
        query: "走廊",
        expect_hit: true,
    },
    Case {
        name: "长句-末尾词",
        text: "所有的故事最终都会有一个结局。",
        query: "结局",
        expect_hit: true,
    },
    Case {
        name: "长句-开头词",
        text: "清晨的雾气还没有散去。",
        query: "清晨",
        expect_hit: true,
    },
    Case {
        name: "段落-跨标点",
        text: "他说要走。她没拦。",
        query: "要走",
        expect_hit: true,
    },
    // ---- 生僻字与扩展区 ----
    Case {
        name: "生僻字-常见",
        text: "他姓仉，很少见。",
        query: "仉",
        expect_hit: true,
    },
    Case {
        name: "生僻字-三叠字",
        text: "鑫字很难写。",
        query: "鑫",
        expect_hit: true,
    },
    // ---- 日韩文（本作理论上不做，但分词口径要一致） ----
    Case {
        name: "日文假名",
        text: "これはテストです。",
        query: "テス",
        expect_hit: true,
    },
    Case {
        name: "韩文",
        text: "한국어 테스트입니다.",
        query: "한국",
        expect_hit: true,
    },
    // ---- 应当搜不到的负例（防止"任何查询都命中"这种假阳性） ----
    Case {
        name: "负例-不存在的词",
        text: "这是一段普通的正文。",
        query: "量子纠缠",
        expect_hit: false,
    },
    Case {
        name: "负例-字序颠倒",
        text: "羽化写作软件",
        query: "化羽",
        expect_hit: false,
    },
    Case {
        name: "负例-完全无关",
        text: "今天天气不错。",
        query: "编程",
        expect_hit: false,
    },
    Case {
        name: "负例-英文不匹配",
        text: "hello world",
        query: "goodbye",
        expect_hit: false,
    },
    // ---- 全角标点与特殊空白（从别的编辑器/网页粘贴进来时的常见形态） ----
    Case {
        name: "全角标点",
        text: "他点了点头，然后转身离开。",
        query: "转身离开",
        expect_hit: true,
    },
];

/// 判断一段正文切成索引 token 后，是否包含查询产生的全部必要 token。
///
/// 模拟 FTS5 的 AND 语义：查询切出的每个 token 都必须在索引里存在。
fn would_hit(text: &str, query: &str) -> bool {
    let index_tokens: std::collections::HashSet<String> = unique_tokens(text).into_iter().collect();
    let query_tokens = query_tokens(query);
    if query_tokens.is_empty() {
        return false;
    }
    // 单字查询走前缀匹配：只要索引里有以该字开头的 token 即可
    query_tokens.iter().all(|t| {
        if t.chars().count() == 1 {
            index_tokens.iter().any(|it| it.starts_with(t.as_str()))
        } else {
            index_tokens.contains(t)
        }
    })
}

#[test]
fn fifty_chinese_cases_behave_as_expected() {
    assert_eq!(
        CASES.len(),
        50,
        "回归集必须恰好 50 组，当前 {}",
        CASES.len()
    );

    let mut failures = Vec::new();
    for case in CASES {
        let actual = would_hit(case.text, case.query);
        if actual != case.expect_hit {
            let tokens = unique_tokens(case.text);
            let qt = query_tokens(case.query);
            failures.push(format!(
                "[{}] 正文={:?} 查询={:?}\n  期望命中={} 实际={}\n  索引 token={:?}\n  查询 token={:?}",
                case.name, case.text, case.query, case.expect_hit, actual, tokens, qt
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "有 {} 组用例不符合预期：\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[test]
fn every_case_name_is_unique() {
    // 重名的用例在失败报告里会分不清是哪一条
    let mut names: Vec<&str> = CASES.iter().map(|c| c.name).collect();
    names.sort_unstable();
    let before = names.len();
    names.dedup();
    assert_eq!(names.len(), before, "用例名有重复");
}

#[test]
fn every_positive_case_produces_query_tokens() {
    // 正向用例的查询必须能切出 token，否则表达式为空、
    // 界面上表现为"搜什么都不出来"——这是最糟的失败模式，
    // 因此单独钉一条测试
    for case in CASES.iter().filter(|c| c.expect_hit) {
        assert!(
            !query_tokens(case.query).is_empty(),
            "[{}] 查询 {:?} 切不出任何 token",
            case.name,
            case.query
        );
    }
}

#[test]
fn queries_never_escape_fts_syntax() {
    // 用户输入不可信：含引号、星号、括号的查询不能破坏 FTS5 表达式
    let tokenizer = yuhua_store::tokenizer::BigramTokenizer;
    for weird in ["\"", "*", "(", ")", "AND", "OR", "NEAR", "a\"b", "**羽化**"] {
        let expr = tokenizer.match_expression(weird);
        if let Some(expr) = expr {
            // 表达式的每个 token 部分都必须是双引号包裹的字面量，
            // 且内部的引号被双写转义
            let stripped = expr.replace("\"\"", "");
            let quote_count = stripped.matches('"').count();
            assert_eq!(quote_count % 2, 0, "表达式 {expr:?} 的引号不成对");
            assert!(!expr.trim().is_empty(), "表达式不应为空");
        }
    }
}

#[test]
fn index_and_query_tokenization_agree_on_real_words() {
    // 这是整套检索能工作的**根本前提**：同一个词在索引侧与查询侧
    // 切出的二元组必须一致。不一致就会"明明有却搜不到"
    let words = [
        "羽化",
        "写作",
        "林曦",
        "太虚诀",
        "青云宗",
        "一言难尽",
        "雁门关",
        "金丹境",
        "逍遥游",
        "断魂剑",
        "欧阳修远",
        "上官婉儿",
    ];
    for word in words {
        let index_side: Vec<String> = bigram_tokens(word).into_iter().collect();
        let query_side = query_tokens(word);
        for q in &query_side {
            assert!(
                index_side.contains(q),
                "词 {word:?} 的查询 token {q:?} 不在索引 token {index_side:?} 里"
            );
        }
    }
}

#[test]
fn negative_cases_are_actually_absent() {
    // 负例必须真的不在正文里，否则这条"负例"是假的，
    // 测试看起来绿但什么都没验证
    for case in CASES.iter().filter(|c| !c.expect_hit) {
        assert!(
            !case.text.contains(case.query),
            "[{}] 负例的查询 {:?} 竟然出现在正文里",
            case.name,
            case.query
        );
    }
}
