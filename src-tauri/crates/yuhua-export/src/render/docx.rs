//! DOCX 渲染器 —— 手写最小 OOXML。
//!
//! 计划书 9.4 明确要求「用 `zip` crate 打包，**不引入 docx 生成库**」。
//! 这么做的理由是体积与可控性：docx-rs 之类的库会带来一棵不小的依赖树，
//! 而我们要写的 OOXML 子集其实只有几百行。
//!
//! ## 包结构
//!
//! ```text
//! [Content_Types].xml          内容类型声明（决定 Word 怎么认每个部件）
//! _rels/.rels                  包级关系：指向主文档
//! word/document.xml            正文
//! word/_rels/document.xml.rels 主文档的关系：指向 styles
//! word/styles.xml              样式表（含中文字体声明）
//! word/media/image-*.png       被内嵌的图片（有图才有）
//! ```
//!
//! ## 两个最容易踩的坑（R18）
//!
//! 1. **中文字体必须显式声明**。OOXML 里字体分三类：`w:ascii`（西文）、
//!    `w:hAnsi`（高 ANSI）、`w:eastAsia`（东亚）。只写前两个的话，
//!    中文会走 Word 的默认字体回退，在不同机器上显示成不同样子 ——
//!    交稿时这是硬伤。
//! 2. **zip 内的路径分隔符必须是 `/`**。用 Windows 的 `\\` 写出条目名，
//!    Word 会认为整个包非法（`[Content_Types].xml` 的匹配是按名字串做的）。
//!
//! ## 不做的事（计划书 9.4「不做」清单）
//!
//! 复杂表格、文本框、图片环绕、目录域 —— 一律不实现。
//!
//! ## 图片：内嵌为行首/行内图形，不做环绕
//!
//! 给了 [`AssetResolver`] 时，能读到且**嗅探得出像素尺寸**的图会进包
//! （`word/media/`），正文里以「行内图形」出现，宽度超出版心时按比例缩到
//! 版心宽。读不到、或尺寸嗅不出（`cx`/`cy` 是必填项，猜一个会让 Word
//! 里的图变形）时退化为「［图片：alt］」斜体段落 —— 宁可少一个排版效果，
//! 也不要产出 Word 打不开或打开后图是歪的文件。

use std::fmt::Write as _;
use std::io::{Cursor, Write};

use crate::assets::{AssetResolver, ImageTable};
use crate::error::{ExportError, Result};
use crate::ir::{Block, Document, Inline};
use crate::render::{ExportFormat, Renderer};

/// DOCX 渲染选项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocxOptions {
    /// 正文中文字体名（写入 `w:eastAsia`）。
    pub body_font_east_asian: String,
    /// 正文西文字体名（写入 `w:ascii` 与 `w:hAnsi`）。
    pub body_font_latin: String,
    /// 标题中文字体名。
    pub heading_font_east_asian: String,
    /// 正文字号，单位为半磅（`w:sz` 的值）。24 = 12pt。
    pub body_size_half_points: u32,
    /// 每章是否分页。
    pub page_break_per_chapter: bool,
}

impl Default for DocxOptions {
    fn default() -> Self {
        Self {
            // 宋体是中文交稿的事实标准；把它写成默认而不是「跟随系统」，
            // 是为了让「本机预览」与「编辑打开」看到的是同一个东西。
            body_font_east_asian: "宋体".to_string(),
            body_font_latin: "Times New Roman".to_string(),
            heading_font_east_asian: "黑体".to_string(),
            body_size_half_points: 24,
            page_break_per_chapter: true,
        }
    }
}

/// DOCX 渲染器。
#[derive(Debug, Clone, Default)]
pub struct DocxRenderer {
    /// 选项。
    pub options: DocxOptions,
    /// 图片资源解析器；`None` 时图片降级为替代文本段落。
    pub assets: Option<AssetResolver>,
}

impl DocxRenderer {
    /// 用指定选项构造。
    pub fn new(options: DocxOptions) -> Self {
        Self {
            options,
            assets: None,
        }
    }

    /// 挂载图片解析器（链式）。
    pub fn with_assets(mut self, assets: Option<AssetResolver>) -> Self {
        self.assets = assets;
        self
    }

    /// 第一遍：扫全书建图片表。没挂 resolver 时得到空表，
    /// 后续渲染路径与「不内嵌」完全一致。
    fn collect_images(&self, document: &Document) -> ImageTable {
        let mut table = ImageTable::new();
        let Some(resolver) = &self.assets else {
            return table;
        };
        for chapter in document.iter_chapters() {
            table.gather(&chapter.blocks, resolver);
        }
        table
    }

    /// 生成 `word/document.xml`。
    fn document_xml(&self, document: &Document, images: &ImageTable) -> String {
        let mut body = String::new();

        // 书名作为文档标题（样式 Title 未定义时退化成普通段落也不难看）
        let _ = writeln!(
            body,
            "<w:p><w:pPr><w:pStyle w:val=\"Title\"/><w:jc w:val=\"center\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
            escape_xml(&document.book.title)
        );
        if !document.book.author.trim().is_empty() {
            let _ = writeln!(
                body,
                "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                escape_xml(document.book.author_or_anonymous())
            );
        }

        let mut current_volume: Option<&str> = None;
        for chapter in document.iter_chapters() {
            let volume_title = document.volume_title(&chapter.volume_id);
            if volume_title != current_volume {
                if let Some(title) = volume_title {
                    self.push_heading(&mut body, 1, title);
                    current_volume = volume_title;
                }
            }
            if self.options.page_break_per_chapter {
                body.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
            }
            self.push_heading(&mut body, 2, &chapter.title);
            self.render_blocks(&chapter.blocks, &mut body, images);
        }

        // <w:sectPr> 定义页面：A4 竖排，页边距 2.54cm / 3.17cm
        // （1440 twips = 1 英寸；A4 宽 11906 高 16838 twips）
        let mut out = String::new();
        out.push_str(XML_DECLARATION);
        // `wp`（行内图形）与 `r`（关系引用）即使本书无图也声明：
        // 根元素只写一次，按「有没有图」分支加属性会让两种产物的根长得不一样，
        // 而多余的命名空间声明对 Word 完全无害。
        out.push_str(
            "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"  \
             xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\"  \
             xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
        );
        out.push_str("<w:body>");
        out.push_str(&body);
        out.push_str(
            "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>             <w:pgMar w:top=\"1440\" w:right=\"1800\" w:bottom=\"1440\" w:left=\"1800\"              w:header=\"851\" w:footer=\"992\" w:gutter=\"0\"/></w:sectPr>",
        );
        out.push_str("</w:body></w:document>");
        out
    }

    /// 追加一个标题段落。
    fn push_heading(&self, out: &mut String, level: u8, text: &str) {
        let style = format!("Heading{}", level.clamp(1, 3));
        let _ = writeln!(
            out,
            "<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
            escape_xml(text)
        );
    }

    /// 渲染块序列。
    fn render_blocks(&self, blocks: &[Block], out: &mut String, images: &ImageTable) {
        for block in blocks {
            self.render_block(block, out, images);
        }
    }

    /// 渲染单个块。
    fn render_block(&self, block: &Block, out: &mut String, images: &ImageTable) {
        match block {
            Block::Paragraph(inlines) => {
                let runs = self.render_inlines(inlines, images);
                if runs.trim().is_empty() {
                    return;
                }
                let _ = writeln!(out, "<w:p>{runs}</w:p>");
            }
            Block::Heading { level, text } => {
                // 章内部的标题从 Heading3 起，避免与章标题抢层级
                self.push_heading(out, level.saturating_add(2).min(3), text);
            }
            Block::Quote(children) => {
                let mut inner = String::new();
                self.render_blocks(children, &mut inner, images);
                // 样式层面上 Quote 已带缩进与斜体；这里再包一层 `w:pStyle`。
                // inner 里的每个 <w:p> 都要替换，所以用字符串替换而不是拼接。
                let quoted =
                    inner.replace("<w:p>", "<w:p><w:pPr><w:pStyle w:val=\"Quote\"/></w:pPr>");
                out.push_str(&quoted);
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                for (index, item) in items.iter().enumerate() {
                    // 用 numId 引用 numbering 会要求额外维护 numbering.xml；
                    // 第一阶段直接在文本前加标记，配合 ListParagraph 的缩进样式，
                    // Word 与 WPS 里都能得到正确的观感，且少了整个部件。
                    let marker = if *ordered {
                        format!("{}. ", start + index as u64)
                    } else {
                        "· ".to_string()
                    };
                    let mut first = true;
                    for child in item {
                        match child {
                            Block::List { .. } => self.render_block(child, out, images),
                            other => {
                                let runs = self.render_block_to_runs(other, images);
                                if runs.trim().is_empty() {
                                    continue;
                                }
                                if first {
                                    let _ = writeln!(
                                        out,
                                        "<w:p><w:pPr><w:pStyle w:val=\"ListParagraph\"/></w:pPr>                                         <w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>{runs}</w:p>",
                                        escape_xml(&marker)
                                    );
                                    first = false;
                                } else {
                                    let _ = writeln!(
                                        out,
                                        "<w:p><w:pPr><w:pStyle w:val=\"ListParagraph\"/></w:pPr>{runs}</w:p>"
                                    );
                                }
                            }
                        }
                    }
                }
            }
            Block::Code { text, .. } => {
                // 代码块：等宽字体 + 浅色底纹，逐行成段以保留换行
                for line in text.split('\n') {
                    let _ = writeln!(
                        out,
                        "<w:p><w:pPr><w:pStyle w:val=\"CodeBlock\"/></w:pPr>                         <w:r><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/></w:rPr>                         <w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                        escape_xml(line)
                    );
                }
            }
            Block::Hr => {
                // 用一条下边框的居中空段落模拟分割线
                let _ = writeln!(
                    out,
                    "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"999999\"/></w:pBdr></w:pPr></w:p>"
                );
            }
            Block::PageBreak => {
                out.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
            }
        }
    }

    /// 把一个块渲染成「runs 片段」（没有 `<w:p>` 外壳）。
    fn render_block_to_runs(&self, block: &Block, images: &ImageTable) -> String {
        match block {
            Block::Paragraph(inlines) => self.render_inlines(inlines, images),
            Block::Heading { text, .. } => format!(
                "<w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                escape_xml(text)
            ),
            Block::Code { text, .. } => format!(
                "<w:r><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/></w:rPr>                 <w:t xml:space=\"preserve\">{}</w:t></w:r>",
                escape_xml(text)
            ),
            _ => String::new(),
        }
    }

    /// 渲染行内元素成 runs。
    fn render_inlines(&self, inlines: &[Inline], images: &ImageTable) -> String {
        let mut out = String::new();
        for inline in inlines {
            match inline {
                Inline::Text(t) => out.push_str(&self.run(t, "")),
                Inline::Code(t) => {
                    out.push_str(
                        &self.run(t, "<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/>"),
                    );
                }
                Inline::Strong(children) => {
                    let inner = self.render_inlines_with_props(children, "<w:b/>", images);
                    out.push_str(&inner);
                }
                Inline::Emph(children) => {
                    out.push_str(&self.render_inlines_with_props(children, "<w:i/>", images));
                }
                Inline::Link { text, .. } => {
                    // 第一阶段不生成超链接关系（那要往 document.xml.rels 里加条目），
                    // 改成「下划线 + 蓝色」的视觉提示并保留文字。
                    // 链接 URL 在纯文本里没有意义，故不加到正文里污染排版。
                    let inner =
                        self.render_inlines_with_props(text, "<w:u w:val=\"single\"/>", images);
                    out.push_str(&inner);
                }
                Inline::Image { url, alt } => match self.image_run(url, alt, images) {
                    Some(drawing) => out.push_str(&drawing),
                    None => out.push_str(&self.alt_text_run(alt, "<w:i/>")),
                },
            }
        }
        out
    }

    /// 带属性地渲染一段行内序列。
    fn render_inlines_with_props(
        &self,
        inlines: &[Inline],
        props: &str,
        images: &ImageTable,
    ) -> String {
        let mut out = String::new();
        for inline in inlines {
            match inline {
                Inline::Text(t) => out.push_str(&self.run(t, props)),
                Inline::Code(t) => {
                    let _ = write!(
                        out,
                        "<w:r><w:rPr>{props}<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/></w:rPr>                         <w:t xml:space=\"preserve\">{}</w:t></w:r>",
                        escape_xml(t)
                    );
                }
                Inline::Strong(children) => {
                    out.push_str(&self.render_inlines_with_props(children, "<w:b/>", images));
                }
                Inline::Emph(children) => {
                    out.push_str(&self.render_inlines_with_props(children, "<w:i/>", images));
                }
                Inline::Link { text, .. } => {
                    out.push_str(&self.render_inlines_with_props(text, props, images));
                }
                Inline::Image { url, alt } => {
                    // 图形不继承字符属性（`<w:rPr>` 对 `<w:drawing>` 没有意义），
                    // 所以强调里的图片与不强调时长得一样。
                    match self.image_run(url, alt, images) {
                        Some(drawing) => out.push_str(&drawing),
                        None => out.push_str(&self.alt_text_run(alt, props)),
                    }
                }
            }
        }
        out
    }

    /// 图片的替代文本 run（内嵌不成时的降级表现）。
    fn alt_text_run(&self, alt: &str, props: &str) -> String {
        let label = if alt.is_empty() {
            "［图片］".to_string()
        } else {
            format!("［图片：{alt}］")
        };
        self.run(&label, props)
    }

    /// 生成一张已内嵌图片的行内图形 run；不可用时返回 `None`。
    ///
    /// 三种「不可用」都要退回降级，而不是硬写一个图形：
    /// 1. 表里没有（没挂 resolver，或磁盘上读不到）；
    /// 2. 嗅不出像素尺寸 —— `wp:extent` 的 `cx`/`cy` 是必填项，
    ///    瞎猜一个比例会让 Word 里的图变形，那比少一张图更糟；
    /// 3. 尺寸算出的 EMU 溢出（超宽图）—— 这里按比例缩放而不是拒绝。
    fn image_run(&self, url: &str, alt: &str, images: &ImageTable) -> Option<String> {
        let index = images.index_of(url)?;
        let entry = images.entries().get(index)?;
        if !entry.asset.has_size() {
            return None;
        }
        let (cx, cy) = emu_extent(entry.asset.width, entry.asset.height);
        // rId1 已被 styles 占用，图片关系从 rId2 起
        let rel_id = index + 2;
        let doc_pr_id = index + 1;
        let name = escape_xml(if alt.is_empty() {
            entry.file_name.as_str()
        } else {
            alt
        });
        let mut out = String::new();
        let _ = write!(
            out,
            "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
<wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>\
<wp:docPr id=\"{doc_pr_id}\" name=\"{name}\"/>\
<a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">\
<a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<pic:nvPicPr><pic:cNvPr id=\"{doc_pr_id}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip r:embed=\"rId{rel_id}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>\
</wp:inline></w:drawing></w:r>"
        );
        Some(out)
    }

    /// 生成一个 run。
    fn run(&self, text: &str, props: &str) -> String {
        if props.is_empty() {
            format!(
                "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                escape_xml(text)
            )
        } else {
            format!(
                "<w:r><w:rPr>{props}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                escape_xml(text)
            )
        }
    }

    /// 生成 `[Content_Types].xml`。
    ///
    /// 每种被内嵌图片的**扩展名**都要有一条 `Default`：OOXML 是按扩展名而不是
    /// 按部件名匹配图片类型的，缺了这条 Word 会直接报「包内容有问题」。
    /// 扩展名取自嗅探结果（`extension_for(mime)`），与 `word/media/` 里
    /// 实际写出的文件名同源，所以不会出现「声明了 png，包里却是 .jpg」。
    fn content_types_xml(&self, images: &ImageTable) -> String {
        let mut out = String::from(XML_DECLARATION);
        out.push_str(
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
        );
        out.push_str("<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>");
        out.push_str("<Default Extension=\"xml\" ContentType=\"application/xml\"/>");
        let mut declared: Vec<&str> = Vec::new();
        for entry in images.entries() {
            let ext = crate::assets::extension_for(entry.asset.mime);
            if declared.contains(&ext) {
                continue;
            }
            declared.push(ext);
            let _ = write!(
                out,
                "<Default Extension=\"{ext}\" ContentType=\"{}\"/>",
                entry.asset.mime
            );
        }
        out.push_str("<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>");
        out.push_str("<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>");
        out.push_str("<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>");
        out.push_str("<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>");
        out.push_str("</Types>");
        out
    }

    /// 生成 `word/styles.xml`。
    ///
    /// 这里最关键的是 [`Self::xml_lang_attrs`]：`w:eastAsia` 不写，
    /// 中文就会走渲染器的默认字体回退（R18）。
    fn styles_xml(&self) -> String {
        let size = self.options.body_size_half_points;
        let mut out = String::from(XML_DECLARATION);
        out.push_str(
            "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
        );

        // docDefaults：整份文档的兜底字体与字号
        let _ = write!(
            out,
            "<w:docDefaults><w:rPrDefault><w:rPr>{}</w:rPr></w:rPrDefault>             <w:pPrDefault><w:pPr><w:spacing w:after=\"120\" w:line=\"360\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>",
            self.xml_lang_attrs(&self.options.body_font_latin, &self.options.body_font_east_asian, size, "")
        );

        out.push_str(&self.style_paragraph(
            "Normal",
            "正文",
            "",
            "<w:jc w:val=\"both\"/><w:ind w:firstLineChars=\"200\" w:firstLine=\"480\"/>",
        ));
        out.push_str(&self.style_paragraph(
            "Title",
            "标题",
            "Normal",
            "<w:jc w:val=\"center\"/><w:spacing w:before=\"240\" w:after=\"240\"/><w:ind w:firstLineChars=\"0\" w:firstLine=\"0\"/>",
        ));
        // styleId 由 id 生成，与 `document.xml` 里 `<w:pStyle w:val="HeadingN"/>` 严格对应。
        // 早先这里传的是显示名（"Heading 3" 带空格），导致三级标题静默退化成 Normal。
        out.push_str(&self.heading_style(1, "标题 1", 36, 320, 160));
        out.push_str(&self.heading_style(2, "标题 2", 32, 280, 140));
        out.push_str(&self.heading_style(3, "标题 3", 28, 240, 120));
        out.push_str(&self.style_paragraph(
            "Quote",
            "引用",
            "Normal",
            "<w:ind w:left=\"480\" w:firstLineChars=\"0\" w:firstLine=\"0\"/><w:rPr><w:i/></w:rPr>",
        ));
        out.push_str(&self.style_paragraph(
            "ListParagraph",
            "列表段落",
            "Normal",
            "<w:ind w:left=\"420\" w:firstLineChars=\"0\" w:firstLine=\"0\"/>",
        ));
        out.push_str(&self.style_paragraph(
            "CodeBlock",
            "代码块",
            "Normal",
            "<w:ind w:left=\"420\" w:firstLineChars=\"0\" w:firstLine=\"0\"/>             <w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F5F5F5\"/>",
        ));

        out.push_str("</w:styles>");
        out
    }

    /// 构造一个基于 `base` 的段落样式。
    fn style_paragraph(&self, id: &str, name: &str, base: &str, props: &str) -> String {
        let base_xml = if base.is_empty() {
            String::new()
        } else {
            format!("<w:basedOn w:val=\"{base}\"/>")
        };
        format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{name}\"/>{base_xml}             <w:qFormat/><w:pPr>{props}</w:pPr></w:style>"
        )
    }

    /// 构造标题样式（自带字号与中文字体）。
    fn heading_style(&self, id: u8, name: &str, size: u32, before: u32, after: u32) -> String {
        let rpr = self.xml_lang_attrs(
            &self.options.body_font_latin,
            &self.options.heading_font_east_asian,
            size,
            "<w:b/>",
        );
        format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"Heading{id}\"><w:name w:val=\"{name}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>\
<w:pPr><w:keepNext/><w:spacing w:before=\"{before}\" w:after=\"{after}\"/><w:ind w:firstLineChars=\"0\" w:firstLine=\"0\"/></w:pPr><w:rPr>{rpr}</w:rPr></w:style>\
            "
        )
    }

    /// 生成带 `w:eastAsia` 的字体声明。
    ///
    /// `w:ascii` / `w:hAnsi` 管西文，`w:eastAsia` 管中日韩。三者的存在
    /// 就是 OOXML 处理混排的方式；漏掉 eastAsia 会让中文变成「由渲染器
    /// 自己挑一个字体」，这正是 R18 描述的中文字体兼容问题。
    fn xml_lang_attrs(&self, latin: &str, east_asian: &str, size: u32, extra: &str) -> String {
        format!(
            "<w:rFonts w:ascii=\"{}\" w:hAnsi=\"{}\" w:eastAsia=\"{}\" w:cs=\"{}\"/>\
{extra}<w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/>",
            escape_xml(latin),
            escape_xml(latin),
            escape_xml(east_asian),
            escape_xml(latin),
        )
    }

    /// 生成包级关系 `_rels/.rels`。
    fn root_rels_xml(&self) -> String {
        let mut out = String::from(XML_DECLARATION);
        out.push_str("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
        out.push_str("<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>");
        out.push_str("<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>");
        out.push_str("<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>");
        out.push_str("</Relationships>");
        out
    }

    /// 生成 `word/_rels/document.xml.rels`。
    ///
    /// 图片关系的 `Target` 是**相对 `word/`** 的 `media/xxx`，而 zip 条目名是
    /// `word/media/xxx` —— OOXML 的关系路径以「所在部件的目录」为基准，
    /// 这一点写错的表现是 Word 打开后图片位置一片空白且不报错。
    fn document_rels_xml(&self, images: &ImageTable) -> String {
        let mut out = String::from(XML_DECLARATION);
        out.push_str("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
        out.push_str("<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>");
        for (index, entry) in images.entries().iter().enumerate() {
            let _ = write!(
                out,
                "<Relationship Id=\"rId{next}\" Type=\"{IMAGE_REL}\" Target=\"{MEDIA_DIR}/{file}\"/>",
                next = index + 2,
                file = entry.file_name,
            );
        }
        out.push_str("</Relationships>");
        out
    }

    /// 生成 `docProps/core.xml`（标题 / 作者 / 时间）。
    fn core_xml(&self, document: &Document, created: &str) -> String {
        let mut out = String::from(XML_DECLARATION);
        out.push_str("<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">");
        let _ = write!(
            out,
            "<dc:title>{}</dc:title><dc:creator>{}</dc:creator>",
            escape_xml(&document.book.title),
            escape_xml(document.book.author_or_anonymous())
        );
        let _ = write!(
            out,
            "<dcterms:created xsi:type=\"dcterms:W3CDTF\">{created}</dcterms:created></cp:coreProperties>"
        );
        out
    }

    /// 生成 `docProps/app.xml`。
    fn app_xml(&self, document: &Document) -> String {
        format!(
            "{XML_DECLARATION}<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\">             <Application>羽化写作</Application><Company></Company><Pages>{}</Pages></Properties>",
            document.chapter_count().max(1)
        )
    }
}

impl<'a> Renderer<'a> for DocxRenderer {
    fn format(&self) -> ExportFormat {
        ExportFormat::Docx
    }

    fn render(&self, document: &'a Document) -> Result<Vec<u8>> {
        // 两遍流程的第一遍：图片表决定 media 部件、内容类型声明与关系表，
        // 这三处必须与正文里引用的编号完全一致。
        let images = self.collect_images(document);

        let mut buffer = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            // DOCX 用 deflate；条目名必须用 `/` 分隔（见模块文档的第二个坑）。
            let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            let created = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
            let parts: [(&str, Vec<u8>); 6] = [
                (
                    "[Content_Types].xml",
                    self.content_types_xml(&images).into_bytes(),
                ),
                ("_rels/.rels", self.root_rels_xml().into_bytes()),
                (
                    "word/document.xml",
                    self.document_xml(document, &images).into_bytes(),
                ),
                (
                    "word/_rels/document.xml.rels",
                    self.document_rels_xml(&images).into_bytes(),
                ),
                ("word/styles.xml", self.styles_xml().into_bytes()),
                (
                    "docProps/core.xml",
                    self.core_xml(document, &created).into_bytes(),
                ),
            ];
            for (name, content) in parts {
                zip.start_file(name, options)
                    .map_err(|e| ExportError::Package(format!("写入 {name} 失败：{e}")))?;
                zip.write_all(&content)
                    .map_err(|e| ExportError::Package(format!("写入 {name} 失败：{e}")))?;
            }
            // app.xml 与 core.xml 分开写，便于上面用固定长度数组
            zip.start_file("docProps/app.xml", options)
                .map_err(|e| ExportError::Package(format!("写入 app.xml 失败：{e}")))?;
            zip.write_all(self.app_xml(document).as_bytes())
                .map_err(|e| ExportError::Package(format!("写入 app.xml 失败：{e}")))?;
            // 图片本体。位图已经各自压缩过，deflate 只是白耗 CPU，
            // 但为保持「包内除 mimetype 类特殊条目外都压缩」的既有约定，
            // 这里同样用 deflate —— 体积差别对一本书而言可以忽略。
            for entry in images.entries() {
                let name = format!("word/{MEDIA_DIR}/{}", entry.file_name);
                zip.start_file(&name, options)
                    .map_err(|e| ExportError::Package(format!("写入 {name} 失败：{e}")))?;
                zip.write_all(&entry.asset.bytes)
                    .map_err(|e| ExportError::Package(format!("写入 {name} 失败：{e}")))?;
            }

            zip.finish()
                .map_err(|e| ExportError::Package(format!("收尾 zip 失败：{e}")))?;
        }
        Ok(buffer.into_inner())
    }
}

/// `word/` 下的图片目录。
const MEDIA_DIR: &str = "media";

/// 图片关系的类型 URI。
const IMAGE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/// 版心宽度上限（EMU）。
///
/// `sectPr` 定义 A4 宽 11906 twips，左右边距各 1800，故版心宽 8306 twips；
/// 1 twip = 1/1440 英寸，1 英寸 = 914400 EMU，于是 8306/1440*914400 ≈ 5274240。
/// 超过这个宽度的图会被等比缩小 —— Word 允许超宽图，但那样会顶破页边距，
/// 交稿时属于「得手动调」的硬伤。
const MAX_WIDTH_EMU: u64 = 5_274_240;

/// 每像素的 EMU 数（按 96 DPI，Office 的屏幕基准）。
const EMU_PER_PIXEL: u64 = 9_525;

/// 由像素尺寸算 `wp:extent` 的 cx/cy，必要时等比缩到版心宽。
fn emu_extent(width: u32, height: u32) -> (u64, u64) {
    let cx = u64::from(width) * EMU_PER_PIXEL;
    let cy = u64::from(height) * EMU_PER_PIXEL;
    if cx <= MAX_WIDTH_EMU {
        return (cx, cy);
    }
    // 整数运算保比例：新宽/旧宽 = 新高/旧高 → 新高 = 旧高 * 新宽 / 旧宽
    let scaled = (cy * MAX_WIDTH_EMU / cx).max(1);
    (MAX_WIDTH_EMU, scaled)
}

/// XML 声明。每个部件开头都要有 —— 少写会让部分解析器猜错编码。
const XML_DECLARATION: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

/// XML 文本转义。
///
/// 除了五个标准实体，还要处理 XML 1.0 **不允许出现**的控制字符
/// （例如用户从别处粘贴进来的 \u{0}）。直接写进 XML 会让 Word 报
/// 「文件已损坏」而不是「有个非法字符」—— 后者用户还能自己修。
pub fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 允许 Tab / LF / CR，其余 C0 控制字符一律丢弃
            ch if ch < '\u{20}' && ch != '\t' && ch != '\n' && ch != '\r' => {}
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{BookMeta, ChapterContent, VolumeMeta};
    use std::collections::HashMap;
    use yuhua_core::{ChapterId, VolumeId};

    fn doc_with(blocks: Vec<Block>) -> Document {
        let vid = VolumeId::new();
        let mut doc = Document::new(BookMeta::new("测试书", "作者"));
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "第一卷".into(),
        });
        doc.chapters
            .push(ChapterContent::new(ChapterId::new(), vid, "第一章", blocks));
        doc
    }

    /// 把产物解压成「条目名 → 文本」。
    ///
    /// 图片部件（`word/media/`）内容留空：PNG 不是 UTF-8，`read_to_string`
    /// 会 panic。字节级的断言用 [`unzip_bytes`]。
    fn unzip(bytes: &[u8]) -> HashMap<String, String> {
        let mut archive =
            zip::ZipArchive::new(Cursor::new(bytes.to_vec())).expect("产物必须是合法 zip");
        let mut map = HashMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_string();
            if name.starts_with("word/media/") {
                map.insert(name, String::new());
                continue;
            }
            let mut content = String::new();
            std::io::Read::read_to_string(&mut entry, &mut content).unwrap();
            map.insert(name, content);
        }
        map
    }

    /// 解压成「条目名 → 原始字节」。
    fn unzip_bytes(bytes: &[u8]) -> HashMap<String, Vec<u8>> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).unwrap();
        let mut map = HashMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_string();
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
            map.insert(name, buf);
        }
        map
    }

    fn render_to_strings(doc: &Document) -> HashMap<String, String> {
        let bytes = DocxRenderer::default().render(doc).unwrap();
        unzip(&bytes)
    }

    #[test]
    fn produces_zip_with_all_required_parts() {
        let parts = render_to_strings(&doc_with(vec![]));
        for name in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "docProps/core.xml",
            "docProps/app.xml",
        ] {
            assert!(
                parts.contains_key(name),
                "缺少部件 {name}，实际有 {:?}",
                parts.keys()
            );
        }
    }

    #[test]
    fn zip_entry_names_use_forward_slashes() {
        // 用反斜杠会让 Word 认为包非法
        let bytes = DocxRenderer::default().render(&doc_with(vec![])).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        for index in 0..archive.len() {
            let entry = archive.by_index(index).unwrap();
            assert!(
                !entry.name().contains('\\'),
                "条目名不该含反斜杠：{}",
                entry.name()
            );
        }
    }

    #[test]
    fn document_xml_contains_chapter_text() {
        let parts = render_to_strings(&doc_with(vec![Block::Paragraph(vec![Inline::text(
            "正文内容",
        )])]));
        let document = &parts["word/document.xml"];
        assert!(document.contains("正文内容"), "{document}");
        assert!(document.contains("第一章"), "{document}");
        assert!(document.contains("测试书"), "{document}");
    }

    #[test]
    fn styles_declare_east_asian_font() {
        // R18：中文字体必须显式声明，否则不同机器上字体回退结果不同
        let parts = render_to_strings(&doc_with(vec![]));
        let styles = &parts["word/styles.xml"];
        assert!(styles.contains("w:eastAsia=\"宋体\""), "{styles}");
        assert!(styles.contains("w:ascii=\"Times New Roman\""), "{styles}");
    }

    #[test]
    fn body_font_is_configurable() {
        let doc = doc_with(vec![]);
        let renderer = DocxRenderer::new(DocxOptions {
            body_font_east_asian: "楷体".into(),
            ..Default::default()
        });
        let parts = unzip(&renderer.render(&doc).unwrap());
        let styles = &parts["word/styles.xml"];
        assert!(styles.contains("w:eastAsia=\"楷体\""), "{styles}");
        assert!(!styles.contains("宋体"), "{styles}");
    }

    #[test]
    fn styles_define_required_style_ids() {
        let parts = render_to_strings(&doc_with(vec![]));
        let styles = &parts["word/styles.xml"];
        for style_id in [
            "Heading1",
            "Heading2",
            "Heading3",
            "Normal",
            "Quote",
            "ListParagraph",
        ] {
            assert!(
                styles.contains(&format!("w:styleId=\"{style_id}\"")),
                "styles.xml 缺少样式 {style_id}：{styles}"
            );
        }
    }

    #[test]
    fn heading_styles_use_heading_font() {
        let parts = render_to_strings(&doc_with(vec![]));
        let styles = &parts["word/styles.xml"];
        assert!(styles.contains("w:eastAsia=\"黑体\""), "{styles}");
    }

    #[test]
    fn each_chapter_starts_with_a_page_break() {
        let vid = VolumeId::new();
        let mut doc = Document::new(BookMeta::new("书", "作者"));
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "卷".into(),
        });
        for title in ["第一章", "第二章"] {
            doc.chapters.push(ChapterContent::new(
                ChapterId::new(),
                vid.clone(),
                title,
                vec![],
            ));
        }
        let parts = render_to_strings(&doc);
        let document = &parts["word/document.xml"];
        assert_eq!(
            document.matches("<w:br w:type=\"page\"/>").count(),
            2,
            "{document}"
        );
    }

    #[test]
    fn page_break_can_be_disabled() {
        let doc = doc_with(vec![]);
        let renderer = DocxRenderer::new(DocxOptions {
            page_break_per_chapter: false,
            ..Default::default()
        });
        let parts = unzip(&renderer.render(&doc).unwrap());
        assert!(!parts["word/document.xml"].contains("w:type=\"page\""));
    }

    #[test]
    fn text_is_xml_escaped() {
        let parts = render_to_strings(&doc_with(vec![Block::Paragraph(vec![Inline::text(
            "a < b & c > d \"引用\"",
        )])]));
        let document = &parts["word/document.xml"];
        assert!(
            document.contains("a &lt; b &amp; c &gt; d &quot;引用&quot;"),
            "{document}"
        );
        assert!(!document.contains("a < b"), "{document}");
    }

    #[test]
    fn script_tag_in_body_cannot_break_the_document() {
        let parts = render_to_strings(&doc_with(vec![Block::Paragraph(vec![Inline::text(
            "</w:t></w:r><w:r><w:t>注入",
        )])]));
        let document = &parts["word/document.xml"];
        assert!(
            !document.contains("</w:t></w:r><w:r><w:t>注入"),
            "{document}"
        );
        assert!(document.contains("&lt;/w:t&gt;"), "{document}");
    }

    #[test]
    fn illegal_control_characters_are_dropped() {
        // XML 1.0 不允许 \u{0}，留着会让 Word 报「文件已损坏」
        let doc = doc_with(vec![Block::Paragraph(vec![Inline::text("前\u{0}后")])]);
        let parts = render_to_strings(&doc);
        let document = &parts["word/document.xml"];
        assert!(document.contains("前后"), "{document}");
        assert!(!document.contains('\u{0}'), "{document}");
    }

    #[test]
    fn emphasis_and_strong_use_run_properties() {
        let parts = render_to_strings(&doc_with(vec![Block::Paragraph(vec![
            Inline::Strong(vec![Inline::text("粗")]),
            Inline::Emph(vec![Inline::text("斜")]),
            Inline::Code("code".into()),
        ])]));
        let document = &parts["word/document.xml"];
        assert!(document.contains("<w:b/>"), "{document}");
        assert!(document.contains("<w:i/>"), "{document}");
        assert!(document.contains("Consolas"), "{document}");
    }

    #[test]
    fn quote_uses_quote_style() {
        let parts = render_to_strings(&doc_with(vec![Block::Quote(vec![Block::Paragraph(vec![
            Inline::text("引用"),
        ])])]));
        let document = &parts["word/document.xml"];
        assert!(document.contains("w:val=\"Quote\""), "{document}");
    }

    #[test]
    fn lists_use_list_paragraph_style_with_markers() {
        let parts = render_to_strings(&doc_with(vec![
            Block::List {
                ordered: false,
                start: 1,
                items: vec![
                    vec![Block::Paragraph(vec![Inline::text("甲")])],
                    vec![Block::Paragraph(vec![Inline::text("乙")])],
                ],
            },
            Block::List {
                ordered: true,
                start: 1,
                items: vec![vec![Block::Paragraph(vec![Inline::text("一")])]],
            },
        ]));
        let document = &parts["word/document.xml"];
        assert!(document.contains("w:val=\"ListParagraph\""), "{document}");
        assert!(document.contains("甲"), "{document}");
        assert!(document.contains("1. "), "{document}");
    }

    #[test]
    fn code_block_uses_monospace_font() {
        let parts = render_to_strings(&doc_with(vec![Block::Code {
            lang: "rust".into(),
            text: "let a = 1;\nlet b = 2;".into(),
        }]));
        let document = &parts["word/document.xml"];
        assert!(document.contains("Consolas"), "{document}");
        assert!(document.contains("let a = 1;"), "{document}");
        assert!(document.contains("let b = 2;"), "{document}");
    }

    #[test]
    fn horizontal_rule_becomes_bottom_border() {
        let parts = render_to_strings(&doc_with(vec![Block::Hr]));
        let document = &parts["word/document.xml"];
        assert!(document.contains("<w:pBdr>"), "{document}");
    }

    #[test]
    fn images_degrade_to_alt_text_paragraphs() {
        let parts = render_to_strings(&doc_with(vec![Block::Paragraph(vec![Inline::Image {
            url: "a.png".into(),
            alt: "示意图".into(),
        }])]));
        let document = &parts["word/document.xml"];
        assert!(document.contains("［图片：示意图］"), "{document}");
    }

    #[test]
    fn content_types_declares_document_and_styles() {
        let parts = render_to_strings(&doc_with(vec![]));
        let types = &parts["[Content_Types].xml"];
        assert!(types.contains("/word/document.xml"), "{types}");
        assert!(types.contains("/word/styles.xml"), "{types}");
        assert!(types.contains("Extension=\"rels\""), "{types}");
    }

    #[test]
    fn root_rels_points_at_document() {
        let parts = render_to_strings(&doc_with(vec![]));
        let rels = &parts["_rels/.rels"];
        assert!(rels.contains("Target=\"word/document.xml\""), "{rels}");
    }

    #[test]
    fn document_rels_points_at_styles() {
        let parts = render_to_strings(&doc_with(vec![]));
        let rels = &parts["word/_rels/document.xml.rels"];
        assert!(rels.contains("Target=\"styles.xml\""), "{rels}");
    }

    #[test]
    fn core_properties_carry_title_and_author() {
        let parts = render_to_strings(&doc_with(vec![]));
        let core = &parts["docProps/core.xml"];
        assert!(core.contains("<dc:title>测试书</dc:title>"), "{core}");
        assert!(core.contains("<dc:creator>作者</dc:creator>"), "{core}");
    }

    #[test]
    fn empty_author_falls_back_to_anonymous() {
        let vid = VolumeId::new();
        let mut doc = Document::new(BookMeta::new("书", "  "));
        doc.volumes.push(VolumeMeta {
            id: vid.clone(),
            title: "卷".into(),
        });
        doc.chapters
            .push(ChapterContent::new(ChapterId::new(), vid, "章", vec![]));
        let parts = render_to_strings(&doc);
        assert!(parts["docProps/core.xml"].contains("佚名"));
    }

    #[test]
    fn every_xml_part_has_declaration_and_is_wellformed_enough() {
        let parts = render_to_strings(&doc_with(vec![Block::Paragraph(vec![Inline::text(
            "内容",
        )])]));
        for (name, content) in &parts {
            assert!(
                content.starts_with("<?xml"),
                "{name} 缺少 XML 声明：{}",
                &content[..content.len().min(60)]
            );
            // 标签成对的最粗校验：至少出现过一次结束标签
            assert!(content.contains("</"), "{name} 没有结束标签");
        }
    }

    #[test]
    fn chinese_text_round_trips_through_zip() {
        let parts = render_to_strings(&doc_with(vec![Block::Paragraph(vec![Inline::text(
            "「天地玄黄，宇宙洪荒。」",
        )])]));
        assert!(parts["word/document.xml"].contains("「天地玄黄，宇宙洪荒。」"));
    }

    #[test]
    fn empty_document_still_produces_valid_package() {
        let doc = Document::new(BookMeta::new("空书", "作者"));
        let bytes = DocxRenderer::default().render(&doc).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        let parts = unzip(&bytes);
        assert!(parts.contains_key("word/document.xml"));
        assert!(parts["word/document.xml"].contains("空书"));
    }

    #[test]
    fn escape_xml_handles_all_five_entities() {
        assert_eq!(escape_xml("&<>\"'"), "&amp;&lt;&gt;&quot;&apos;");
    }

    #[test]
    fn escape_xml_keeps_tabs_and_newlines() {
        assert_eq!(escape_xml("a\tb\nc\r"), "a\tb\nc\r");
    }

    // ------------------------------------------------------------------
    //  图片内嵌（P2-3）
    // ------------------------------------------------------------------

    use crate::assets::testing::{png, url, workspace};
    use crate::assets::AssetResolver;

    /// 一段只含一张图的正文。
    fn doc_image(src: &str, alt: &str) -> Document {
        doc_with(vec![Block::Paragraph(vec![Inline::Image {
            url: src.into(),
            alt: alt.into(),
        }])])
    }

    fn renderer_for(root: &std::path::Path) -> DocxRenderer {
        DocxRenderer::default().with_assets(Some(AssetResolver::new(root.to_path_buf())))
    }

    #[test]
    fn embedded_image_is_a_part_with_the_original_bytes() {
        let ws = workspace(&[("a.png", 3, 2)]);
        let doc = doc_image(&url("a.png"), "插图");
        let parts = unzip_bytes(&renderer_for(ws.path()).render(&doc).unwrap());
        let written = parts
            .get("word/media/image-1.png")
            .unwrap_or_else(|| panic!("没有内嵌图片，实际有 {:?}", parts.keys()));
        assert_eq!(written, &png(3, 2));
    }

    #[test]
    fn drawing_references_relationship_and_extent() {
        let ws = workspace(&[("a.png", 3, 2)]);
        let parts = render_to_strings_with(ws.path(), &doc_image(&url("a.png"), "插图"));
        let document = &parts["word/document.xml"];
        assert!(document.contains("<w:drawing>"), "{document}");
        assert!(document.contains("r:embed=\"rId2\""), "{document}");
        // 3x2 像素 @96dpi = 28575 x 19050 EMU
        assert!(document.contains("cx=\"28575\" cy=\"19050\""), "{document}");
        assert!(document.contains("name=\"插图\""), "{document}");
        let rels = &parts["word/_rels/document.xml.rels"];
        assert!(
            rels.contains("Id=\"rId2\"") && rels.contains("Target=\"media/image-1.png\""),
            "{rels}"
        );
        let types = &parts["[Content_Types].xml"];
        assert!(
            types.contains("Default Extension=\"png\" ContentType=\"image/png\""),
            "{types}"
        );
    }

    fn render_to_strings_with(root: &std::path::Path, doc: &Document) -> HashMap<String, String> {
        let bytes = renderer_for(root).render(doc).unwrap();
        unzip(&bytes)
    }

    #[test]
    fn two_images_get_consecutive_relationship_ids() {
        let ws = workspace(&[("a.png", 3, 2), ("b.png", 4, 4)]);
        let doc = doc_with(vec![
            Block::Paragraph(vec![Inline::Image {
                url: url("a.png"),
                alt: "甲".into(),
            }]),
            Block::Paragraph(vec![Inline::Image {
                url: url("b.png"),
                alt: "乙".into(),
            }]),
        ]);
        let parts = render_to_strings_with(ws.path(), &doc);
        let rels = &parts["word/_rels/document.xml.rels"];
        assert!(rels.contains("Id=\"rId2\""), "{rels}");
        assert!(rels.contains("Id=\"rId3\""), "{rels}");
        let document = &parts["word/document.xml"];
        assert!(document.contains("r:embed=\"rId2\""), "{document}");
        assert!(document.contains("r:embed=\"rId3\""), "{document}");
        // 样式关系仍占 rId1
        assert!(rels.contains("Id=\"rId1\""), "{rels}");
        assert!(rels.contains("Target=\"styles.xml\""), "{rels}");
    }

    #[test]
    fn same_extension_is_declared_only_once() {
        let ws = workspace(&[("a.png", 3, 2), ("b.png", 4, 4)]);
        let doc = doc_with(vec![Block::Paragraph(vec![
            Inline::Image {
                url: url("a.png"),
                alt: "甲".into(),
            },
            Inline::Image {
                url: url("b.png"),
                alt: "乙".into(),
            },
        ])]);
        let parts = render_to_strings_with(ws.path(), &doc);
        let types = &parts["[Content_Types].xml"];
        assert_eq!(
            types.matches("Default Extension=\"png\"").count(),
            1,
            "{types}"
        );
    }

    #[test]
    fn oversized_image_is_scaled_to_the_text_width() {
        let ws = workspace(&[("wide.png", 2000, 1000)]);
        let doc = doc_image(&url("wide.png"), "横幅");
        let parts = render_to_strings_with(ws.path(), &doc);
        let document = &parts["word/document.xml"];
        // 2000px 的原始宽远超版心，必须顶到上限且保持 2:1 比例
        assert!(
            document.contains(&format!(
                "cx=\"{MAX_WIDTH_EMU}\" cy=\"{}\"",
                MAX_WIDTH_EMU / 2
            )),
            "{document}"
        );
    }

    #[test]
    fn image_without_a_sniffable_size_degrades_to_alt_text() {
        // 头合法但宽高都是 0 —— 猜一个尺寸会让 Word 里的图变形，宁可降级
        let ws = workspace(&[("zero.png", 0, 0)]);
        let doc = doc_image(&url("zero.png"), "没尺寸");
        let parts = render_to_strings_with(ws.path(), &doc);
        let document = &parts["word/document.xml"];
        assert!(document.contains("［图片：没尺寸］"), "{document}");
        assert!(!document.contains("<w:drawing>"), "{document}");
    }

    #[test]
    fn unreadable_image_degrades_to_alt_text_and_adds_no_part() {
        let ws = workspace(&[("a.png", 3, 2)]);
        let doc = doc_image("manuscript/ch.assets/gone.png", "丢了的图");
        let bytes = renderer_for(ws.path()).render(&doc).unwrap();
        let parts = unzip_bytes(&bytes);
        assert!(
            !parts.keys().any(|n| n.starts_with("word/media/")),
            "缺图不该产出 media 条目：{:?}",
            parts.keys()
        );
        let document = &unzip(&bytes)["word/document.xml"];
        assert!(document.contains("［图片：丢了的图］"), "{document}");
        // 关系表与内容类型里也不该留下悬空引用
        let rels = String::from_utf8(parts["word/_rels/document.xml.rels"].clone()).unwrap();
        assert!(!rels.contains("image"), "{rels}");
        let types = String::from_utf8(parts["[Content_Types].xml"].clone()).unwrap();
        assert!(!types.contains("Extension=\"png\""), "{types}");
    }

    #[test]
    fn no_resolver_means_no_disk_access() {
        let doc = doc_image(&url("a.png"), "图");
        let parts = unzip(&DocxRenderer::default().render(&doc).unwrap());
        assert!(
            parts.keys().all(|n| !n.starts_with("word/media/")),
            "{:?}",
            parts.keys()
        );
        assert!(parts["word/document.xml"].contains("［图片：图］"));
    }

    #[test]
    fn relationship_target_is_relative_to_word_dir() {
        // 关系路径以「所在部件的目录」为基准：写 media/xxx 而不是 word/media/xxx，
        // 写错的表现为 Word 打开后图片位置空白且不报错，极难排查
        let ws = workspace(&[("a.png", 3, 2)]);
        let doc = doc_image(&url("a.png"), "插图");
        let parts = render_to_strings_with(ws.path(), &doc);
        let rels = &parts["word/_rels/document.xml.rels"];
        assert!(rels.contains("Target=\"media/image-1.png\""), "{rels}");
        assert!(!rels.contains("word/media"), "{rels}");
    }
}
