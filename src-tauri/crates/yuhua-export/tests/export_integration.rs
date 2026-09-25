//! 导出引擎端到端集成测试。
//!
//! 单元测试（各 `src/*.rs` 里的 `#[cfg(test)] mod tests`）验证的是「每个部件
//! 自己写对了」；这一层验证的是**契约**：真实产出的文件字节里，
//! EPUB 的 mimetype 布局、zip 条目顺序、跨格式内容一致性这些
//! 「只有把产物当真文件读回来才能确认」的性质。
//!
//! 放在 `tests/` 而不是 `src/` 的理由：这里用 `yuhua_export::` 以**外部**
//! 使用者视角调用公开 API，顺带把「crate 的导出面是否够用」也测了。
//! 如果只从 lib 内部测试，公开 API 少导出一个类型也照样编译通过。

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use yuhua_core::{BookId, ChapterId, Document as CoreDocument, VolumeId};
use yuhua_export::ir::{Block, BookMeta, ChapterContent, Inline, VolumeMeta};
use yuhua_export::render::epub::MIMETYPE_CONTENT;
use yuhua_export::scope::{self, ExportScope};
use yuhua_export::{render, render_to_path, ExportFormat, Renderer};

/// 造一份包含各种块类型与「危险字符」的 IR。
fn sample_ir() -> yuhua_export::Document {
    let vid = VolumeId::new();
    let mut doc = BookMeta::new("羽化笔记", "张三");
    doc.id = Some(BookId::new());
    doc.description = "一本用于端到端核验的书".into();
    let book = doc;

    let mut ir = yuhua_export::Document::new(book);
    ir.volumes.push(VolumeMeta {
        id: vid.clone(),
        title: "第一卷".into(),
    });
    ir.chapters.push(ChapterContent::new(
        ChapterId::new(),
        vid.clone(),
        "第一章 羽化",
        vec![
            Block::Heading {
                level: 1,
                text: "场景一".into(),
            },
            Block::Paragraph(vec![
                Inline::text("正文里有 "),
                Inline::Strong(vec![Inline::text("粗体")]),
                Inline::text("、"),
                Inline::Emph(vec![Inline::text("斜体")]),
                Inline::text(" 与 </w:t> & <script>alert(1)</script> 等字符。"),
            ]),
            Block::Quote(vec![Block::Paragraph(vec![Inline::text("引用内容")])]),
            Block::List {
                ordered: false,
                start: 1,
                items: vec![
                    vec![Block::Paragraph(vec![Inline::text("甲")])],
                    vec![Block::Paragraph(vec![Inline::text("乙")])],
                ],
            },
            Block::Code {
                lang: "rust".into(),
                text: "let a = 1 < 2;".into(),
            },
            Block::Hr,
        ],
    ));
    ir.chapters.push(ChapterContent::new(
        ChapterId::new(),
        vid,
        "第二章 归墟",
        vec![Block::Paragraph(vec![Inline::text("第二章正文。")])],
    ));
    ir
}

/// 解压成「条目名 → 文本」。
fn unzip(bytes: &[u8]) -> HashMap<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).expect("应当是合法 zip");
    let mut map = HashMap::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().to_string();
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        map.insert(name, content);
    }
    map
}

/// 解压成有序的条目列表（含压缩方法）。
fn unzip_ordered(bytes: &[u8]) -> Vec<(String, bool, Vec<u8>)> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).expect("应当是合法 zip");
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().to_string();
        let stored = entry.compression() == zip::CompressionMethod::Stored;
        let mut content = Vec::new();
        entry.read_to_end(&mut content).unwrap();
        entries.push((name, stored, content));
    }
    entries
}

#[test]
fn epub_mimetype_is_first_stored_and_exact_in_raw_bytes() {
    let bytes = render(ExportFormat::Epub, &sample_ir()).unwrap();

    // ---- 直接读原始字节，不借助解压库 ----
    // zip 本地文件头固定布局：
    //   0..4   签名 0x04034b50 ("PK")
    //   4..6   版本
    //   6..8   通用位标记
    //   8..10  压缩方法（0 = stored）
    //   ...
    //   26..28 文件名长度
    //   28..30 扩展字段长度
    //   30..   文件名
    assert_eq!(
        &bytes[0..4],
        b"PK\x03\x04",
        "EPUB 必须以 zip 本地文件头开头"
    );
    let method = u16::from_le_bytes([bytes[8], bytes[9]]);
    assert_eq!(method, 0, "第一个条目必须无压缩（Stored）");

    let name_len = u16::from_le_bytes([bytes[26], bytes[27]]) as usize;
    let extra_len = u16::from_le_bytes([bytes[28], bytes[29]]) as usize;
    let name = std::str::from_utf8(&bytes[30..30 + name_len]).unwrap();
    assert_eq!(name, "mimetype", "第一个条目必须是 mimetype");

    let data_start = 30 + name_len + extra_len;
    let content = &bytes[data_start..data_start + MIMETYPE_CONTENT.len()];
    assert_eq!(
        std::str::from_utf8(content).unwrap(),
        "application/epub+zip",
        "mimetype 内容必须精确"
    );
    // 紧跟其后的字节不能是换行 —— 「mimetype 末尾带 \n」是 epubcheck 的经典报错
    assert_ne!(
        bytes[data_start + MIMETYPE_CONTENT.len()],
        b'\n',
        "mimetype 内容之后不该立刻出现换行"
    );
}

#[test]
fn epub_ordered_entries_match_epub3_layout() {
    let bytes = render(ExportFormat::Epub, &sample_ir()).unwrap();
    let entries = unzip_ordered(&bytes);
    let names: Vec<&str> = entries.iter().map(|(n, _, _)| n.as_str()).collect();

    assert_eq!(names[0], "mimetype");
    assert!(names.contains(&"META-INF/container.xml"), "{names:?}");
    assert!(names.contains(&"OEBPS/content.opf"), "{names:?}");
    assert!(names.contains(&"OEBPS/nav.xhtml"), "{names:?}");
    // 每章一个 XHTML
    assert!(names.contains(&"OEBPS/chapter-0001.xhtml"), "{names:?}");
    assert!(names.contains(&"OEBPS/chapter-0002.xhtml"), "{names:?}");

    // 只有 mimetype 允许无压缩
    let stored: Vec<&str> = entries
        .iter()
        .filter(|(n, stored, _)| *stored && n != "mimetype")
        .map(|(n, _, _)| n.as_str())
        .collect();
    assert!(stored.is_empty(), "不应有无压缩条目：{stored:?}");
}

#[test]
fn epub_metadata_is_complete() {
    let parts = unzip(&render(ExportFormat::Epub, &sample_ir()).unwrap());
    let opf = &parts["OEBPS/content.opf"];
    assert!(opf.contains("<dc:title>羽化笔记</dc:title>"), "{opf}");
    assert!(opf.contains("<dc:language>zh</dc:language>"), "{opf}");
    assert!(
        opf.contains("<dc:creator id=\"creator\">张三</dc:creator>"),
        "{opf}"
    );
    assert!(opf.contains("urn:uuid:"), "{opf}");
    assert!(opf.contains("property=\"dcterms:modified\""), "{opf}");
}

#[test]
fn docx_contains_expected_parts_and_text() {
    let bytes = render(ExportFormat::Docx, &sample_ir()).unwrap();
    assert_eq!(&bytes[..4], b"PK\x03\x04");
    let parts = unzip(&bytes);

    for name in [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/_rels/document.xml.rels",
        "word/styles.xml",
    ] {
        assert!(parts.contains_key(name), "缺少 {name}");
    }
    let document = &parts["word/document.xml"];
    assert!(document.contains("羽化笔记"), "{document}");
    assert!(document.contains("第一章 羽化"), "{document}");
    assert!(document.contains("第二章 归墟"), "{document}");
    // 中文字体必须显式声明（R18）
    assert!(
        parts["word/styles.xml"].contains("w:eastAsia="),
        "缺少东亚字体声明"
    );
    // 每章分页
    assert!(document.contains("w:type=\"page\""));
}

#[test]
fn docx_and_epub_escape_dangerous_characters() {
    let ir = sample_ir();
    for format in [ExportFormat::Docx, ExportFormat::Epub, ExportFormat::Html] {
        let bytes = render(format, &ir).unwrap();
        let text = String::from_utf8_lossy(&bytes).into_owned();

        // 无论哪种格式，产物里都不能出现「未转义的、可被解释为标记的」片段
        match format {
            ExportFormat::Html => {
                assert!(!text.contains("<script>alert"), "{format:?} 未转义脚本");
                assert!(text.contains("&lt;script&gt;"), "{format:?} 应转义为实体");
            }
            _ => {
                // DOCX/EPUB 是压缩容器，文本在压缩流里；解压后再查
                let parts = unzip(&bytes);
                let joined: String = parts.values().cloned().collect::<Vec<_>>().join("\n");
                assert!(!joined.contains("<script>alert"), "{format:?} 未转义脚本");
                assert!(
                    joined.contains("&lt;script&gt;"),
                    "{format:?} 应把 < 转义成 &lt;"
                );
            }
        }
    }
}

#[test]
fn all_implemented_formats_render_non_empty_and_readable() {
    let ir = sample_ir();
    for format in ExportFormat::ALL {
        if !format.is_available() {
            continue;
        }
        let bytes = render(format, &ir).unwrap();
        assert!(!bytes.is_empty(), "{format:?} 产出为空");

        // 文本类格式必须能按 UTF-8 解出来且包含正文
        match format {
            ExportFormat::Txt | ExportFormat::Markdown | ExportFormat::Html => {
                let text = String::from_utf8(bytes).expect("必须是合法 UTF-8");
                assert!(
                    text.contains("正文里有"),
                    "{format:?} 缺少正文：{}",
                    &text[..text.len().min(200)]
                );
                assert!(!text.contains('\u{fffd}'), "{format:?} 出现乱码");
                // 零外链
                assert!(!text.contains("http://cdn"), "{format:?} 含 CDN 外链");
                assert!(!text.contains("<link "), "{format:?} 含外链样式");
            }
            ExportFormat::Docx | ExportFormat::Epub => {
                let parts = unzip(&bytes);
                let joined: String = parts.values().cloned().collect::<Vec<_>>().join("\n");
                assert!(joined.contains("正文里有"), "{format:?} 缺少正文");
            }
            ExportFormat::Pdf => unreachable!("PDF 不可用，已在上面跳过"),
        }
    }
}

#[test]
fn pdf_is_explicitly_unimplemented_not_silently_wrong() {
    let ir = sample_ir();
    let err = render(ExportFormat::Pdf, &ir).unwrap_err();
    assert!(matches!(err, yuhua_export::ExportError::Unimplemented(_)));
    assert_eq!(err.code(), "UNIMPLEMENTED");
    // 未实现必须能被翻译回领域统一错误，供 IPC 返回前端
    let core: yuhua_core::YuhuaError = err.into();
    assert_eq!(core.code(), "UNIMPLEMENTED");
}

#[test]
fn render_to_path_writes_atomically_and_leaves_no_temp_files() {
    let ir = sample_ir();
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("交稿.docx");

    let report = render_to_path(ExportFormat::Docx, &ir, &target).unwrap();
    assert_eq!(report.path, target);
    assert!(target.exists());

    let leftovers: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
}

#[test]
fn render_to_path_is_utf8_safe_for_chinese_filenames() {
    let ir = sample_ir();
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("羽化笔记-第一章.txt");
    render_to_path(ExportFormat::Txt, &ir, &target).unwrap();
    let content = std::fs::read_to_string(&target).unwrap();
    assert!(content.contains("正文里有"), "{content}");
}

#[test]
fn end_to_end_from_core_document_through_scope_to_file() {
    // 走完整链路：领域文档 → 范围装配 → 渲染 → 落盘
    let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00").unwrap();
    let mut core = CoreDocument::new("整书流水线", now);
    core.book.author = "李四".into();
    let vid = core.volumes[0].id.clone();
    for (index, body) in [
        "# 一\n\n第一章**正文**",
        "# 二\n\n第二章正文\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |",
    ]
    .into_iter()
    .enumerate()
    {
        let mut chapter = yuhua_core::Chapter::new(
            &core.book.id,
            &vid,
            format!("第{}章", index + 1),
            format!("manuscript/{index}.md"),
            index as i32,
            now,
        );
        chapter.body = body.into();
        core.chapters.push(chapter);
    }

    let ir = scope::assemble(&core, &ExportScope::Whole).unwrap();
    assert_eq!(ir.chapter_count(), 2);
    // 第二章含表格，必须留下降级记录（R19）
    assert_eq!(ir.degradations.len(), 1);
    assert_eq!(
        ir.degradations[0].kind,
        yuhua_export::DegradationKind::Table
    );
    assert_eq!(ir.degradations[0].chapter_title, "第2章");

    let dir = tempfile::tempdir().unwrap();
    for format in [
        ExportFormat::Txt,
        ExportFormat::Markdown,
        ExportFormat::Html,
    ] {
        let target = dir.path().join(format!("book.{}", format.extension()));
        let report = render_to_path(format, &ir, &target).unwrap();
        assert!(report.bytes > 0, "{format:?}");
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(text.contains("第一章"), "{format:?}");
        // 表格内容不能丢
        assert!(
            text.contains('a') || text.contains("列"),
            "{format:?} 丢了表格内容"
        );
    }
}

#[test]
fn streaming_writer_matches_in_memory_render() {
    // 内存不变量的契约：流式接口与一次性产出必须字节一致
    let ir = sample_ir();
    let renderer = yuhua_export::render::txt::TxtRenderer::default();
    let bytes = renderer.render(&ir).unwrap();
    let mut streamed: Vec<u8> = Vec::new();
    renderer.render_to_writer(&ir, &mut streamed).unwrap();
    assert_eq!(bytes, streamed);
}

#[test]
fn markdown_output_strips_front_matter_and_keeps_structure() {
    // 直接喂一份「磁盘上带 Front Matter 的原文」走完整链路
    let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00").unwrap();
    let mut core = CoreDocument::new("剥离测试", now);
    let vid = core.volumes[0].id.clone();
    let mut chapter =
        yuhua_core::Chapter::new(&core.book.id, &vid, "第一章", "manuscript/000.md", 0, now);
    // 模拟 yuhua-fs 剥离后的 body（不含 Front Matter）
    chapter.body = "正文第一段\n\n## 小节\n\n正文第二段".into();
    core.chapters.push(chapter);

    let ir = scope::assemble(&core, &ExportScope::Whole).unwrap();
    let text = String::from_utf8(render(ExportFormat::Markdown, &ir).unwrap()).unwrap();
    assert!(!text.contains("title:"), "不该出现 Front Matter：{text}");
    assert!(text.contains("# 第一卷"), "{text}");
    assert!(text.contains("## 第一章"), "{text}");
    assert!(text.contains("正文第一段"), "{text}");
}

#[test]
fn writer_that_always_fails_surfaces_an_io_error() {
    // 渲染器的错误路径：写入端失败必须报错而不是静默成功
    struct FailingWriter;
    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "断了"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let ir = sample_ir();
    let renderer = yuhua_export::render::txt::TxtRenderer::default();
    let err = renderer
        .render_to_writer(&ir, &mut FailingWriter)
        .unwrap_err();
    assert_eq!(err.code(), "IO_ERROR");
}
