//! PDF 文件结构的底稿：对象写入、xref 表、trailer。
//!
//! ## 为什么自己写而不是用 lopdf / printpdf
//!
//! 我们要产出的 PDF 子集非常窄：几十个间接对象、没有压缩对象流、没有
//! 增量更新、没有加密。这种规模的写入器不到 200 行，而引入一个通用 PDF 库
//! 要带进一棵依赖树，还未必能干净地表达「Type0 / Identity-H / 内嵌
//! FontFile2」这套中文必须的组合。计划书 9.4 对手写 OOXML 的判断
//! （「要写的子集只有几百行」）在这里同样成立。
//!
//! ## xref 表必须是**字节偏移**的表
//!
//! PDF 的交叉引用表记录的是每个对象在文件里的**绝对字节偏移**。
//! 这意味着写对象时必须一边写一边记 buffer.len()，最后再补 xref 与
//! trailer —— 顺序不能颠倒。常见错误是「先算好偏移再写」，
//! 一旦某个对象的内容与预估差一个字节，整份文件的 xref 就全错，
//! 阅读器要么报「文件损坏」要么（更糟）在 Adobe 里打开成空白页。
//!
//! ## 对象编号从 1 开始，0 号是链表头
//!
//! xref 的第 0 项固定是 0000000000 65535 f（空闲对象链的头），
//! 从第 1 项起才是真实对象。漏掉第 0 项是最常见的「PDF 打不开」原因之一。

/// PDF 对象号。
///
/// 用 newtype 而不是裸 u32：对象号在代码里到处都是，
/// 与「字形编号」「字符码」混在一起时极易写反，而写反的后果是
/// 内容流指向一个不存在的对象 —— 阅读器只会给你一片空白，不报错。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObjId(pub u32);

impl ObjId {
    /// 打印成 PDF 语法里的引用形式，例如 12 0 R。
    pub fn reference(self) -> String {
        format!("{} 0 R", self.0)
    }
}

/// 一个间接对象：编号 + 原始字节体。
#[derive(Debug, Clone)]
pub struct IndirectObject {
    /// 对象号。
    pub id: ObjId,
    /// 对象体（不含 N 0 obj 与 endobj 外壳）。
    pub body: Vec<u8>,
}

impl IndirectObject {
    /// 构造一个对象。
    pub fn new(id: ObjId, body: impl Into<Vec<u8>>) -> Self {
        Self {
            id,
            body: body.into(),
        }
    }
}

/// 分配对象号的计数器。
///
/// 渲染器每需要一个对象就 next() 一次。不用「先数好要几个对象再编号」：
/// 页数在渲染完成前是未知的（要排版才知道分几页），
/// 而为了数页数把正文渲染两遍是纯浪费。
#[derive(Debug, Default)]
pub struct ObjAllocator {
    next: u32,
}

impl ObjAllocator {
    /// 新建分配器。对象号从 1 开始（0 号被空闲链表占用）。
    pub fn new() -> Self {
        Self { next: 1 }
    }

    /// 取下一个对象号。
    ///
    /// 刻意不叫 next()：那会与 Iterator::next 撞名，
    /// 读代码的人（和 clippy）都会以为这里实现了迭代器协议。
    pub fn allocate(&mut self) -> ObjId {
        let id = ObjId(self.next);
        self.next += 1;
        id
    }

    /// 已分配的对象总数（不含 0 号）。
    pub fn count(&self) -> u32 {
        self.next - 1
    }
}

/// 把一组对象序列化成完整的 PDF 文件字节。
///
/// root 是文档目录（Catalog）的对象号；info 是元数据字典的对象号，
/// 传 None 表示不写元数据。
pub fn write_pdf(objects: &[IndirectObject], root: ObjId, info: Option<ObjId>) -> Vec<u8> {
    // 头部注释行里的二进制标记（>127 的字节）是给传输工具看的：
    // 它告诉 FTP / 版本控制「这是二进制文件，别做行尾转换」。
    // 少了这一行的 PDF 在 Windows 上传后经常打不开，是个经典坑。
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"%PDF-1.7\n");
    out.extend_from_slice(b"%\xE2\xE3\xCF\xD3\n");

    // 对象必须按编号升序写：xref 表本身可以乱序，但升序能让
    // 用文本编辑器排查问题时一眼看出缺了哪个对象。
    let mut ordered: Vec<&IndirectObject> = objects.iter().collect();
    ordered.sort_by_key(|object| object.id.0);

    let mut offsets: Vec<(u32, usize)> = Vec::with_capacity(ordered.len());
    for object in &ordered {
        let offset = out.len();
        offsets.push((object.id.0, offset));
        out.extend_from_slice(format!("{} 0 obj\n", object.id.0).as_bytes());
        out.extend_from_slice(&object.body);
        out.extend_from_slice(b"\nendobj\n");
    }

    // 对象号可能不连续（调用方漏了两个），按最大编号铺 xref，
    // 未写出的槽位填成空闲项 —— 这样即使上游有 bug，
    // 产出仍然是**结构合法**的 PDF，只是少了内容。
    let max_id = ordered.last().map(|o| o.id.0).unwrap_or(0);
    let xref_offset = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", max_id + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for id in 1..=max_id {
        match offsets.iter().find(|(object_id, _)| *object_id == id) {
            Some((_, offset)) => {
                // 每条固定 20 字节（10 位偏移 + 空格 + 5 位世代号 + 空格 + 类型 + 2 字节 EOL）。
                // 长度不对会让严格模式的解析器（pdf.js、部分阅读器）报格式错误。
                out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
            }
            None => out.extend_from_slice(b"0000000000 65535 f \n"),
        }
    }

    let mut trailer = String::new();
    trailer.push_str("trailer\n<<\n");
    trailer.push_str(&format!("/Size {}\n", max_id + 1));
    trailer.push_str(&format!("/Root {}\n", root.reference()));
    if let Some(info) = info {
        trailer.push_str(&format!("/Info {}\n", info.reference()));
    }
    trailer.push_str(">>\n");
    trailer.push_str(&format!("startxref\n{xref_offset}\n%%EOF\n"));
    out.extend_from_slice(trailer.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocator_starts_at_one_and_never_reuses() {
        let mut allocator = ObjAllocator::new();
        assert_eq!(allocator.allocate(), ObjId(1));
        assert_eq!(allocator.allocate(), ObjId(2));
        assert_eq!(allocator.count(), 2);
    }

    #[test]
    fn reference_uses_zero_generation() {
        assert_eq!(ObjId(7).reference(), "7 0 R");
    }

    #[test]
    fn header_and_trailer_are_present() {
        let mut allocator = ObjAllocator::new();
        let root = allocator.allocate();
        let objects = vec![IndirectObject::new(root, "<< /Type /Catalog >>")];
        let bytes = write_pdf(&objects, root, None);
        let text = String::from_utf8_lossy(&bytes).to_string();
        assert!(text.starts_with("%PDF-1.7\n"), "{text}");
        // 头部第二行应当是二进制标记
        assert!(bytes.contains(&0xE2));
        assert!(text.contains("\ntrailer\n"), "{text}");
        assert!(text.trim_end().ends_with("%%EOF"), "{text}");
        assert!(text.contains("/Root 1 0 R"), "{text}");
    }

    #[test]
    fn xref_entries_point_at_real_offsets() {
        let mut allocator = ObjAllocator::new();
        let root = allocator.allocate();
        let second = allocator.allocate();
        let objects = vec![
            IndirectObject::new(root, "<< /Type /Catalog >>"),
            IndirectObject::new(second, "<< /Type /Pages >>"),
        ];
        let bytes = write_pdf(&objects, root, None);

        // 全程按**字节**切片：头部第二行是二进制标记（>127 的字节），
        // 用 String 去按字节下标切会在字符边界上 panic ——
        // 这个坑在我们自己的测试里先踩了一次，正好说明「PDF 是二进制，
        // 不要拿字符串工具去处理它」。
        let find = |needle: &[u8]| -> usize {
            bytes
                .windows(needle.len())
                .position(|window| window == needle)
                .unwrap_or_else(|| panic!("找不到 {:?}", String::from_utf8_lossy(needle)))
        };
        let xref_at = find(b"xref\n") + "xref\n".len();
        let xref = &bytes[xref_at..];
        let header_end = xref.iter().position(|b| *b == b'\n').unwrap();
        let header = String::from_utf8_lossy(&xref[..header_end]).to_string();
        assert_eq!(header, "0 3");

        let mut cursor = header_end + 1;
        let mut line = || {
            let end = xref[cursor..].iter().position(|b| *b == b'\n').unwrap() + cursor;
            let out = String::from_utf8_lossy(&xref[cursor..end]).to_string();
            cursor = end + 1;
            out
        };
        assert_eq!(line(), "0000000000 65535 f ");
        for index in 0..2usize {
            let entry = line();
            let offset: usize = entry[..10].parse().unwrap();
            let expected = format!("{} 0 obj", index + 1);
            assert!(
                bytes[offset..].starts_with(expected.as_bytes()),
                "对象 {} 的 xref 偏移对不上：{:?}",
                index + 1,
                String::from_utf8_lossy(&bytes[offset..(offset + 20).min(bytes.len())])
            );
        }
    }

    #[test]
    fn info_reference_is_written_when_given() {
        let mut allocator = ObjAllocator::new();
        let root = allocator.allocate();
        let info = allocator.allocate();
        let objects = vec![
            IndirectObject::new(root, "<< /Type /Catalog >>"),
            IndirectObject::new(info, "<< /Title (book) >>"),
        ];
        let text = String::from_utf8_lossy(&write_pdf(&objects, root, Some(info))).to_string();
        assert!(text.contains("/Info 2 0 R"), "{text}");
    }

    #[test]
    fn objects_are_written_in_ascending_id_order() {
        let objects = vec![
            IndirectObject::new(ObjId(3), "(c)"),
            IndirectObject::new(ObjId(1), "(a)"),
            IndirectObject::new(ObjId(2), "(b)"),
        ];
        let text = String::from_utf8_lossy(&write_pdf(&objects, ObjId(1), None)).to_string();
        let a = text.find("1 0 obj").unwrap();
        let b = text.find("2 0 obj").unwrap();
        let c = text.find("3 0 obj").unwrap();
        assert!(a < b && b < c, "{text}");
    }

    #[test]
    fn missing_object_ids_become_free_entries() {
        // 上游漏号时仍要产出结构合法的 PDF，而不是让 xref 表断档
        let objects = vec![
            IndirectObject::new(ObjId(1), "(a)"),
            IndirectObject::new(ObjId(3), "(c)"),
        ];
        let bytes = write_pdf(&objects, ObjId(1), None);
        let text = String::from_utf8_lossy(&bytes).to_string();
        assert!(text.contains("0 4\n"), "{text}");
        let xref = text.split("xref\n").nth(1).unwrap();
        assert!(xref.contains("0000000000 65535 f \n"), "{xref}");
    }

    #[test]
    fn empty_object_list_still_produces_a_parseable_skeleton() {
        let bytes = write_pdf(&[], ObjId(1), None);
        let text = String::from_utf8_lossy(&bytes).to_string();
        assert!(text.starts_with("%PDF-1.7"), "{text}");
        assert!(text.contains("/Size 1"), "{text}");
    }
}
