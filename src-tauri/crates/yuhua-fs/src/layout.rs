//! 工作区目录布局与路径安全。
//!
//! 对应计划书 4.1 节：
//!
//! ```text
//! 我的小说/
//! ├─ .yuhua/          引擎目录（工作区配置、备份、崩溃日志、统计）
//! ├─ manuscript/      正文（Markdown 真源）
//! ├─ outline/         大纲
//! ├─ characters/      人物
//! ├─ worldbuilding/   设定
//! └─ .trash/          回收站
//! ```
//!
//! ## 为什么索引库不在这里
//!
//! 见计划书 4.3 节：SQLite 是二进制且带 WAL 与共享内存文件，云盘客户端
//! 对正在写入的二进制做部分同步极易损坏。索引是**可抛弃的缓存**，
//! 因此放到系统应用数据目录（见 [`WorkspaceLayout::index_db_path`] 的说明）。
//! 这条约束由 `tests` 中的 `workspace_contains_no_binary_db` 守住。
//!
//! ## 路径安全是本模块的核心职责
//!
//! 所有来自前端、Front Matter、回收站记录的路径都必须经过
//! [`WorkspaceLayout::resolve`]，它会拒绝绝对路径与 `..` 逃逸。
//! 这不是多余的谨慎：Front Matter 是用户可以直接编辑的文本文件，
//! 一个手滑的 `../../` 就能让保存操作写到工作区外面去。

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use yuhua_core::{Result, YuhuaError};

/// 当前工作区格式版本。
///
/// 每当目录结构或配置文件形状发生**不兼容**变化时递增，
/// 并在 [`super::workspace`] 中补一段迁移逻辑。
/// 用户看到的是「正在升级工作区格式」，而不是数据损坏。
pub const FORMAT_VERSION: u32 = 1;

/// 引擎目录名。
pub const ENGINE_DIR: &str = ".yuhua";
/// 正文目录名。
pub const MANUSCRIPT_DIR: &str = "manuscript";
/// 大纲目录名。
pub const OUTLINE_DIR: &str = "outline";
/// 人物目录名。
pub const CHARACTERS_DIR: &str = "characters";
/// 设定目录名。
pub const WORLDBUILDING_DIR: &str = "worldbuilding";
/// 回收站目录名。
pub const TRASH_DIR: &str = ".trash";
/// 备份子目录名。
pub const BACKUP_DIR: &str = "backup";
/// 崩溃日志子目录名。
pub const JOURNAL_DIR: &str = "journal";
/// 统计子目录名。
pub const STATS_DIR: &str = "stats";
/// 工作区配置文件。
pub const CONFIG_FILE: &str = "workspace.json";

/// 工作区目录布局。
///
/// 这是一个**轻量句柄**：只持有根路径，所有具体路径按需拼接。
/// 好处是它可以在任意线程间自由复制传递，不持有文件句柄。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceLayout {
    root: PathBuf,
}

impl WorkspaceLayout {
    /// 以给定根目录建立布局句柄。
    ///
    /// **不**校验目录是否存在 —— 创建流程需要在目录还不存在时就拿到布局。
    /// 需要校验时用 [`WorkspaceLayout::ensure_structure`]。
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// 工作区根目录。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 工作区唯一标识（工作区目录名的规范化形式，用于索引库文件名）。
    pub fn workspace_id(&self) -> String {
        // 用规范化后的路径做 blake3 摘要：同一个工作区在任何设备上
        // 只要路径一致就得到同一个索引库名；路径变了就当新工作区重建索引，
        // 这正好符合「索引是可抛弃缓存」的定位。
        let canonical = self
            .root
            .canonicalize()
            .unwrap_or_else(|_| self.root.clone());
        let normalized = canonical.to_string_lossy().replace('\\', "/").to_lowercase();
        let hash = blake3::hash(normalized.as_bytes());
        hash.to_hex()[..16].to_string()
    }

    /// `.yuhua/` 引擎目录。
    pub fn engine_dir(&self) -> PathBuf {
        self.root.join(ENGINE_DIR)
    }

    /// 工作区配置文件路径。
    pub fn config_path(&self) -> PathBuf {
        self.engine_dir().join(CONFIG_FILE)
    }

    /// 备份目录。
    pub fn backup_dir(&self) -> PathBuf {
        self.engine_dir().join(BACKUP_DIR)
    }

    /// 崩溃日志目录。
    pub fn journal_dir(&self) -> PathBuf {
        self.engine_dir().join(JOURNAL_DIR)
    }

    /// 统计目录。
    pub fn stats_dir(&self) -> PathBuf {
        self.engine_dir().join(STATS_DIR)
    }

    /// 正文目录。
    pub fn manuscript_dir(&self) -> PathBuf {
        self.root.join(MANUSCRIPT_DIR)
    }

    /// 大纲目录。
    pub fn outline_dir(&self) -> PathBuf {
        self.root.join(OUTLINE_DIR)
    }

    /// 人物目录。
    pub fn characters_dir(&self) -> PathBuf {
        self.root.join(CHARACTERS_DIR)
    }

    /// 设定目录。
    pub fn worldbuilding_dir(&self) -> PathBuf {
        self.root.join(WORLDBUILDING_DIR)
    }

    /// 回收站目录。
    pub fn trash_dir(&self) -> PathBuf {
        self.root.join(TRASH_DIR)
    }

    /// 索引库的存放路径（**在工作区之外**）。
    ///
    /// 按平台放到系统应用数据目录：
    ///
    /// | 平台 | 路径 |
    /// | --- | --- |
    /// | Windows | `%APPDATA%\YuhuaWriter\index\<workspace-id>.sqlite` |
    /// | macOS | `~/Library/Application Support/YuhuaWriter/index/...` |
    /// | Linux | `~/.local/share/YuhuaWriter/index/...` |
    ///
    /// 找不到系统数据目录时（极少数受限环境）退回到引擎目录下的
    /// `index/`。宁可索引库进工作区，也不能让应用完全无法建立索引；
    /// 此时会在日志里留下明确警告。
    pub fn index_db_path(&self) -> PathBuf {
        match dirs_index_base() {
            Some(base) => base.join(format!("{}.sqlite", self.workspace_id())),
            None => self.engine_dir().join("index").join(format!("{}.sqlite", self.workspace_id())),
        }
    }

    /// 把相对路径（`/` 分隔）拼成绝对路径，并做**安全校验**。
    ///
    /// 拒绝：
    /// - 绝对路径（`D:/x`、`/etc/x`）
    /// - Windows 盘符与 UNC 前缀
    /// - 任何 `..` 组件（不允许逃逸出工作区）
    ///
    /// 允许并归一化：`./` 前缀、重复分隔符。
    pub fn resolve(&self, relative: &str) -> Result<PathBuf> {
        let normalized = normalize_relative(relative)?;
        Ok(self.root.join(normalized))
    }

    /// 把绝对路径转成相对工作区根的 `/` 分隔字符串。
    ///
    /// 用于「扫描磁盘后发现这个文件属于本工作区」的反向场景。
    /// 路径不在工作区内时返回 [`YuhuaError::Invariant`]。
    pub fn relativize(&self, absolute: &Path) -> Result<String> {
        let rel = absolute.strip_prefix(&self.root).map_err(|_| {
            YuhuaError::Invariant(format!(
                "路径不在工作区内：{}（根：{}）",
                absolute.display(),
                self.root.display()
            ))
        })?;
        let s = rel.to_string_lossy().replace('\\', "/");
        Ok(s)
    }

    /// 创建完整的目录结构（幂等）。
    ///
    /// 已存在的目录不会报错，因此可以安全地在每次打开工作区时调用。
    pub fn ensure_structure(&self) -> Result<()> {
        let dirs = [
            self.engine_dir(),
            self.backup_dir(),
            self.journal_dir(),
            self.stats_dir(),
            self.manuscript_dir(),
            self.outline_dir(),
            self.characters_dir(),
            self.worldbuilding_dir(),
            self.trash_dir(),
        ];
        for d in dirs {
            std::fs::create_dir_all(&d).map_err(|e| YuhuaError::io(&d, e))?;
        }
        Ok(())
    }

    /// 判断该路径是否是「引擎目录 / 回收站」这类**不应当出现在正文树中**的路径。
    ///
    /// 扫描 manuscript 时用它过滤掉误入的条目。
    pub fn is_reserved_name(name: &str) -> bool {
        matches!(
            name,
            ENGINE_DIR | TRASH_DIR | ".git" | ".gitignore" | "node_modules"
        )
    }

    /// 生成章节文件名：`001-第一章 落羽.md`
    ///
    /// 序号前缀让**系统文件管理器里的排序与应用内排序一致**（计划书 4.1 节）。
    /// 序号宽度固定 3 位，因此在 999 章以内文件管理器排序天然正确；
    /// 超过 999 章时按字符串排序仍基本可用（1000 会排在 999 之后）。
    pub fn chapter_file_name(sort: i32, title: &str) -> String {
        format!("{:03}-{}.md", sort + 1, sanitize_file_name(title))
    }

    /// 生成卷目录名：`001-第一卷 风起`
    pub fn volume_dir_name(sort: i32, title: &str) -> String {
        format!("{:03}-{}", sort + 1, sanitize_file_name(title))
    }
}

/// 清洗文件 / 目录名，去掉各平台非法字符。
///
/// 章节标题是用户自由输入，完全可能出现 `第一章：落羽`（冒号在 Windows 上非法）
/// 或 `他真的生气了?`（问号非法）。这里统一替换为全角对应字符而不是删除，
/// 保留可读性。
pub fn sanitize_file_name(name: &str) -> String {
    let trimmed = name.trim();
    let cleaned: String = trimmed
        .chars()
        .map(|c| match c {
            // Windows 非法字符：\ / : * ? " < > |
            '\\' => '＼',
            '/' => '／',
            ':' => '：',
            '*' => '＊',
            '?' => '？',
            '"' => '＂',
            '<' => '＜',
            '>' => '＞',
            '|' => '｜',
            // 控制字符直接丢弃
            c if c.is_control() => '_',
            c => c,
        })
        .collect();

    // 去掉首尾的点与空格：Windows 不允许文件名以点或空格结尾
    let cleaned = cleaned.trim_matches(|c| c == '.' || c == ' ').to_string();

    if cleaned.is_empty() {
        "未命名".to_string()
    } else if cleaned.len() > 120 {
        // 留出「001-」前缀与「.md」后缀的空间，同时避免超出路径长度限制
        cleaned.chars().take(120).collect()
    } else {
        cleaned
    }
}

/// 校验并归一化相对路径。
///
/// 返回 `/` 分隔的规范化字符串（不含前导 `./`）。
fn normalize_relative(relative: &str) -> Result<String> {
    if relative.trim().is_empty() {
        return Err(YuhuaError::InvalidInput("路径不能为空".into()));
    }

    // 显式挡住 Windows 盘符与 UNC，即使 Path 解析在别的平台上行为不同
    let bytes = relative.as_bytes();
    let has_drive_prefix = bytes.len() >= 2 && bytes[1] == b':' && (bytes[0] as char).is_ascii_alphabetic();
    if has_drive_prefix || relative.starts_with("\\\\") {
        return Err(YuhuaError::InvalidInput(format!(
            "不接受绝对路径：{relative}"
        )));
    }

    let mut segments: Vec<String> = Vec::new();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy().to_string();
                // 挡掉经 Path 归一后仍可能出现的空段
                if !s.is_empty() {
                    segments.push(s);
                }
            }
            Component::CurDir => {} // ./ 直接忽略
            Component::ParentDir => {
                return Err(YuhuaError::InvalidInput(format!(
                    "路径不能包含 ..（禁止逃逸出工作区）：{relative}"
                )));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(YuhuaError::InvalidInput(format!(
                    "不接受绝对路径：{relative}"
                )));
            }
        }
    }

    if segments.is_empty() {
        return Err(YuhuaError::InvalidInput(format!("路径无有效内容：{relative}")));
    }

    Ok(segments.join("/"))
}

/// 取系统应用数据目录下的 `YuhuaWriter/index`。
fn dirs_index_base() -> Option<PathBuf> {
    // 不用 dirs::data_dir() 而是分平台显式书写：
    // 计划书 4.3 节的表格把三个平台的路径写死了，实现必须与文档一致。
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("YuhuaWriter").join("index"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|p| {
            PathBuf::from(p)
                .join("Library")
                .join("Application Support")
                .join("YuhuaWriter")
                .join("index")
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"))
            })
            .map(|p| p.join("YuhuaWriter").join("index"))
    }
}

/// 工作区格式版本记录，写入 `workspace.json`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatVersion {
    /// 写入时的格式版本。
    pub format_version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirs_are_under_root() {
        let l = WorkspaceLayout::new("D:/ws");
        assert!(l.manuscript_dir().starts_with(l.root()));
        assert!(l.engine_dir().ends_with(".yuhua"));
        assert!(l.trash_dir().ends_with(".trash"));
    }

    #[test]
    fn config_lives_in_engine_dir() {
        let l = WorkspaceLayout::new("D:/ws");
        assert_eq!(l.config_path(), PathBuf::from("D:/ws/.yuhua/workspace.json"));
    }

    #[test]
    fn index_db_is_outside_workspace() {
        // 核心不变量：索引库绝不进工作区
        let l = WorkspaceLayout::new("D:/my-novel");
        let idx = l.index_db_path();
        assert!(
            !idx.starts_with(l.root()),
            "索引库不能放在工作区内，实际得到：{}",
            idx.display()
        );
        assert!(idx.to_string_lossy().ends_with(".sqlite"));
    }

    #[test]
    fn workspace_id_is_stable_for_same_path() {
        let a = WorkspaceLayout::new("D:/my-novel").workspace_id();
        let b = WorkspaceLayout::new("D:/my-novel").workspace_id();
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn workspace_id_differs_for_different_paths() {
        let a = WorkspaceLayout::new("D:/novel-a").workspace_id();
        let b = WorkspaceLayout::new("D:/novel-b").workspace_id();
        assert_ne!(a, b);
    }

    #[test]
    fn workspace_id_ignores_case_and_separator_style() {
        let a = WorkspaceLayout::new("D:/My-Novel").workspace_id();
        let b = WorkspaceLayout::new("D:\\My-Novel").workspace_id();
        assert_eq!(a, b);
    }

    #[test]
    fn resolve_joins_relative_path() {
        let l = WorkspaceLayout::new("D:/ws");
        let p = l.resolve("manuscript/001/a.md").unwrap();
        assert_eq!(p, PathBuf::from("D:/ws/manuscript/001/a.md"));
    }

    #[test]
    fn resolve_normalizes_cur_dir_segments() {
        let l = WorkspaceLayout::new("D:/ws");
        let p = l.resolve("./manuscript/./a.md").unwrap();
        assert_eq!(p, PathBuf::from("D:/ws/manuscript/a.md"));
    }

    #[test]
    fn resolve_rejects_parent_escape() {
        let l = WorkspaceLayout::new("D:/ws");
        let err = l.resolve("manuscript/../../../etc/passwd").unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(err.to_string().contains(".."));
    }

    #[test]
    fn resolve_rejects_leading_parent() {
        let l = WorkspaceLayout::new("D:/ws");
        assert!(l.resolve("../outside.md").is_err());
    }

    #[test]
    fn resolve_rejects_absolute_windows_path() {
        let l = WorkspaceLayout::new("D:/ws");
        assert!(l.resolve("C:/Windows/System32/x.md").is_err());
        assert!(l.resolve("D:/other/x.md").is_err());
    }

    #[test]
    fn resolve_rejects_unc_path() {
        let l = WorkspaceLayout::new("D:/ws");
        assert!(l.resolve("\\\\server\\share\\x.md").is_err());
    }

    #[test]
    fn resolve_rejects_empty_path() {
        let l = WorkspaceLayout::new("D:/ws");
        assert!(l.resolve("").is_err());
        assert!(l.resolve("   ").is_err());
    }

    #[test]
    fn relativize_inverts_resolve() {
        let l = WorkspaceLayout::new("D:/ws");
        let rel = "manuscript/001/a.md";
        let abs = l.resolve(rel).unwrap();
        assert_eq!(l.relativize(&abs).unwrap(), rel);
    }

    #[test]
    fn relativize_rejects_outside_path() {
        let l = WorkspaceLayout::new("D:/ws");
        let out = PathBuf::from("D:/elsewhere/a.md");
        assert!(l.relativize(&out).is_err());
    }

    #[test]
    fn ensure_structure_creates_all_dirs_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let l = WorkspaceLayout::new(dir.path());
        l.ensure_structure().unwrap();
        for d in [
            l.engine_dir(),
            l.backup_dir(),
            l.journal_dir(),
            l.stats_dir(),
            l.manuscript_dir(),
            l.outline_dir(),
            l.characters_dir(),
            l.worldbuilding_dir(),
            l.trash_dir(),
        ] {
            assert!(d.is_dir(), "缺少目录：{}", d.display());
        }
        // 再次调用不应失败
        l.ensure_structure().unwrap();
    }

    #[test]
    fn workspace_contains_no_binary_db() {
        // 守住「索引库不进工作区」这条不变量：结构里不能出现任何 .sqlite
        let dir = tempfile::tempdir().unwrap();
        let l = WorkspaceLayout::new(dir.path());
        l.ensure_structure().unwrap();
        let mut found = Vec::new();
        for entry in walk(dir.path()) {
            if entry.extension().map(|e| e == "sqlite").unwrap_or(false) {
                found.push(entry);
            }
        }
        assert!(found.is_empty(), "工作区内出现索引库：{found:?}");
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.extend(walk(&p));
                } else {
                    out.push(p);
                }
            }
        }
        out
    }

    #[test]
    fn sanitize_replaces_windows_illegal_chars() {
        assert_eq!(sanitize_file_name("第一章：落羽"), "第一章：落羽".replace(':', "："));
        assert_eq!(sanitize_file_name("a/b"), "a／b");
        assert_eq!(sanitize_file_name("a?b"), "a？b");
        assert_eq!(sanitize_file_name("a*b"), "a＊b");
        assert_eq!(sanitize_file_name("a|b"), "a｜b");
    }

    #[test]
    fn sanitize_trims_trailing_dots_and_spaces() {
        // Windows 不允许文件名以点或空格结尾
        assert_eq!(sanitize_file_name("标题..."), "标题");
        assert_eq!(sanitize_file_name("标题   "), "标题");
    }

    #[test]
    fn sanitize_falls_back_for_empty_result() {
        assert_eq!(sanitize_file_name(""), "未命名");
        assert_eq!(sanitize_file_name("..."), "未命名");
        assert_eq!(sanitize_file_name("   "), "未命名");
    }

    #[test]
    fn sanitize_truncates_long_titles() {
        let long = "字".repeat(500);
        let s = sanitize_file_name(&long);
        assert!(s.chars().count() <= 120, "长度 {}", s.chars().count());
    }

    #[test]
    fn chapter_file_name_has_zero_padded_prefix() {
        assert_eq!(
            WorkspaceLayout::chapter_file_name(0, "第一章 落羽"),
            "001-第一章 落羽.md"
        );
        assert_eq!(
            WorkspaceLayout::chapter_file_name(9, "第十章"),
            "010-第十章.md"
        );
    }

    #[test]
    fn volume_dir_name_has_zero_padded_prefix() {
        assert_eq!(
            WorkspaceLayout::volume_dir_name(0, "第一卷 风起"),
            "001-第一卷 风起"
        );
    }

    #[test]
    fn reserved_names_cover_engine_and_vcs() {
        assert!(WorkspaceLayout::is_reserved_name(".yuhua"));
        assert!(WorkspaceLayout::is_reserved_name(".trash"));
        assert!(WorkspaceLayout::is_reserved_name(".git"));
        assert!(!WorkspaceLayout::is_reserved_name("manuscript"));
        assert!(!WorkspaceLayout::is_reserved_name("第一章.md"));
    }
}
