//! 应用运行时状态。
//!
//! ## 职责划分
//!
//! | 结构 | 持有 | 生命周期 |
//! | --- | --- | --- |
//! | [\`WorkspaceSession\`] | 工作区路径、索引句柄、文件监听器 | 打开工作区时创建，关闭时销毁 |
//! | [\`AppState\`] | 上面这些 + **当前文稿结构** | 整个应用生命周期 |
//!
//! **文稿结构（\`Document\`）故意放在 \`AppState\` 而不是 \`WorkspaceSession\` 里**：
//! 结构化操作（新建 / 删除 / 重命名 / 排序）之后需要整个替换它，
//! 而 \`WorkspaceSession\` 被 \`Arc\` 共享、不可变。把易变的那一份单独放进
//! 一个写锁里，读命令走读锁，锁的争用面最小。
//!
//! ## 为什么用 RwLock 而不是 Mutex
//!
//! 检索、字数查询这类只读操作远多于写操作。读写锁允许它们并发执行，
//! 符合「后台命令互不阻塞」的设计。
//!
//! ## 为什么一个应用实例只开一个工作区
//!
//! 第一阶段把「多工作区切换」列为 Should 项（计划书 8.1 节）。
//! 用 \`Option<...>\` 而不是 \`Vec<...>\`，让「同时只开一个」
//! 成为类型层面的保证，而不是靠调用方自觉。

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use yuhua_core::model::Document;
use yuhua_fs::layout::WorkspaceLayout;
use yuhua_fs::watch::WorkspaceWatcher;
use yuhua_fs::workspace::{RecoveryReport, Workspace};
use yuhua_store::index::Index;
use yuhua_store::schema::open_database;

use crate::error::CommandError;

/// 一个已打开的工作区会话（不含易变的文稿结构）。
pub struct WorkspaceSession {
    /// 工作区（目录布局 + 配置）。
    pub workspace: Workspace,
    /// 索引句柄。
    pub index: Index,
    /// 文件监听器。为 \`None\` 表示监听启动失败（不阻断使用）。
    pub watcher: Option<WorkspaceWatcher>,
    /// 打开时的崩溃恢复报告。
    pub recovery: RecoveryReport,
}

impl WorkspaceSession {
    /// 目录布局。
    pub fn layout(&self) -> &WorkspaceLayout {
        &self.workspace.layout
    }

    /// 工作区根路径。
    pub fn root(&self) -> &std::path::Path {
        self.workspace.layout.root()
    }

    /// 工作区根路径的字符串形式（供索引记录展示用）。
    pub fn root_str(&self) -> String {
        self.root().to_string_lossy().to_string()
    }
}

impl std::fmt::Debug for WorkspaceSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceSession")
            .field("root", &self.root())
            .finish_non_exhaustive()
    }
}

/// 应用全局状态。
#[derive(Default)]
pub struct AppState {
    /// 当前打开的工作区。\`None\` 表示还没打开任何工作区。
    session: RwLock<Option<Arc<WorkspaceSession>>>,
    /// 内存中的文稿结构（书 / 卷 / 章，不含正文的主体）。
    document: RwLock<Option<Document>>,
}

impl AppState {
    /// 新建一个空状态。
    pub fn new() -> Self {
        Self::default()
    }

    /// 打开工作区并替换当前会话。
    ///
    /// 依次：打开工作区 → 建/开索引 → 扫描磁盘装配文稿 → 同步索引
    /// → 崩溃恢复 → 启动文件监听。
    pub fn open(&self, root: PathBuf) -> Result<Arc<WorkspaceSession>, CommandError> {
        let workspace = Workspace::open(root)?;
        let root_str = workspace.layout.root().to_string_lossy().to_string();

        // 索引库在工作区之外（不变量 3）
        let db_path = workspace.index_db_path();
        let conn = open_database(&db_path)?;
        let index = Index::new(conn);

        // 扫描磁盘装配文稿
        let document = crate::scan::scan_workspace(&workspace)?;
        document.validate()?;

        // 全量同步索引
        index.upsert_book(&document.book, &root_str)?;
        index.sync_volumes(&document.volumes)?;
        index.sync_document(&document.book, &root_str, &document.chapters)?;

        // 崩溃恢复
        let recovery = workspace.recover();

        // 监听失败不阻断打开：监听是增强功能，不是必需品
        let watcher = WorkspaceWatcher::start(workspace.layout.root()).ok();

        let session = Arc::new(WorkspaceSession {
            workspace,
            index,
            watcher,
            recovery,
        });

        // 先装文稿，再暴露 session：这样 current() 一旦成功返回，
        // 文稿一定已经就绪，读命令不会拿到半初始化状态。
        {
            let mut doc_guard = self
                .document
                .write()
                .map_err(|_| CommandError::internal("文稿锁被污染（可能有线程 panic）"))?;
            *doc_guard = Some(document);
        }

        let mut guard = self
            .session
            .write()
            .map_err(|_| CommandError::internal("会话锁被污染（可能有线程 panic）"))?;
        *guard = Some(session.clone());
        Ok(session)
    }

    /// 新建工作区并打开。
    pub fn create(&self, root: PathBuf, title: String) -> Result<Arc<WorkspaceSession>, CommandError> {
        Workspace::create(&root, &title)?;
        self.open(root)
    }

    /// 关闭当前工作区。
    pub fn close(&self) -> Result<(), CommandError> {
        {
            let mut guard = self
                .session
                .write()
                .map_err(|_| CommandError::internal("会话锁被污染"))?;
            // drop Arc 时监听器自动停止（WorkspaceWatcher 的 Drop）
            *guard = None;
        }
        if let Ok(mut doc) = self.document.write() {
            *doc = None;
        }
        Ok(())
    }

    /// 取当前会话的只读句柄。
    pub fn current(&self) -> Result<Arc<WorkspaceSession>, CommandError> {
        let guard = self
            .session
            .read()
            .map_err(|_| CommandError::internal("会话锁被污染"))?;
        guard.clone().ok_or_else(CommandError::not_opened)
    }

    /// 是否已打开工作区。
    pub fn has_session(&self) -> bool {
        self.session.read().map(|g| g.is_some()).unwrap_or(false)
    }

    /// 取文稿的只读快照（clone）。
    ///
    /// 返回 clone 而不是守卫：命令层需要在不持有锁的情况下做 IO
    /// （读文件、查索引）。Document 里存的是章节**摘要级**数据
    /// （不含正文），clone 成本与「章节数」同阶而非与「总字数」同阶，
    /// 因此可以放心用这种方式。
    pub fn document(&self) -> Result<Document, CommandError> {
        let guard = self
            .document
            .read()
            .map_err(|_| CommandError::internal("文稿锁被污染"))?;
        guard.clone().ok_or_else(CommandError::not_opened)
    }

    /// 在写锁内修改文稿。
    ///
    /// 传闭包而不是暴露可变引用：所有改动在一次写锁内完成，
    /// 调用方无法把引用泄漏到锁外。
    pub fn with_document_mut<F, R>(&self, f: F) -> Result<R, CommandError>
    where
        F: FnOnce(&mut Document) -> Result<R, CommandError>,
    {
        let mut guard = self
            .document
            .write()
            .map_err(|_| CommandError::internal("文稿锁被污染"))?;
        let doc = guard.as_mut().ok_or_else(CommandError::not_opened)?;
        f(doc)
    }

    /// 整体替换文稿（结构化重载用）。
    pub fn replace_document(&self, doc: Document) -> Result<(), CommandError> {
        let mut guard = self
            .document
            .write()
            .map_err(|_| CommandError::internal("文稿锁被污染"))?;
        *guard = Some(doc);
        Ok(())
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("has_session", &self.has_session())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_state_has_no_session() {
        let s = AppState::new();
        assert!(!s.has_session());
        assert_eq!(s.current().unwrap_err().code(), "NO_WORKSPACE");
        assert_eq!(s.document().unwrap_err().code(), "NO_WORKSPACE");
    }

    #[test]
    fn open_creates_session_and_document() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let state = AppState::new();
        let session = state.create(root.clone(), "测试书".into()).unwrap();

        assert!(state.has_session());
        assert_eq!(session.workspace.config.title, "测试书");

        let doc = state.document().unwrap();
        assert_eq!(doc.book.title, "测试书");
        assert_eq!(doc.volumes.len(), 1, "新建工作区应有一个默认卷");
        assert!(doc.chapters.is_empty());
    }

    #[test]
    fn close_clears_everything() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        state.create(dir.path().join("ws"), "书".into()).unwrap();
        assert!(state.has_session());

        state.close().unwrap();
        assert!(!state.has_session());
        assert!(state.document().is_err());
    }

    #[test]
    fn with_document_mut_persists_changes() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        state.create(dir.path().join("ws"), "书".into()).unwrap();

        state
            .with_document_mut(|doc| {
                doc.book.title = "改过的书名".into();
                Ok(())
            })
            .unwrap();

        assert_eq!(state.document().unwrap().book.title, "改过的书名");
    }

    #[test]
    fn with_document_mut_propagates_errors() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        state.create(dir.path().join("ws"), "书".into()).unwrap();

        let r = state.with_document_mut(|_doc| {
            Err::<(), _>(CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(
                "故意失败".into(),
            )))
        });
        assert!(r.is_err());
        // 失败后状态仍可用
        assert!(state.document().is_ok());
    }

    #[test]
    fn replace_document_swaps_whole_structure() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        state.create(dir.path().join("ws"), "书".into()).unwrap();

        let now = chrono::Local::now().fixed_offset();
        let fresh = Document::new("全新的书", now);
        state.replace_document(fresh).unwrap();
        assert_eq!(state.document().unwrap().book.title, "全新的书");
    }

    #[test]
    fn reopening_workspace_replaces_session() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        state.create(dir.path().join("a"), "第一本".into()).unwrap();
        state.create(dir.path().join("b"), "第二本".into()).unwrap();

        assert_eq!(state.document().unwrap().book.title, "第二本");
    }

    #[test]
    fn opening_invalid_workspace_keeps_state_usable() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        state.create(dir.path().join("ws"), "书".into()).unwrap();

        // 打开一个不存在的目录应当失败，且不影响已打开的会话
        assert!(state.open(dir.path().join("不存在")).is_err());
        assert!(state.has_session());
        assert_eq!(state.document().unwrap().book.title, "书");
    }

    #[test]
    fn index_db_lives_outside_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let state = AppState::new();
        let s = state.create(root.clone(), "书".into()).unwrap();
        assert!(!s.workspace.index_db_path().starts_with(&root));
    }

    #[test]
    fn root_str_is_available() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        let s = state.create(dir.path().join("ws"), "书".into()).unwrap();
        assert!(!s.root_str().is_empty());
    }
}
