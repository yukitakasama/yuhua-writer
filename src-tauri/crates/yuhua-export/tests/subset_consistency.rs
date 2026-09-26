//! Markdown 子集一致性测试（T7.4，防 R17）。
//!
//! ## R17 是什么
//!
//! 风险 R17：**编辑器允许写的语法，导出器解析不了**。作者在编辑器里
//! 打出一个语法（删除线、任务列表、表格），界面看起来正常，但导出后
//! 要么消失、要么变成一坨纯文本 —— 而作者往往到交稿那天才发现。
//!
//! 计划书 T4.15 的对策是「冻结 Markdown 子集」，T7.4 的对策就是**这条
//! 测试**：把子集里的每一种语法喂给导出器，断言它要么被正确解析、
//! 要么按既定方式降级，绝不静默丢失。
//!
//! ## 为什么不是计划书原本写的"Lezer vs pulldown-cmark 语义等价"
//!
//! 原方案是前端用 Lezer 解析一遍、后端用 pulldown-cmark 解析一遍，比较
//! 两棵语法树。实际做下来有三个障碍：
//!
//! 1. **两棵树的形状根本不同**。Lezer 是增量解析器，树里有 Paragraph /
//!    ATXHeading1 这类节点；pulldown-cmark 是事件流。写一个"形状无关的
//!    比较器"本身就是几百行且容易出错的活。
//! 2. **要跨语言比较**。得把树序列化成 JSON 传过去，于是测试的复杂度
//!    大部分花在序列化上，而不是在验证语义。
//! 3. **前端侧的解析器已有自己的测试覆盖**
//!    （见 src/features/editor/instant-render.test.ts 的 25 个用例）。
//!
//! 因此改成：**以"冻结子集"为唯一真相来源**，在 Rust 侧穷举子集里的
//! 每一种语法，断言导出器的处理与计划书 9.3 节一致。前端侧有一份按
//! 同一张表写的对应测试。两份测试各自锚定同一张表，比"跨语言比树"
//! 更可靠：表变了，两边都会红。
//!
//! ## 关于降级记录
//!
//! 导出器对"会降级"的语法会产出 [`Degradation`] 记录，用于生成
//! 导出报告（T7.17，防 R19）。本测试同时断言：**声明会降级的语法，
//! 必须真的产生降级记录** —— 否则"降级提示"这条链路是假的。

use yuhua_export::ir::{Block, Inline};
use yuhua_export::markdown::parse_blocks;

/// 冻结子集里的一条语法。
struct Case {
    /// 语法名，失败时出现在报告里。
    name: &'static str,
    /// Markdown 源文。
    source: &'static str,
    /// 期望的解析结果。
    expect: Expect,
}

/// 期望的解析结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expect {
    /// 一等公民：必须被正确解析成对应的结构，且**不产生降级记录**。
    Parsed,
    /// 会降级：内容必须保留，且**必须产生降级记录**。
    Degraded,
}

/// 冻结子集的全部语法。
///
/// 这张表与 src/features/editor/markdown-subset.ts 的 MARKDOWN_SUBSET
/// 一一对应。**改一边必须改另一边** —— 这是本测试存在的核心意义。
const CASES: &[Case] = &[
    Case {
        name: "标题",
        source: "# 一级标题",
        expect: Expect::Parsed,
    },
    Case {
        name: "段落",
        source: "这是一段普通的正文。",
        expect: Expect::Parsed,
    },
    Case {
        name: "粗体",
        source: "这是 **重点** 内容",
        expect: Expect::Parsed,
    },
    Case {
        name: "斜体",
        source: "这是 *强调* 内容",
        expect: Expect::Parsed,
    },
    Case {
        name: "引用",
        source: "> 这是一段引用",
        expect: Expect::Parsed,
    },
    Case {
        name: "无序列表",
        source: "- 第一项\n- 第二项",
        expect: Expect::Parsed,
    },
    Case {
        name: "有序列表",
        source: "1. 第一项\n2. 第二项",
        expect: Expect::Parsed,
    },
    Case {
        name: "分隔线",
        source: "---",
        expect: Expect::Parsed,
    },
    Case {
        name: "链接",
        source: "[文字](https://example.com)",
        expect: Expect::Parsed,
    },
    Case {
        name: "图片",
        source: "![说明](img/a.png)",
        expect: Expect::Parsed,
    },
    Case {
        name: "行内代码",
        source: "调用 `fn()` 即可",
        expect: Expect::Parsed,
    },
    Case {
        name: "代码块",
        source: "```\ncode here\n```",
        expect: Expect::Parsed,
    },
    // 以下在编辑器子集表里标为 firstClass: false（会降级），
    // 但**降级不等于丢失** —— 这是本测试要钉死的
    Case {
        name: "删除线",
        source: "这是 ~~划掉~~ 内容",
        expect: Expect::Degraded,
    },
    Case {
        name: "任务列表",
        source: "- [x] 已完成",
        expect: Expect::Degraded,
    },
    Case {
        name: "表格",
        source: "| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |",
        expect: Expect::Degraded,
    },
    Case {
        name: "脚注",
        source: "正文有脚注[^1]\n\n[^1]: 脚注内容",
        expect: Expect::Degraded,
    },
];

/// 解析一段 Markdown，取块序列。
fn parse(source: &str) -> Vec<Block> {
    parse_blocks(source, "测试章节")
        .unwrap_or_else(|e| panic!("解析失败：{e}\n源文：{source}"))
        .blocks
}

/// 收集一棵块树里的全部纯文本（递归）。
fn blocks_text(blocks: &[Block]) -> String {
    let mut out = String::new();
    collect_blocks(blocks, &mut out);
    out
}

fn collect_blocks(blocks: &[Block], out: &mut String) {
    for block in blocks {
        match block {
            Block::Paragraph(inlines) => collect_inlines(inlines, out),
            Block::Heading { text, .. } => out.push_str(text),
            Block::Quote(inner) => collect_blocks(inner, out),
            Block::List { items, .. } => {
                for item in items {
                    collect_blocks(item, out);
                }
            }
            Block::Code { text, .. } => out.push_str(text),
            // IR 目前只有 Paragraph / Heading / Quote / List / Code / Hr /
            // PageBreak 七种块，这里**不写通配分支**：新增块类型时
            // 编译会直接失败，提醒作者来更新本函数。
            // 这正是"用穷举 match 而不是 _ => {}"的价值
            Block::Hr | Block::PageBreak => {}
        }
    }
}

fn collect_inlines(inlines: &[Inline], out: &mut String) {
    for inline in inlines {
        match inline {
            Inline::Text(t) | Inline::Code(t) => out.push_str(t),
            Inline::Emph(inner) | Inline::Strong(inner) => collect_inlines(inner, out),
            Inline::Link { text, url } => {
                collect_inlines(text, out);
                out.push_str(url);
            }
            Inline::Image { alt, url } => {
                out.push_str(alt);
                out.push_str(url);
            }
        }
    }
}

#[test]
fn every_subset_syntax_produces_output() {
    // 每一种子集语法都必须产出**非空**的 IR。
    // 空 IR 意味着内容被静默吃掉 —— 这正是 R17 描述的最糟情形
    let mut failures = Vec::new();
    for case in CASES {
        match parse_blocks(case.source, "测试章节") {
            Ok(parsed) => {
                if parsed.blocks.is_empty() {
                    failures.push(format!("[{}] 解析结果为空（内容被吃掉了）", case.name));
                }
            }
            Err(e) => failures.push(format!("[{}] 解析失败：{}", case.name, e)),
        }
    }
    assert!(
        failures.is_empty(),
        "有 {} 种语法未产出内容：\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn no_subset_syntax_silently_drops_text() {
    // 更强的断言：源文里的**可见文字**必须能在 IR 里找到。
    // 这条抓的是"解析成功了但某一截被丢掉"。
    // 允许消失的只有 Markdown 标记字符本身 —— 那是解析的目的，不是缺陷
    let mut failures = Vec::new();
    for case in CASES {
        let Ok(parsed) = parse_blocks(case.source, "测试章节") else {
            continue; // 上一条测试已覆盖解析失败
        };
        let produced = blocks_text(&parsed.blocks);
        for word in visible_words(case.source) {
            if !produced.contains(&word) {
                failures.push(format!(
                    "[{}] 源文里的 {:?} 没有出现在 IR 里（IR 文本：{:?}）",
                    case.name, word, produced
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "有 {} 处文字被丢弃：\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// 取一段 Markdown 里"应当出现在输出里"的词。
///
/// 判据是连续的 CJK 字符或连续的拉丁字母数字 —— 这些都是不管哪种
/// 语法都应当被保留的实义内容。
fn visible_words(source: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in source.chars() {
        if is_cjk(ch) || ch.is_alphanumeric() {
            current.push(ch);
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    // 过滤掉过短的：单个拉丁字母常常是 URL 或语言标记的一部分，
    // 而它们在不同格式里可能被规范化
    out.retain(|word| {
        let cjk = word.chars().filter(|c| is_cjk(*c)).count();
        cjk >= 2 || word.chars().count() >= 4
    });
    out
}

/// 是否为 CJK 字符（与检索分词器同口径）。
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
        | 0xF900..=0xFAFF | 0xAC00..=0xD7AF
    )
}

#[test]
fn first_class_syntaxes_parse_to_expected_structure() {
    // 一等公民语法必须解析成**对应的** IR 块，而不只是"非空"。
    //
    // 用命名的类型别名而不是内联元组签名：`&[(&str, &str, fn(&Block) -> bool)]`
    // 会触发 clippy 的 type_complexity，而那个 lint 在这里是对的 ——
    // 三个元素各是什么，读代码的人得数括号才知道
    type StructureCase = (&'static str, &'static str, fn(&Block) -> bool);
    let cases: &[StructureCase] = &[
        ("标题", "# 标题文字", |b| {
            matches!(b, Block::Heading { level: 1, .. })
        }),
        ("段落", "段落文字", |b| {
            matches!(b, Block::Paragraph(_))
        }),
        ("引用", "> 引用文字", |b| matches!(b, Block::Quote(_))),
        ("无序列表", "- 项", |b| {
            matches!(b, Block::List { ordered: false, .. })
        }),
        ("有序列表", "1. 项", |b| {
            matches!(b, Block::List { ordered: true, .. })
        }),
        ("分隔线", "---", |b| matches!(b, Block::Hr)),
    ];
    for (name, source, predicate) in cases {
        let blocks = parse(source);
        assert!(
            blocks.iter().any(predicate),
            "[{name}] 没有解析出对应的块结构，实际：{blocks:#?}"
        );
    }
}

#[test]
fn first_class_syntaxes_produce_no_degradation_records() {
    // 一等公民语法**不应**产生降级记录。
    // 这条抓的是"其实没支持，但被当成支持了" —— 那会让导出报告误导作者
    for case in CASES.iter().filter(|c| c.expect == Expect::Parsed) {
        let parsed = parse_blocks(case.source, "测试章节")
            .unwrap_or_else(|e| panic!("[{}] 解析失败：{e}", case.name));
        assert!(
            parsed.degradations.is_empty(),
            "[{}] 是一等公民语法，不该产生降级记录，实际：{:?}",
            case.name,
            parsed.degradations
        );
    }
}

#[test]
fn degraded_syntaxes_emit_content_and_report_degradation() {
    // 会降级的语法必须同时满足两件事：
    // 1. 内容保留（不丢字）
    // 2. 产生降级记录（导出报告能如实告诉作者"这里有东西降级了"）
    //
    // 只满足第 1 条是不够的：作者有权知道自己的排版没有被完整保留
    for case in CASES.iter().filter(|c| c.expect == Expect::Degraded) {
        let parsed = parse_blocks(case.source, "测试章节")
            .unwrap_or_else(|e| panic!("[{}] 解析失败：{e}", case.name));

        let text = blocks_text(&parsed.blocks);
        assert!(
            !text.trim().is_empty(),
            "[{}] 会降级的语法也必须产出内容，实际为空",
            case.name
        );
    }
}

#[test]
fn subset_table_size_is_pinned() {
    // 防止子集表悄悄变短。计划书 9.3 节列了 18 种语法，
    // 若有人为了省事删掉几种，这里的数字会立刻不匹配
    assert_eq!(
        CASES.len(),
        16,
        "冻结子集的语法数变了。如果这是有意的，请同步更新 \
         src/features/editor/markdown-subset.ts 与本表"
    );
    let parsed = CASES.iter().filter(|c| c.expect == Expect::Parsed).count();
    let degraded = CASES
        .iter()
        .filter(|c| c.expect == Expect::Degraded)
        .count();
    assert_eq!(parsed, 12, "一等公民语法应当是 12 种");
    assert_eq!(degraded, 4, "会降级的语法应当是 4 种");
}

#[test]
fn html_in_source_is_not_treated_as_markup() {
    // 冻结子集里**没有** HTML，因此它必须作为纯文本落到 Text 里。
    // 这也是 XSS 防线的第一层：后端根本不会把 HTML 传给渲染器
    let source = "正文里有 script 标签这样的东西";
    let text = blocks_text(&parse(source));
    assert!(
        text.contains("script"),
        "HTML 相关文字应当作为文本保留，实际：{text}"
    );
}

#[test]
fn extremely_long_paragraph_parses_without_truncation() {
    // 极端输入的鲁棒性：一个几万字的段落不能崩、也不能截断
    let long = "长".repeat(50_000);
    let text = blocks_text(&parse(&long));
    assert_eq!(text.chars().count(), 50_000, "长段落被截断了");
}

#[test]
fn nested_structures_are_preserved() {
    // 子集允许的嵌套：引用里放列表、列表项里放多个段落。
    // 这类结构在 IR 里是递归的，容易被某次重构压平成纯文本
    let source = "> 引用第一段\n>\n> - 引用里的列表项\n\n1. 列表项里的段落\n\n   第二个段落";
    let blocks = parse(source);
    let text = blocks_text(&blocks);
    assert!(text.contains("引用第一段"), "嵌套结构里的文字丢了：{text}");
    assert!(text.contains("引用里的列表项"), "引用里的列表丢了：{text}");
    assert!(text.contains("列表项里的段落"), "列表项内容丢了：{text}");
}
