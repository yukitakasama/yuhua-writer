//! 工作区扫描：把磁盘上的目录树装配成领域模型。
//!
//! ## 扫描规则
//!
//! ```text
//! manuscript/
//!  ├─ 001-第一卷 风起/        <- 目录 = 卷（名字带 3 位序号前缀）
//!  │   ├─ 001-第一章.md      <- .md 文件 = 章
//!  │   └─ 002-第二章.md
//!  └─ 002-第二卷 惊蛰/
//! ```
//!
//! ## 宽容原则
//!
//! 用户会用文件管理器整理工作区。因此扫描必须能处理：
//!
//! | 情况 | 处理 |
//! | --- | --- |
//! | 卷目录没有序号前缀 | 按目录名字典序排，序号按顺序补 |
//! | 章节直接放在 manuscript/ 根下 | 归入「未分卷」，自动建一个卷容器 |
//! | 文件名没有序号前缀 | 按名字排序 |
//! | 非 .md 文件 | 忽略（图片、素材、笔记都不是稿件） |
//! | 隐藏目录（.yuhua / .trash / .git） | 跳过 |
//! | Front Matter 损坏 | 用文件名推导标题（chapter_io 已保证不丢正文） |
//!
//! ## 一个刻意的取舍：扫描时**读取正文**
//!
//! 装配文稿需要每章的 `word_count`（卷章树要显示字数）。
//! 这意味着扫描要读一遍全部文件。对 100 万字工作区，
//! 这是一次几秒级的操作，发生在「打开工作区」时，用户有心理预期。
//!
//! 替代方案（先只读 Front Matter、字数懒加载）会让卷章树出现
//! 「字数先空后跳」的闪烁，体验更差。因此选择一次性读完，
//! **但读完即丢正文**：装配后的 `Document.chapters` 里 `body` 为空、
//! `body_loaded = false`，内存占用与书名总字数无关。

use std::path::Path;

use yuhua_core::model::{Book, Chapter, Document, Volume};
use yuhua_core::{Result, YuhuaError};
use yuhua_fs::chapter_io::read_chapter;
use yuhua_fs::layout::WorkspaceLayout;
use yuhua_fs::workspace::Workspace;

/// 扫描工作区，装配文稿结构。
pub fn scan_workspace(workspace: &Workspace) -> Result<Document> {
    let layout = &workspace.layout;
    let manuscript = layout.manuscript_dir();

    let now = now_local();
    let title = if workspace.config.title.is_empty() {
        layout
            .root()
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名作品".to_string())
    } else {
        workspace.config.title.clone()
    };

    let mut book = Book::new(&title, workspace.config.created);
    book.updated = now;

    let mut volumes: Vec<Volume> = Vec::new();
    let mut chapters: Vec<Chapter> = Vec::new();

    // 收集卷目录（已排序）
    let mut volume_dirs = read_volume_dirs(&manuscript);

    // 若 manuscript 根下直接有 .md 文件，为它们建一个容器卷
    let root_chapters = read_markdown_files(&manuscript);
    if !root_chapters.is_empty() {
        // 放在最前面，因为它承载的是「还没归档的稿件」
        volumes.push(Volume::new(&book.id, "未分卷", -1, now));
    }

    volume_dirs.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    // 只用目录名建卷，绝对路径在这里用不上（章节挂载时才需要）
    for (i, (dir_name, _path)) in volume_dirs.iter().enumerate() {
        let vol_title = strip_sort_prefix(dir_name);
        volumes.push(Volume::new(&book.id, &vol_title, i as i32, now));
    }

    // 建一个从目录名到卷 ID 的映射，供章节挂载
    let volume_by_dir: std::collections::HashMap<String, yuhua_core::VolumeId> = volume_dirs
        .iter()
        .enumerate()
        .filter_map(|(i, (dir_name, _))| {
            volumes
                .iter()
                .filter(|v| v.sort >= 0)
                .nth(i)
                .map(|v| (dir_name.clone(), v.id.clone()))
        })
        .collect();

    // 挂载「未分卷」章节
    if let Some(unfiled) = volumes.iter().find(|v| v.sort == -1) {
        for (sort, file) in root_chapters.iter().enumerate() {
            if let Some(ch) = load_chapter(file, &book.id, &unfiled.id, sort as i32, &layout.to_relative_str(file)) {
                chapters.push(ch);
            }
        }
    }

    // 挂载各卷下的章节
    for (dir_name, dir_path) in &volume_dirs {
        let Some(volume_id) = volume_by_dir.get(dir_name) else {
            continue;
        };
        let files = read_markdown_files(dir_path);
        for (sort, file) in files.iter().enumerate() {
            let rel = layout.to_relative_str(file);
            if let Some(ch) = load_chapter(file, &book.id, volume_id, sort as i32, &rel) {
                chapters.push(ch);
            }
        }
    }

    // 一卷都没有时补一个默认卷。
    //
    // 为什么必须有：领域模型规定「章不能没有卷」（见 yuhua-core::model 的
    // 模块文档），新建章节时需要一个可挂载的卷。一个刚创建的、或者用户
    // 手工清空过 manuscript/ 的工作区，扫描结果就是零卷 —— 此时若不补，
    // 界面上就无处可以「新建章节」。
    if volumes.is_empty() {
        volumes.push(Volume::new(&book.id, "第一卷", 0, now));
    }

    Ok(Document {
        book,
        volumes,
        chapters,
    })
}

/// 读取一个章节文件并转成领域对象。
///
/// 返回 `None` 表示该文件无法读取（例如刚好被云盘锁住）。
/// **单个文件失败不阻断整个扫描** —— 宁可少一章，也不要让用户
/// 打不开整个工作区。
fn load_chapter(
    path: &Path,
    book_id: &yuhua_core::BookId,
    volume_id: &yuhua_core::VolumeId,
    sort: i32,
    relative_path: &str,
) -> Option<Chapter> {
    let file = read_chapter(path).ok()?;
    let mtime = std::fs::metadata(path)
        .ok()
        .map(|m| yuhua_store::index::mtime_millis(&m))
        .unwrap_or(0);

    // 用「正文」而非「整个文件」算哈希：Front Matter 里的 updated 时间戳
    // 每次保存都会变，若把元数据也算进去，会导致每次保存都判定为「内容变了」。
    let hash = yuhua_store::index::content_hash(&file.body);

    Some(Chapter {
        meta: file.meta,
        book_id: book_id.clone(),
        volume_id: volume_id.clone(),
        path: relative_path.to_string(),
        sort,
        body: file.body,
        body_loaded: true,
        mtime,
        content_hash: hash,
    })
}

/// 列出 manuscript 下的卷目录，返回 `(目录名, 绝对路径)`。
fn read_volume_dirs(manuscript: &Path) -> Vec<(String, std::path::PathBuf)> {
    let Ok(entries) = std::fs::read_dir(manuscript) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            // 跳过隐藏目录与保留目录
            !WorkspaceLayout::is_reserved_name(&name) && !name.starts_with('.')
        })
        .filter(|e| e.path().is_dir())
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .collect()
}

/// 列出目录下的 Markdown 文件（已排序）。
fn read_markdown_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<std::path::PathBuf> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
        })
        .map(|e| e.path())
        .collect();
    // 按文件名自然排序：让「002-第二章」排在「010-第十章」前面
    files.sort_by(|a, b| {
        natural_cmp(
            &a.file_name().unwrap_or_default().to_string_lossy(),
            &b.file_name().unwrap_or_default().to_string_lossy(),
        )
    });
    files
}

/// 去掉文件名开头的 `NNN-` 序号前缀。
fn strip_sort_prefix(name: &str) -> String {
    match name.split_once('-') {
        Some((prefix, rest))
            if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty() =>
        {
            rest.to_string()
        }
        _ => name.to_string(),
    }
}

/// 自然排序比较：把文件名里的数字段按数值比较。
///
/// 纯字典序会把 `010-` 排在 `002-` 前面吗？不会 —— 因为序号是
/// 零填充 3 位的，字典序恰好等于数值序。但用户手工改名去掉前缀后
/// （变成「第十章」「第二章」），字典序就乱了。这里做自然排序兜底：
/// 逐段比较，数字段按数值、非数字段按字典序。
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();

    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    // 两边都进入数字段：取完整数字做数值比较
                    let na = take_number(&mut ai);
                    let nb = take_number(&mut bi);
                    match na.cmp(&nb) {
                        Ordering::Equal => continue,
                        other => return other,
                    }
                } else {
                    match ca.cmp(&cb) {
                        Ordering::Equal => {
                            ai.next();
                            bi.next();
                        }
                        other => return other,
                    }
                }
            }
        }
    }
}

/// 从迭代器取出连续的数字字符并解析为 u64。
fn take_number(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> u64 {
    let mut s = String::new();
    while let Some(&c) = it.peek() {
        if c.is_ascii_digit() {
            s.push(c);
            it.next();
        } else {
            break;
        }
    }
    s.parse().unwrap_or(0)
}

/// 取本地时区偏移。
fn local_offset() -> chrono::FixedOffset {
    *chrono::Local::now().offset()
}

/// 当前本地时间。
fn now_local() -> chrono::DateTime<chrono::FixedOffset> {
    use chrono::Utc;
    Utc::now().with_timezone(&local_offset())
}

/// 扩展 [`WorkspaceLayout`]：把绝对路径转成相对字符串。
///
/// 放在这里而不是 yuhua-fs，是因为它只是一个便利方法；
/// 核心的路径安全校验仍在 `yuhua_fs::layout` 里。
trait LayoutExt {
    fn to_relative_str(&self, path: &Path) -> String;
}

impl LayoutExt for WorkspaceLayout {
    fn to_relative_str(&self, path: &Path) -> String {
        self.relativize(path)
            .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
    }
}

/// 装配一个空文稿（供「新建工作区」使用）。
pub fn empty_document(title: &str) -> Result<Document> {
    let now = now_local();
    let doc = Document::new(title, now);
    doc.validate()?;
    Ok(doc)
}

/// 校验文稿并转成领域错误。
pub fn validate(doc: &Document) -> Result<()> {
    doc.validate().map_err(|e| match e {
        YuhuaError::Invariant(m) => YuhuaError::Invariant(m),
        other => other,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_numeric_sort_prefix() {
        assert_eq!(strip_sort_prefix("001-第一卷 风起"), "第一卷 风起");
        assert_eq!(strip_sort_prefix("010-第十章"), "第十章");
    }

    #[test]
    fn keeps_non_numeric_prefix() {
        // 「第一卷-风起」里的「第一卷」不是序号，不能被切掉
        assert_eq!(strip_sort_prefix("第一卷-风起"), "第一卷-风起");
        assert_eq!(strip_sort_prefix("没有前缀"), "没有前缀");
        // 只有数字但后面为空，也不切
        assert_eq!(strip_sort_prefix("001-"), "001-");
    }

    #[test]
    fn natural_sort_orders_padded_numbers() {
        let mut v = vec!["010-a", "002-b", "001-c"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["001-c", "002-b", "010-a"]);
    }

    #[test]
    fn natural_sort_handles_unpadded_numbers() {
        // 用户手工改名后序号没有零填充，自然排序仍要正确
        let mut v = vec!["第10章", "第2章", "第1章"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["第1章", "第2章", "第10章"]);
    }

    #[test]
    fn natural_sort_is_consistent_with_equality() {
        use std::cmp::Ordering;
        assert_eq!(natural_cmp("abc", "abc"), Ordering::Equal);
        assert_eq!(natural_cmp("abc", "abd"), Ordering::Less);
        assert_eq!(natural_cmp("abd", "abc"), Ordering::Greater);
        assert_eq!(natural_cmp("a", "ab"), Ordering::Less);
    }

    #[test]
    fn natural_sort_handles_pure_numbers() {
        let mut v = vec!["100", "9", "10", "1"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["1", "9", "10", "100"]);
    }

    #[test]
    fn take_number_parses_leading_digits() {
        let s = "123abc";
        let mut it = s.chars().peekable();
        assert_eq!(take_number(&mut it), 123);
        // 剩余部分应是 abc
        assert_eq!(it.collect::<String>(), "abc");
    }

    #[test]
    fn take_number_returns_zero_when_no_digits() {
        let s = "abc";
        let mut it = s.chars().peekable();
        assert_eq!(take_number(&mut it), 0);
    }

    #[test]
    fn empty_document_has_default_volume() {
        let doc = empty_document("新书").unwrap();
        assert_eq!(doc.book.title, "新书");
        assert_eq!(doc.volumes.len(), 1);
        assert!(doc.chapters.is_empty());
    }
}
