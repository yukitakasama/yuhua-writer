//! 字体发现与最小 TrueType 解析。
//!
//! ## 为什么这里要自己解析 TrueType
//!
//! PDF 要内嵌中文字体并做到「可搜索、可复制」（P10），唯一正确的做法是
//! **CID 字体（Type0 / Identity-H）+ ToUnicode CMap**：内容流里写的是**字形
//! 编号（GID）**而不是 Unicode，再靠 ToUnicode 把 GID 映射回码点，阅读器
//! 才能选中文字、搜索关键词。要把 Unicode 变成 GID，就必须解析字体的
//! cmap 表；要算中文按字号的宽度，就必须解析 hmtx。
//!
//! 任务书允许引入 ttf-parser，但前提是「本地 cargo registry 缓存里能离线
//! 拿到」。实际核对的结果是：本机 registry 里只有 fontdb（它把
//! ttf-parser 作为依赖），而 **ttf-parser 本身并不在缓存里**。加依赖会让
//! 构建必须联网，违反「优先纯 Rust、可离线构建」的前提。
//!
//! 所以这里手写一个**只读、越界即失败**的最小解析器。它要读的表恰好六个：
//!
//! | 表 | 用途 | 为什么必须要 |
//! | --- | --- | --- |
//! | head | unitsPerEm、indexToLocFormat | 字号换算的基准 |
//! | hhea | numberOfHMetrics | 决定 hmtx 每项是 4 字节还是 2 字节 |
//! | hmtx | advanceWidth | 中文按字号算宽度的唯一来源 |
//! | cmap | Unicode → GID | Identity-H 编码的前半段 |
//! | maxp | numGlyphs | 校验 GID 不越界（越界会让阅读器直接崩） |
//! | glyf | 存在性 | 区分 TrueType 轮廓与 CFF/OTF |
//!
//! **不做子集化**。理由写在 crate::render::pdf 的模块文档里：子集化是
//! 一个体积优化，而「嵌错字体导致整本书乱码」是正确性事故。第一版宁可
//! 让 PDF 大 20 MB，也要保证任何一段文本都能正确显示。
//!
//! ## 为什么全程用「越界即返回 None」而不是索引 panic
//!
//! 字体文件来自用户磁盘（可能是第三方字体、可能被截断、可能是伪装成 ttf
//! 的别的文件）。任何一处 data[i] 都有可能 panic，而渲染器 panic 会让
//! 整个导出流程炸掉、连错误码都拿不到。因此这里所有读取都走
//! be_u16 / read 这类**返回 Option** 的辅助函数，一路传播到
//! TrueTypeFont::parse 的 Result。这是「宁可报错也不崩」在字节层面的落实。

use std::path::{Path, PathBuf};

use crate::error::{ExportError, Result};

/// 字体探针字节数。
///
/// 只需要读到表目录（12 字节头 + 每张表 16 字节 × 若干）就够决定
/// 「这个文件能不能用」。16 KB 足够覆盖表数上百的字体，
/// 而按 32 MB 去读一遍宋体是纯浪费 —— 导出时每台机器上都可能扫几十个候选。
const PROBE_BYTES: usize = 16 * 1024;

/// 一份已解析的 TrueType 字体。
///
/// 持有**整份字体字节**而不是 &[u8]：渲染器一边遍历章节一边可能需要在
/// 任意时刻查字形，生命周期绑到外部 buffer 会让调用点到处加泛型参数；
/// 字体本身只有几 MB，独占一份是划算的取舍。
///
/// 结构体里存的是**偏移量**而不是解析好的数组：hmtx 有三万个字形，
/// 全部展开成 Vec<u16> 要 60 KB 内存和一次 O(n) 拷贝，
/// 而我们真正查宽度的字形只有正文用到的那几千个。
#[derive(Debug, Clone)]
pub struct TrueTypeFont {
    /// 字体文件绝对路径（错误信息与日志要用）。
    path: PathBuf,
    /// 整份字体字节，PDF 的 FontFile2 直接把它写进去。
    data: Vec<u8>,
    /// 字形单位/em。1000 或 2048 最常见。
    units_per_em: u16,
    /// 字形总数。校验 GID 越界用。
    num_glyphs: u16,
    /// 长水平度量（hmtx 里 4 字节项）的项数。
    number_of_h_metrics: u16,
    /// hmtx 表在 data 中的起始偏移。
    hmtx_offset: usize,
    /// hmtx 表长度。
    hmtx_length: usize,
    /// cmap 各子表的索引信息。
    cmap_subtables: Vec<CmapSubtable>,
    /// cmap 表在 data 中的起始偏移。
    cmap_offset: usize,
    /// 来自 name 表的字体名（仅用于诊断与 PDF 的 /BaseFont）。
    postscript_name: Option<String>,
}

/// 一条 cmap 子表的索引信息。
#[derive(Debug, Clone, Copy)]
struct CmapSubtable {
    /// 平台 ID（3 = Windows，0 = Unicode，1 = Macintosh）。
    platform_id: u16,
    /// 编码 ID（Windows 上 1 = BMP，10 = 完整 Unicode）。
    encoding_id: u16,
    /// 子表数据相对 cmap 表头的偏移。
    offset: u32,
    /// 子表格式（4 / 12 是我们要的）。
    format: u16,
}

impl TrueTypeFont {
    /// 从字节解析一份字体。path 只用于错误信息。
    pub fn parse(path: impl Into<PathBuf>, data: Vec<u8>) -> Result<Self> {
        let path = path.into();
        let corrupt = |detail: &str| ExportError::Font {
            path: path.display().to_string(),
            detail: detail.to_string(),
        };

        // 表目录：4 字节 sfnt 版本 + 2 字节表数 + 6 字节搜索参数 = 12 字节
        let num_tables = be_u16(&data, 4).ok_or_else(|| corrupt("文件太短，读不到表目录"))?;
        let mut tables: Vec<(u32, u32, u32)> = Vec::with_capacity(num_tables as usize);
        for index in 0..num_tables as usize {
            let entry = 12 + index * 16;
            let tag = read(&data, entry, 4).ok_or_else(|| corrupt("表目录被截断"))?;
            let offset = be_u32(&data, entry + 8).ok_or_else(|| corrupt("表目录被截断"))?;
            let length = be_u32(&data, entry + 12).ok_or_else(|| corrupt("表目录被截断"))?;
            tables.push((
                u32::from_be_bytes([tag[0], tag[1], tag[2], tag[3]]),
                offset,
                length,
            ));
        }

        let find = |wanted: &[u8; 4]| -> Option<(usize, usize)> {
            let tag = u32::from_be_bytes(*wanted);
            tables
                .iter()
                .find(|(t, _, _)| *t == tag)
                .map(|(_, offset, length)| (*offset as usize, *length as usize))
        };

        // 缺 hmtx 的字体无法排版（算不出任何字宽），直接判不可用。
        // CFF/OTF 只带 CFF 轮廓，PDF 里必须用 CIDFontType0 与 FontFile3，
        // 那是另一套完全不同的对象结构；先按 glyf 表的存在性判出来。
        let (hmtx_offset, hmtx_length) =
            find(b"hmtx").ok_or_else(|| corrupt("缺少 hmtx 表（无法计算字宽）"))?;
        if find(b"glyf").is_none() {
            return Err(corrupt(
                "不是 TrueType 轮廓字体（缺少 glyf 表，可能是 CFF/OTF）",
            ));
        }

        let (head_offset, head_length) = find(b"head").ok_or_else(|| corrupt("缺少 head 表"))?;
        if head_length < 54 {
            return Err(corrupt("head 表长度异常"));
        }
        let units_per_em =
            be_u16(&data, head_offset + 18).ok_or_else(|| corrupt("head 表被截断"))?;
        if units_per_em == 0 {
            return Err(corrupt("head 表里的 unitsPerEm 为 0"));
        }

        let (hhea_offset, _) = find(b"hhea").ok_or_else(|| corrupt("缺少 hhea 表"))?;
        let number_of_h_metrics =
            be_u16(&data, hhea_offset + 34).ok_or_else(|| corrupt("hhea 表被截断"))?;

        let (maxp_offset, _) = find(b"maxp").ok_or_else(|| corrupt("缺少 maxp 表"))?;
        let num_glyphs = be_u16(&data, maxp_offset + 4).ok_or_else(|| corrupt("maxp 表被截断"))?;

        let (cmap_offset, _) = find(b"cmap").ok_or_else(|| corrupt("缺少 cmap 表"))?;
        let cmap_subtables =
            parse_cmap_directory(&data, cmap_offset).ok_or_else(|| corrupt("cmap 表目录损坏"))?;
        if cmap_subtables.is_empty() {
            return Err(corrupt("cmap 里没有任何可用子表"));
        }

        let postscript_name = find(b"name").and_then(|(offset, _)| read_name(&data, offset));

        Ok(Self {
            path,
            data,
            units_per_em,
            num_glyphs,
            number_of_h_metrics,
            hmtx_offset,
            hmtx_length,
            cmap_subtables,
            cmap_offset,
            postscript_name,
        })
    }

    /// 从磁盘读取并解析。
    ///
    /// 先用 PROBE_BYTES 做一次廉价预检，确认「这是 TrueType 而不是 CFF/OTF」
    /// 之后才整份读进来。系统字体目录里躺着大量 .ttf 后缀却是 CFF 轮廓的
    /// 文件，如果每个都整份读一遍再拒绝，导出前的字体搜索会白白多花上百毫秒。
    pub fn load(path: &Path) -> Result<Self> {
        use std::io::{Read as _, Seek as _};

        let mut file = std::fs::File::open(path).map_err(|e| ExportError::io(path, e))?;
        let mut probe = vec![0u8; PROBE_BYTES];
        let mut filled = 0usize;
        // 短文件（小于探针长度）不算错误：读多少算多少。
        while filled < probe.len() {
            match file.read(&mut probe[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => return Err(ExportError::io(path, e)),
            }
        }
        probe.truncate(filled);
        if !looks_like_truetype(&probe) {
            return Err(ExportError::Font {
                path: path.display().to_string(),
                detail: "缺少 glyf 表（可能是 CFF/OTF 字体，不支持）".to_string(),
            });
        }

        file.rewind().map_err(|e| ExportError::io(path, e))?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .map_err(|e| ExportError::io(path, e))?;
        Self::parse(path, data)
    }

    /// 字体文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 字体名（name 表的 PostScript 名），没有就返回 None。
    pub fn postscript_name(&self) -> Option<&str> {
        self.postscript_name.as_deref()
    }

    /// 整份字体字节，直接写进 PDF 的 FontFile2。
    pub fn data(&self) -> &[u8] {
        &self.data
    }

    /// 字形单位/em。
    pub fn units_per_em(&self) -> u16 {
        self.units_per_em
    }

    /// 字形总数。
    pub fn num_glyphs(&self) -> u16 {
        self.num_glyphs
    }

    /// 字节数（供渲染器做体积提示）。
    pub fn byte_len(&self) -> usize {
        self.data.len()
    }

    /// Unicode 码点 → 字形编号。
    ///
    /// 优先用 Windows 平台的 Unicode 子表（3/10 完整 Unicode 优先于 3/1 BMP），
    /// 退到 0 号平台的 Unicode 子表，最后才试 Macintosh。
    /// 这个优先级是有实践依据的：部分中文字体同时带 3/1 与 3/10 子表，
    /// 前者在增补平面字符上给出的是错误的映射。
    pub fn glyph_id(&self, ch: char) -> Option<u16> {
        let codepoint = ch as u32;
        let mut candidates: Vec<CmapSubtable> = self.cmap_subtables.clone();
        candidates.sort_by_key(|sub| match (sub.platform_id, sub.encoding_id) {
            (3, 10) => 0,
            (0, _) => 1,
            (3, 1) => 2,
            (1, 0) => 3,
            _ => 4,
        });
        for sub in candidates {
            if let Some(gid) = lookup_cmap(&self.data, self.cmap_offset, &sub, codepoint) {
                if gid != 0 {
                    return Some(gid);
                }
            }
        }
        None
    }

    /// 字形的水平推进量（字体单位，不是点）。
    ///
    /// hmtx 的存储是「前 numberOfHMetrics 项各 4 字节（advance + lsb），
    /// 其余字形共用最后一项的 advance，只有 2 字节 lsb」。
    /// 中文全角字通常落在前面，但标点、西文常常落在末尾的共享区，
    /// 漏掉这条规则会让半数字符宽度算错、整页排版跟着错位。
    pub fn advance_width(&self, glyph_id: u16) -> u16 {
        let last_metric = self.number_of_h_metrics.saturating_sub(1) as usize;
        let index = if (glyph_id as usize) < self.number_of_h_metrics as usize {
            glyph_id as usize
        } else {
            last_metric
        };
        if index * 4 + 2 > self.hmtx_length {
            // 度量表比声明的字形数短：这是字体本身不自洽。
            // 退化成一个「半角宽度」而不是 0 —— 宽度 0 会让同一个位置
            // 无限叠字，比宽度不准更糟。
            return self.units_per_em / 2;
        }
        be_u16(&self.data, self.hmtx_offset + index * 4).unwrap_or(self.units_per_em / 2)
    }
}

/// 廉价判断「这看起来像 TrueType 轮廓字体」。
///
/// 只扫表目录里的 tag，不做任何解析。用于在整份读文件之前先筛掉 CFF/OTF，
/// 也用于字体发现阶段给候选文件排序。
pub fn looks_like_truetype(data: &[u8]) -> bool {
    if data.len() < 12 {
        return false;
    }
    let num_tables = match be_u16(data, 4) {
        Some(n) => n,
        None => return false,
    };
    for index in 0..num_tables as usize {
        if let Some(tag) = read(data, 12 + index * 16, 4) {
            if tag == b"glyf" {
                return true;
            }
        }
    }
    false
}

/// 解析 cmap 表目录，收集所有可用子表。
fn parse_cmap_directory(data: &[u8], cmap_offset: usize) -> Option<Vec<CmapSubtable>> {
    let num_subtables = be_u16(data, cmap_offset + 2)?;
    let mut out = Vec::with_capacity(num_subtables as usize);
    for index in 0..num_subtables as usize {
        let record = cmap_offset + 4 + index * 8;
        let platform_id = be_u16(data, record)?;
        let encoding_id = be_u16(data, record + 2)?;
        let offset = be_u32(data, record + 4)?;
        // 格式在子表开头两字节
        let format = be_u16(data, cmap_offset + offset as usize)?;
        // 只认格式 4（BMP）与 12（全 Unicode）。格式 0/6/2 等在中文场景下
        // 要么只覆盖 ASCII，要么已被弃用，收集进来只会白白多一次查表。
        if format == 4 || format == 12 {
            out.push(CmapSubtable {
                platform_id,
                encoding_id,
                offset,
                format,
            });
        }
    }
    Some(out)
}

/// 在一条子表里查码点。
fn lookup_cmap(
    data: &[u8],
    cmap_offset: usize,
    subtable: &CmapSubtable,
    codepoint: u32,
) -> Option<u16> {
    let base = cmap_offset + subtable.offset as usize;
    match subtable.format {
        4 => lookup_cmap_format4(data, base, codepoint),
        12 => lookup_cmap_format12(data, base, codepoint),
        _ => None,
    }
}

/// 格式 4：BMP 分段映射。
///
/// 结构是四张平行数组（endCode / startCode / idDelta / idRangeOffset），
/// 查表分两步：先二分出码点落在哪一段，再看 idRangeOffset 是否为 0
/// 决定是「偏移量跳转」还是「idDelta 直接加」。
fn lookup_cmap_format4(data: &[u8], base: usize, codepoint: u32) -> Option<u16> {
    // 格式 4 只覆盖 BMP
    if codepoint > 0xFFFF {
        return None;
    }
    let codepoint = codepoint as u16;
    let seg_count = be_u16(data, base + 6)? / 2;
    let end_codes = base + 14;
    // +2 跳过 reservedPad
    let start_codes = end_codes + seg_count as usize * 2 + 2;
    let id_deltas = start_codes + seg_count as usize * 2;
    let id_range_offsets = id_deltas + seg_count as usize * 2;

    // 段是按 endCode 升序的，二分查找比线性扫快得多（汉字字体常有上千段）
    let mut low = 0usize;
    let mut high = seg_count as usize;
    while low < high {
        let mid = (low + high) / 2;
        let end = be_u16(data, end_codes + mid * 2)?;
        if end < codepoint {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    if low >= seg_count as usize {
        return None;
    }
    let start = be_u16(data, start_codes + low * 2)?;
    if codepoint < start {
        return None;
    }
    let delta = be_u16(data, id_deltas + low * 2)? as i16;
    let range_offset = be_u16(data, id_range_offsets + low * 2)?;
    if range_offset == 0 {
        // 整段平移
        return Some(codepoint.wrapping_add(delta as u16));
    }
    // 跳到 glyphIdArray：位置是「idRangeOffset 所在地址」+ range_offset +
    // (codepoint - start) * 2。这里的「所在地址」是相对 cmap 表头的绝对偏移。
    let glyph_address = id_range_offsets + low * 2 + range_offset as usize;
    let glyph_address = glyph_address + (codepoint - start) as usize * 2;
    let gid = be_u16(data, glyph_address)?;
    if gid == 0 {
        return None;
    }
    Some(gid.wrapping_add(delta as u16))
}

/// 格式 12：分段线性映射，覆盖全部 Unicode 平面。
fn lookup_cmap_format12(data: &[u8], base: usize, codepoint: u32) -> Option<u16> {
    let groups = be_u32(data, base + 12)?;
    let mut low = 0u32;
    let mut high = groups;
    while low < high {
        let mid = (low + high) / 2;
        let group = base + 16 + mid as usize * 12;
        let end = be_u32(data, group + 4)?;
        if end < codepoint {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    if low >= groups {
        return None;
    }
    let group = base + 16 + low as usize * 12;
    let start = be_u32(data, group)?;
    let start_gid = be_u32(data, group + 8)?;
    if codepoint < start {
        return None;
    }
    u16::try_from(start_gid.checked_add(codepoint - start)?).ok()
}

/// 从 name 表里挑一个 PostScript 名（name ID 6）。
///
/// PDF 的 /BaseFont 只是给阅读器做字体匹配的提示，名字不参与渲染，
/// 所以这里「读不到就算了」：拿不到名字就退化成 YuhuaEmbedded。
/// 为一个纯提示字段把整个字体判成不可用是不值得的。
fn read_name(data: &[u8], name_offset: usize) -> Option<String> {
    let count = be_u16(data, name_offset + 2)?;
    let string_offset = name_offset + be_u16(data, name_offset + 4)? as usize;
    for index in 0..count as usize {
        let record = name_offset + 6 + index * 12;
        let platform_id = be_u16(data, record)?;
        let name_id = be_u16(data, record + 6)?;
        if name_id != 6 {
            continue;
        }
        let length = be_u16(data, record + 8)? as usize;
        let offset = be_u16(data, record + 10)? as usize;
        let raw = read(data, string_offset + offset, length)?;
        // Windows 平台的名字是 UTF-16BE，Mac 平台是 MacRoman。
        // 我们只要 ASCII 可见部分，两种编码下 ASCII 的字节值一致，
        // 直接过滤可打印字符即可，不必为它单独写解码器。
        let decoded = if platform_id == 3 {
            raw.chunks_exact(2)
                .map(|pair| pair[1])
                .filter(|b| b.is_ascii_graphic() || *b == b' ')
                .map(char::from)
                .collect::<String>()
        } else {
            raw.iter()
                .filter(|b| b.is_ascii_graphic() || **b == b' ')
                .map(|b| char::from(*b))
                .collect::<String>()
        };
        if !decoded.is_empty() {
            return Some(decoded);
        }
    }
    None
}

// ============================================================================
//  字节读取辅助
// ============================================================================

/// 取一段字节；越界返回 None 而不是 panic。
pub(crate) fn read(data: &[u8], offset: usize, length: usize) -> Option<&[u8]> {
    let end = offset.checked_add(length)?;
    data.get(offset..end)
}

/// 读大端 u16。
pub(crate) fn be_u16(data: &[u8], offset: usize) -> Option<u16> {
    let bytes = read(data, offset, 2)?;
    Some(u16::from_be_bytes([bytes[0], bytes[1]]))
}

/// 读大端 u32。
pub(crate) fn be_u32(data: &[u8], offset: usize) -> Option<u32> {
    let bytes = read(data, offset, 4)?;
    Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成一份最小但结构完整的 TrueType。
    ///
    /// 手写而不是塞一个真字体进仓库：真字体动辄 10 MB，进仓库会把克隆
    /// 成本抬起来；而我们要验证的是**解析逻辑**，一份两百多字节的合成字体
    /// 就足以覆盖所有分支，且测试读起来一目了然。
    ///
    /// 造出来的字体里，U+4E00「一」映射到 GID 3；GID 0/1/2/3 的宽度分别是
    /// 800 / 500 / 750 / 1000，GID 4 复用最后一项的 1000。
    fn synthetic_font() -> Vec<u8> {
        // 布局：header(12) + 6 个表目录项(96) = 108 起是各表数据
        const HEAD: usize = 108;
        const HHEA: usize = HEAD + 54;
        const MAXP: usize = HHEA + 36;
        const HMTX: usize = MAXP + 32;
        // 格式 4 子表的完整布局：
        //   0  format(2) / 2 length(2) / 4 language(2) / 6 segCountX2(2)
        //   8  searchRange(2) / 10 entrySelector(2) / 12 rangeShift(2)
        //   14 endCode[] / +2 pad / startCode[] / idDelta[] / idRangeOffset[]
        // 一段(segCount=1) → 7 个 u16（14 字节）+ 2 字节 pad = 16 字节
        const CMAP: usize = HMTX + 16;
        const SUBTABLE: usize = CMAP + 12;
        const GLYF: usize = SUBTABLE + 28;

        let mut data = vec![0u8; GLYF + 16];
        // sfnt 版本 1.0 + 6 张表
        data[0..4].copy_from_slice(&[0x00, 0x01, 0x00, 0x00]);
        data[4..6].copy_from_slice(&6u16.to_be_bytes());

        let mut put = |index: usize, tag: &[u8; 4], offset: usize, length: usize| {
            let entry = 12 + index * 16;
            data[entry..entry + 4].copy_from_slice(tag);
            data[entry + 8..entry + 12].copy_from_slice(&(offset as u32).to_be_bytes());
            data[entry + 12..entry + 16].copy_from_slice(&(length as u32).to_be_bytes());
        };
        put(0, b"head", HEAD, 54);
        put(1, b"hhea", HHEA, 36);
        put(2, b"maxp", MAXP, 32);
        put(3, b"hmtx", HMTX, 16);
        put(4, b"cmap", CMAP, 12 + 28);
        put(5, b"glyf", GLYF, 16);

        // head：unitsPerEm = 1000
        data[HEAD + 18..HEAD + 20].copy_from_slice(&1000u16.to_be_bytes());
        // hhea：numberOfHMetrics = 4
        data[HHEA + 34..HHEA + 36].copy_from_slice(&4u16.to_be_bytes());
        // maxp：numGlyphs = 5
        data[MAXP + 4..MAXP + 6].copy_from_slice(&5u16.to_be_bytes());

        // hmtx：GID 0/1/2/3 各 4 字节（advance, lsb）
        for (index, advance) in [800u16, 500, 750, 1000].into_iter().enumerate() {
            let base = HMTX + index * 4;
            data[base..base + 2].copy_from_slice(&advance.to_be_bytes());
        }

        // cmap：1 条子表，格式 4，平台 3 / 编码 1
        data[CMAP + 2..CMAP + 4].copy_from_slice(&1u16.to_be_bytes());
        data[CMAP + 4..CMAP + 6].copy_from_slice(&3u16.to_be_bytes());
        data[CMAP + 6..CMAP + 8].copy_from_slice(&1u16.to_be_bytes());
        data[CMAP + 8..CMAP + 12].copy_from_slice(&12u32.to_be_bytes());

        // 格式 4 子表。数组的排布必须与 lookup_cmap_format4 里的推导严格一致：
        //   endCode@14, pad@16, startCode@18, idDelta@20, idRangeOffset@22
        let sub = SUBTABLE;
        data[sub..sub + 2].copy_from_slice(&4u16.to_be_bytes());
        data[sub + 2..sub + 4].copy_from_slice(&28u16.to_be_bytes());
        // segCountX2 = 2（一段）
        data[sub + 6..sub + 8].copy_from_slice(&2u16.to_be_bytes());
        // endCode[0] = 0x4E00
        data[sub + 14..sub + 16].copy_from_slice(&0x4E00u16.to_be_bytes());
        // reservedPad 在 sub+16
        // startCode[0] = 0x4E00
        data[sub + 18..sub + 20].copy_from_slice(&0x4E00u16.to_be_bytes());
        // idDelta[0]：目标 GID 3，源码点 0x4E00 → delta = 3 - 0x4E00
        let delta = (3u16).wrapping_sub(0x4E00);
        data[sub + 20..sub + 22].copy_from_slice(&delta.to_be_bytes());
        // idRangeOffset[0] = 0（走 idDelta 路径），留在 sub+22 的零即可
        data
    }

    #[test]
    fn parses_header_tables() {
        let font = TrueTypeFont::parse("synthetic.ttf", synthetic_font()).unwrap();
        assert_eq!(font.units_per_em(), 1000);
        assert_eq!(font.num_glyphs(), 5);
    }

    #[test]
    fn maps_codepoint_to_glyph_via_format4() {
        let font = TrueTypeFont::parse("synthetic.ttf", synthetic_font()).unwrap();
        assert_eq!(font.glyph_id('一'), Some(3));
        // 不在任何段里的字符没有字形
        assert_eq!(font.glyph_id('A'), None);
    }

    #[test]
    fn reads_advance_widths_with_fallback_to_last_metric() {
        let font = TrueTypeFont::parse("synthetic.ttf", synthetic_font()).unwrap();
        assert_eq!(font.advance_width(0), 800);
        assert_eq!(font.advance_width(1), 500);
        assert_eq!(font.advance_width(3), 1000);
        // GID 4 超出 numberOfHMetrics，复用最后一项的 advance
        assert_eq!(font.advance_width(4), 1000);
    }

    #[test]
    fn rejects_font_without_glyf() {
        let mut data = synthetic_font();
        data[12 + 5 * 16..12 + 5 * 16 + 4].copy_from_slice(b"CFF ");
        let err = TrueTypeFont::parse("otf.ttf", data).unwrap_err();
        assert!(matches!(err, ExportError::Font { .. }), "{err}");
        assert!(err.to_string().contains("glyf"), "{err}");
    }

    #[test]
    fn rejects_truncated_file_without_panicking() {
        let full = synthetic_font();
        // 逐个截断长度，任何长度都不能 panic
        for length in 0..full.len() {
            let _ = TrueTypeFont::parse("cut.ttf", full[..length].to_vec());
        }
    }

    #[test]
    fn truncated_hmtx_degrades_to_half_width_instead_of_zero() {
        // 把 hmtx 长度声明得比实际短：查宽度要退化而不是越界
        let mut data = synthetic_font();
        let entry = 12 + 3 * 16;
        data[entry + 12..entry + 16].copy_from_slice(&2u32.to_be_bytes());
        let font = TrueTypeFont::parse("short.ttf", data).unwrap();
        assert_eq!(font.advance_width(3), 500);
    }

    #[test]
    fn format12_subtable_covers_beyond_bmp() {
        // 直接构造一条格式 12 子表并查表，覆盖增补平面路径
        let mut table = vec![0u8; 40];
        table[0..2].copy_from_slice(&12u16.to_be_bytes());
        table[12..16].copy_from_slice(&1u32.to_be_bytes()); // nGroups = 1
        table[16..20].copy_from_slice(&0x20000u32.to_be_bytes()); // startChar
        table[20..24].copy_from_slice(&0x20010u32.to_be_bytes()); // endChar
        table[24..28].copy_from_slice(&7u32.to_be_bytes()); // startGlyphID
        assert_eq!(lookup_cmap_format12(&table, 0, 0x20005), Some(12));
        assert_eq!(lookup_cmap_format12(&table, 0, 0x10000), None);
    }

    #[test]
    fn looks_like_truetype_needs_glyf() {
        assert!(looks_like_truetype(&synthetic_font()));
        assert!(!looks_like_truetype(&[0u8; 4]));
        let mut data = synthetic_font();
        data[12 + 5 * 16..12 + 5 * 16 + 4].copy_from_slice(b"CFF ");
        assert!(!looks_like_truetype(&data));
    }

    #[test]
    fn byte_readers_return_none_out_of_bounds() {
        let data = [0u8, 1, 2];
        assert_eq!(be_u16(&data, 0), Some(1));
        assert_eq!(be_u16(&data, 2), None);
        assert_eq!(be_u32(&data, 0), None);
        assert_eq!(read(&data, 1, 5), None);
        // 极端 offset 不能因为 checked_add 溢出而 panic
        assert_eq!(read(&data, usize::MAX, 1), None);
    }
}
