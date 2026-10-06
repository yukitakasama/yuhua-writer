//! M7 / P8 的采集夹具：大规模导出的耗时与内存。
//!
//! ## 为什么是 example 而不是 test
//!
//! 这两条指标要的是**真实量级**（100 万字 / 300 章），放进常规测试会把
//! `cargo test` 拖慢十几秒，而且测试环境（debug profile）与发布形态
//! （release）的内存差异很大 —— 用 debug 数字去比 ≤120 MB 的预算毫无意义。
//! example 不会被 `cargo test` 跑，必须显式 `cargo run --release --example` 才执行。
//!
//! ## 内存怎么读
//!
//! 本 crate `#![forbid(unsafe_code)]`，读进程内存计数需要 FFI，所以峰值内存由
//! **外部采样器**读（采集命令见 `docs/benchmarks.md`），这里只负责把负载按
//! 真实形态造出来，并报告耗时与产物体积。
//!
//! ## 正文是按需生成的
//!
//! 用 [`ChapterSource`] 而不是先把 100 万字的 Markdown 全塞进
//! `yuhua_core::Document`，这样测到的峰值才是生产路径的形态
//! （元数据 + 逐章读取），而不是「夹具自己先把全书装进内存」。

use std::fmt::Write as _;
use std::time::Instant;

use yuhua_core::Chapter;
use yuhua_export::ir::{Block, Inline};
use yuhua_export::scope::{assemble_with, ChapterSource};
use yuhua_export::{ExportFormat, ExportScope};

/// 每章目标字数（计划书 M7 的「100 万字 / 300 章」即 3333 字/章）。
const CHARS_PER_CHAPTER: usize = 3_333;

/// 按需生成正文的数据源。
///
/// 每次调用只构造一章的 Markdown，返回后即可被释放。
struct GeneratedSource;

impl ChapterSource for GeneratedSource {
    fn body_of(&self, _id: &yuhua_core::ChapterId) -> Option<String> {
        let mut body = String::with_capacity(CHARS_PER_CHAPTER * 3 + 64);
        body.push_str("# 章标题\n\n");
        let mut counter = 0usize;
        while body.chars().count() < CHARS_PER_CHAPTER {
            counter += 1;
            let _ = writeln!(body, "第 {counter} 段：落羽风起，长夜将尽，此句用于填满一章应有的字数与语义。");
            // 每 40 段插一组富结构，保证解析器走完整降级路径而不是短路
            if counter % 40 == 0 {
                let _ = write!(
                    body,
                    "\n> 引用：{counter}\n\n- 列表甲\n- 列表乙\n\n**粗体**与`行内码`\n\n| 甲 |\n| --- |\n| 1 |\n\n"
                );
            }
        }
        Some(body)
    }
}

/// 造一本 `chapters` 章的书的**元数据**（正文留空，由 source 供）。
fn metadata_only(chapters: usize) -> yuhua_core::Document {
    let created = chrono::DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00")
        .expect("时间常量必然合法");
    let mut doc = yuhua_core::Document::new("百万字基准书", created);
    doc.book.author = "基准".into();
    let vid = doc.volumes[0].id.clone();
    for index in 0..chapters {
        let mut chapter = Chapter::new(
            &doc.book.id,
            &vid,
            format!("第{index}章"),
            format!("manuscript/v0001/c{index:04}.md"),
            index as i32,
            created,
        );
        chapter.body = String::new();
        doc.chapters.push(chapter);
    }
    doc
}

/// IR 里的正文字数，用来核对负载规模是否真的是「100 万字」。
fn ir_char_count(blocks: &[Block]) -> usize {
    fn ir_inline_len(inlines: &[Inline]) -> usize {
        inlines
            .iter()
            .map(|inline| match inline {
                Inline::Text(t) | Inline::Code(t) => t.chars().count(),
                Inline::Emph(children) | Inline::Strong(children) => ir_inline_len(children),
                Inline::Link { text, .. } => ir_inline_len(text),
                // 图片只带 alt 文本，不计入正文字数
                Inline::Image { .. } => 0,
            })
            .sum()
    }
    blocks
        .iter()
        .map(|block| match block {
            Block::Paragraph(inlines) => ir_inline_len(inlines),
            Block::Heading { text, .. } => text.chars().count(),
            Block::Quote(children) => ir_char_count(children),
            Block::List { items, .. } => items.iter().map(|item| ir_char_count(item)).sum(),
            Block::Code { text, .. } => text.chars().count(),
            Block::Hr | Block::PageBreak => 0,
        })
        .sum()
}

/// 每种格式重复渲染的次数。
///
/// 两个理由：一是单次耗时太短（几十毫秒），外部内存采样器来不及看清峰值，
/// 重复能把可观测窗口拉够；二是拿到中位数而不是单次噪声。
const REPEAT: usize = 20;

/// 中位数（毫秒）。会原地排序。
fn median_ms(mut v: Vec<u128>) -> u128 {
    v.sort_unstable();
    v[v.len() / 2]
}

/// 选哪一组规模。命令行第二个参数取 `p8` / `m7`，缺省两组都跑。
///
/// 分开跑是为了**分别**拿到两组的内存峰值：一次跑完只能拿到全局峰值，
/// 那样无法回答 M7 里「不随书量增长」这半句。
fn selected_scale() -> Option<&'static str> {
    match std::env::args().nth(1).as_deref() {
        Some("p8") => Some("P8_300k_100ch"),
        Some("m7") => Some("M7_1m_300ch"),
        _ => None,
    }
}

fn main() {
    let out_dir = std::env::temp_dir().join("yuhua-export-peak");
    std::fs::create_dir_all(&out_dir).expect("临时目录可建");
    println!("PID={}", std::process::id());
    println!("CHARS_PER_CHAPTER={CHARS_PER_CHAPTER} REPEAT={REPEAT}");

    // 两组规模：P8（30 万字 / 100 章）与 M7（100 万字 / 300 章）
    let wanted = selected_scale();
    for (label, chapter_count) in [("P8_300k_100ch", 100usize), ("M7_1m_300ch", 300usize)] {
        if wanted.is_some_and(|w| w != label) {
            continue;
        }
        let build = Instant::now();
        let doc = metadata_only(chapter_count);
        let ir = assemble_with(&doc, &GeneratedSource, &ExportScope::Whole).expect("装配失败");
        let chars: usize = ir.chapters.iter().map(|c| ir_char_count(&c.blocks)).sum();
        println!(
            "{label} assemble_ms={} chapters={} chars={}",
            build.elapsed().as_millis(),
            ir.chapter_count(),
            chars
        );

        for format in [
            ExportFormat::Txt,
            ExportFormat::Docx,
            ExportFormat::Epub,
            ExportFormat::Html,
            ExportFormat::Markdown,
            ExportFormat::Pdf,
        ] {
            let target = out_dir.join(format!("{}.{label}", format.id()));
            let mut durations = Vec::with_capacity(REPEAT);
            let mut bytes = 0usize;
            // PDF 依赖本机中文字体；缺字体时它按设计返回可恢复错误，
            // 这里如实记录并继续 —— 不该让前面几种格式的采集作废。
            let mut skipped: Option<String> = None;
            for _ in 0..REPEAT {
                let start = Instant::now();
                let report = match yuhua_export::render_to_path(format, &ir, &target) {
                    Ok(report) => report,
                    Err(e) => {
                        skipped = Some(e.to_string());
                        break;
                    }
                };
                durations.push(start.elapsed().as_millis());
                bytes = report.bytes;
            }
            if let Some(reason) = skipped {
                println!("{label} {} skipped: {reason}", format.id());
                continue;
            }
            println!(
                "{label} {} median_ms={} max_ms={} bytes={}",
                format.id(),
                median_ms(durations.clone()),
                durations.iter().max().copied().unwrap_or(0),
                bytes
            );
        }
    }
    println!("DONE");
}
