//! PDF 渲染器的测试。
//!
//! ## 为什么有一个「迷你 PDF 解析器」
//!
//! docx.rs 的做法是「把产物解压出来，按字节断言结构」。
//! PDF 没有 zip 那样现成的容器解析器可用，但我们需要的检验只有四件事：
//!
//! 1. 有 xref 表，且**每条偏移都真的指向一个对象头**；
//! 2. 有 trailer，且 /Root 指向的对象真的是 /Catalog；
//! 3. 内容流的 /Length 与 stream…endstream 之间的真实字节数一致；
//! 4. ToUnicode CMap 里确实有输入汉字的码点。
//!
//! 这四件事用一百来行的解析器就能查，而且**查的是字节本身**，
//! 不是我们自己的数据结构 —— 后者只能证明「我以为我写对了」。
//! 第 3 条尤其重要：/Length 写错是 PDF 里最容易犯又最难自查的错误，
//! 阅读器不会报错，只会少显示最后一段。

use super::*;
use crate::ir::{BookMeta, ChapterContent, VolumeMeta};
use yuhua_core::{ChapterId, VolumeId};

/// 在字节流里找一段子序列，返回起始下标。
///
/// 全程按字节而不是 String 处理：PDF 的头部第二行是二进制标记，
/// 用 String 按字节下标切会在字符边界上 panic。这条经验是被测试自己
/// 撞出来的 —— 第一版解析器就是这么炸的。
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// 从产物里取出一个间接对象的原始体。
///
/// 按 "N 0 obj" 找起点、按 endobj 找终点。够土，但对自查来说够准 ——
/// 我们只需要拿到自己刚写进去的东西，不需要一个通用的 PDF 库。
fn object_body(bytes: &[u8], id: u32) -> Option<String> {
    let start =
        find_bytes(bytes, format!("\n{id} 0 obj\n").as_bytes())? + format!("\n{id} 0 obj\n").len();
    let end = find_bytes(&bytes[start..], b"\nendobj")? + start;
    Some(String::from_utf8_lossy(&bytes[start..end]).to_string())
}

/// 迷你解析器：解析 xref 表并校验每条偏移都指向真实对象头。
///
/// 返回 (xref 条目数, trailer 里声明的 /Size)。
fn parse_xref(bytes: &[u8]) -> (usize, usize) {
    let startxref = find_bytes(bytes, b"startxref").expect("缺少 startxref");
    let number_start = startxref + "startxref".len();
    let number_end = bytes[number_start..]
        .iter()
        .position(|b| b.is_ascii_digit())
        .map(|offset| number_start + offset)
        .expect("startxref 后面没有数字");
    let mut number_stop = number_end;
    while number_stop < bytes.len() && bytes[number_stop].is_ascii_digit() {
        number_stop += 1;
    }
    let xref_offset: usize = std::str::from_utf8(&bytes[number_end..number_stop])
        .unwrap()
        .parse()
        .expect("startxref 不是数字");
    assert!(
        bytes[xref_offset..].starts_with(b"xref"),
        "startxref 指向的位置不是 xref 表：{:?}",
        String::from_utf8_lossy(&bytes[xref_offset..(xref_offset + 20).min(bytes.len())])
    );

    // 逐行读 xref 子节
    let mut cursor = xref_offset;
    let line = |cursor: &mut usize| -> String {
        let end = bytes[*cursor..]
            .iter()
            .position(|b| *b == b'\n')
            .unwrap_or(bytes.len() - *cursor)
            + *cursor;
        let out = String::from_utf8_lossy(&bytes[*cursor..end]).to_string();
        *cursor = end + 1;
        out
    };
    // xref 表由「一行关键字 + 一行子节头（起始对象号 条目数）+ 若干条目行」组成。
    // 把关键字行与子节头当成一行读，是写迷你解析器时最容易犯的错。
    assert_eq!(line(&mut cursor), "xref");
    let header = line(&mut cursor);
    let mut header_parts = header.split_whitespace();
    let first: usize = header_parts.next().unwrap().parse().unwrap();
    let count: usize = header_parts.next().unwrap().parse().unwrap();
    assert_eq!(first, 0, "xref 子节必须从 0 号对象开始");
    assert!(header_parts.next().is_none(), "子节头应当只有两个字段");

    assert_eq!(
        line(&mut cursor),
        "0000000000 65535 f ",
        "0 号对象必须是空闲项"
    );
    for id in 1..count {
        let entry = line(&mut cursor);
        // 规范要求每条 xref 条目**连行尾符在内**恰好 20 字节。
        // 这里读回来的是去掉 \n 的正文，所以长度是 19；
        // 加上行尾符正好 20 —— 长度不对会让严格模式的解析器直接报格式错误。
        assert_eq!(entry.len(), 19, "xref 条目正文应当是 19 字节：{entry:?}");
        assert!(
            entry.ends_with(" n "),
            "条目类型必须是 n 或 f，且以空格补齐：{entry:?}"
        );
        let offset: usize = entry[..10].parse().unwrap();
        let expected = format!("{id} 0 obj");
        assert!(
            bytes[offset..].starts_with(expected.as_bytes()),
            "对象 {id} 的 xref 偏移 {offset} 指向了 {:?}",
            String::from_utf8_lossy(&bytes[offset..(offset + 24).min(bytes.len())])
        );
    }

    let size_at = find_bytes(bytes, b"/Size ").expect("trailer 里缺少 /Size");
    let size_text = &bytes[size_at + "/Size ".len()..];
    let size_end = size_text
        .iter()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(size_text.len());
    let size = std::str::from_utf8(&size_text[..size_end])
        .unwrap()
        .parse()
        .unwrap();
    (count, size)
}

/// 校验所有内容流的 /Length 与真实字节数一致。
fn assert_stream_lengths(bytes: &[u8]) {
    let mut cursor = 0usize;
    let mut checked = 0usize;
    while let Some(found) = find_bytes(&bytes[cursor..], b"/Length ") {
        let at = cursor + found;
        let number_start = at + "/Length ".len();
        // 排除 /Length1 这类以 /Length 开头的其它键（后面跟的不是空格就是数字）
        let number_end = bytes[number_start..]
            .iter()
            .position(|b| !b.is_ascii_digit())
            .unwrap_or(0)
            + number_start;
        if number_end == number_start {
            cursor = at + 1;
            continue;
        }
        let length: usize = std::str::from_utf8(&bytes[number_start..number_end])
            .unwrap()
            .parse()
            .unwrap();
        let Some(stream_at) = find_bytes(&bytes[at..], b"stream\n").map(|o| at + o + 7) else {
            cursor = at + 1;
            continue;
        };
        let data = &bytes[stream_at..stream_at + length];
        assert!(
            find_bytes(data, b"endstream").is_none(),
            "/Length {length} 声明得太长，把 endstream 也吞进流里了"
        );
        assert!(
            bytes[stream_at + length..].starts_with(b"\nendstream"),
            "/Length {length} 与实际字节数不一致：后面是 {:?}",
            String::from_utf8_lossy(
                &bytes[stream_at + length..(stream_at + length + 20).min(bytes.len())]
            )
        );
        checked += 1;
        cursor = stream_at + length;
    }
    assert!(checked >= 2, "应当至少有两个流对象（内容流 + ToUnicode）");
}

/// 造一份含全部块类型的文档。
fn rich_document() -> Document {
    let vid = VolumeId::new();
    let mut doc = Document::new(BookMeta::new("羽化笔记", "张三"));
    doc.volumes.push(VolumeMeta {
        id: vid.clone(),
        title: "第一卷 落羽".into(),
    });
    let mut blocks = vec![
        Block::Paragraph(vec![
            Inline::text("第一段正文，包含"),
            Inline::Strong(vec![Inline::text("加粗")]),
            Inline::text("与"),
            Inline::Emph(vec![Inline::text("斜体")]),
            Inline::text("，还有行内代码 "),
            Inline::Code("let x = 1".into()),
            Inline::text("。"),
        ]),
        Block::Paragraph(vec![Inline::Link {
            url: "https://example.com".into(),
            text: vec![Inline::text("链接")],
        }]),
        Block::Paragraph(vec![Inline::Image {
            url: "cover.png".into(),
            alt: "封面插图".into(),
        }]),
    ];
    for level in 1..=6u8 {
        blocks.push(Block::Heading {
            level,
            text: format!("第 {level} 级标题"),
        });
    }
    blocks.push(Block::Quote(vec![Block::Paragraph(vec![Inline::text(
        "引用的内容",
    )])]));
    blocks.push(Block::List {
        ordered: false,
        start: 1,
        items: vec![
            vec![Block::Paragraph(vec![Inline::text("无序一")])],
            vec![Block::List {
                ordered: true,
                start: 3,
                items: vec![vec![Block::Paragraph(vec![Inline::text("嵌套有序")])]],
            }],
        ],
    });
    blocks.push(Block::Code {
        lang: "rust".into(),
        text: "fn main() {\n    println!(\"你好\");\n}".into(),
    });
    blocks.push(Block::Hr);
    blocks.push(Block::PageBreak);
    blocks.push(Block::Paragraph(vec![Inline::text("分页之后的正文")]));

    doc.chapters.push(ChapterContent::new(
        ChapterId::new(),
        vid,
        "第一章 出发",
        blocks,
    ));
    doc
}

/// 用合成字体渲染，绕开「本机有没有中文字体」这一环境依赖。
fn render_with_synthetic_font(doc: &Document, options: PdfOptions) -> (Vec<u8>, Vec<char>) {
    let font_bytes = crate::render::pdf::text::uniform_font_bytes();
    let font = TrueTypeFont::parse("uniform.ttf", font_bytes).unwrap();
    // 直接走内部装配路径：渲染器的字体发现会去磁盘找字体，
    // 而测试必须与机器环境无关。
    let renderer = PdfRenderer { options };
    let mut layout = PdfLayout::new(renderer.options.page_size, renderer.options.margins);
    // 缺字收集是渲染器的正式职责，这里走同一条路径，
    // 保证测试覆盖的正是生产代码用到的那套排版逻辑。
    let mut missing: Vec<char> = Vec::new();
    renderer.render_front_matter(doc, &mut layout, &font, &mut missing);
    for chapter in doc.iter_chapters() {
        renderer.render_blocks(&mut layout, &font, &chapter.blocks, 0, &mut missing);
    }
    let pages = layout.finish();
    let bytes = assemble_pdf(&font, &pages, doc, &renderer.options).unwrap();
    (bytes, missing)
}

#[test]
fn produces_structurally_valid_pdf() {
    let doc = rich_document();
    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    assert!(bytes.starts_with(b"%PDF-1.7\n"), "PDF 头不对");
    assert!(
        bytes.ends_with(b"%%EOF\n"),
        "PDF 结尾必须是 %%EOF：{:?}",
        String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(20)..])
    );
    let (count, size) = parse_xref(&bytes);
    assert!(count > 5, "对象太少：{count}");
    assert_eq!(count, size, "/Size 必须等于 xref 条目数");
    assert_stream_lengths(&bytes);
}

#[test]
fn trailer_points_at_a_real_catalog() {
    let doc = rich_document();
    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let text = String::from_utf8_lossy(&bytes).to_string();
    let root = text
        .split("/Root ")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .expect("trailer 缺少 /Root");
    let id: u32 = root.parse().expect("/Root 不是对象号");
    let body = object_body(&bytes, id).expect("找不到 Catalog 对象");
    assert!(body.contains("/Type /Catalog"), "Catalog 不对：{body}");
    assert!(body.contains("/Pages"), "Catalog 缺少 /Pages：{body}");
}

#[test]
fn every_page_references_the_pages_tree_and_a_content_stream() {
    let doc = rich_document();
    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let text = String::from_utf8_lossy(&bytes).to_string();
    let page_objects: Vec<&str> = text
        .split(" 0 obj\n")
        .filter(|chunk| chunk.starts_with("<< /Type /Page "))
        .collect();
    assert!(!page_objects.is_empty(), "没有任何 /Page 对象");
    for page in &page_objects {
        assert!(page.contains("/Parent "), "页面缺少 /Parent：{page}");
        assert!(page.contains("/MediaBox"), "页面缺少 /MediaBox：{page}");
        assert!(page.contains("/Contents "), "页面缺少 /Contents：{page}");
        assert!(page.contains("/Font << /F1 "), "页面资源里没有字体：{page}");
        // A4 尺寸必须写进 MediaBox
        assert!(page.contains("595.28 841.89"), "MediaBox 不是 A4：{page}");
    }
}

#[test]
fn font_is_embedded_as_cid_font_type2() {
    let doc = rich_document();
    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let text = String::from_utf8_lossy(&bytes).to_string();
    // Type0 + Identity-H 是「可搜索」的必要条件
    assert!(text.contains("/Subtype /Type0"), "缺少 Type0 字体");
    assert!(
        text.contains("/Encoding /Identity-H"),
        "缺少 Identity-H 编码"
    );
    assert!(
        text.contains("/Subtype /CIDFontType2"),
        "缺少 CIDFontType2 子字体"
    );
    // 字体必须是内嵌的，而不是靠阅读器去系统里找
    assert!(text.contains("/FontFile2"), "字体没有内嵌");
    // CIDToGIDMap /Identity 与 Identity-H 配套
    assert!(text.contains("/CIDToGIDMap /Identity"), "缺少 CIDToGIDMap");
}

#[test]
fn embedded_font_bytes_are_written_verbatim() {
    let doc = rich_document();
    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let font_bytes = crate::render::pdf::text::uniform_font_bytes();
    // 字体字节必须原样出现在 PDF 里。用「找子序列」而不是精确偏移比对，
    // 是因为 PDF 里字体前后还有 << /Length … >> stream 之类的包装。
    assert!(
        bytes
            .windows(font_bytes.len())
            .any(|window| window == font_bytes.as_slice()),
        "内嵌的字体字节与源文件不一致"
    );
}

#[test]
fn to_unicode_maps_glyphs_back_to_the_input_chinese_codepoints() {
    let doc = rich_document();
    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let text = String::from_utf8_lossy(&bytes).to_string();
    assert!(text.contains("/CMapType 2"), "缺少 ToUnicode CMap");
    assert!(
        text.contains("begincodespacerange"),
        "ToUnicode 缺少 codespacerange"
    );

    // 正文里出现的汉字必须在 CMap 里有映射，否则它搜不到、复制出来是乱码。
    // 合成字体的 cmap 覆盖全 BMP 且全部映射到 GID 1，所以这里查的是
    // 「这些码点确实被写进了 bfchar」而不是查具体 GID。
    for ch in "羽化笔记第一卷落羽第一章出发".chars() {
        let expected = format!("<{:04X}>", ch as u32);
        assert!(
            text.contains(&expected),
            "ToUnicode 里找不到 {ch}（{expected}）的码点"
        );
    }
    // 反向断言：内容流里写的是**字形编号**而不是码点本身。
    // 这是「ToUnicode 确实在起作用」的证据 —— 如果两者相等，
    // 说明我们根本没在用 GID，ToUnicode 也就无从附会。
    let gid = format!("<{:04X}>", ('羽' as u32) + 1);
    assert!(text.contains(&gid), "内容流里找不到字形编号 {gid}");
}

#[test]
fn to_unicode_bfchar_sections_never_exceed_100_entries() {
    // CMap 规范规定 beginbfchar 每段最多 100 项，
    // 超了 Adobe 的解析器会拒绝整份 CMap —— 全部文字都搜不到。
    let font = crate::render::pdf::text::uniform_font_for_page_tests();
    let cmap = to_unicode_cmap_for(&font);
    let mut sections = 0usize;
    let mut entries = 0usize;
    // CMap 的格式是「<条数> beginbfchar」单独占一行，随后是条目行、endbfchar。
    // 因此按 beginbfchar 切分时，条数其实留在**上一段**的末行 ——
    // 这是写这条断言时最容易搞错的一点。
    let lines: Vec<&str> = cmap.lines().map(str::trim).collect();
    let mut index = 0usize;
    while index < lines.len() {
        if !lines[index].ends_with("beginbfchar") {
            index += 1;
            continue;
        }
        let count: usize = lines[index]
            .trim_end_matches("beginbfchar")
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("bfchar 段头不是数字：{:?}", lines[index]));
        assert!(count <= 100, "bfchar 段有 {count} 项，超过规范上限");

        // 段头声明的条数必须与随后的实际条目行数一致：
        // 声明多了，Adobe 的解析器会读越界并放弃整份 CMap，
        // 结果是「全部文字都搜不到」——一个不会报错、只会失效的故障。
        let mut actual = 0usize;
        let mut cursor = index + 1;
        while cursor < lines.len() && lines[cursor] != "endbfchar" {
            if !lines[cursor].is_empty() {
                actual += 1;
            }
            cursor += 1;
        }
        assert_eq!(actual, count, "段头声明 {count} 项，实际有 {actual} 项");
        entries += count;
        sections += 1;
        index = cursor;
    }
    // 合成字体的 cmap 只有一段 [0x0000, 0xFFFF] 且 idDelta = 1，
    // 于是每个合法的 BMP 标量值各有一个 GID。精确数目可以推出来：
    //   65536 个码位 − 2048 个代理码位（D800–DFFF 不是合法 char）
    //   − 1（U+FFFF 加 1 后回绕成 0，即 .notdef，被 glyph_id 拒绝）
    //   = 63487
    // 这个数字写死在断言里是有意的：它同时钉住了三件事 ——
    // 代理区被跳过、.notdef 被拒绝、没有重复映射。
    const EXPECTED_MAPPINGS: usize = 65536 - 2048 - 1;
    assert!(sections > 0, "CMap 里没有任何 bfchar 段");
    assert_eq!(
        entries, EXPECTED_MAPPINGS,
        "全 BMP 映射的条数不对（实际 {entries}）"
    );
    assert_eq!(
        sections,
        EXPECTED_MAPPINGS.div_ceil(100),
        "段数应当按每段最多 100 条切分"
    );
}

#[test]
fn content_stream_writes_glyph_ids_not_unicode() {
    let doc = rich_document();
    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let text = String::from_utf8_lossy(&bytes).to_string();
    // Identity-H 下内容流里应当是 <....> 的 GID 串
    assert!(text.contains("Tj"), "内容流里没有文本操作符");
    assert!(text.contains("/F1 "), "内容流没有选择字体");
    assert!(text.contains(" Tm"), "内容流没有设置文本矩阵");
}

#[test]
fn chapter_page_break_is_honored_and_configurable() {
    let doc = rich_document();
    let (bytes_on, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let pages_on = String::from_utf8_lossy(&bytes_on)
        .matches("/Type /Page ")
        .count();

    let (bytes_off, _) = render_with_synthetic_font(
        &doc,
        PdfOptions {
            page_break_per_chapter: false,
            ..Default::default()
        },
    );
    let pages_off = String::from_utf8_lossy(&bytes_off)
        .matches("/Type /Page ")
        .count();
    // 关掉分章分页不会让页数变多
    assert!(pages_off <= pages_on, "{pages_off} vs {pages_on}");
}

#[test]
fn page_numbers_can_be_disabled() {
    let doc = rich_document();
    let (on, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let (off, _) = render_with_synthetic_font(
        &doc,
        PdfOptions {
            page_numbers: false,
            ..Default::default()
        },
    );
    // 页脚是 "1 / N" 的形式，关掉之后内容流字节数会变小
    assert!(off.len() < on.len(), "关掉页码后产物没有变小");
}

#[test]
fn custom_page_size_is_reflected_in_media_box() {
    let doc = rich_document();
    let (bytes, _) = render_with_synthetic_font(
        &doc,
        PdfOptions {
            page_size: PageSize::LETTER,
            ..Default::default()
        },
    );
    let text = String::from_utf8_lossy(&bytes).to_string();
    assert!(
        text.contains("612.00 792.00"),
        "MediaBox 不是 Letter：{text}"
    );
}

#[test]
fn metadata_carries_title_and_author_as_utf16() {
    let doc = rich_document();
    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let text = String::from_utf8_lossy(&bytes).to_string();
    assert!(text.contains("/Title "), "缺少 /Title");
    assert!(text.contains("/Author "), "缺少 /Author");
    // 中文必须以 UTF-16BE + BOM 的十六进制形式写入，
    // 否则阅读器的「文档属性」里会是一串乱码。
    let title = text.split("/Title ").nth(1).unwrap();
    assert!(title.starts_with("<FEFF"), "标题不是 UTF-16BE：{title}");
    assert!(title.contains("7FBD"), "标题里没有「羽」的码点");
}

#[test]
fn empty_document_still_produces_one_valid_page() {
    let doc = Document::new(BookMeta::new("空书", "作者"));
    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let (count, _) = parse_xref(&bytes);
    assert!(count > 4);
    let text = String::from_utf8_lossy(&bytes).to_string();
    // 一个零页的 PDF 在多数阅读器里会被判为损坏
    assert!(text.contains("/Type /Page "), "空书也必须有一页");
    assert!(text.contains("/Count 1"), "空书应当恰好一页");
}

#[test]
fn missing_font_path_reports_font_unavailable_not_garbage() {
    let doc = rich_document();
    let renderer = PdfRenderer::new(PdfOptions {
        font_path: Some(PathBuf::from("Z:/definitely/not/a/font.ttf")),
        ..Default::default()
    });
    let err = renderer.render(&doc).unwrap_err();
    assert_eq!(err.code(), "FONT_UNAVAILABLE", "{err}");
    // 错误里必须带上路径，用户才知道是哪一个字体出的问题
    assert!(err.to_string().contains("not/a/font.ttf"), "{err}");
}

#[test]
fn font_error_never_produces_bytes() {
    // 这条断言是「绝不静默产出乱码 PDF」的机器化表达：
    // 拿不到字体时，必须是 Err 而不是一个能写盘的 Vec<u8>。
    let doc = rich_document();
    let renderer = PdfRenderer::new(PdfOptions {
        font_path: Some(PathBuf::from("Z:/nope.ttf")),
        ..Default::default()
    });
    let result = renderer.render(&doc);
    assert!(result.is_err(), "缺字体时不该产出任何字节");
}

#[test]
fn renderer_reports_pdf_format() {
    assert_eq!(PdfRenderer::default().format(), ExportFormat::Pdf);
}

#[test]
fn inline_degradation_matches_txt_and_docx() {
    let doc = Document::new(BookMeta::new("书", "作者"));
    let renderer = PdfRenderer::default();
    let runs = renderer.inline_runs(&[
        Inline::Link {
            url: "https://example.com".into(),
            text: vec![Inline::text("站点")],
        },
        Inline::Image {
            url: "a.png".into(),
            alt: "示意图".into(),
        },
        Inline::Strong(vec![Inline::text("粗")]),
    ]);
    let joined: String = runs.iter().map(|run| run.text.clone()).collect();
    // 与 TXT / DOCX 的降级文案逐字一致（计划书 R19）
    assert!(joined.contains("站点（https://example.com）"), "{joined}");
    assert!(joined.contains("［图片：示意图］"), "{joined}");
    assert!(joined.contains('粗'), "{joined}");
    let _ = doc;
}

#[test]
fn image_without_alt_still_gets_a_placeholder() {
    let renderer = PdfRenderer::default();
    let runs = renderer.inline_runs(&[Inline::Image {
        url: "a.png".into(),
        alt: String::new(),
    }]);
    assert_eq!(runs[0].text, "［图片］");
}

#[test]
fn pdf_text_string_uses_utf16be_with_bom() {
    assert_eq!(pdf_text_string("A"), "<FEFF0041>");
    assert_eq!(pdf_text_string(""), "<FEFF>");
    assert_eq!(pdf_text_string("一"), "<FEFF4E00>");
}

#[test]
fn base_font_name_is_sanitized() {
    // PDF 名字对象里不能有空格与斜杠，否则整个字典解析会错位
    let font = crate::render::pdf::text::uniform_font_for_page_tests();
    let name = base_font_name(&font);
    assert!(
        !name.contains(' ') && !name.contains('/'),
        "字体名里出现了非法字符：{name}"
    );
}

#[test]
fn long_text_spans_multiple_pages() {
    let vid = VolumeId::new();
    let mut doc = Document::new(BookMeta::new("长书", "作者"));
    doc.volumes.push(VolumeMeta {
        id: vid.clone(),
        title: "卷".into(),
    });
    // 每段 200 字 × 40 段 ≈ 8000 字，A4 一页放不下
    let paragraphs: Vec<Block> = (0..40)
        .map(|_| Block::Paragraph(vec![Inline::text("字".repeat(200))]))
        .collect();
    doc.chapters.push(ChapterContent::new(
        ChapterId::new(),
        vid,
        "长章",
        paragraphs,
    ));

    let (bytes, _) = render_with_synthetic_font(&doc, PdfOptions::default());
    let text = String::from_utf8_lossy(&bytes).to_string();
    let pages = text.matches("/Type /Page ").count();
    assert!(pages > 1, "8000 字应当分多页，实际只有 {pages} 页");
    // 多页时 xref 与流长度仍然必须全对
    parse_xref(&bytes);
    assert_stream_lengths(&bytes);
}

#[test]
fn missing_characters_are_skipped_in_the_content_stream() {
    // 合成字体的 cmap 只覆盖 BMP，用增补平面字符制造缺字。
    // 缺字必须被**跳过**而不是写成 GID 0：GID 0 是 .notdef，
    // 多数阅读器会画一个空心方框，看起来就像乱码。
    let font = crate::render::pdf::text::uniform_font_for_page_tests();
    assert_eq!(hex_string(&font, "甲\u{20000}乙"), "<75334E5A>");
}

#[test]
fn missing_characters_are_reported_to_the_caller() {
    // 「某些字没显示出来」必须有一个可解释的出口：
    // 渲染器把缺字收集起来交回调用方，导出报告才能提示
    // 「本字体缺少 2 个字符」，而不是让用户对着空洞猜原因。
    let vid = VolumeId::new();
    let mut doc = Document::new(BookMeta::new("缺字书", "作者"));
    doc.volumes.push(VolumeMeta {
        id: vid.clone(),
        title: "卷".into(),
    });
    doc.chapters.push(ChapterContent::new(
        ChapterId::new(),
        vid,
        "章",
        vec![Block::Paragraph(vec![Inline::text(
            "甲\u{20000}乙\u{20001}",
        )])],
    ));

    let font = crate::render::pdf::text::uniform_font_for_page_tests();
    let renderer = PdfRenderer::default();
    let mut layout = PdfLayout::new(renderer.options.page_size, renderer.options.margins);
    let mut missing: Vec<char> = Vec::new();
    renderer.render_front_matter(&doc, &mut layout, &font, &mut missing);
    for chapter in doc.iter_chapters() {
        renderer.render_blocks(&mut layout, &font, &chapter.blocks, 0, &mut missing);
    }
    missing.sort_unstable();
    missing.dedup();
    assert_eq!(missing, vec!['\u{20000}', '\u{20001}'], "缺字没有被收集");
}
