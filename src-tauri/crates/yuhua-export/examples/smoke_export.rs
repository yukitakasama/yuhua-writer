//! 端到端冒烟：真实产出各格式文件，供外部脚本核验产物结构。
//!
//! 这个 example 的价值在于**脱离单元测试的自我断言**：
//! 它把真实文件写到磁盘，由外部脚本（Node）解压并检查 zip 结构、
//! 转义正确性等只有看真实字节才能确认的性质。
//!
//! 运行：`cargo run -p yuhua-export --example smoke_export -- <输出目录>`
//!
//! PDF 也在其中，但它多一层环境依赖：**必须能在这台机器上找到中文字体**。
//! 找不到时这个 example 会打印 ERR 而不是 panic —— 产物缺失本身就是
//! 一条值得看见的信息（PDF 是六种格式里唯一依赖外部资源的）。

use yuhua_export::{
    render_to_path, Block, BookMeta, ChapterContent, Document, ExportFormat, Inline, VolumeMeta,
};

fn main() {
    let out_dir = std::env::args()
        .nth(1)
        .expect("用法：smoke_export <输出目录>");
    std::fs::create_dir_all(&out_dir).unwrap();

    // 构造一份带「有风险内容」的文稿：转义字符、嵌套强调、引用、列表
    let vid = yuhua_core::VolumeId::new();
    let mut doc = Document::new(BookMeta::new("羽化笔记", "测试作者"));
    doc.volumes.push(VolumeMeta {
        id: vid.clone(),
        title: "第一卷 风起".into(),
    });

    let mut ch1 = ChapterContent::new(
        yuhua_core::ChapterId::new(),
        vid.clone(),
        "第一章 落羽",
        vec![
            Block::Paragraph(vec![Inline::text("第一段正文，含中文标点：你好，世界。")]),
            Block::Paragraph(vec![
                Inline::text("转义风险："),
                Inline::text("<script>alert(1)</script> & \"双引号\" '单引号'"),
            ]),
            Block::Quote(vec![Block::Paragraph(vec![Inline::text("引用中的一段话")])]),
            Block::List {
                ordered: false,
                start: 1,
                items: vec![
                    vec![Block::Paragraph(vec![Inline::text("列表项一")])],
                    vec![Block::Paragraph(vec![Inline::text("列表项二")])],
                ],
            },
            Block::Heading {
                level: 2,
                text: "小节标题".to_string(),
            },
            Block::Paragraph(vec![Inline::text(
                "结尾段落，用于验证中文不乱码：落羽化羽。",
            )]),
        ],
    );
    ch1.volume_id = vid.clone();
    doc.chapters.push(ch1);

    let mut ch2 = ChapterContent::new(
        yuhua_core::ChapterId::new(),
        vid.clone(),
        "第二章 山雨",
        vec![Block::Paragraph(vec![Inline::text("第二章的正文内容。")])],
    );
    ch2.volume_id = vid;
    doc.chapters.push(ch2);

    for (name, fmt) in [
        ("out.txt", ExportFormat::Txt),
        ("out.md", ExportFormat::Markdown),
        ("out.html", ExportFormat::Html),
        ("out.docx", ExportFormat::Docx),
        ("out.epub", ExportFormat::Epub),
        ("out.pdf", ExportFormat::Pdf),
    ] {
        let path = std::path::Path::new(&out_dir).join(name);
        match render_to_path(fmt, &doc, &path) {
            Ok(report) => println!("OK {name} bytes={}", report.bytes),
            Err(e) => println!("ERR {name}: {e}"),
        }
    }
}
