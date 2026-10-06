//! 图片内嵌的端到端验证：Markdown 原文 → IR → 包内字节。
//!
//! 单测（`render::epub` / `render::docx`）直接构造 `Inline::Image`，跳过了
//! 「Markdown 里的 `![](相对路径)` 会变成什么」这一环。而命令层
//! （`src-tauri/src/commands.rs::export_document`）用的恰恰是这一环：
//! 表里的 key 是解析器给出的 URL 字符串，只要解析器对路径做任何归一化
//! （百分号编码、去 `./`、拆 title），resolver 就会查不到图，
//! 表现是「导出成功但图没进去」—— 静默降级，最难发现的一类问题。
//! 所以这里必须从 Markdown 源头打通。

use std::io::Read;
use std::path::Path;

use yuhua_export::assets::AssetResolver;
use yuhua_export::{ExportFormat, ExportScope};

fn timestamp() -> chrono::DateTime<chrono::FixedOffset> {
    chrono::DateTime::parse_from_rfc3339("2026-01-01T09:00:00+08:00").unwrap()
}

/// 装配成「一本书、一章、正文为 `body`」的 IR。
fn assemble(body: &str) -> yuhua_export::Document {
    let mut core = yuhua_core::Document::new("插图测试书", timestamp());
    let vid = core.volumes[0].id.clone();
    let mut chapter = yuhua_core::Chapter::new(
        &core.book.id,
        &vid,
        "第一章",
        "manuscript/v0001/c0001.md",
        0,
        timestamp(),
    );
    chapter.body = body.to_string();
    core.chapters.push(chapter);
    yuhua_export::scope::assemble(&core, &ExportScope::Whole).expect("装配失败")
}

/// 与命令层一致的实际调用序列。
fn render_through_the_real_pipeline(format: ExportFormat, body: &str, root: &Path) -> Vec<u8> {
    let ir = assemble(body);
    yuhua_export::render_with_assets(format, &ir, Some(&AssetResolver::new(root))).unwrap()
}

/// 解压成「条目名 → 字节」。
fn entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).unwrap();
    let mut out = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).unwrap();
        out.push((name, buf));
    }
    out
}

/// 取某个条目的文本内容。
fn entry_text(parts: &[(String, Vec<u8>)], name: &str) -> String {
    let found = parts
        .iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("缺少条目 {name}，实际为 {:?}", names(parts)));
    String::from_utf8(found.1.clone()).unwrap_or_else(|_| panic!("{name} 应当是文本"))
}

fn names(parts: &[(String, Vec<u8>)]) -> Vec<&str> {
    parts.iter().map(|(n, _)| n.as_str()).collect()
}

/// 一张合法 PNG：签名 + IHDR（宽/高）+ 尾部，尺寸嗅探器只读这些。
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend_from_slice(&[0x00, 0x00, 0x00, 0x0D]);
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&width.to_be_bytes());
    v.extend_from_slice(&height.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0, 0x1F, 0x4D, 0xA2, 0x0D]);
    v.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
    v.extend_from_slice(b"IEND");
    v.extend_from_slice(&[0xAE, 0x42, 0x60, 0x82]);
    v
}

/// 建一个含 `assets/cover.png`（8x5）的临时工作区根。
fn workspace_with_image() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let image_path = dir.path().join("assets");
    std::fs::create_dir_all(&image_path).unwrap();
    std::fs::write(image_path.join("cover.png"), png(8, 5)).unwrap();
    dir
}

const BODY: &str = "第一章正文。\n\n![封面](assets/cover.png)\n";

#[test]
fn markdown_image_is_embedded_into_epub() {
    let dir = workspace_with_image();
    let bytes = render_through_the_real_pipeline(ExportFormat::Epub, BODY, dir.path());
    let parts = entries(&bytes);
    let image = parts
        .iter()
        .find(|(name, _)| name.starts_with("OEBPS/images/"))
        .unwrap_or_else(|| panic!("EPUB 没内嵌图片，条目为 {:?}", names(&parts)));
    assert_eq!(image.1, png(8, 5), "包内字节必须与原图逐字节一致");

    let chapter = entry_text(&parts, "OEBPS/chapter-0001.xhtml");
    assert!(chapter.contains("images/image-1.png"), "{chapter}");
    // 原始的磁盘相对路径不该留在产物里
    assert!(!chapter.contains("assets/cover.png"), "{chapter}");
    let opf = entry_text(&parts, "OEBPS/content.opf");
    assert!(opf.contains("media-type=\"image/png\""), "{opf}");
}

#[test]
fn markdown_image_is_embedded_into_docx() {
    let dir = workspace_with_image();
    let bytes = render_through_the_real_pipeline(ExportFormat::Docx, BODY, dir.path());
    let parts = entries(&bytes);
    let image = parts
        .iter()
        .find(|(name, _)| name == "word/media/image-1.png")
        .unwrap_or_else(|| panic!("DOCX 没内嵌图片，条目为 {:?}", names(&parts)));
    assert_eq!(image.1, png(8, 5));

    let document = entry_text(&parts, "word/document.xml");
    assert!(document.contains("<w:drawing>"), "{document}");
    // 8x5 像素 @96dpi = 76200 x 47625 EMU
    assert!(document.contains("cx=\"76200\" cy=\"47625\""), "{document}");
    // 图进包了就不该再有替代文本占位
    assert!(!document.contains("［图片"), "{document}");
    let rels = entry_text(&parts, "word/_rels/document.xml.rels");
    assert!(rels.contains("Target=\"media/image-1.png\""), "{rels}");
}

#[test]
fn chinese_asset_path_is_embedded() {
    // 中文稿子的图片目录常常就叫「插图」。resolver 用 `Path::join`，
    // 非 ASCII 段名不该在这里被拒。
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("插图");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(assets.join("封面.png"), png(8, 5)).unwrap();
    let bytes = render_through_the_real_pipeline(
        ExportFormat::Epub,
        "正文\n\n![封面](插图/封面.png)\n",
        dir.path(),
    );
    let parts = entries(&bytes);
    assert!(
        parts.iter().any(|(n, _)| n == "OEBPS/images/image-1.png"),
        "中文路径没内嵌，条目为 {:?}",
        names(&parts)
    );
}

#[test]
fn a_data_uri_image_is_never_read_from_disk() {
    // 内联 data URI 不是磁盘路径。resolver 拒绝带协议的 URL，
    // 于是 EPUB 原样保留（阅读器认 data URI），DOCX 因为拿不到像素尺寸
    // 而降级为替代文本 —— 两种都不报错、也不多产出一个空条目。
    let dir = workspace_with_image();
    let body = "正文\n\n![内联](data:image/png;base64,AAAA)\n";
    let epub = entries(&render_through_the_real_pipeline(
        ExportFormat::Epub,
        body,
        dir.path(),
    ));
    assert!(
        !epub.iter().any(|(n, _)| n.starts_with("OEBPS/images/")),
        "data URI 不该产出图片条目：{:?}",
        names(&epub)
    );
    assert!(
        entry_text(&epub, "OEBPS/chapter-0001.xhtml").contains("data:image/png;base64,AAAA"),
        "EPUB 应保留内联图"
    );

    let docx = entries(&render_through_the_real_pipeline(
        ExportFormat::Docx,
        body,
        dir.path(),
    ));
    assert!(
        !docx.iter().any(|(n, _)| n.starts_with("word/media/")),
        "data URI 不该产出 media 条目：{:?}",
        names(&docx)
    );
    assert!(
        entry_text(&docx, "word/document.xml").contains("［图片：内联］"),
        "DOCX 应降级为替代文本"
    );
}

#[test]
fn other_formats_are_unaffected_by_the_resolver() {
    // 内嵌只对容器格式有意义。TXT / Markdown / HTML 传了 resolver 也必须
    // 与不传时逐字节一致，否则「同一本书导出两次结果不同」会无从解释。
    let dir = workspace_with_image();
    let ir = assemble(BODY);
    for format in [
        ExportFormat::Txt,
        ExportFormat::Markdown,
        ExportFormat::Html,
    ] {
        let with =
            yuhua_export::render_with_assets(format, &ir, Some(&AssetResolver::new(dir.path())))
                .unwrap();
        let without = yuhua_export::render(format, &ir).unwrap();
        assert_eq!(with, without, "{format:?} 不该受 resolver 影响");
    }
}

#[test]
fn writing_the_export_into_a_directory_outside_the_workspace_still_embeds() {
    // 产物路径与图片根是两回事：用户常把交稿件导到桌面。
    // 这条拦住「顺手用产物所在目录当 resolver 根」的错误实现。
    let dir = workspace_with_image();
    let out_dir = tempfile::tempdir().unwrap();
    let ir = assemble(BODY);
    let target = out_dir.path().join("交稿.epub");
    let report = yuhua_export::render_to_path_with_assets(
        ExportFormat::Epub,
        &ir,
        &target,
        Some(&AssetResolver::new(dir.path())),
    )
    .unwrap();
    assert_eq!(report.path, target);
    assert_eq!(
        report.bytes,
        std::fs::metadata(&target).unwrap().len() as usize
    );
    let parts = entries(&std::fs::read(&target).unwrap());
    assert!(parts.iter().any(|(n, _)| n == "OEBPS/images/image-1.png"));
    // 内嵌之后产物应明显大于「不内嵌」的同本书
    let plain =
        yuhua_export::render_to_path(ExportFormat::Epub, &ir, &out_dir.path().join("p.epub"))
            .unwrap();
    assert!(report.bytes > plain.bytes, "带图的包该更大");
}
