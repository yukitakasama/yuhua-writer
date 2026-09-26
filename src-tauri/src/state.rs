//! 应用运行时状态。
//!
//! ## 职责划分
//!
//! | 结构 | 持有 | 生命周期 |
//! | --- | --- | --- |
//! | [`WorkspaceSession`] | 工作区路径、索引句柄、文件监听器、崩溃恢复报告 | 打开工作区时创建，关闭时销毁 |
//! | [`AppState`] | 会话句柄 + **当前文稿结构** | 整个应用生命周期 |
//!
//! **文稿结构（`Document`）故意放在 `AppState` 而不是 `WorkspaceSession` 里**：
//! 结构化操作（新建 / 删除 / 重命名 / 排序）之后需要整个替换它，
//! 而 `WorkspaceSession` 一旦被 `Arc` 共享就不可整体替换。
//! 把易变的那一份单独放进一个写锁里，读命令走读锁，锁的争用面最小。
//!
//! ## 为什么会话要包一层 `Mutex`
//!
//! Tauri 2 的 `#[tauri::command]` 要求 `State` 持有的类型满足
//! `Send + Sync`（命令可以跑在任意工作线程上）。而会话里的两个成员
//! **结构上就不是 `Sync` 的**：
//!
//! - [`yuhua_store::index::Index`] 内部是 `rusqlite::Connection`，
//!   它用 `RefCell<InnerConnection>` 与 `RefCell<LruCache<..>>` 做内部可变性
//!   —— 这是「同一时刻只能有一个访问者」的结构化声明。
//! - [`yuhua_fs::watch::WorkspaceWatcher`] 内部是 `std::sync::mpsc::Receiver`，
//!   `Receiver` 是 `Send` 但不是 `Sync`（共享接收端会破坏 mpsc 语义）。
//!
//! 这两个约束都指向同一个结论：**这些资源必须有「专属所有者」**。
//! 于是把整个会话放进 `Mutex`：`Mutex<T>: Sync` 只要 `T: Send`，
//! 而 `Index` 与 `Receiver` 都是 `Send` 的。互斥锁把
//! 「同一时刻只有一个访问者」变成运行时的强制约束，正好与它们的结构互补。
//!
//! 之所以选「锁整个会话」而不是「各成员各自加锁」：
//!
//! 1. 命令层几乎总是要同时用到 `layout` + `index`，分锁会引入
//!    多个锁的获取顺序问题，而单锁没有死锁面。
//! 2. 命令层是薄壳，临界区极短（一次索引读写或一次路径解析），
//!    锁粒度粗带来的争用可以忽略。
//!
//! **纪律：绝不跨 `await` 持有这个锁。** 当前所有命令都是同步函数
//! （签名里没有 `async`），一旦将来引入异步命令，必须先把需要的数据
//! 克隆出来、释放守卫，再做异步等待。
//!
//! ## 为什么一个应用实例只开一个工作区
//!
//! 第一阶段把「多工作区切换」列为 Should 项（计划书 8.1 节）。
//! 用 `Option<...>` 而不是 `Vec<...>`，让「同时只开一个」
//! 成为类型层面的保证，而不是靠调用方自觉。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use yuhua_core::model::Document;
use yuhua_fs::layout::WorkspaceLayout;
use yuhua_fs::watch::WorkspaceWatcher;
use yuhua_fs::workspace::{RecoveryReport, Workspace, WorkspaceConfig};
use yuhua_store::index::Index;
use yuhua_store::schema::open_database;

use crate::error::CommandError;

/// 一个已打开的工作区会话（不含易变的文稿结构）。
///
/// 本身**不是** `Sync`（见模块文档），永远以 `Arc<Mutex<Self>>` 的
/// 形式被 [`AppState`] 持有，外部访问一律经过互斥锁。
///
/// 字段全部私有：`Index` 里的 `Connection` 不是 `Sync` 的，
/// 若把字段公开出去，调用方就可能把一个 `&Connection` 存起来跨线程用。
/// 让所有权始终停留在 `Mutex` 后面，是这条约束唯一可靠的落地方式。
pub struct WorkspaceSession {
    /// 工作区（目录布局 + 配置）。
    workspace: Workspace,
    /// 索引句柄。
    index: Index,
    /// 文件监听器。为 `None` 表示监听启动失败（不阻断使用）。
    ///
    /// 字段只作为「持有者」存在：丢掉它即停止监听（`WorkspaceWatcher` 的
    /// `Drop`）。因此即使暂时没有读取它的地方，也必须保留这个字段。
    #[allow(dead_code)]
    watcher: Option<WorkspaceWatcher>,
    /// 打开时的崩溃恢复报告。
    recovery: RecoveryReport,
}

impl WorkspaceSession {
    /// 目录布局。
    pub fn layout(&self) -> &WorkspaceLayout {
        &self.workspace.layout
    }

    /// 工作区根路径。
    pub fn root(&self) -> &Path {
        self.workspace.layout.root()
    }

    /// 工作区根路径的字符串形式（供索引记录展示用）。
    pub fn root_str(&self) -> String {
        self.root().to_string_lossy().to_string()
    }

    /// 工作区配置。
    pub fn config(&self) -> &WorkspaceConfig {
        &self.workspace.config
    }

    /// 打开时的崩溃恢复报告。
    pub fn recovery(&self) -> &RecoveryReport {
        &self.recovery
    }

    /// 借用索引。
    ///
    /// 返回普通引用而不是守卫：调用方此时已经持有会话锁，
    /// 再返回一个守卫会让调用点同时出现两个借出物，徒增理解成本。
    pub fn index(&self) -> &Index {
        &self.index
    }

    /// 借用工作区（供结构重载时重新扫描磁盘）。
    ///
    /// 只借出引用、不提供「重新打开」的入口，是有意为之：
    /// [`Workspace::open`] 有副作用 —— 它会刷新配置文件里的
    /// `last_opened` 并写回磁盘。结构重载（新建 / 删除 / 重命名 /
    /// 排序后都会触发）若走 `open`，每建一章都会重写一次
    /// `workspace.json`；而工作区按设计要放进云盘或 Git，
    /// 这种无谓的写入会制造同步噪音甚至冲突。
    pub fn workspace(&self) -> &Workspace {
        &self.workspace
    }

    /// 把当前文稿的卷清单写入 `workspace.json`。
    ///
    /// ## 为什么 `dir_name` 要**沿用**配置里的旧值，而不是现算
    ///
    /// 这是本函数最关键的一条规则，也是「卷名可以随时改、目录名一动不动」
    /// 这个设计成立的支点。
    ///
    /// `dir_name` 是卷在磁盘上的**身份**（配置与目录之间靠它对应）。
    /// 若拿当前内存的 `sort` 与 `title` 现算 `volume_dir_name(..)`：
    ///
    /// - **重命名后**会得到一个磁盘上不存在的目录名，于是下一次扫描
    ///   在 `volume_dirs` 里找不到匹配的目录 → 卷被当成"配置里的幽灵"丢弃，
    ///   取而代之的是从目录名兜底新建的**另一个 ID** ——
    ///   界面上表现为「改个名字，卷整个没了」。
    /// - **重排后**同理：sort 变了，目录名的编号却没变。
    ///
    /// 因此只有**新卷**（配置里还没有它的 ID）才现算目录名 ——
    /// 而那一刻 `create_volume` 刚用同一个公式把目录建了出来，两边必然一致。
    ///
    /// ## 为什么传入的是「整份文稿」而不是一串卷
    ///
    /// 因为调用方（命令层）手里只有 `Document`，而 `VolumeRecord`
    /// 需要 `dir_name`。让每个调用点各算一遍是重复且容易漏的，
    /// 收敛到这里一处。
    ///
    /// ## 顺序纪律：必须先落盘再重扫
    ///
    /// 所有会改卷的命令都遵循「改内存 → `save_volumes` → 重扫」。
    /// 反过来（先重扫）会让扫描拿旧配置重建卷，改动当场丢失 ——
    /// 那正是本次要修的那个缺陷。
    pub fn save_volumes(&mut self, doc: &Document) -> Result<(), CommandError> {
        let existing = self.workspace.volumes().to_vec();
        // 磁盘上真实存在的卷目录，用于给"配置里还没有"的卷找到它真正的名字
        let on_disk = crate::scan::list_volume_dir_names(&self.workspace.layout);

        let records: Vec<yuhua_fs::workspace::VolumeRecord> = doc
            .volumes
            .iter()
            // sort == -1 的「未分卷」是一个**虚拟容器**（根下散章的挂载点），
            // 它在磁盘上没有对应目录，写进配置只会在下次扫描时变成一个
            // 指向不存在目录的记录。
            .filter(|v| v.sort >= 0)
            .map(|v| {
                let id = v.id.to_string();
                // 目录名的取值优先级（见上面的说明）：
                // 1. 配置里已有的记录 —— 沿用，目录名是磁盘上的既成事实
                // 2. 磁盘上真实存在的目录 —— 用户手工建的目录会被扫描
                //    兜底收成一个新卷，此时它的目录名只能是磁盘上那个。
                //    匹配规则用「剥掉序号前缀后等于卷标题」，这与
                //    `scan_workspace` 建卷时用的是**同一个** `strip_sort_prefix`，
                //    因此两边必然得出同一个结论。
                // 3. 都没有 —— 全新卷，按规则现算
                //    （调用方刚从同一个公式把目录建了出来）
                let dir_name = existing
                    .iter()
                    .find(|r| r.id == id)
                    .map(|r| r.dir_name.clone())
                    .or_else(|| {
                        on_disk
                            .iter()
                            .find(|d| crate::scan::strip_sort_prefix(d) == v.title)
                            .cloned()
                    })
                    .unwrap_or_else(|| WorkspaceLayout::volume_dir_name(v.sort, &v.title));
                yuhua_fs::workspace::VolumeRecord {
                    id,
                    title: v.title.clone(),
                    sort: v.sort,
                    dir_name,
                }
            })
            .collect();
        self.workspace.save_volumes(&records)?;
        Ok(())
    }
}

impl std::fmt::Debug for WorkspaceSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceSession")
            .field("root", &self.root())
            .finish_non_exhaustive()
    }
}

/// 会话句柄 —— 命令层从 `AppState` 取到的就是它。
///
/// 用 `Arc` 而不是裸的 `Mutex`：命令取到句柄后要在
/// **不持有外层 `RwLock` 读锁**的情况下继续工作（做文件 IO、
/// 查索引），因此需要把所有权带出去。内层的 `Mutex` 则保证
/// 并发命令之间的串行化。
pub type SessionHandle = Arc<Mutex<WorkspaceSession>>;

/// 加锁失败（锁中毒）时的统一错误。
///
/// 锁中毒意味着有线程在持锁时 panic 了，属于程序缺陷，
/// 必须与「用户操作不当」在错误码上区分开。
pub fn poisoned() -> CommandError {
    CommandError::internal("会话锁被污染（可能有线程 panic）")
}

/// 应用全局状态。
///
/// 两个字段都是 `RwLock<Option<..>>`，且内层类型均满足 `Send`，
/// 因此 `AppState` 是 `Send + Sync` 的，可以安全地交给 Tauri 的
/// `manage` 与任意命令线程。
#[derive(Default)]
pub struct AppState {
    /// 当前打开的工作区。`None` 表示还没打开任何工作区。
    session: RwLock<Option<SessionHandle>>,
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
    ///
    /// 全程不持有会话锁：此时会话还没发布出去，没有并发访问者。
    pub fn open(&self, root: PathBuf) -> Result<SessionHandle, CommandError> {
        let mut workspace = Workspace::open(root)?;
        let root_str = workspace.layout.root().to_string_lossy().to_string();

        // 索引库在工作区之外（不变量 3）
        let db_path = workspace.index_db_path();
        let conn = open_database(&db_path)?;
        let index = Index::new(conn);

        // 扫描磁盘装配文稿。
        //
        // 「空工作区补一个默认卷」的逻辑放在 scan_workspace 内部，而不是这里 ——
        // 那样能同时覆盖 rescan_workspace 等所有扫描调用方，
        // 避免只在这一条路径上生效而在别处又出现「零卷」。
        let (document, volume_dirs) = crate::scan::scan_workspace_with_dirs(&workspace)?;
        document.validate()?;

        // ---- 旧格式回填：把扫描推导出的卷清单写进配置 ----
        //
        // 放在这里而不是 scan_workspace 内部，是为了让扫描保持**纯读**
        // （它被 reload_and_sync 在持锁状态下调用，不该有写盘副作用）。
        //
        // 只在配置为空时回填：非空说明这个工作区已经记录过卷信息，
        // 此时扫描结果可能包含用户手工新建的目录 —— 那些目录会在
        // 下一次「结构改动」时才被写进配置，不必在每次打开时都写一次盘。
        // 每开一次工作区就重写 workspace.json 会制造云盘同步噪音。
        if workspace.volumes().is_empty() {
            // 目录名取自**磁盘实际的名字**（`volume_dirs`），
            // 绝不用 `volume_dir_name(sort, title)` 现算 —— 那是一个
            // 生成规则，而用户手工建的 / 手工改过名的目录并不服从它。
            // 现算会写进一个不存在的目录名，下次扫描找不到匹配，
            // 于是从目录名兜底再建一个同名却不同 ID 的卷（见 scan 模块
            // `VolumeDirMap` 的文档）。
            let records: Vec<yuhua_fs::workspace::VolumeRecord> = volume_dirs
                .iter()
                .filter_map(|(id, dir_name)| {
                    let vol = document.volumes.iter().find(|v| v.id.as_str() == id)?;
                    Some(yuhua_fs::workspace::VolumeRecord {
                        id: id.clone(),
                        title: vol.title.clone(),
                        sort: vol.sort,
                        dir_name: dir_name.clone(),
                    })
                })
                .collect();

            // 配置里还没有、磁盘上也没有目录的卷（新工作区的默认「第一卷」）
            // 需要补一个目录出来：扫描是**目录驱动**的，不在磁盘上的卷
            // 下次扫描就会被丢弃，而它的 ID 会被重新生成，
            // 索引里引用它的章节全成孤儿。
            let missing: Vec<yuhua_fs::workspace::VolumeRecord> = document
                .volumes
                .iter()
                .filter(|v| v.sort >= 0)
                .filter(|v| !records.iter().any(|r| r.id == v.id.to_string()))
                .map(|v| yuhua_fs::workspace::VolumeRecord {
                    id: v.id.to_string(),
                    title: v.title.clone(),
                    sort: v.sort,
                    // 这里**可以**现算：它是全新目录，由我们按规则创建
                    dir_name: WorkspaceLayout::volume_dir_name(v.sort, &v.title),
                })
                .collect();

            for record in &missing {
                let dir = workspace.layout.manuscript_dir().join(&record.dir_name);
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    // 建不出来不阻断打开：卷仍然在内存与界面上是正确的，
                    // 首次写章节时 `write_chapter` 还会再试着建一次父目录
                    eprintln!(
                        "[工作区] 卷目录创建失败（不影响本次打开）：{}：{e}",
                        dir.display()
                    );
                }
            }

            let mut all = records;
            all.extend(missing);
            all.sort_by_key(|r| r.sort);

            // 回填失败不阻断打开：配置写不进去只意味着下次打开会再推导一遍，
            // 而卷名此刻已经在内存与界面上是正确的。为了一个缓存性的写入
            // 让用户打不开工作区，是明显更糟的取舍。
            if let Err(e) = workspace.save_volumes(&all) {
                eprintln!("[工作区] 卷清单回填失败（不影响本次打开）：{e}");
            }
        }

        // 全量同步索引
        index.upsert_book(&document.book, &root_str)?;
        index.sync_volumes(&document.volumes)?;
        index.sync_document(&document.book, &root_str, &document.chapters)?;

        // 崩溃恢复
        let recovery = workspace.recover();

        // 监听失败不阻断打开：监听是增强功能，不是必需品
        let watcher = WorkspaceWatcher::start(workspace.layout.root()).ok();

        let session: SessionHandle = Arc::new(Mutex::new(WorkspaceSession {
            workspace,
            index,
            watcher,
            recovery,
        }));

        // 先装文稿，再暴露 session：这样 current() 一旦成功返回，
        // 文稿一定已经就绪，读命令不会拿到半初始化状态。
        {
            let mut doc_guard = self.document.write().map_err(|_| poisoned())?;
            *doc_guard = Some(document);
        }

        let mut guard = self.session.write().map_err(|_| poisoned())?;
        *guard = Some(session.clone());
        Ok(session)
    }

    /// 新建工作区并打开。
    pub fn create(&self, root: PathBuf, title: String) -> Result<SessionHandle, CommandError> {
        Workspace::create(&root, &title)?;
        self.open(root)
    }

    /// 关闭当前工作区。
    pub fn close(&self) -> Result<(), CommandError> {
        {
            let mut guard = self.session.write().map_err(|_| poisoned())?;
            // 丢掉最后一份 Arc 时监听器随之停止（WorkspaceWatcher 的 Drop）
            *guard = None;
        }
        if let Ok(mut doc) = self.document.write() {
            *doc = None;
        }
        Ok(())
    }

    /// 取当前会话的共享句柄。
    ///
    /// 返回 `Arc` 而不是锁守卫：命令拿到句柄后再决定何时加锁，
    /// 这样「取会话」与「用索引」之间不夹着任何锁，路径解析、
    /// 文件读写等慢操作可以在锁外完成。
    pub fn current(&self) -> Result<SessionHandle, CommandError> {
        let guard = self.session.read().map_err(|_| poisoned())?;
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
        let guard = self.document.read().map_err(|_| poisoned())?;
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
        let mut guard = self.document.write().map_err(|_| poisoned())?;
        let doc = guard.as_mut().ok_or_else(CommandError::not_opened)?;
        f(doc)
    }

    /// 整体替换文稿（结构化重载用）。
    pub fn replace_document(&self, doc: Document) -> Result<(), CommandError> {
        let mut guard = self.document.write().map_err(|_| poisoned())?;
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

    /// 打开测试用工作区，返回状态与句柄。
    fn opened() -> (tempfile::TempDir, AppState, SessionHandle) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        let handle = state
            .create(dir.path().join("ws"), "测试书".into())
            .unwrap();
        (dir, state, handle)
    }

    #[test]
    fn fresh_state_has_no_session() {
        let s = AppState::new();
        assert!(!s.has_session());
        assert_eq!(s.current().unwrap_err().code(), "NO_WORKSPACE");
        assert_eq!(s.document().unwrap_err().code(), "NO_WORKSPACE");
    }

    #[test]
    fn open_creates_session_and_document() {
        let (_dir, state, handle) = opened();

        assert!(state.has_session());
        assert_eq!(handle.lock().unwrap().config().title, "测试书");

        let doc = state.document().unwrap();
        assert_eq!(doc.book.title, "测试书");
        assert_eq!(doc.volumes.len(), 1, "新建工作区应有一个默认卷");
        assert!(doc.chapters.is_empty());
    }

    #[test]
    fn close_clears_everything() {
        let (_dir, state, _handle) = opened();
        assert!(state.has_session());

        state.close().unwrap();
        assert!(!state.has_session());
        assert!(state.document().is_err());
    }

    #[test]
    fn with_document_mut_persists_changes() {
        let (_dir, state, _handle) = opened();

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
        let (_dir, state, _handle) = opened();

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
        let (_dir, state, _handle) = opened();

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
        let (dir, state, _handle) = opened();

        // 打开一个不存在的目录应当失败，且不影响已打开的会话
        assert!(state.open(dir.path().join("不存在")).is_err());
        assert!(state.has_session());
        assert_eq!(state.document().unwrap().book.title, "测试书");
    }

    #[test]
    fn index_db_lives_outside_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let state = AppState::new();
        let handle = state.create(root.clone(), "书".into()).unwrap();
        assert!(!handle
            .lock()
            .unwrap()
            .layout()
            .index_db_path()
            .starts_with(&root));
    }

    #[test]
    fn root_str_is_available() {
        let (_dir, _state, handle) = opened();
        assert!(!handle.lock().unwrap().root_str().is_empty());
    }

    #[test]
    fn session_handle_is_send_and_sync() {
        // 这条断言是 Tauri 命令层能编译的前提：State 要求 Send + Sync。
        // 若将来有人往 WorkspaceSession 里塞了 Rc / RefCell 之类，
        // 这里会先于 tauri-macros 报错，错误信息也更直白。
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<AppState>();
        assert_send_sync::<SessionHandle>();
    }
}
