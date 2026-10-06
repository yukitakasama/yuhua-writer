//! 专项：百万字全文检索达标（P5，≤ 300 ms）。
//!
//! ## 这条测试为什么必须存在
//!
//! `docs/benchmarks.md` 一直把 P5 写成「已由集成测试覆盖」，但**那份测试
//! 从来没被写过** —— 被引用的文件与三个测试名都不存在。M11 的其余指标
//! 依赖真实窗口环境、只能人工采集，唯独 P5 是可以在 CI 里自动证明的，
//! 于是它既是唯一的自动化性能门禁，也是最容易被「文档说有」糊过去的一条。
//! 现在把真的那条补上。
//!
//! ## 为什么必须真的造一百万字
//!
//! 检索耗时的来源是 FTS5 的倒排合并与中文二元组展开，**语料规模决定耗时**。
//! 用一千字跑一千遍测不出「索引变大后查询变慢」—— 那种写法只能证明
//! 「函数会返回」，不能证明预算。所以这里按计划书口径造 100 章 × 1 万字。
//!
//! ## 断言用中位数而不是单次
//!
//! 单次查询会受系统调度与页缓存影响；连续 5 次取中位数才是可复现的数字。
//! 这也是为什么把实测值打印出来：基准记录要的是数字，不是「通过」。

use std::time::Instant;

use yuhua_core::model::{Chapter, Document};
use yuhua_store::index::{content_hash, Index};
use yuhua_store::schema::open_in_memory;
use yuhua_store::search::{search, SearchQuery};

/// P5 预算（毫秒）。
const BUDGET_MS: u128 = 300;

/// 章数 × 每章字数 = 100 万字（计划书 M11 的口径）。
const CHAPTERS: usize = 100;
const CHARS_PER_CHAPTER: usize = 10_000;

fn ts() -> chrono::DateTime<chrono::FixedOffset> {
    chrono::DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00").unwrap()
}

/// 造一百万字并索引，返回索引库。
///
/// 语料刻意包含**会被查到的**中文二元组（"落羽"、"风起"、"破庙"），
/// 并且散布在不同章里 —— 只匹配标题的语料会让查询代价被严重低估，
/// 因为 FTS5 的位置表与Posting 长度才是成本来源。
fn seeded_million() -> Index {
    let conn = open_in_memory().expect("内存库应可打开");
    let idx = Index::new(conn);
    let doc = Document::new("百万字基准书", ts());
    let vol = doc.volumes[0].id.clone();
    idx.upsert_book(&doc.book, "D:/ws-bench").unwrap();
    idx.sync_volumes(&doc.volumes).unwrap();

    // 一段约 100 字的正文，重复到目标字数；关键词周期性出现
    let paragraph = concat!(
        "他沿着长长的走廊一直往前走，直到尽头那扇门出现在眼前。窗外的雨还在下，",
        "没有人说话。落羽停下脚步，听见风起的声响从屋脊上传来，破庙的钟声响了半夜。\n\n",
    );
    for index in 0..CHAPTERS {
        let mut unit = String::new();
        while unit.chars().count() < CHARS_PER_CHAPTER {
            unit.push_str(paragraph);
        }
        let mut chapter = Chapter::new(
            &doc.book.id,
            &vol,
            format!("第{index}章"),
            format!("manuscript/{index:04}.md"),
            index as i32,
            ts(),
        );
        chapter.body = unit;
        chapter.content_hash = content_hash(&chapter.body);
        idx.upsert_chapter(&chapter).unwrap();
    }
    idx
}

fn median(mut values: Vec<u128>) -> u128 {
    values.sort_unstable();
    values[values.len() / 2]
}

/// 一次检索的耗时（**微秒**）。
///
/// 用毫秒记不得：一百万字在这台机器上远低于 1 ms，全部记成「0 ms」的
/// 基准数字既没有可比性，也无法在将来退化时被发现（1 ms 和 0 ms 都显示 0）。
fn query_us(idx: &Index, keyword: &str) -> u128 {
    let start = Instant::now();
    let hits = search(idx.connection(), &SearchQuery::new(keyword.to_string()))
        .unwrap_or_else(|e| panic!("检索 {keyword} 失败：{e}"));
    let us = start.elapsed().as_micros();
    println!("P5 query {keyword:?} => {} 条, {us} µs", hits.total);
    us
}

#[test]
fn search_on_million_chars_meets_p5_budget() {
    let build = Instant::now();
    let idx = seeded_million();
    println!(
        "P5 语料规模：{CHAPTERS} 章 × {CHARS_PER_CHAPTER} 字，索引耗时 {} ms",
        build.elapsed().as_millis()
    );

    // 全部是语料里真实存在的词组：查不到的关键词会提前返回，
    // 测出来的是「空结果」的成本而不是「一百万字里合并 posting」的成本
    let keywords = ["落羽", "风起", "破庙", "雨还在下", "停下脚步"];
    let mut durations = Vec::new();
    // 每个关键词查 5 次：第一次通常最慢（页缓存未热），取中位数
    for keyword in keywords {
        let runs: Vec<u128> = (0..5).map(|_| query_us(&idx, keyword)).collect();
        let med = median(runs);
        println!("P5 {keyword:?} 中位数 {med} µs");
        durations.push(med);
    }
    let worst = *durations.iter().max().unwrap();
    println!(
        "P5 实测：最快中位数 {} µs，最慢中位数 {} µs（预算 {} ms）",
        durations.iter().min().unwrap(),
        worst,
        BUDGET_MS
    );
    assert!(
        worst < BUDGET_MS * 1000,
        "P5 未达标：最慢的一条检索花了 {worst} µs，预算 {BUDGET_MS} ms"
    );
}

#[test]
fn million_char_corpus_actually_has_the_expected_volume() {
    // 语料规模是这条基准的前提：如果造数据的路径哪天退化成一章，
    // 「检索很快」就毫无意义。用命中数反证规模。
    let idx = seeded_million();
    let hits = search(idx.connection(), &SearchQuery::new("落羽".to_string())).unwrap();
    assert!(
        hits.total as usize >= CHAPTERS,
        "{CHAPTERS} 章都含关键词，召回数不该低于章数：实际 {}",
        hits.total
    );
}
