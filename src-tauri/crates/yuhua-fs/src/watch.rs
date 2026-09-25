//! 文件监听：外部改动与云盘同步。
//!
//! 对应计划书 4.5 节第 2 条与 T2.8：
//!
//! > **优雅处理外部改动**：`notify` 监听云盘落盘事件，自动重载未在编辑的章节；
//! > 正在编辑的章节若被外部改动，弹出冲突提示，**保留内存版本并另存冲突副本，
//! > 绝不静默覆盖**。
//!
//! ## 为什么不用轮询
//!
//! 计划书 6.1 节第 12 条：「无轮询定时器；文件变动走 OS 事件」。
//! 轮询会持续占用 CPU 与唤醒磁盘，直接违背内存 / 能耗要求。
//!
//! ## 关键设计：**防抖 + 分类**
//!
//! 云盘同步一个文件往往触发**多次**事件（临时文件创建、重命名、
//! 元数据更新）。若每个事件都通知前端重载，会造成大量无意义的刷新。
//! 因此本模块：
//!
//! 1. 把原始事件做 [`DEBOUNCE_MS`] 防抖聚合
//! 2. 只报告**我们关心的路径类型**（`.md` 文件，且不在引擎目录内）
//! 3. 输出语义化的事件类型（新增 / 修改 / 删除 / 重命名）
//!
//! ## 线程模型
//!
//! `notify` 的回调在其自己的线程上运行。本模块把事件推进一个
//! `std::sync::mpsc` 通道，由调用方决定怎么消费
//! （Tauri 命令层会转成前端事件，测试里可以直接 `recv`）。
//! 这样本模块不依赖任何异步运行时，保持可测试。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use yuhua_core::{Result, YuhuaError};

/// 事件防抖窗口（毫秒）。
///
/// 200 ms 是在「云盘多次事件能合并」与「用户感知不到延迟」之间的折中。
pub const DEBOUNCE_MS: u64 = 200;

/// 一次外部改动的语义化描述。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// **相对于工作区根**的路径。
    pub relative_path: String,
    /// 改动类型。
    pub kind: ChangeKind,
}

/// 改动类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    /// 新文件出现。
    Created,
    /// 已有文件内容变化。
    Modified,
    /// 文件被删除。
    Removed,
    /// 重命名（在 notify 层面通常表现为「删 + 增」，此处汇总后可能不出现）。
    Renamed,
}

/// 工作区文件监听器。
pub struct WorkspaceWatcher {
    /// 底层 notify 监听器。必须持有，drop 时自动停止监听。
    _watcher: RecommendedWatcher,
    /// 语义化事件的接收端。
    rx: Receiver<FileChange>,
    /// 工作区根目录。
    root: PathBuf,
}

impl std::fmt::Debug for WorkspaceWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // RecommendedWatcher 未实现 Debug，手写一个只暴露有用信息的实现
        f.debug_struct("WorkspaceWatcher")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

impl WorkspaceWatcher {
    /// 开始监听工作区的 `manuscript/` 目录。
    ///
    /// 只监听正文目录：大纲、设定等目录的改动频率极低，
    /// 监听它们只会增加事件噪音。
    pub fn start(workspace_root: impl Into<PathBuf>) -> Result<Self> {
        let root = workspace_root.into();
        let watch_target = root.join("manuscript");

        let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<Event>>();
        let (tx, rx) = mpsc::channel::<FileChange>();

        let mut watcher = notify::recommended_watcher(move |res| {
            // 发送失败（接收端已 drop）不是错误，静默忽略
            let _ = raw_tx.send(res);
        })
        .map_err(|e| YuhuaError::InvalidInput(format!("无法创建文件监听器：{e}")))?;

        // 目录还不存在时先建出来：否则监听会失败
        if !watch_target.exists() {
            std::fs::create_dir_all(&watch_target).map_err(|e| YuhuaError::io(&watch_target, e))?;
        }

        watcher
            .watch(&watch_target, RecursiveMode::Recursive)
            .map_err(|e| YuhuaError::InvalidInput(format!("无法监听目录 {watch_target:?}：{e}")))?;

        // 后台线程：把原始事件防抖聚合成语义化改动
        let root_for_thread = root.clone();
        std::thread::Builder::new()
            .name("yuhua-fs-watch".to_string())
            .spawn(move || debounce_loop(raw_rx, tx, root_for_thread))
            .map_err(|e| YuhuaError::InvalidInput(format!("无法启动监听线程：{e}")))?;

        Ok(Self {
            _watcher: watcher,
            rx,
            root,
        })
    }

    /// 阻塞等待下一个改动（带超时）。
    ///
    /// 返回 `None` 表示超时（没有改动）。
    /// 用超时而不是纯阻塞，是为了让调用方有机会检查退出标志。
    pub fn next_change(&self, timeout: Duration) -> Option<FileChange> {
        match self.rx.recv_timeout(timeout) {
            Ok(change) => Some(change),
            Err(RecvTimeoutError::Timeout) => None,
            // 通道断开说明监听线程已退出
            Err(RecvTimeoutError::Disconnected) => None,
        }
    }

    /// 以尽量短的时间取出当前所有待处理改动（非阻塞）。
    pub fn drain_changes(&self) -> Vec<FileChange> {
        let mut out = Vec::new();
        while let Ok(c) = self.rx.try_recv() {
            out.push(c);
        }
        out
    }

    /// 是否只关心这个路径（`.md` 且不在引擎 / 回收站目录下）。
    pub fn is_relevant(relative_path: &str) -> bool {
        // 必须是 Markdown
        if !relative_path.ends_with(".md") {
            return false;
        }
        // 引擎目录与回收站的改动是我们自己造成的，不应触发「外部改动」流程
        for segment in relative_path.split('/') {
            if matches!(segment, ".yuhua" | ".trash" | ".git" | "node_modules") {
                return false;
            }
        }
        // 原子写产生的临时文件不应触发外部改动提示
        if relative_path.contains(".tmp-") {
            return false;
        }
        true
    }
}

/// 把原始事件按路径聚合去重，产出语义化改动。
///
/// ## 聚合策略
///
/// 对同一个路径在防抖窗口内的多个事件，**保留最后一个**：
/// 云盘同步的典型序列是「创建临时 → 改名 → 更新元数据」，
/// 用户视角只关心「这个文件最终变成了什么样子」。
///
/// 特别注意：**不能把 Created 和 Modified 分开报**，
/// 否则一次同步会给前端发两条重载请求。这里统一用最终事件类型。
fn debounce_loop(rx: Receiver<notify::Result<Event>>, tx: Sender<FileChange>, root: PathBuf) {
    // 累积中的改动：路径 → 最终类型
    let mut pending: Vec<(String, ChangeKind)> = Vec::new();
    let mut last_event: Option<Instant> = None;

    loop {
        let timeout = match last_event {
            // 有积压事件时，等到防抖窗口结束
            Some(t) => {
                let elapsed = t.elapsed();
                if elapsed >= Duration::from_millis(DEBOUNCE_MS) {
                    flush(&mut pending, &tx);
                    last_event = None;
                    Duration::from_secs(3600)
                } else {
                    Duration::from_millis(DEBOUNCE_MS) - elapsed
                }
            }
            // 空闲时阻塞等待，不会空转
            None => Duration::from_secs(3600),
        };

        match rx.recv_timeout(timeout) {
            Ok(Ok(event)) => {
                let kind = classify(&event.kind);
                let Some(kind) = kind else { continue };

                for path in &event.paths {
                    let Ok(rel) = path.strip_prefix(&root) else {
                        continue;
                    };
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    if !WorkspaceWatcher::is_relevant(&rel) {
                        continue;
                    }
                    // 同一路径的事件合并规则：见 merge_kind 的说明
                    match pending.iter_mut().find(|(p, _)| p == &rel) {
                        Some(slot) => slot.1 = merge_kind(slot.1, kind),
                        None => pending.push((rel, kind)),
                    }
                }
                if !pending.is_empty() {
                    last_event = Some(Instant::now());
                }
            }
            Ok(Err(_)) => {
                // 单个底层事件出错（例如文件刚好被云盘锁住）不致命，
                // 跳过即可；下一次事件仍然会正常处理。
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {
                flush(&mut pending, &tx);
                last_event = None;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// 合并同一路径上的多次事件。
///
/// 规则不是简单「取最后一个」，而是按语义优先级：
///
/// | 已有 | 新来 | 结果 | 理由 |
/// | --- | --- | --- | --- |
/// | Created | Modified | Created | 新文件必然伴随一次数据写入，对用户而言仍是「新出现的文件」 |
/// | Created | Removed | Removed | 建了又删等于没发生，但对调用方「文件没了」更准确 |
/// | Modified | Created | Created | 不应出现，但若出现以更"强"的事件为准 |
/// | 任意 | Renamed | Renamed | 重命名是更强的语义 |
///
/// 没有这条规则时，`fs::write` 新建一个文件会产出
/// `Created` + `Modified` 两个事件，简单取后者会把「新章节」
/// 误报成「已有章节被外部修改」，触发不必要的冲突提示。
fn merge_kind(prev: ChangeKind, next: ChangeKind) -> ChangeKind {
    use ChangeKind::*;
    match (prev, next) {
        // 重命名语义最强，覆盖其它
        (_, Renamed) => Renamed,
        // 建立后又删除：文件确实不在了
        (Created, Removed) => Removed,
        // 新建后的写入仍视为「新建」
        (Created, Modified) => Created,
        // 删除后又被创建（或反之）：以最新发生的事件为准
        (Removed, Created) => Created,
        // 其余情况取最新事件
        (_, next) => next,
    }
}

/// 把积压的改动发出去。
fn flush(pending: &mut Vec<(String, ChangeKind)>, tx: &Sender<FileChange>) {
    for (relative_path, kind) in pending.drain(..) {
        // 接收端已关闭则停止（应用正在退出）
        if tx
            .send(FileChange {
                relative_path,
                kind,
            })
            .is_err()
        {
            return;
        }
    }
}

/// 把 notify 的事件类型映射成我们的语义。
///
/// 返回 `None` 表示该类型我们不关心（例如仅访问时间变化）。
fn classify(kind: &EventKind) -> Option<ChangeKind> {
    match kind {
        EventKind::Create(_) => Some(ChangeKind::Created),
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => Some(ChangeKind::Renamed),
        EventKind::Modify(_) => Some(ChangeKind::Modified),
        EventKind::Remove(_) => Some(ChangeKind::Removed),
        // 权限变化、访问事件等与写作内容无关，忽略以减少噪音
        _ => None,
    }
}

/// 判断一个外部改动是否需要提示冲突。
///
/// 计划书要求：正在编辑的章节被外部改动时弹提示，未在编辑的自动重载。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExternalChangeAction {
    /// 自动重载，用户无感。
    AutoReload,
    /// 正在编辑，需要提示用户处理。
    PromptUser,
}

/// 根据「该章是否正在编辑」决定处理方式。
///
/// 抽成独立函数是为了让这条产品规则可以被单元测试直接验证，
/// 而不必启动真实监听器。
pub fn decide_action(is_being_edited: bool) -> ExternalChangeAction {
    if is_being_edited {
        ExternalChangeAction::PromptUser
    } else {
        ExternalChangeAction::AutoReload
    }
}

/// 检查路径是否在工作区的保留目录内。
pub fn is_in_reserved_dir(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        matches!(s.as_ref(), ".yuhua" | ".trash" | ".git" | "node_modules")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relevant_paths_are_markdown_in_manuscript() {
        assert!(WorkspaceWatcher::is_relevant(
            "manuscript/001/001-第一章.md"
        ));
        assert!(WorkspaceWatcher::is_relevant("manuscript/a.md"));
    }

    #[test]
    fn non_markdown_paths_are_ignored() {
        assert!(!WorkspaceWatcher::is_relevant("manuscript/notes.txt"));
        assert!(!WorkspaceWatcher::is_relevant("manuscript/image.png"));
        assert!(!WorkspaceWatcher::is_relevant("manuscript/data.json"));
    }

    #[test]
    fn engine_and_trash_paths_are_ignored() {
        // 我们自己造成的改动不该触发「外部改动」流程
        assert!(!WorkspaceWatcher::is_relevant(".yuhua/backup/a.md"));
        assert!(!WorkspaceWatcher::is_relevant(".trash/20260101/a.md"));
        assert!(!WorkspaceWatcher::is_relevant("manuscript/.yuhua/x.md"));
        assert!(!WorkspaceWatcher::is_relevant(".git/COMMIT_EDITMSG.md"));
    }

    #[test]
    fn temp_files_are_ignored() {
        // 原子写自己的临时文件不能触发外部改动提示
        assert!(!WorkspaceWatcher::is_relevant(
            "manuscript/001.md.tmp-abcdef12"
        ));
        assert!(!WorkspaceWatcher::is_relevant(
            "manuscript/a.md.tmp-12345678"
        ));
    }

    #[test]
    fn merge_keeps_created_for_new_file_double_event() {
        // fs::write 新建文件会先 Create 再 Modify，必须仍报 Created
        assert_eq!(
            merge_kind(ChangeKind::Created, ChangeKind::Modified),
            ChangeKind::Created
        );
    }

    #[test]
    fn merge_prefers_renamed_over_everything() {
        assert_eq!(
            merge_kind(ChangeKind::Created, ChangeKind::Renamed),
            ChangeKind::Renamed
        );
        assert_eq!(
            merge_kind(ChangeKind::Modified, ChangeKind::Renamed),
            ChangeKind::Renamed
        );
    }

    #[test]
    fn merge_reports_removed_when_file_created_then_deleted() {
        assert_eq!(
            merge_kind(ChangeKind::Created, ChangeKind::Removed),
            ChangeKind::Removed
        );
    }

    #[test]
    fn merge_takes_latest_for_plain_modifications() {
        assert_eq!(
            merge_kind(ChangeKind::Modified, ChangeKind::Modified),
            ChangeKind::Modified
        );
        assert_eq!(
            merge_kind(ChangeKind::Removed, ChangeKind::Modified),
            ChangeKind::Modified
        );
    }

    #[test]
    fn classify_maps_common_event_kinds() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind};
        assert_eq!(
            classify(&EventKind::Create(CreateKind::File)),
            Some(ChangeKind::Created)
        );
        assert_eq!(
            classify(&EventKind::Modify(ModifyKind::Data(
                notify::event::DataChange::Content
            ))),
            Some(ChangeKind::Modified)
        );
        assert_eq!(
            classify(&EventKind::Modify(ModifyKind::Name(
                notify::event::RenameMode::Both
            ))),
            Some(ChangeKind::Renamed)
        );
        assert_eq!(
            classify(&EventKind::Remove(RemoveKind::File)),
            Some(ChangeKind::Removed)
        );
    }

    #[test]
    fn classify_ignores_access_events() {
        assert_eq!(
            classify(&EventKind::Access(notify::event::AccessKind::Read)),
            None
        );
    }

    #[test]
    fn editing_chapter_requires_prompt() {
        // 计划书硬约束：正在编辑的章节被外部改动，绝不静默覆盖
        assert_eq!(decide_action(true), ExternalChangeAction::PromptUser);
    }

    #[test]
    fn idle_chapter_auto_reloads() {
        assert_eq!(decide_action(false), ExternalChangeAction::AutoReload);
    }

    #[test]
    fn reserved_dir_detection() {
        assert!(is_in_reserved_dir(Path::new("D:/ws/.yuhua/backup/x.md")));
        assert!(is_in_reserved_dir(Path::new("D:/ws/.trash/x.md")));
        assert!(!is_in_reserved_dir(Path::new("D:/ws/manuscript/x.md")));
    }

    #[test]
    fn watcher_observes_real_file_creation() {
        // 真实验证：创建文件后应当收到 Created 事件
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let watcher = WorkspaceWatcher::start(&root).unwrap();

        // 先清掉监听器启动过程中可能产生的历史事件
        std::thread::sleep(Duration::from_millis(300));
        watcher.drain_changes();

        let target = root.join("manuscript/001-第一章.md");
        std::fs::write(&target, "正文内容").unwrap();

        // 轮询等待，避免固定 sleep 造成的偶发失败
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut found = None;
        while Instant::now() < deadline {
            if let Some(c) = watcher.next_change(Duration::from_millis(200)) {
                if c.relative_path.ends_with("001-第一章.md") {
                    found = Some(c);
                    break;
                }
            }
        }

        let change = found.expect("未收到文件创建事件");
        // 新文件必须报 Created（合并规则保证 Modified 不会覆盖它）
        assert_eq!(change.kind, ChangeKind::Created);
        assert_eq!(change.relative_path, "manuscript/001-第一章.md");
    }

    #[test]
    fn watcher_ignores_non_markdown_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let watcher = WorkspaceWatcher::start(&root).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        watcher.drain_changes();

        std::fs::write(root.join("manuscript/笔记.txt"), "不是 Markdown").unwrap();
        std::thread::sleep(Duration::from_millis(600));

        let changes = watcher.drain_changes();
        assert!(
            changes.iter().all(|c| !c.relative_path.ends_with(".txt")),
            "不应报告 .txt 改动：{changes:?}"
        );
    }

    #[test]
    fn watcher_coalesces_rapid_writes_into_one_change() {
        // 云盘式连续写入应被防抖合并，而不是产生 N 条事件
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let watcher = WorkspaceWatcher::start(&root).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        watcher.drain_changes();

        let target = root.join("manuscript/001-第一章.md");
        for i in 0..8 {
            std::fs::write(&target, format!("第 {i} 次写入")).unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }

        std::thread::sleep(Duration::from_millis(900));
        let changes = watcher.drain_changes();
        let for_target: Vec<_> = changes
            .iter()
            .filter(|c| c.relative_path.ends_with("001-第一章.md"))
            .collect();
        assert!(
            for_target.len() <= 2,
            "8 次快速写入应被合并，实际产生 {} 条事件：{for_target:?}",
            for_target.len()
        );
    }
}
