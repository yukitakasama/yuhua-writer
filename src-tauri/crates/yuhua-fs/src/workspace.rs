//! 工作区：创建、打开、校验、最近列表。
//!
//! 对应计划书 4.1 节与任务 T2.2 / T2.3。
//!
//! ## 工作区的定义
//!
//! **一个工作区就是一个普通文件夹**，里面包含 `.yuhua/workspace.json`
//! 作为「这是一个羽化写作工作区」的标记。这个设计让工作区可以：
//!
//! - 直接拖进坚果云 / OneDrive / Git 实现同步（计划书 4.5 节）
//! - 被用户用文件管理器自由浏览、整理、备份
//! - 在不安装本软件的机器上仍然完全可读（全是 Markdown 文本）
//!
//! ## 格式版本与迁移
//!
//! `workspace.json` 里记录 `formatVersion`。打开时：
//!
//! | 磁盘版本 | 行为 |
//! | --- | --- |
//! | == 当前版本 | 直接打开 |
//! | < 当前版本 | 走迁移钩子（见 [`Workspace::open`] 的说明） |
//! | > 当前版本 | 拒绝打开，提示用户升级软件 |
//!
//! 最后一条很重要：**旧版本软件打开新格式工作区，会静默丢失新字段**。
//! 宁可明确拒绝，也不要造成数据损失。

use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize};
use yuhua_core::{Result, YuhuaError};

use crate::layout::{WorkspaceLayout, CONFIG_FILE, FORMAT_VERSION};

/// 工作区配置文件的内容（`.yuhua/workspace.json`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    /// 工作区格式版本。
    pub format_version: u32,
    /// 工作区唯一 ID。
    pub workspace_id: String,
    /// 工作区创建时间。
    pub created: DateTime<FixedOffset>,
    /// 最近一次打开时间。
    #[serde(default)]
    pub last_opened: Option<DateTime<FixedOffset>>,
    /// 书名（冗余存储，便于不解析 manuscript 就能显示）。
    #[serde(default)]
    pub title: String,
}

impl WorkspaceConfig {
    /// 为新工作区生成默认配置。
    pub fn new(workspace_id: impl Into<String>, title: impl Into<String>) -> Self {
        let now = Utc::now().with_timezone(&local_offset());
        Self {
            format_version: FORMAT_VERSION,
            workspace_id: workspace_id.into(),
            created: now,
            last_opened: Some(now),
            title: title.into(),
        }
    }
}

/// 一个已打开的工作区。
#[derive(Debug, Clone)]
pub struct Workspace {
    /// 目录布局句柄。
    pub layout: WorkspaceLayout,
    /// 配置。
    pub config: WorkspaceConfig,
}

/// 工作区摘要（供「最近列表」展示，不需要真正打开）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    /// 工作区根路径。
    pub root: PathBuf,
    /// 工作区 ID。
    pub workspace_id: String,
    /// 书名。
    pub title: String,
    /// 创建时间。
    pub created: DateTime<FixedOffset>,
    /// 最近打开时间。
    pub last_opened: Option<DateTime<FixedOffset>>,
    /// 该路径当前是否仍然可用（目录存在且配置可读）。
    ///
    /// 最近列表里可能有已被移动或删除的工作区，UI 需要能标示出来，
    /// 而不是让用户点击后才报错。
    pub available: bool,
}

/// 最近打开的工作区记录项。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    /// 工作区根路径。
    pub root: PathBuf,
    /// 书名。
    pub title: String,
    /// 最近打开时间。
    pub last_opened: DateTime<FixedOffset>,
}

impl Workspace {
    /// 新建一个工作区。
    ///
    /// 会在 `root` 下创建完整目录结构与配置文件。
    /// **若目录已存在且非空则不报错**（用户可能选了一个已有内容的文件夹），
    /// 但若其中已有 `.yuhua/workspace.json`，则拒绝覆盖 —— 那是已有工作区，
    /// 误当新工作区创建会覆盖它的元数据。
    pub fn create(root: impl Into<PathBuf>, title: &str) -> Result<Self> {
        let layout = WorkspaceLayout::new(root.into());

        let config_path = layout.config_path();
        if config_path.exists() {
            return Err(YuhuaError::InvalidInput(format!(
                "该目录已经是一个工作区：{}。请改用「打开工作区」。",
                layout.root().display()
            )));
        }

        // 目录本身必须能创建
        std::fs::create_dir_all(layout.root()).map_err(|e| YuhuaError::io(layout.root(), e))?;
        layout.ensure_structure()?;

        let config = WorkspaceConfig::new(layout.workspace_id(), title);
        write_config(&layout, &config)?;

        Ok(Self { layout, config })
    }

    /// 打开一个已有工作区。
    ///
    /// ## 校验顺序（先便宜后昂贵）
    ///
    /// 1. 目录存在吗
    /// 2. 有 `.yuhua/workspace.json` 吗（判定「这是不是工作区」）
    /// 3. 配置能解析吗
    /// 4. 版本兼容吗
    /// 5. 补齐缺失的标准目录（容忍用户手工删掉了某个空目录）
    ///
    /// 第 5 步是宽容性的体现：相比「目录结构不完整就报错」，
    /// 直接补齐能让用户在文件管理器里清理过之后仍然正常使用。
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let layout = WorkspaceLayout::new(root.into());

        if !layout.root().is_dir() {
            return Err(YuhuaError::InvalidWorkspace {
                path: layout.root().to_path_buf(),
                reason: "目录不存在".to_string(),
            });
        }

        let config_path = layout.config_path();
        if !config_path.exists() {
            return Err(YuhuaError::InvalidWorkspace {
                path: layout.root().to_path_buf(),
                reason: format!("缺少 {CONFIG_FILE}，这可能不是一个羽化写作工作区"),
            });
        }

        let text = std::fs::read_to_string(&config_path).map_err(|e| YuhuaError::io(&config_path, e))?;
        let mut config: WorkspaceConfig =
            serde_json::from_str(&text).map_err(|e| YuhuaError::Parse {
                context: "workspace.json",
                message: e.to_string(),
            })?;

        // 版本检查
        if config.format_version > FORMAT_VERSION {
            return Err(YuhuaError::InvalidWorkspace {
                path: layout.root().to_path_buf(),
                reason: format!(
                    "工作区格式版本为 {}，高于本软件支持的 {}。请升级羽化写作后再打开，                     以免丢失新格式中的数据。",
                    config.format_version, FORMAT_VERSION
                ),
            });
        }

        // 迁移钩子。当前只有版本 1，没有实际迁移步骤；
        // 将来新增版本时在这里按序补上 migrate_v1_to_v2 等函数。
        if config.format_version < FORMAT_VERSION {
            config.format_version = FORMAT_VERSION;
        }

        // 补齐缺失的标准目录
        layout.ensure_structure()?;

        // 更新最近打开时间
        config.last_opened = Some(Utc::now().with_timezone(&local_offset()));
        // 写回失败不阻断打开：只影响「最近打开时间」这一个展示字段
        let _ = write_config(&layout, &config);

        Ok(Self { layout, config })
    }

    /// 判断一个目录是否是工作区（不真正打开）。
    ///
    /// 用于 UI 上给用户选目录时做即时校验。
    pub fn is_workspace(root: &Path) -> bool {
        root.join(".yuhua").join(CONFIG_FILE).is_file()
    }

    /// 读取工作区摘要（用于最近列表）。
    pub fn summarize(root: &Path) -> WorkspaceSummary {
        let layout = WorkspaceLayout::new(root);
        let available = Self::is_workspace(root);

        match std::fs::read_to_string(layout.config_path())
            .ok()
            .and_then(|t| serde_json::from_str::<WorkspaceConfig>(&t).ok())
        {
            Some(cfg) => WorkspaceSummary {
                root: root.to_path_buf(),
                workspace_id: cfg.workspace_id,
                title: if cfg.title.is_empty() {
                    derive_title_from_path(root)
                } else {
                    cfg.title
                },
                created: cfg.created,
                last_opened: cfg.last_opened,
                available,
            },
            None => WorkspaceSummary {
                root: root.to_path_buf(),
                workspace_id: String::new(),
                title: derive_title_from_path(root),
                created: now_local(),
                last_opened: None,
                available: false,
            },
        }
    }

    /// 清理上次崩溃遗留的临时文件与记录。
    ///
    /// 打开工作区后立刻调用。返回清理统计，供 UI 决定是否提示用户。
    pub fn recover(&self) -> RecoveryReport {
        // 1. 清理原子写残留的临时文件（递归整棵正文树）
        let swept_temp_files = sweep_recursive(&self.layout.manuscript_dir());

        // 2. 汇报未完成的 journal 记录
        let journal = crate::journal::Journal::new(self.layout.journal_dir());
        let pending = journal.pending();

        // 3. 清理过期回收站条目
        let trash = crate::trash::TrashManager::new(self.layout.clone());
        let purged_trash_items = trash.purge_expired().unwrap_or(0);

        // 4. 识别云盘冲突副本（只识别，绝不删除）
        let conflicts =
            crate::conflict::detect_conflicts(&self.layout.manuscript_dir(), self.layout.root());

        // 一次构造完成，避免 default() 之后再逐字段赋值
        RecoveryReport {
            swept_temp_files,
            interrupted_operations: pending
                .iter()
                .map(|e| format!("{}：{}", e.kind.label(), e.description))
                .collect(),
            pending_paths: pending.iter().flat_map(|e| e.paths.clone()).collect(),
            purged_trash_items,
            conflicts,
        }
    }

    /// 索引库路径（工作区之外）。
    pub fn index_db_path(&self) -> PathBuf {
        self.layout.index_db_path()
    }
}

/// 崩溃恢复报告。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecoveryReport {
    /// 清理的临时文件数。
    pub swept_temp_files: usize,
    /// 未完成的操作描述（上次崩溃时正在做的事）。
    pub interrupted_operations: Vec<String>,
    /// 未完成操作涉及的文件。
    pub pending_paths: Vec<String>,
    /// 清理的过期回收站条目数。
    pub purged_trash_items: usize,
    /// 发现的云盘冲突副本。
    pub conflicts: Vec<crate::conflict::DetectedConflict>,
}

impl RecoveryReport {
    /// 是否有需要提示用户的情况。
    ///
    /// 只清理了几个临时文件不值得打扰用户；但上次有未完成的操作、
    /// 或发现了冲突副本，就必须明确告知。
    pub fn needs_user_attention(&self) -> bool {
        !self.interrupted_operations.is_empty() || !self.conflicts.is_empty()
    }
}

/// 写配置文件。
fn write_config(layout: &WorkspaceLayout, config: &WorkspaceConfig) -> Result<()> {
    let json = serde_json::to_string_pretty(config).map_err(|e| YuhuaError::Parse {
        context: "workspace.json",
        message: e.to_string(),
    })?;
    std::fs::create_dir_all(layout.engine_dir()).map_err(|e| YuhuaError::io(layout.engine_dir(), e))?;
    // 配置也用原子写：它记录了工作区身份，写坏会导致工作区打不开
    crate::atomic::atomic_write(&layout.config_path(), &json)
}

/// 从路径推导书名（配置缺失时的兜底）。
fn derive_title_from_path(root: &Path) -> String {
    root.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "未命名工作区".to_string())
}

/// 递归清理临时文件。
fn sweep_recursive(dir: &Path) -> usize {
    if !dir.exists() {
        return 0;
    }
    let mut n = crate::atomic::sweep_temp_files(dir).unwrap_or(0);
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                let name = e.file_name().to_string_lossy().to_string();
                if !matches!(name.as_str(), ".yuhua" | ".trash" | ".git" | "node_modules") {
                    n += sweep_recursive(&p);
                }
            }
        }
    }
    n
}

/// 取本地时区偏移。
fn local_offset() -> FixedOffset {
    *chrono::Local::now().offset()
}

/// 当前本地时间。
fn now_local() -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&local_offset())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_makes_full_structure_and_config() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("我的小说");
        let ws = Workspace::create(&root, "我的小说").unwrap();

        assert!(ws.layout.manuscript_dir().is_dir());
        assert!(ws.layout.engine_dir().is_dir());
        assert!(ws.layout.trash_dir().is_dir());
        assert!(ws.layout.config_path().is_file());
        assert_eq!(ws.config.title, "我的小说");
        assert_eq!(ws.config.format_version, FORMAT_VERSION);
    }

    #[test]
    fn create_refuses_to_overwrite_existing_workspace() {
        // 关键：绝不能把已有工作区当新工作区创建，那会覆盖元数据
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("已有工作区");
        Workspace::create(&root, "第一本书").unwrap();

        let err = Workspace::create(&root, "新书名").unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(err.to_string().contains("已经是一个工作区"));

        // 原配置必须完好
        let reopened = Workspace::open(&root).unwrap();
        assert_eq!(reopened.config.title, "第一本书");
    }

    #[test]
    fn create_into_non_empty_directory_is_allowed() {
        // 用户选了一个已有内容的文件夹（例如放着素材的目录）也应可用
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("素材.txt"), "一些素材").unwrap();
        let ws = Workspace::create(dir.path(), "小说").unwrap();
        assert!(ws.layout.config_path().exists());
        // 用户原有文件不能被碰
        assert!(dir.path().join("素材.txt").exists());
    }

    #[test]
    fn open_roundtrips_created_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let created = Workspace::create(&root, "测试书").unwrap();
        let opened = Workspace::open(&root).unwrap();

        assert_eq!(opened.config.workspace_id, created.config.workspace_id);
        assert_eq!(opened.config.title, "测试书");
        assert_eq!(opened.config.created, created.config.created);
        // 打开会刷新 last_opened
        assert!(opened.config.last_opened.is_some());
    }

    #[test]
    fn open_missing_directory_fails_clearly() {
        let dir = tempfile::tempdir().unwrap();
        let err = Workspace::open(dir.path().join("不存在")).unwrap_err();
        assert_eq!(err.code(), "WORKSPACE_INVALID");
        assert!(err.to_string().contains("目录不存在"));
    }

    #[test]
    fn open_non_workspace_directory_fails_with_guidance() {
        let dir = tempfile::tempdir().unwrap();
        let err = Workspace::open(dir.path()).unwrap_err();
        assert_eq!(err.code(), "WORKSPACE_INVALID");
        assert!(err.to_string().contains("workspace.json"));
    }

    #[test]
    fn open_rejects_future_format_version() {
        // 旧版本软件打开新格式工作区必须明确拒绝，否则会静默丢字段
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let ws = Workspace::create(&root, "书").unwrap();

        let mut cfg = ws.config.clone();
        cfg.format_version = FORMAT_VERSION + 5;
        write_config(&ws.layout, &cfg).unwrap();

        let err = Workspace::open(&root).unwrap_err();
        assert_eq!(err.code(), "WORKSPACE_INVALID");
        assert!(err.to_string().contains("高于本软件支持"), "got {err}");
    }

    #[test]
    fn open_tolerates_corrupt_config() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        Workspace::create(&root, "书").unwrap();
        std::fs::write(root.join(".yuhua/workspace.json"), "{ 不是 JSON").unwrap();

        let err = Workspace::open(&root).unwrap_err();
        assert_eq!(err.code(), "PARSE_ERROR");
    }

    #[test]
    fn open_recreates_missing_standard_directories() {
        // 用户在文件管理器里删掉了空的 outline 目录，不应导致无法打开
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        Workspace::create(&root, "书").unwrap();
        std::fs::remove_dir_all(root.join("outline")).unwrap();

        let ws = Workspace::open(&root).unwrap();
        assert!(ws.layout.outline_dir().is_dir());
    }

    #[test]
    fn is_workspace_detects_marker_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        assert!(!Workspace::is_workspace(&root));
        Workspace::create(&root, "书").unwrap();
        assert!(Workspace::is_workspace(&root));
        // 普通目录不算
        assert!(!Workspace::is_workspace(dir.path()));
    }

    #[test]
    fn summarize_reads_config() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("我的小说");
        let ws = Workspace::create(&root, "我的小说").unwrap();

        let sum = Workspace::summarize(&root);
        assert!(sum.available);
        assert_eq!(sum.title, "我的小说");
        assert_eq!(sum.workspace_id, ws.config.workspace_id);
    }

    #[test]
    fn summarize_marks_missing_workspace_unavailable() {
        // 最近列表里可能有已被删除的工作区，UI 要能标示
        let dir = tempfile::tempdir().unwrap();
        let sum = Workspace::summarize(&dir.path().join("已删除的工作区"));
        assert!(!sum.available);
        // 标题兜底为目录名，而不是空白
        assert_eq!(sum.title, "已删除的工作区");
    }

    #[test]
    fn summarize_tolerates_corrupt_config() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        Workspace::create(&root, "书").unwrap();
        std::fs::write(root.join(".yuhua/workspace.json"), "坏的").unwrap();

        let sum = Workspace::summarize(&root);
        assert!(!sum.available);
        // 标题回退到目录名而不是空白
        assert_eq!(sum.title, "ws");
    }

    #[test]
    fn recovery_reports_clean_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::create(dir.path().join("ws"), "书").unwrap();
        let report = ws.recover();
        assert_eq!(report.swept_temp_files, 0);
        assert!(report.interrupted_operations.is_empty());
        assert!(report.conflicts.is_empty());
        assert!(!report.needs_user_attention());
    }

    #[test]
    fn recovery_sweeps_temp_files_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::create(dir.path().join("ws"), "书").unwrap();
        let deep = ws.layout.manuscript_dir().join("001-第一卷");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("001-第一章.md.tmp-abc123"), "半截内容").unwrap();

        let report = ws.recover();
        assert_eq!(report.swept_temp_files, 1);
        assert!(!deep.join("001-第一章.md.tmp-abc123").exists());
    }

    #[test]
    fn recovery_reports_interrupted_operation() {
        // 模拟上次崩溃：journal 里留了一条未完成的保存
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::create(dir.path().join("ws"), "书").unwrap();
        let journal = crate::journal::Journal::new(ws.layout.journal_dir());
        journal
            .begin(
                crate::journal::JournalKind::ChapterSave,
                vec!["manuscript/001/001-第一章.md".into()],
                "保存第一章",
            )
            .unwrap();

        let report = ws.recover();
        assert!(report.needs_user_attention());
        assert_eq!(report.interrupted_operations.len(), 1);
        assert!(report.interrupted_operations[0].contains("保存第一章"));
        assert_eq!(report.pending_paths.len(), 1);
    }

    #[test]
    fn recovery_detects_conflicts_without_deleting() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::create(dir.path().join("ws"), "书").unwrap();
        let conflict = ws.layout.manuscript_dir().join("001-第一章 (冲突副本).md");
        std::fs::write(&conflict, "冲突版本").unwrap();

        let report = ws.recover();
        assert!(report.needs_user_attention());
        assert_eq!(report.conflicts.len(), 1);
        // 绝不删除
        assert!(conflict.exists());
    }

    #[test]
    fn recover_does_not_report_attention_for_trivial_sweep() {
        // 只清掉几个临时文件不值得打扰用户
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::create(dir.path().join("ws"), "书").unwrap();
        std::fs::write(ws.layout.manuscript_dir().join("x.md.tmp-1"), "x").unwrap();
        let report = ws.recover();
        assert_eq!(report.swept_temp_files, 1);
        assert!(!report.needs_user_attention());
    }

    #[test]
    fn index_db_path_is_outside_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let ws = Workspace::create(&root, "书").unwrap();
        assert!(!ws.index_db_path().starts_with(&root));
    }

    #[test]
    fn config_json_is_human_readable() {
        // 用户可能打开配置文件排查问题，字段名要清晰
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        Workspace::create(&root, "我的小说").unwrap();
        let text = std::fs::read_to_string(root.join(".yuhua/workspace.json")).unwrap();
        assert!(text.contains("formatVersion"));
        assert!(text.contains("workspaceId"));
        assert!(text.contains("我的小说"));
    }
}
