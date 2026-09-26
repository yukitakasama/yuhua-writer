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
    Ok(scan_workspace_with_dirs(workspace)?.0)
}

/// 扫描结果里的卷目录对应关系，形如 `(卷 ID, 磁盘目录名)`。
///
/// ## 为什么要把它单独交出来
///
/// 因为**目录名只能从磁盘得到，不能现算**。
/// `WorkspaceLayout::volume_dir_name(sort, title)` 是一个"生成规则"，
/// 而磁盘上的目录是历史遗留的既成事实 —— 用户手工建的目录可以叫
/// 任何名字，用户手工改过名的目录也与规则不再相符。
///
/// 回填 `workspace.json` 时必须写**真实目录名**：拿 sort+title 现算，
/// 会在"目录名与规则不符"的工作区里写进一个不存在的目录名，
/// 于是下一次扫描找不到匹配 → 从目录名兜底新建一个**同名的第二个卷**
/// （ID 却不同）。用户看到的是卷莫名其妙多了一份。
pub type VolumeDirMap = Vec<(String, String)>;

/// 扫描工作区，同时交回真实的「卷 ID ↔ 目录名」对应关系。
///
/// [`scan_workspace`] 只是它的薄封装 —— 绝大多数调用方不关心目录名，
/// 只有工作区初次打开时的回填需要（见 `AppState::open`）。
pub fn scan_workspace_with_dirs(workspace: &Workspace) -> Result<(Document, VolumeDirMap)> {
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

    // 从目录名到卷 ID 的映射，供章节挂载。
    //
    // ## 为什么必须按 `dir_name` 查表，而不能靠下标对齐
    //
    // 这里以前是 `volumes.iter().filter(|v| v.sort >= 0).nth(i)` ——
    // 它假定「第 i 个目录」对应「第 i 个 sort >= 0 的卷」。在卷的 sort
    // 恰好等于枚举下标时这成立，但配置优先之后就**不再成立**了：
    // 用户可以任意重排卷，sort 可以是 2、0、1，也可以有空洞。
    // 那时 `nth(i)` 会把目录 A 的章节挂到卷 B 下面 —— 一种
    // 「章节全在，但都跑到了错误的卷里」的静默数据错乱。
    //
    // 卷的**身份**来自它自己的目录，因此只能用目录名做键。
    //
    // 建卷与建映射在**同一个循环**里完成：两者必须共用同一套查找
    // 规则，分成两段写迟早会漂移（那正是上面那个 bug 的成因）。
    let mut volume_by_dir: std::collections::HashMap<String, yuhua_core::VolumeId> =
        std::collections::HashMap::new();

    for (i, (dir_name, _path)) in volume_dirs.iter().enumerate() {
        // ---- 配置优先、目录名兜底 ----
        //
        // 命中的卷用配置里的 id / title / sort：这正是不变量
        // 「重命名不能被扫描冲掉」的落地点。重命名走的是
        // 「写配置 → 重扫」这条路 —— 扫描若仍从目录名重建标题，
        // 那次写入就白做了。
        //
        // 未命中的目录（用户手工新建的）退回老逻辑：从目录名
        // `strip_sort_prefix` 出标题，sort 用枚举下标。
        let record = workspace.volumes().iter().find(|r| r.dir_name == *dir_name);

        let volume = match record {
            Some(record) => {
                // ID 必须沿用配置里的：它是章节挂载与索引的主键，
                // 每次扫描换一个新 ID 会让引用它的章节全部变成孤儿。
                // 配置里的 ID 解析不了（被人手改坏了）时退回新生成的，
                // 宁可换一次 ID 也不要让整个工作区打不开。
                match yuhua_core::VolumeId::parse(record.id.clone()) {
                    Ok(id) => Volume {
                        id,
                        book_id: book.id.clone(),
                        title: record.title.clone(),
                        sort: record.sort,
                        created: now,
                    },
                    Err(_) => Volume::new(&book.id, &record.title, record.sort, now),
                }
            }
            None => {
                let vol_title = strip_sort_prefix(dir_name);
                Volume::new(&book.id, &vol_title, i as i32, now)
            }
        };

        volume_by_dir.insert(dir_name.clone(), volume.id.clone());
        volumes.push(volume);
    }

    // 挂载「未分卷」章节
    if let Some(unfiled) = volumes.iter().find(|v| v.sort == -1) {
        for (sort, file) in root_chapters.iter().enumerate() {
            if let Some(ch) = load_chapter(
                file,
                &book.id,
                &unfiled.id,
                sort as i32,
                &layout.to_relative_str(file),
            ) {
                chapters.push(ch);
            }
        }
    }

    // 挂载各卷下的章节
    for (dir_name, dir_path) in &volume_dirs {
        let Some(volume_id) = volume_by_dir.get(dir_name) else {
            continue;
        };
        let files = read_chapter_files(dir_path);
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

    // 真实的「卷 ID ↔ 目录名」对应关系。
    //
    // 只包含**磁盘上真的有目录**的卷：默认卷（上面那个分支）与「未分卷」
    // 都是虚拟容器，它们没有目录名可言。调用方据此可以知道"哪些卷需要
    // 补建目录"（见 `AppState::open` 的回填）。
    let volume_dir_map: VolumeDirMap = volumes
        .iter()
        .filter(|v| v.sort >= 0)
        .filter_map(|v| {
            // 反向查：这个卷 ID 是由哪个目录建出来的
            volume_by_dir
                .iter()
                .find(|(_, id)| **id == v.id)
                .map(|(dir_name, _)| (v.id.to_string(), dir_name.clone()))
        })
        .collect();

    Ok((
        Document {
            book,
            volumes,
            chapters,
        },
        volume_dir_map,
    ))
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

/// Returns manuscript files from a volume, supporting both the legacy flat
/// layout and the chapter-directory layout. tips.md is deliberately ignored.
fn read_chapter_files(volume_dir: &Path) -> Vec<std::path::PathBuf> {
    let mut files = read_markdown_files(volume_dir);
    let Ok(entries) = std::fs::read_dir(volume_dir) else {
        return files;
    };
    let mut chapter_dirs: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    chapter_dirs.sort_by(|a, b| {
        natural_cmp(
            &a.file_name().unwrap_or_default().to_string_lossy(),
            &b.file_name().unwrap_or_default().to_string_lossy(),
        )
    });
    for dir in chapter_dirs {
        let Some(dir_name) = dir.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let canonical = dir.join(format!("{dir_name}.md"));
        if canonical.is_file() {
            files.push(canonical);
            continue;
        }
        let fallback = read_markdown_files(&dir);
        if let Some(file) = fallback.into_iter().next() {
            files.push(file);
        }
    }
    files.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
    files
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
        .filter(|e| {
            !e.file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("tips.md")
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

/// 列出 `manuscript/` 下所有卷目录名（已排序）。
///
/// 供 `state` 在回填 / 持久化卷清单时取得**磁盘上的真实目录名**。
/// 拿不到这个列表就只能靠 `volume_dir_name(sort, title)` 现算，
/// 而那个公式对用户手工建的目录并不成立（见 [`VolumeDirMap`]）。
pub fn list_volume_dir_names(layout: &WorkspaceLayout) -> Vec<String> {
    let mut names: Vec<String> = read_volume_dirs(&layout.manuscript_dir())
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    names
}

/// 去掉文件名开头的 `NNN-` 序号前缀。
///
/// `pub` 是因为 `state` 在给"配置里还没有记录的卷"找回真实目录名时，
/// 必须用**与扫描完全同一套**的推导规则 —— 两处各写一遍迟早会漂移。
pub fn strip_sort_prefix(name: &str) -> String {
    match name.split_once('-') {
        Some((prefix, rest))
            if !prefix.is_empty()
                && prefix.chars().all(|c| c.is_ascii_digit())
                && !rest.is_empty() =>
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

    // ========================================================================
    //  任务 B：配置优先的卷装配
    //
    //  这些用例钉的是 `scan.rs` 里那句被替换掉的
    //  `volumes.iter().filter(|v| v.sort >= 0).nth(i)`。那个写法假定
    //  「第 i 个目录」对应「第 i 个 sort >= 0 的卷」，只在
    //  sort 恰好等于枚举下标时成立。
    // ========================================================================

    /// 造一个工作区，写好几个卷目录与章节文件。
    ///
    /// 返回 (临时目录, Workspace)。临时目录必须由调用方持有 ——
    /// `tempfile::TempDir` 一 drop 目录就整个删掉了。
    fn workspace_with_volumes(dirs: &[&str]) -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::create(dir.path().join("ws"), "书").unwrap();
        for d in dirs {
            let vol_dir = ws.layout.manuscript_dir().join(d);
            std::fs::create_dir_all(&vol_dir).unwrap();
            std::fs::write(vol_dir.join("001-第一章.md"), "正文").unwrap();
        }
        (dir, ws)
    }

    #[test]
    fn scan_reads_chapter_directories_and_ignores_tips() {
        let (_dir, ws) = workspace_with_volumes(&[]);
        let volume_dir = ws.layout.manuscript_dir().join("001-第一卷");
        let chapter_dir = volume_dir.join("001-第一章 落羽");
        std::fs::create_dir_all(&chapter_dir).unwrap();
        std::fs::write(chapter_dir.join("001-第一章 落羽.md"), "正文").unwrap();
        std::fs::write(chapter_dir.join("tips.md"), "写作提示").unwrap();

        let doc = scan_workspace(&ws).unwrap();

        assert_eq!(doc.chapters.len(), 1);
        assert!(doc.chapters[0]
            .path
            .ends_with("manuscript/001-第一卷/001-第一章 落羽/001-第一章 落羽.md"));
    }

    #[test]
    fn scan_falls_back_to_directory_names_when_config_is_empty() {
        // 旧工作区（配置里没有 volumes）：按目录名推导，序号用枚举下标
        let (_dir, ws) = workspace_with_volumes(&["001-第一卷 风起", "002-第二卷 惊蛰"]);
        assert!(ws.volumes().is_empty(), "前提：配置里还没有卷清单");

        let doc = scan_workspace(&ws).unwrap();

        let titles: Vec<&str> = doc.volumes.iter().map(|v| v.title.as_str()).collect();
        assert_eq!(titles, vec!["第一卷 风起", "第二卷 惊蛰"]);
        let sorts: Vec<i32> = doc.volumes.iter().map(|v| v.sort).collect();
        assert_eq!(sorts, vec![0, 1]);
        // 章节必须挂到各自的卷上
        assert_eq!(doc.chapters.len(), 2);
    }

    #[test]
    fn scan_prefers_config_title_over_directory_name() {
        // 核心回归：目录名还是旧的 `001-第一卷 风起`，配置里已经改名。
        // 扫描必须用配置里的新名字 —— 否则重命名会被重扫冲掉。
        let (_dir, mut ws) = workspace_with_volumes(&["001-第一卷 风起"]);
        ws.save_volumes(&[yuhua_fs::workspace::VolumeRecord {
            id: "vol_renamed".into(),
            title: "改过的卷名".into(),
            sort: 0,
            dir_name: "001-第一卷 风起".into(),
        }])
        .unwrap();

        let doc = scan_workspace(&ws).unwrap();

        assert_eq!(doc.volumes.len(), 1);
        assert_eq!(doc.volumes[0].title, "改过的卷名");
        assert_eq!(doc.volumes[0].id.as_str(), "vol_renamed");
    }

    #[test]
    fn scan_maps_chapters_by_dir_name_not_by_position() {
        // ## 这是本次改动最容易引入新 bug 的地方
        //
        // 三个目录，配置里的 sort 是 2 / 0 / 1 —— 与目录的枚举顺序
        // **完全错开**。旧的 `nth(i)` 会把目录 A 的章节挂到卷 C 上。
        // 现在按 dir_name 查表，必须各归各位。
        let (_dir, mut ws) = workspace_with_volumes(&["001-甲卷", "002-乙卷", "003-丙卷"]);
        ws.save_volumes(&[
            yuhua_fs::workspace::VolumeRecord {
                id: "vol_jia".into(),
                title: "甲卷".into(),
                sort: 2,
                dir_name: "001-甲卷".into(),
            },
            yuhua_fs::workspace::VolumeRecord {
                id: "vol_yi".into(),
                title: "乙卷".into(),
                sort: 0,
                dir_name: "002-乙卷".into(),
            },
            yuhua_fs::workspace::VolumeRecord {
                id: "vol_bing".into(),
                title: "丙卷".into(),
                sort: 1,
                dir_name: "003-丙卷".into(),
            },
        ])
        .unwrap();

        let doc = scan_workspace(&ws).unwrap();

        assert_eq!(doc.volumes.len(), 3);
        assert_eq!(doc.chapters.len(), 3, "三个目录各有一章，一章都不能丢");

        // 每章的 volume_id 必须指向它**自己那个目录**对应的卷
        let id_of = |dir_marker: &str| -> String {
            doc.chapters
                .iter()
                .find(|c| c.path.contains(dir_marker))
                .unwrap_or_else(|| panic!("找不到 {dir_marker} 下的章节"))
                .volume_id
                .to_string()
        };
        assert_eq!(id_of("001-甲卷"), "vol_jia");
        assert_eq!(id_of("002-乙卷"), "vol_yi");
        assert_eq!(id_of("003-丙卷"), "vol_bing");

        // 顺带钉死 sort 不参与位置对齐这件事
        let sorts: Vec<i32> = doc.volumes.iter().map(|v| v.sort).collect();
        assert_eq!(sorts, vec![2, 0, 1], "sort 来自配置，不应被枚举下标覆盖");
    }

    #[test]
    fn scan_handles_manual_directory_without_config_record() {
        // 用户手工新建了一个目录：配置里没有它，走兜底路径。
        // 配置里那条 sort=5 的卷不存在于磁盘上，因此**不该**被建出来
        // （磁盘是稿件内容的唯一权威）。
        let (_dir, mut ws) = workspace_with_volumes(&["001-甲卷", "002-手工新建"]);
        ws.save_volumes(&[yuhua_fs::workspace::VolumeRecord {
            id: "vol_jia".into(),
            title: "甲卷".into(),
            sort: 5,
            dir_name: "001-甲卷".into(),
        }])
        .unwrap();

        let doc = scan_workspace(&ws).unwrap();

        assert_eq!(doc.volumes.len(), 2, "配置里不存在的卷不该凭配置造出来");
        // 命中的那个用配置的 id 与 sort
        let jia = doc
            .volumes
            .iter()
            .find(|v| v.id.as_str() == "vol_jia")
            .unwrap();
        assert_eq!(jia.sort, 5);
        // 未命中的那个从目录名推导
        assert!(doc.volumes.iter().any(|v| v.title == "手工新建"));
    }

    #[test]
    fn scan_keeps_config_volume_id_stable_across_calls() {
        // ID 稳定性：扫描是幂等的，不能每次给同一个卷换一个新 ID ——
        // 那会让索引里引用它的章节全部变成孤儿。
        let (_dir, mut ws) = workspace_with_volumes(&["001-甲卷"]);
        ws.save_volumes(&[yuhua_fs::workspace::VolumeRecord {
            id: "vol_stable".into(),
            title: "甲卷".into(),
            sort: 0,
            dir_name: "001-甲卷".into(),
        }])
        .unwrap();

        let first = scan_workspace(&ws).unwrap();
        let second = scan_workspace(&ws).unwrap();

        assert_eq!(first.volumes[0].id.as_str(), "vol_stable");
        assert_eq!(first.volumes[0].id, second.volumes[0].id);
        assert_eq!(first.chapters[0].volume_id, second.chapters[0].volume_id);
    }
}
