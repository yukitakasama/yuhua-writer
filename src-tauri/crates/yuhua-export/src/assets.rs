//! 图片资源：把正文里的相对路径解析成字节，供 EPUB / DOCX 打包内嵌。
//!
//! ## 为什么导出引擎要自己读文件
//!
//! `yuhua-export` 刻意不依赖 `yuhua-fs`（纯计算层不该被文件系统层的
//! 演进牵动，见 `render/mod.rs` 里原子写也是自己实现的一份）。
//! 但图片字节确实在磁盘上，渲染器不读就永远嵌不进去。
//!
//! 折中办法：这里只做**「给定工作区根，安全地读一个文件」**这一件事，
//! 不引入目录布局、卷章模型等任何 `yuhua-fs` 的知识。
//!
//! ## 路径安全
//!
//! 正文里的图片路径来自用户手写的 Markdown，`![x](../../Windows/x)` 这种
//! 完全写得出来。所以解析必须钉死在根目录内 —— 越界一律当作「读不到」，
//! 让渲染器退回降级路径，而不是把用户没打算导出的文件打进包里。
//! 这是 Zip Slip 的**读取侧**镜像：那边是解包不许越界，这边是打包不许越界。
//!
//! ## 读不到不是错误
//!
//! 图片缺失（作者删了图、云盘还没同步下来）不该让整个导出失败。
//! 因此 [`AssetResolver::load`] 返回 `Option`，渲染器拿 `None` 时
//! 退回原有的降级表现（EPUB 保留原始 src、DOCX 输出「［图片：alt］」），
//! 并且**不**为它生成 manifest 条目。

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use crate::ir::{Block, Inline};

/// 一张已读出的图片。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    /// 文件字节。
    pub bytes: Vec<u8>,
    /// MIME 类型，如 `image/png`。
    pub mime: &'static str,
    /// 小写扩展名，不含点，如 `png`。
    pub extension: String,
    /// 像素宽。嗅探不出来时为 0。
    pub width: u32,
    /// 像素高。嗅探不出来时为 0。
    pub height: u32,
}

impl Asset {
    /// 是否有可用的尺寸信息（DOCX 排版需要）。
    pub fn has_size(&self) -> bool {
        self.width > 0 && self.height > 0
    }
}

/// 按工作区根解析图片相对路径。
#[derive(Debug, Clone)]
pub struct AssetResolver {
    root: PathBuf,
}

impl AssetResolver {
    /// 以工作区根构造。
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// 工作区根。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 把正文里的 URL 解析成工作区内的绝对路径。
    ///
    /// 拒绝：绝对路径、带盘符的路径、含 `..` 的路径、URL 查询与片段。
    /// 这里**不**用 `canonicalize`：它要求文件已存在，且在 Windows 上会
    /// 把路径改写成 `\\?\` 前缀形式，反而让前缀比对更容易出错。
    /// 我们只需要「逻辑上是否越界」，自己做词法检查足够。
    pub fn resolve(&self, url: &str) -> Option<PathBuf> {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return None;
        }
        // 外链与内联 data URI 都不该去磁盘上读
        let scheme_hit = trimmed.find(":");
        if let Some(colon) = scheme_hit {
            // 只有形如 `C:` 的单字母前缀才是 Windows 绝对路径；
            // 而那种路径本来也在下面被 `is_absolute` 拦掉。
            // 其余的 `http:` / `data:` / `mailto:` 一律视为非本地资源。
            if colon > 0 {
                return None;
            }
        }
        let without_tail = trimmed
            .split_once('#')
            .map_or(trimmed, |(head, _)| head)
            .split_once('?')
            .map_or(trimmed, |(head, _)| head);

        let relative = Path::new(without_tail);
        if relative.is_absolute() || without_tail.starts_with('/') {
            return None;
        }
        for part in relative.components() {
            match part {
                // `..` 一律拒绝；`.` 与正常段名归一化后再查一次越界
                Component::ParentDir => return None,
                Component::CurDir | Component::Normal(_) => {}
                // 盘符与根目录：`is_absolute` 之后仍可能出现（如 `\a\b`）
                Component::Prefix(_) | Component::RootDir => return None,
            }
        }
        let joined = self.root.join(relative);
        // 拼接后再做一次词法越界检查：`a/../..` 这类会绕过逐段判断
        let normalized = collapse_dot_dirs(&joined)?;
        let root_normalized = collapse_dot_dirs(&self.root)?;
        if normalized.starts_with(&root_normalized) {
            Some(normalized)
        } else {
            None
        }
    }

    /// 读取并识别一张图片。读不到 / 不是支持的图片格式时返回 `None`。
    pub fn load(&self, url: &str) -> Option<Asset> {
        let path = self.resolve(url)?;
        let bytes = std::fs::read(&path).ok()?;
        let mime = sniff_image_mime(&bytes)?;
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| extension_for(mime).to_string());
        let (width, height) = sniff_image_size(&bytes);
        Some(Asset {
            bytes,
            mime,
            extension,
            width,
            height,
        })
    }
}

/// 把路径里的 `.` 与 `..` 在**词法上**折叠掉（不要求文件存在）。
///
/// 返回 `None` 表示 `..` 冲出了起点，即越界。
fn collapse_dot_dirs(path: &Path) -> Option<PathBuf> {
    let mut out = Vec::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                // 只能弹掉一个 Normal 段；弹到空就说明越界了
                match out.last() {
                    Some(Component::Normal(_)) => {
                        out.pop();
                    }
                    _ => return None,
                }
            }
            other => out.push(other),
        }
    }
    Some(out.iter().collect())
}

/// 嗅探图片真实格式（看魔数，不看扩展名）。
///
/// 为什么不信扩展名：作者完全可能把 JPEG 命名成 `.png`，
/// 而 EPUB 的 `media-type` 与 DOCX 的 `ContentType` 必须与**实际字节**
/// 一致，否则阅读器会解不出来。
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    None
}

/// 该 MIME 的规范扩展名（用于包内文件名）。
pub fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "bin",
    }
}

/// 嗅探像素尺寸。嗅不出时返回 `(0, 0)`，调用方按「不知道尺寸」处理。
///
/// 手写而不是引 `image` crate：只需要四种格式的头信息，
/// 而 `image` 会拖进一批解码器（本 crate 是纯计算层，编译时间也算成本）。
pub fn sniff_image_size(bytes: &[u8]) -> (u32, u32) {
    match sniff_image_mime(bytes) {
        Some("image/png") => png_size(bytes),
        Some("image/jpeg") => jpeg_size(bytes),
        Some("image/gif") => gif_size(bytes),
        Some("image/webp") => webp_size(bytes),
        Some("image/bmp") => bmp_size(bytes),
        _ => (0, 0),
    }
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    let slice = b.get(at..at + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn be16(b: &[u8], at: usize) -> Option<u32> {
    let slice = b.get(at..at + 2)?;
    Some(u32::from(u16::from_be_bytes([slice[0], slice[1]])))
}

fn le16(b: &[u8], at: usize) -> Option<u32> {
    let slice = b.get(at..at + 2)?;
    Some(u32::from(u16::from_le_bytes([slice[0], slice[1]])))
}

fn le32(b: &[u8], at: usize) -> Option<u32> {
    let slice = b.get(at..at + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// PNG：签名 8 字节 + 长度 4 + `IHDR` 4，之后是宽 4 + 高 4（大端）。
fn png_size(b: &[u8]) -> (u32, u32) {
    if b.len() < 24 || &b[12..16] != b"IHDR" {
        return (0, 0);
    }
    match (be32(b, 16), be32(b, 20)) {
        (Some(w), Some(h)) => (w, h),
        _ => (0, 0),
    }
}

/// GIF：逻辑屏描述符在头 6 字节之后，宽与高各 2 字节小端。
fn gif_size(b: &[u8]) -> (u32, u32) {
    match (le16(b, 6), le16(b, 8)) {
        (Some(w), Some(h)) => (w, h),
        _ => (0, 0),
    }
}

/// BMP：DIB 头里宽在偏移 18、高在 22（小端）。
///
/// 高度在规范里是**有符号**的（负数表示自上而下的行序），这里按无符号读出后
/// 清掉符号位 —— 只关心像素数量，不关心行序。
fn bmp_size(b: &[u8]) -> (u32, u32) {
    match (le32(b, 18), le32(b, 22)) {
        (Some(w), Some(h)) => (w, h & 0x7FFF_FFFF),
        _ => (0, 0),
    }
}

/// JPEG：扫段头找 SOF0..SOF15（跳过 DHT/DAC 等），
/// 段内 2 字节长度 + 1 字节精度 + 2 字节高 + 2 字节宽（大端）。
fn jpeg_size(b: &[u8]) -> (u32, u32) {
    let mut at = 2usize; // 跳过 SOI
    while at + 4 <= b.len() {
        if b[at] != 0xFF {
            at += 1;
            continue;
        }
        let marker = b[at + 1];
        // 0xFF 填充字节会连续出现
        if marker == 0xFF {
            at += 1;
            continue;
        }
        // RST0..RST7、SOI、EOI 不带长度字段
        if (0xD0..=0xD9).contains(&marker) || marker == 0x01 {
            at += 2;
            continue;
        }
        let Some(len) = be16(b, at + 2) else {
            return (0, 0);
        };
        let len = len as usize;
        if len < 2 {
            return (0, 0);
        }
        // SOF1/2/3 与 SOF5..7/9/10/11/13/14/15 都是帧头，布局一致
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            // 段体起点 = 长度字段之后；精度 1 字节，高 2，宽 2
            let body = at + 4;
            return match (be16(b, body + 1), be16(b, body + 3)) {
                (Some(h), Some(w)) => (w, h),
                _ => (0, 0),
            };
        }
        at += 2 + len;
    }
    (0, 0)
}

/// WebP：三种容器布局（VP8 / VP8L / VP8X）尺寸编码各不相同，
/// 这里覆盖常见的有损与无损两种，认不出就交回 `(0,0)`。
fn webp_size(b: &[u8]) -> (u32, u32) {
    if b.len() < 16 {
        return (0, 0);
    }
    match &b[12..16] {
        // 有损：帧头在 "VP8 " 之后第 26、28 字节（各 14 位，小端）
        b"VP8 " => {
            let w = le16(b, 26).map(|v| v & 0x3FFF);
            let h = le16(b, 28).map(|v| v & 0x3FFF);
            match (w, h) {
                (Some(w), Some(h)) => (w, h),
                _ => (0, 0),
            }
        }
        // 无损：签名 0x2F 之后是 14 位宽-1 / 14 位高-1
        b"VP8L" => match le32(b, 21) {
            Some(bits) => ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1),
            None => (0, 0),
        },
        // 扩展：24 位宽-1 / 高-1，小端三字节
        b"VP8X" => {
            if b.len() < 30 {
                return (0, 0);
            }
            let w = b[24] as u32 | (b[25] as u32) << 8 | (b[26] as u32) << 16;
            let h = b[27] as u32 | (b[28] as u32) << 8 | (b[29] as u32) << 16;
            (w + 1, h + 1)
        }
        _ => (0, 0),
    }
}

/// 一次导出里被内嵌的图片集合（去重 + 分配包内文件名）。
///
/// ## 为什么要去重
///
/// 同一张图常被多章引用（章节题图、反复出现的插图）。不去重的话
/// 一张 2 MB 的图会被复制几十份，EPUB 体积直接失控。
///
/// ## 为什么要先收集再生成
///
/// manifest（EPUB）与关系表（DOCX）必须列出**所有**被引用的图片，
/// 而引用散落在各章正文里。所以渲染流程是两遍：
/// 先扫一遍建表，再产出正文（用表里分配好的包内名）与清单。
#[derive(Debug, Default)]
pub struct ImageTable {
    entries: Vec<TableEntry>,
    /// 原始 URL（归一化后）→ `entries` 下标
    by_url: HashMap<String, usize>,
}

/// 表里的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableEntry {
    /// 图片本体。
    pub asset: Asset,
    /// 包内**文件名**，如 `image-1.png`。
    ///
    /// 只存文件名而不带目录：EPUB 把图片放在 `OEBPS/images/`，
    /// DOCX 放在 `word/media/`，两边各接自己的前缀。
    pub file_name: String,
}

impl ImageTable {
    /// 空表。
    pub fn new() -> Self {
        Self::default()
    }

    /// 是否一张图都没有。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 已登记的全部图片（按登记顺序，即首次出现顺序）。
    pub fn entries(&self) -> &[TableEntry] {
        &self.entries
    }

    /// 登记一张图，返回它在包内的**文件名**；读不到时返回 `None`。
    ///
    /// 同一路径第二次登记时直接复用已有条目（含已分配的文件名），
    /// 因此调用方可以无脑对每个 `Inline::Image` 调一次。
    pub fn register(&mut self, resolver: &AssetResolver, url: &str) -> Option<&str> {
        let key = normalize_url_key(url);
        if let Some(index) = self.by_url.get(&key) {
            return Some(&self.entries[*index].file_name);
        }
        let asset = resolver.load(url)?;
        let index = self.entries.len() + 1;
        // 扩展名取**嗅探结果**而不是原文件名：包内名与 media-type
        // 必须一致，而原文件名完全可能是错的
        let file_name = format!("image-{}.{}", index, extension_for(asset.mime));
        self.entries.push(TableEntry { asset, file_name });
        self.by_url.insert(key, self.entries.len() - 1);
        Some(&self.entries[self.entries.len() - 1].file_name)
    }

    /// 查已登记的图片（不新登记）。
    pub fn lookup(&self, url: &str) -> Option<&TableEntry> {
        self.by_url
            .get(&normalize_url_key(url))
            .map(|i| &self.entries[*i])
    }

    /// 某张图在表里的序号（0 基）。
    ///
    /// DOCX 的关系 ID 与 `docPr id` 都要「一图一号」，而编号就是登记顺序，
    /// 所以除了内容还得知道排位。
    pub fn index_of(&self, url: &str) -> Option<usize> {
        self.by_url.get(&normalize_url_key(url)).copied()
    }

    /// 扫过一段块序列，把其中**能读到**的图片全部登记（递归进引用与列表）。
    ///
    /// EPUB 与 DOCX 用的是同一套「先建表、再产出」的两遍流程，
    /// 遍历逻辑放在这里只写一遍：渲染器各自的降级规则不同，
    /// 但「哪些行内位置可能出现图片」这件事必须一致，
    /// 否则一种格式嵌了、另一种漏了，就是内容丢失。
    pub fn gather(&mut self, blocks: &[Block], resolver: &AssetResolver) {
        for block in blocks {
            self.gather_block(block, resolver);
        }
    }

    /// 单个块的图片收集。
    fn gather_block(&mut self, block: &Block, resolver: &AssetResolver) {
        match block {
            Block::Paragraph(inlines) => self.gather_inlines(inlines, resolver),
            Block::Quote(children) => self.gather(children, resolver),
            Block::List { items, .. } => {
                for item in items {
                    self.gather(item, resolver);
                }
            }
            // 标题 / 代码 / 分隔线 / 分页不含行内图片
            _ => {}
        }
    }

    /// 一段行内序列的图片收集（递归强调、粗体与链接里的图片）。
    fn gather_inlines(&mut self, inlines: &[Inline], resolver: &AssetResolver) {
        for inline in inlines {
            match inline {
                Inline::Image { url, .. } => {
                    self.register(resolver, url);
                }
                Inline::Emph(children) | Inline::Strong(children) => {
                    self.gather_inlines(children, resolver);
                }
                Inline::Link { text, .. } => self.gather_inlines(text, resolver),
                Inline::Text(_) | Inline::Code(_) => {}
            }
        }
    }
}

/// 去重键：统一分隔符并去掉 `./` 前缀，让 `./a.png` 与 `a.png` 命中同一项。
fn normalize_url_key(url: &str) -> String {
    let slashed = url.trim().replace('\\', "/");
    slashed.strip_prefix("./").unwrap_or(&slashed).to_string()
}

/// 各渲染器共用的图片测试夹具。
///
/// EPUB 与 DOCX 都要「一个真有图片文件的工作区 + 一张能嗅出尺寸的 PNG」，
/// 而伪造的 PNG 头必须与 `sniff_image_size` 的解析方式严格对齐 —— 这种
/// 细节写两遍必然有一天只改一处，于是尺寸测试在一个格式里假绿。
#[cfg(test)]
pub(crate) mod testing {
    /// 测试工作区里放图片的相对目录。
    pub(crate) const DIR: &str = "manuscript/ch.assets";

    /// 一张头信息合法、尺寸可指定的 PNG（数据段是假的，嗅探器只看头）。
    pub(crate) fn png(width: u32, height: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&[0x00, 0x00, 0x00, 0x0D]);
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&width.to_be_bytes());
        v.extend_from_slice(&height.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]);
        v.extend_from_slice(&[0x1F, 0x4D, 0xA2, 0x0D]); // 假 CRC，嗅探不校验
        v.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        v.extend_from_slice(b"IEND");
        v.extend_from_slice(&[0xAE, 0x42, 0x60, 0x82]);
        v
    }

    /// 建一个临时工作区，按 `(文件名, 宽, 高)` 写入若干 PNG。
    ///
    /// 返回值必须活到断言结束（`TempDir` 一 drop 目录就没了）。
    pub(crate) fn workspace(images: &[(&str, u32, u32)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join(DIR);
        std::fs::create_dir_all(&assets).unwrap();
        for (name, width, height) in images {
            std::fs::write(assets.join(name), png(*width, *height)).unwrap();
        }
        dir
    }

    /// 正文里引用夹具图片时用的相对 URL。
    pub(crate) fn url(name: &str) -> String {
        format!("{DIR}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一张 1x1 的合法 PNG。
    fn png_bytes() -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&[0x00, 0x00, 0x00, 0x0D]);
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&1u32.to_be_bytes());
        v.extend_from_slice(&1u32.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]);
        v.extend_from_slice(&[0x1F, 0x4D, 0xA2, 0x0D]); // 假 CRC，嗅探不校验
        v.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        v.extend_from_slice(b"IEND");
        v.extend_from_slice(&[0xAE, 0x42, 0x60, 0x82]);
        v
    }

    fn workspace_with_image() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("manuscript").join("ch.assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("a.png"), png_bytes()).unwrap();
        // 一个扩展名骗人的文件：内容是 PNG 却叫 .jpg
        std::fs::write(assets.join("trader.jpg"), png_bytes()).unwrap();
        dir
    }

    #[test]
    fn resolves_relative_paths_inside_workspace() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        let p = r
            .resolve("manuscript/ch.assets/a.png")
            .expect("相对路径应可解析");
        assert!(p.starts_with(dir.path()));
    }

    #[test]
    fn rejects_parent_dir_escape() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        assert_eq!(r.resolve("../../etc/passwd"), None);
        assert_eq!(r.resolve("a/../../b/../../c"), None);
        assert_eq!(r.resolve("manuscript/../../outside.png"), None);
    }

    #[test]
    fn rejects_absolute_and_remote_urls() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        assert_eq!(r.resolve("/etc/passwd"), None);
        assert_eq!(r.resolve("https://example.com/a.png"), None);
        assert_eq!(r.resolve("data:image/png;base64,AAAA"), None);
        assert_eq!(r.resolve(""), None);
    }

    #[test]
    fn accepts_cur_dir_prefix() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        assert!(r.resolve("./manuscript/ch.assets/a.png").is_some());
    }

    #[test]
    fn loads_image_and_sniffs_size() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        let asset = r.load("manuscript/ch.assets/a.png").unwrap();
        assert_eq!(asset.mime, "image/png");
        assert_eq!((asset.width, asset.height), (1, 1));
        assert!(asset.has_size());
    }

    #[test]
    fn missing_file_is_none_not_error() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        assert!(r.load("manuscript/ch.assets/gone.png").is_none());
    }

    #[test]
    fn non_image_file_is_rejected() {
        let dir = workspace_with_image();
        std::fs::write(dir.path().join("note.txt"), b"just text").unwrap();
        let r = AssetResolver::new(dir.path());
        assert!(r.load("note.txt").is_none());
    }

    #[test]
    fn mime_comes_from_bytes_not_extension() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        let asset = r.load("manuscript/ch.assets/trader.jpg").unwrap();
        // 文件名叫 .jpg，但字节是 PNG —— media-type 必须跟字节走
        assert_eq!(asset.mime, "image/png");
    }

    #[test]
    fn table_deduplicates_same_url() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        let mut t = ImageTable::new();
        let first = t
            .register(&r, "manuscript/ch.assets/a.png")
            .unwrap()
            .to_string();
        let again = t
            .register(&r, "./manuscript/ch.assets/a.png")
            .unwrap()
            .to_string();
        assert_eq!(first, again, "同一张图应复用同一个包内名");
        assert_eq!(t.entries().len(), 1);
    }

    #[test]
    fn table_assigns_stable_package_names() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        let mut t = ImageTable::new();
        // 扩展名由嗅探结果决定，与源文件名无关
        let name = t.register(&r, "manuscript/ch.assets/a.png").unwrap();
        assert_eq!(name, "image-1.png");
        assert!(!t.is_empty());
    }

    #[test]
    fn table_skips_unreadable_without_breaking_numbering() {
        let dir = workspace_with_image();
        let r = AssetResolver::new(dir.path());
        let mut t = ImageTable::new();
        assert!(t.register(&r, "manuscript/ch.assets/gone.png").is_none());
        let name = t.register(&r, "manuscript/ch.assets/a.png").unwrap();
        // 读不到的图不占编号，包内名从 1 开始连续
        assert_eq!(name, "image-1.png");
        assert_eq!(t.entries().len(), 1);
    }

    #[test]
    fn png_size_sniffer() {
        assert_eq!(sniff_image_size(&png_bytes()), (1, 1));
    }

    #[test]
    fn gif_size_sniffer() {
        let mut b = b"GIF89a".to_vec();
        b.extend_from_slice(&[10, 0, 20, 0, 0]);
        assert_eq!(sniff_image_size(&b), (10, 20));
    }

    #[test]
    fn jpeg_size_sniffer_reads_sof_segment() {
        let mut b = vec![0xFF, 0xD8]; // SOI
        b.extend_from_slice(&[0xFF, 0xC0]); // SOF0
        b.extend_from_slice(&[0x00, 0x11]); // 段长 17
        b.push(8); // 精度
        b.extend_from_slice(&[0x00, 0x64]); // 高 100
        b.extend_from_slice(&[0x00, 0x32]); // 宽 50
        b.extend_from_slice(&[0x03, 0x01, 0x11]);
        assert_eq!(sniff_image_size(&b), (50, 100));
    }

    #[test]
    fn unknown_bytes_have_no_size() {
        assert_eq!(sniff_image_size(b"not an image"), (0, 0));
        assert_eq!(sniff_image_mime(b"nope"), None);
    }

    #[test]
    fn dot_folding_leaves_prefix_untouched() {
        // collapse_dot_dirs 是纯词法折叠，它**不知道**哪里是起点，
        // 所以 `/ws/a/../..` 会被折成根而不是报错 —— 越界的判定
        // 由 resolve 的「折叠结果必须以 root 开头」那一步负责
        // （见 rejects_parent_dir_escape）。这里只验证折叠本身。
        let root = Path::new("/ws");
        assert_eq!(
            collapse_dot_dirs(&root.join("a/./b")),
            Some(PathBuf::from("/ws/a/b"))
        );
        assert_eq!(
            collapse_dot_dirs(&root.join("a/b/../c")),
            Some(PathBuf::from("/ws/a/c"))
        );
        // 折到根以外就再也加不回 root 之下，resolve 因此会拒绝
        let escaped = collapse_dot_dirs(&root.join("a/../..")).unwrap();
        assert!(!escaped.starts_with(root));
    }
}
