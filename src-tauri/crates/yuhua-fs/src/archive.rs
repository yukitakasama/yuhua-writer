//! 工作区归档（T2.14，Should 项）。
//!
//! ## 这个功能为谁而做
//!
//! 三个真实场景：
//!
//! 1. **换机器**。作者要把整本书拷到另一台电脑上。工作区是一堆目录，
//!    直接拷当然也行，但"打包成一个文件"更适合走微信 / 网盘。
//! 2. **给别人看稿**。编辑要一份可以直接打开的项目副本。
//! 3. **动手前的快照**。作者要在做一次大改（重排卷章、删掉一整卷）
//!    之前先存一个"现在这样"的包，出事还能回来。
//!
//! ## 归档里放什么、不放什么
//!
//! **放**：`manuscript/`、`outline/`、`characters/`、`worldbuilding/`、
//! `.yuhua/workspace.json`（工作区配置，没有它这个包就不算工作区）。
//!
//! **不放**：
//!
//! - `.trash/` 回收站。作者导出的是"作品"，不是"垃圾"。回收站里
//!   可能有几百 MB 的历史版本，放进包里既拖慢传输，又让"这个包有多大"
//!   变得不可预期。
//! - `.yuhua/backup/` 与 `.yuhua/journal/`。轮转备份是**本机的**
//!   崩溃保护，跟着包走没有意义（到别的机器上会立刻被轮转策略清掉）。
//!   恢复历史版本应当用版本控制或云盘，而不是靠归档包。
//! - `.yuhua/stats/`。写作统计是"这台设备上我的进度"，它有自己的
//!   跨设备合并策略（见 `yuhua-stats`）。塞进归档会让"合并"与
//!   "覆盖"两种语义混淆。
//!
//! ## 为什么与导出引擎分开
//!
//! 导出引擎产出的是**给读者看的成品**（TXT/DOCX/EPUB）；归档产出的是
//! **给作者或工具用的工程副本**，它的正确性判据是"解压后再打开还是
//! 一个完整工作区"，而不是"排版好不好看"。两者的输入、输出、
//! 测试方式都不同，因此不共用代码路径。

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use yuhua_core::{Result, YuhuaError};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::layout::{BACKUP_DIR, CONFIG_FILE, ENGINE_DIR, JOURNAL_DIR, TRASH_DIR};

/// 归档文件的默认扩展名。
pub const ARCHIVE_EXTENSION: &str = "yuhua";

/// 归档里的清单文件名。
///
/// 为什么要有清单：解压一个包时，工具需要**先**知道这是什么、
/// 格式版本是多少，才能决定要不要迁移。让调用方去猜"有没有
/// `.yuhua/workspace.json`"是不可靠的（老版本可能没有）。
pub const MANIFEST_NAME: &str = "archive.json";

/// 当前归档格式版本。
pub const ARCHIVE_VERSION: u32 = 1;

/// 读缓冲大小。
///
/// 64 KiB 是"单次系统调用不太碎、内存占用可忽略"的常用折中值。
/// 这个值决定了归档的内存峰值：**峰值约等于一个缓冲区加上
/// zip 内部的压缩窗口**，与工作区总大小无关。
const BUFFER_SIZE: usize = 64 * 1024;

/// 归档清单。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveManifest {
    /// 归档格式版本。
    pub archive_version: u32,
    /// 工作区格式版本（来自 `workspace.json`）。
    pub workspace_format_version: u32,
    /// 书名。
    pub title: String,
    /// 打包时间（RFC 3339）。
    pub created: String,
    /// 归档时的章节数，供解压前预览。
    pub chapter_count: usize,
    /// 归档时的总字节数（未压缩），供解压前预览。
    pub raw_bytes: u64,
    /// 打包工具标识。
    pub tool: String,
}

/// 打包统计。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArchiveStats {
    /// 写入的文件数。
    pub file_count: usize,
    /// 未压缩总字节数。
    pub raw_bytes: u64,
    /// 产出的归档字节数。
    pub archive_bytes: u64,
}

/// 归档选项。
#[derive(Debug, Clone)]
pub struct ArchiveOptions {
    /// 压缩级别（0–9）。0 表示不压缩。
    ///
    /// 默认 6：文本压缩到这个级别后再往上加，基本只是让打包变慢，
    /// 体积收益很小（Markdown 的可压缩性在级别 6 附近已经吃满）。
    pub level: i64,
    /// 是否包含回收站。默认 false（见模块说明）。
    pub include_trash: bool,
    /// 打包工具标识，写进清单。
    pub tool: String,
}

impl Default for ArchiveOptions {
    fn default() -> Self {
        Self {
            level: 6,
            include_trash: false,
            tool: format!("yuhua-writer {}", env!("CARGO_PKG_VERSION")),
        }
    }
}

/// 把一条消息包成 `InvalidInput`。
///
/// ## 为什么错误类型是 `InvalidInput` 而不是 `Io`
///
/// `YuhuaError::Io` 要求携带原始的 `std::io::Error` 作为 source，
/// 而"归档里有一个越界条目"这类问题**根本没有底层 io 错误** ——
/// 硬造一个会把"文件读不出来"和"包被人改过"混成同一类，
/// 让前端的错误提示没法区分该不该让用户重试。
fn invalid(message: impl Into<String>) -> YuhuaError {
    YuhuaError::InvalidInput(message.into())
}

/// 把 io 错误附上正在操作的路径。
fn io_at(path: impl Into<PathBuf>, err: std::io::Error) -> YuhuaError {
    YuhuaError::io(path, err)
}

/// 判断一个工作区内的相对路径是否应当被排除在归档之外。
///
/// 抽成独立函数是为了**可测试**：这条规则决定了"作者的稿子会不会
/// 被漏掉"，也决定了"包里会不会混进几百 MB 垃圾"，两者都是
/// 不能靠人工点点点来确认的。
pub fn should_exclude(relative: &str, include_trash: bool) -> bool {
    let normalized = relative.replace(BACKSLASH, "/");

    // 引擎目录下的可再生数据
    for dir in [BACKUP_DIR, JOURNAL_DIR, "stats"] {
        let prefix = format!("{ENGINE_DIR}/{dir}");
        if normalized == prefix || normalized.starts_with(&format!("{prefix}/")) {
            return true;
        }
    }

    if !include_trash
        && (normalized == TRASH_DIR || normalized.starts_with(&format!("{TRASH_DIR}/")))
    {
        return true;
    }

    // 临时文件：原子写的中间产物，绝不能进包。
    // 判据放在最后是因为它可能出现在任何目录下
    normalized.ends_with(".tmp") || normalized.ends_with(".yuhua-tmp")
}

/// 把一个工作区打包成 zip。
///
/// ## 为什么流式写盘而不是先在内存里拼好
///
/// 一本 100 万字的书光 Markdown 就有 3 MB 左右，但加上大纲、人物卡、
/// 设定资料与可能的图片，几百 MB 是常态。先在内存里拼完整包会让
/// 内存峰值等于工作区大小 —— 这直接违反计划书的不变量 5。
/// 因此这里边读边写，峰值内存约等于"一个读缓冲 + 压缩窗口"。
pub fn archive_workspace(
    root: &Path,
    out: &Path,
    options: &ArchiveOptions,
) -> Result<ArchiveStats> {
    let root = root
        .canonicalize()
        .map_err(|e| io_at(root.to_path_buf(), e))?;

    // 先收一份清单：要打进去哪些文件。
    // 边遍历边写会让"这个包有多大"无从统计，也让清单无法先写进包
    let entries = collect_entries(&root, options)?;

    let chapter_count = entries
        .iter()
        .filter(|e| e.relative.ends_with(".md") && e.relative.starts_with("manuscript/"))
        .count();
    let raw_bytes: u64 = entries.iter().map(|e| e.size).sum();

    let manifest = ArchiveManifest {
        archive_version: ARCHIVE_VERSION,
        workspace_format_version: read_format_version(&root),
        title: read_workspace_title(&root).unwrap_or_else(|| "未命名".to_string()),
        created: chrono::Utc::now().to_rfc3339(),
        chapter_count,
        raw_bytes,
        tool: options.tool.clone(),
    };

    // 原子产出：先写临时文件，成功后 rename。
    // 与 yuhua-fs 的其它写操作保持一致 —— 作者不该看到半截的包
    let temp_path = out.with_extension(format!("{ARCHIVE_EXTENSION}.tmp"));
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| io_at(parent.to_path_buf(), e))?;
        }
    }

    match write_archive(&entries, &manifest, &temp_path, out, options) {
        Ok(bytes) => Ok(ArchiveStats {
            file_count: entries.len(),
            raw_bytes,
            archive_bytes: bytes,
        }),
        Err(err) => {
            // 失败时清掉临时文件，不给作者留下一个"看起来像成品"的残骸
            let _ = std::fs::remove_file(&temp_path);
            Err(err)
        }
    }
}

/// 实际写包的内部实现。
fn write_archive(
    entries: &[ArchiveEntry],
    manifest: &ArchiveManifest,
    temp_path: &Path,
    out: &Path,
    options: &ArchiveOptions,
) -> Result<u64> {
    let file = File::create(temp_path).map_err(|e| io_at(temp_path.to_path_buf(), e))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));

    // ## level 的语义
    //
    // `level <= 0` 表示**不压缩**（Stored）。这里必须把 level 设成
    // `None` 而不是 `Some(0)`：zip 库会拒绝"Stored + 0 级"这个组合
    // （Stored 压根没有压缩级别这个概念），报的是
    // "Unsupported compression level"，而调用方从这条消息里
    // 完全看不出是自己传了 0。
    //
    // `level` 同时夹进 1..=9：zip 库只接受这个区间，
    // 传 10 同样会失败。与其让调用方踩一次，不如在这里收敛。
    let compress = options.level > 0;
    let level = options.level.clamp(1, 9);
    let method = if compress {
        CompressionMethod::Deflated
    } else {
        CompressionMethod::Stored
    };
    let file_options = SimpleFileOptions::default()
        .compression_method(method)
        .compression_level(if compress { Some(level) } else { None })
        // 时间戳统一用固定值：同样的内容在任何时候打包都应当得到
        // 逐字节相同的包（可复现）。用当前时间会让"两次打包结果
        // 不一致"成为常态，那样就没法用哈希确认包没被改过
        .last_modified_time(zip::DateTime::default());

    // 清单必须第一个写入：解压工具应当能在不读完整个包的情况下
    // 知道这是什么格式
    let manifest_json = serde_json::to_vec_pretty(manifest)
        .map_err(|e| invalid(format!("清单序列化失败：{}", e)))?;
    zip.start_file(MANIFEST_NAME, file_options)
        .map_err(|e| invalid(format!("写入清单失败：{}", e)))?;
    zip.write_all(&manifest_json)
        .map_err(|e| invalid(format!("写入清单失败：{}", e)))?;

    let mut buffer = vec![0u8; BUFFER_SIZE];
    for entry in entries {
        zip.start_file(entry.relative.clone(), file_options)
            .map_err(|e| invalid(format!("写入 {} 失败：{}", entry.relative, e)))?;
        let mut source = BufReader::new(
            File::open(&entry.absolute).map_err(|e| io_at(entry.absolute.clone(), e))?,
        );
        loop {
            let n = source
                .read(&mut buffer)
                .map_err(|e| io_at(entry.absolute.clone(), e))?;
            if n == 0 {
                break;
            }
            zip.write_all(&buffer[..n])
                .map_err(|e| invalid(format!("写入 {} 失败：{}", entry.relative, e)))?;
        }
    }

    let writer = zip
        .finish()
        .map_err(|e| invalid(format!("收尾归档失败：{}", e)))?;
    let inner = writer
        .into_inner()
        .map_err(|e| invalid(format!("刷新归档失败：{}", e)))?;
    inner
        .sync_all()
        .map_err(|e| io_at(temp_path.to_path_buf(), e))?;

    // 原子替换
    std::fs::rename(temp_path, out).map_err(|e| io_at(out.to_path_buf(), e))?;

    let size = std::fs::metadata(out)
        .map_err(|e| io_at(out.to_path_buf(), e))?
        .len();
    Ok(size)
}

/// 归档里的一个待写入条目。
#[derive(Debug, Clone)]
struct ArchiveEntry {
    /// 相对工作区根的路径，用 `/` 分隔（zip 规范要求）。
    relative: String,
    /// 磁盘上的绝对路径。
    absolute: PathBuf,
    /// 文件大小，用于统计。
    size: u64,
}

/// 收集要打包的文件。
fn collect_entries(root: &Path, options: &ArchiveOptions) -> Result<Vec<ArchiveEntry>> {
    let mut out = Vec::new();
    walk(root, root, options, &mut out)?;
    // 排序让打包结果**稳定**：目录遍历顺序由文件系统决定，不稳定的话
    // 同样的工作区两次打包会得到不同的字节，那"可复现"就无从谈起
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
}

/// 递归遍历。
fn walk(
    root: &Path,
    dir: &Path,
    options: &ArchiveOptions,
    out: &mut Vec<ArchiveEntry>,
) -> Result<()> {
    let reader = std::fs::read_dir(dir).map_err(|e| io_at(dir.to_path_buf(), e))?;
    for item in reader {
        let item = item.map_err(|e| io_at(dir.to_path_buf(), e))?;
        let path = item.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| invalid(format!("路径 {} 不在工作区内", path.display())))?
            .to_string_lossy()
            .replace(BACKSLASH, "/");

        if should_exclude(&relative, options.include_trash) {
            continue;
        }

        let meta = std::fs::symlink_metadata(&path).map_err(|e| io_at(path.clone(), e))?;

        // 符号链接一律跳过：跟着链走可能跑出工作区，甚至成环。
        // 写作工作区里没有需要符号链接的场景，跳过是安全的
        if meta.file_type().is_symlink() {
            continue;
        }

        if meta.is_dir() {
            walk(root, &path, options, out)?;
        } else if meta.is_file() {
            out.push(ArchiveEntry {
                relative,
                absolute: path,
                size: meta.len(),
            });
        }
    }
    Ok(())
}

/// 读工作区配置文件的 JSON。读不到或解析失败都返回 `None` ——
/// 归档本身不该因为配置有点小问题就整包失败。
fn read_config(root: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(root.join(ENGINE_DIR).join(CONFIG_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// 读工作区配置里的书名。
fn read_workspace_title(root: &Path) -> Option<String> {
    read_config(root)?
        .get("title")?
        .as_str()
        .map(str::to_string)
}

/// 读工作区格式版本。
fn read_format_version(root: &Path) -> u32 {
    read_config(root)
        .and_then(|v| v.get("formatVersion").and_then(serde_json::Value::as_u64))
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(crate::layout::FORMAT_VERSION)
}

/// 解包结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedArchive {
    /// 清单。
    pub manifest: ArchiveManifest,
    /// 解出的文件数。
    pub file_count: usize,
    /// 解出的总字节数。
    pub total_bytes: u64,
}

/// 把一个归档解到目标目录。
///
/// ## 为什么必须自己做路径校验而不是信任 zip 里的条目名
///
/// 这是经典的 **Zip Slip** 漏洞：恶意（或损坏）的归档里可以有
/// `../../passwd` 这样的条目名，天真地 `join` 就会写到目标目录
/// 之外。作者的归档包会经过微信 / 网盘传递，完全不可信，
/// 因此这里的校验不是可选项。
pub fn extract_archive(archive: &Path, dest: &Path) -> Result<ExtractedArchive> {
    let file = File::open(archive).map_err(|e| io_at(archive.to_path_buf(), e))?;
    let mut zip = ZipArchive::new(BufReader::new(file))
        .map_err(|e| invalid(format!("归档格式不正确：{}", e)))?;

    std::fs::create_dir_all(dest).map_err(|e| io_at(dest.to_path_buf(), e))?;
    let dest_canonical = dest
        .canonicalize()
        .map_err(|e| io_at(dest.to_path_buf(), e))?;

    let manifest = read_manifest_from_zip(&mut zip)?;
    if manifest.archive_version > ARCHIVE_VERSION {
        return Err(invalid(format!(
            "这个归档来自更新的版本（格式 v{}，本机支持到 v{}），请先升级羽化写作",
            manifest.archive_version, ARCHIVE_VERSION
        )));
    }

    let mut buffer = vec![0u8; BUFFER_SIZE];
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;

    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|e| invalid(format!("读取归档条目失败：{}", e)))?;
        let name = entry.name().to_string();
        if name == MANIFEST_NAME {
            continue;
        }
        let target = safe_join(&dest_canonical, &name)?;

        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| io_at(target.clone(), e))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_at(parent.to_path_buf(), e))?;
        }

        let mut out = BufWriter::new(File::create(&target).map_err(|e| io_at(target.clone(), e))?);
        loop {
            let n = entry
                .read(&mut buffer)
                .map_err(|e| invalid(format!("解压 {} 失败：{}", name, e)))?;
            if n == 0 {
                break;
            }
            out.write_all(&buffer[..n])
                .map_err(|e| io_at(target.clone(), e))?;
            total_bytes += n as u64;
        }
        out.flush().map_err(|e| io_at(target.clone(), e))?;
        file_count += 1;
    }

    Ok(ExtractedArchive {
        manifest,
        file_count,
        total_bytes,
    })
}

/// 把归档条目名安全地接到目标目录下。
///
/// 三重检查（绝对路径、盘符、`..`）有重叠，但都保留：
/// 只靠其中任何一条都会在某种边界上漏掉。
pub fn safe_join(dest: &Path, name: &str) -> Result<PathBuf> {
    let normalized = name.replace(BACKSLASH, "/");

    if normalized.starts_with('/') || has_drive_prefix(&normalized) {
        return Err(invalid(format!("归档里有绝对路径条目：{}", name)));
    }

    // 逐段检查：不做文件系统解析，因此目标目录还不存在也能判
    for component in Path::new(&normalized).components() {
        match component {
            Component::ParentDir => {
                return Err(invalid(format!("归档里有越界条目：{}", name)));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(invalid(format!("归档里有绝对路径条目：{}", name)));
            }
            _ => {}
        }
    }

    Ok(dest.join(&normalized))
}

/// 只读归档的清单，不解压。
///
/// 用于"打开前先看看这是什么"的预览界面。
pub fn read_manifest(archive: &Path) -> Result<ArchiveManifest> {
    let file = File::open(archive).map_err(|e| io_at(archive.to_path_buf(), e))?;
    let mut zip = ZipArchive::new(BufReader::new(file))
        .map_err(|e| invalid(format!("归档格式不正确：{}", e)))?;
    read_manifest_from_zip(&mut zip)
}

/// 从任意 `Read + Seek` 读清单（供测试与流式场景使用）。
pub fn read_manifest_from<R: Read + Seek>(reader: R) -> Result<ArchiveManifest> {
    let mut zip = ZipArchive::new(reader).map_err(|e| invalid(format!("归档格式不正确：{}", e)))?;
    read_manifest_from_zip(&mut zip)
}

/// 从一个已打开的归档里取清单。
fn read_manifest_from_zip<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Result<ArchiveManifest> {
    let mut entry = zip
        .by_name(MANIFEST_NAME)
        .map_err(|_| invalid("归档里没有清单文件，可能不是羽化写作的归档"))?;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|e| invalid(format!("读取清单失败：{}", e)))?;
    serde_json::from_str(&text).map_err(|e| invalid(format!("清单解析失败：{}", e)))
}

/// 判断是否有 Windows 盘符前缀（`C:` / `C:/`）。
fn has_drive_prefix(path: &str) -> bool {
    let chars: Vec<char> = path.chars().take(3).collect();
    chars.len() == 3
        && chars[0].is_ascii_alphabetic()
        && chars[1] == ':'
        && (chars[2] == '/' || chars[2] == BACKSLASH)
}

/// 反斜杠字符。
///
/// 用常量而不是字面量 `'\\'`：这个字符在源文件里要写成两个反斜杠，
/// 在补丁、正则、模板里反复出现时非常容易把转义层数搞错 ——
/// 一旦写错就是一个语法错误，或者更糟：静默匹配到错误的东西。
const BACKSLASH: char = '\\';
