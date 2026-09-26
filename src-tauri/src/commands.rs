//! Tauri 命令层。
//!
//! ## 定位：薄壳
//!
//! 本模块遵循计划书 3.1 节的约束：
//!
//! > 命令层职责：参数校验、权限边界、错误码翻译、事件推送。
//! > **原则：薄壳，不含业务逻辑。**
//!
//! 因此每个命令都只做三件事：
//! 1. 取当前工作区（校验「已打开」这个前提）
//! 2. 调用领域 crate 里的一个函数
//! 3. 把结果或错误翻译成 IPC 形状
//!
//! ## 访问会话的统一姿势
//!
//! 会话（\`WorkspaceSession\`）里的索引与监听器都不是 \`Sync\` 的
//! （见 \`state\` 模块文档），因此它被 \`Arc<Mutex<..>>\` 包着。命令里
//! 访问它的写法固定为两步：
//!
//! \`\`\`text
//! let s = session(&state)?;      // Arc：把所有权带出来，不持有外层读锁
//! let guard = lock_session(&s)?; // 只在真正要用时才加锁
//! let index = guard.index();
//! \`\`\`
//!
//! **先取 \`Arc\`、后加锁**，是因为中间往往夹着路径解析与文件读写
//! 这类慢操作；把它们放在锁外，并发命令才不会互相拖住。
//!
//! ## 返回类型约定
//!
//! 所有命令返回 \`Result<T, CommandError>\`。前端拿到的错误形如
//! \`{ code, message, recoverable, detail }\`，按 \`code\` 分支处理。
//!
//! ## 命名约定
//!
//! 计划书附录 A：命令名小写下划线、动词开头（\`create_chapter\`）。
//! 由 tauri-specta 或前端手写的 \`invoke("create_chapter")\` 直接对应。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use yuhua_core::model::{ChapterSummary, Document, OutlineNode};
use yuhua_core::{ChapterId, CountMode, VolumeId};
use yuhua_export::{ExportFormat, ExportScope};
use yuhua_fs::conflict::DetectedConflict;
use yuhua_fs::workspace::WorkspaceSummary;
use yuhua_store::search::{SearchQuery, SearchResults};
use yuhua_store::stats::WordStats;

use crate::error::CommandError;
use crate::state::{poisoned, AppState, SessionHandle, WorkspaceSession};

/// 命令层统一的 Result。
type CmdResult<T> = std::result::Result<T, CommandError>;

/// Returns the on-disk object that owns a chapter. New workspaces store the
/// manuscript in a chapter directory; legacy workspaces still store a single
/// markdown file directly under the volume directory.
fn chapter_storage_path(path: &str) -> String {
    let p = std::path::Path::new(path);
    let Some(parent) = p.parent() else {
        return path.to_string();
    };
    // manuscript/<volume>/<chapter>/<chapter>.md is the new layout.
    // Legacy files have only manuscript/<volume>/<chapter>.md.
    if p.components().count() >= 4 {
        parent.to_string_lossy().replace('\\', "/")
    } else {
        path.to_string()
    }
}

/// 取当前会话句柄，未打开时报错。
///
/// 只返回 \`Arc\`，不加锁：加锁的时机由调用方决定，
/// 这样慢操作可以留在锁外。
fn session(state: &AppState) -> CmdResult<SessionHandle> {
    state.current()
}

/// 对被 \`Mutex\` 包住的会话加锁。
///
/// 抽成函数是因为这个 \`map_err\` 在命令里出现频率很高，
/// 而中毒错误的文案必须**处处一致**（前端按文案做过展示兜底）。
fn lock_session(s: &SessionHandle) -> CmdResult<std::sync::MutexGuard<'_, WorkspaceSession>> {
    s.lock().map_err(|_| poisoned())
}

// ============================================================================
//  工作区
// ============================================================================

/// 工作区打开结果（供前端一次性拿到初始状态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    /// 工作区摘要。
    pub workspace: WorkspaceSummary,
    /// 文稿结构（书 + 卷 + 章摘要）。
    pub outline: Vec<OutlineNode>,
    /// 全书字数统计。
    pub words: WordStats,
    /// 崩溃恢复报告：需要提示用户时非空。
    pub recovery: RecoveryReportDto,
}

/// 崩溃恢复报告的 IPC 形状。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReportDto {
    /// 清理的临时文件数。
    pub swept_temp_files: usize,
    /// 上次未完成的操作描述。
    pub interrupted_operations: Vec<String>,
    /// 涉及的章节路径。
    pub pending_paths: Vec<String>,
    /// 清理的过期回收站条目数。
    pub purged_trash_items: usize,
    /// 发现的云盘冲突副本。
    pub conflicts: Vec<ConflictDto>,
}

/// 冲突副本的 IPC 形状。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDto {
    /// 相对路径。
    pub relative_path: String,
    /// 文件名。
    pub file_name: String,
    /// 推测对应的原始文件名。
    pub original_file_name: String,
    /// 命中的命名模式说明。
    pub pattern_label: String,
}

impl From<DetectedConflict> for ConflictDto {
    fn from(c: DetectedConflict) -> Self {
        Self {
            relative_path: c.relative_path,
            file_name: c.file_name,
            original_file_name: c.original_file_name,
            pattern_label: c.pattern.label().to_string(),
        }
    }
}

/// 新建工作区并打开。
#[tauri::command]
pub fn create_workspace(
    state: State<'_, AppState>,
    path: String,
    title: String,
) -> CmdResult<OpenResult> {
    if title.trim().is_empty() {
        return Err(CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(
            "书名不能为空".into(),
        )));
    }
    let handle = state.create(PathBuf::from(path), title)?;
    let doc = state.document()?;
    build_open_result(&handle, &doc)
}

/// 打开已有工作区。
#[tauri::command]
pub fn open_workspace(state: State<'_, AppState>, path: String) -> CmdResult<OpenResult> {
    let handle = state.open(PathBuf::from(path))?;
    let doc = state.document()?;
    build_open_result(&handle, &doc)
}

/// 组装打开工作区的返回值。
///
/// 需要同时看会话（索引、恢复报告）与文稿，因此在这里加一次锁，
/// 把该取的都取完就立刻释放。
fn build_open_result(s: &SessionHandle, doc: &Document) -> CmdResult<OpenResult> {
    let guard = lock_session(s)?;

    let words = yuhua_store::stats::word_stats(
        guard.index().connection(),
        doc.book.id.as_str(),
        None,
        None,
    )?;

    let recovery = guard.recovery();
    Ok(OpenResult {
        workspace: yuhua_fs::workspace::Workspace::summarize(guard.root()),
        outline: doc.outline(),
        words,
        recovery: RecoveryReportDto {
            swept_temp_files: recovery.swept_temp_files,
            interrupted_operations: recovery.interrupted_operations.clone(),
            pending_paths: recovery.pending_paths.clone(),
            purged_trash_items: recovery.purged_trash_items,
            conflicts: recovery.conflicts.iter().cloned().map(Into::into).collect(),
        },
    })
}

/// 关闭当前工作区。
#[tauri::command]
pub fn close_workspace(state: State<'_, AppState>) -> CmdResult<()> {
    state.close()
}

/// 是否已打开工作区。
#[tauri::command]
pub fn has_workspace(state: State<'_, AppState>) -> bool {
    state.has_session()
}

/// 读取指定目录中的工作区信息（用于「打开」对话框的即时校验）。
///
/// 不需要 \`State\`：这是纯磁盘检查，未打开工作区时也要能用。
#[tauri::command]
pub fn inspect_workspace(path: String) -> WorkspaceSummary {
    yuhua_fs::workspace::Workspace::summarize(std::path::Path::new(&path))
}

// ============================================================================
//  文稿结构
// ============================================================================

/// 取文稿大纲（卷 + 章摘要 + 字数聚合）。
#[tauri::command]
pub fn get_outline(state: State<'_, AppState>) -> CmdResult<Vec<OutlineNode>> {
    Ok(state.document()?.outline())
}

/// 取全书 / 指定卷 / 指定章的字数统计。
#[tauri::command]
pub fn get_word_stats(
    state: State<'_, AppState>,
    volume_id: Option<String>,
    chapter_id: Option<String>,
) -> CmdResult<WordStats> {
    let s = session(&state)?;
    let doc = state.document()?;
    let guard = lock_session(&s)?;
    Ok(yuhua_store::stats::word_stats(
        guard.index().connection(),
        doc.book.id.as_str(),
        volume_id.as_deref(),
        chapter_id.as_deref(),
    )?)
}

/// 新建一卷。
///
/// 命令壳只做参数解包；真正的逻辑在 [`create_volume_impl`]，这样它就
/// 能用 `&AppState` 直接单测 —— `State<'_, T>` 没有公开构造方式。
#[tauri::command]
pub fn create_volume(state: State<'_, AppState>, title: String) -> CmdResult<Vec<OutlineNode>> {
    create_volume_impl(&state, title)
}

/// [`create_volume`] 的实现（不含 Tauri 外壳，便于测试）。
fn create_volume_impl(state: &AppState, title: String) -> CmdResult<Vec<OutlineNode>> {
    let s = session(state)?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(
            "卷名不能为空".into(),
        )));
    }

    let doc_before = state.document()?;
    let now = now_local();
    let next_sort = doc_before
        .volumes
        .iter()
        .map(|v| v.sort)
        .max()
        .unwrap_or(-1)
        + 1;
    let volume = yuhua_core::model::Volume::new(&doc_before.book.id, &title, next_sort, now);

    // 建目录 + 持久化。锁的作用域只覆盖「取布局」这一步。
    let dir_name = yuhua_fs::layout::WorkspaceLayout::volume_dir_name(next_sort, &title);
    let dir = {
        let guard = lock_session(&s)?;
        guard.layout().manuscript_dir().join(&dir_name)
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::io(&dir, e)))?;

    state.with_document_mut(|doc| {
        doc.volumes.push(volume.clone());
        doc.renumber_volumes();
        Ok(())
    })?;

    // 先落盘再重扫。顺序不能反：重扫会用配置里的卷清单重建内存结构，
    // 若配置里还没有这个新卷，它会被当成「用户手工建的目录」——
    // 那样拿到的标题是 `strip_sort_prefix(001-新卷名)`，虽然碰巧一样，
    // 但 sort 会退化成枚举下标，与 `renumber_volumes` 的结果不再一致。
    persist_volumes(state)?;

    // 同步索引
    reload_and_sync(state)?;
    Ok(state.document()?.outline())
}

/// 重命名一卷。
#[tauri::command]
pub fn rename_volume(
    state: State<'_, AppState>,
    volume_id: String,
    title: String,
) -> CmdResult<Vec<OutlineNode>> {
    rename_volume_impl(&state, volume_id, title)
}

/// [`rename_volume`] 的实现（不含 Tauri 外壳，便于测试）。
fn rename_volume_impl(
    state: &AppState,
    volume_id: String,
    title: String,
) -> CmdResult<Vec<OutlineNode>> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(
            "卷名不能为空".into(),
        )));
    }
    let vid = VolumeId::parse(volume_id)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;

    state.with_document_mut(|doc| {
        let vol = doc
            .volumes
            .iter_mut()
            .find(|v| v.id == vid)
            .ok_or_else(|| {
                CommandError::Domain(yuhua_core::YuhuaError::NotFound {
                    kind: "volume",
                    id: vid.to_string(),
                })
            })?;
        vol.title = title.clone();
        Ok(())
    })?;

    // ---- 关键顺序：先落盘，再重扫 ----
    //
    // 重命名此前只改内存，紧接着的 `reload_and_sync` 用扫描结果
    // **整体覆盖**内存文稿，于是新卷名当场丢失 ——
    // 界面闪一下又变回旧名，用户以为是自己没点到。
    //
    // 修法是让卷名有一个磁盘上的家（`workspace.json` 的 `volumes`），
    // 扫描改为「配置优先」。因此这里必须先写配置：若先重扫，
    // 扫描读到的还是旧配置，改动照样被冲掉。
    persist_volumes(state)?;

    reload_and_sync(state)?;
    Ok(state.document()?.outline())
}

/// 删除一卷（移入回收站）。
#[tauri::command]
pub fn delete_volume(state: State<'_, AppState>, volume_id: String) -> CmdResult<Vec<OutlineNode>> {
    delete_volume_impl(&state, volume_id)
}

/// [`delete_volume`] 的实现（不含 Tauri 外壳，便于测试）。
fn delete_volume_impl(state: &AppState, volume_id: String) -> CmdResult<Vec<OutlineNode>> {
    let s = session(state)?;
    let vid = VolumeId::parse(volume_id)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;

    let doc_before = state.document()?;
    let vol = doc_before
        .find_volume(&vid)
        .ok_or_else(|| {
            CommandError::Domain(yuhua_core::YuhuaError::NotFound {
                kind: "volume",
                id: vid.to_string(),
            })
        })?
        .clone();

    // 找磁盘目录。
    //
    // ## 为什么优先用配置里的 `dir_name`，而不是现拼
    //
    // 现拼的 `volume_dir_name(vol.sort, &vol.title)` 依赖两个可能已经
    // 过期的内存字段：卷被重命名后 title 是新的、目录名还是旧的；
    // 卷被重排后 sort 是新的、目录名里的编号还是旧的。两种情况下
    // 拼出来的路径都指向**别的目录或不存在的位置**，于是
    // `.exists()` 为假 → 跳过回收站 → 章节从内存与索引里被删掉，
    // 而磁盘文件原封不动，下次扫描它们又"复活"。
    //
    // 配置里的 `dir_name` 是**当初建这个目录时用的那一个**，
    // 因此它是这条路径上唯一的权威。
    let dir_name = lock_session(&s)?
        .config()
        .volumes
        .iter()
        .find(|r| r.id == vid.as_str())
        .map(|r| r.dir_name.clone())
        .unwrap_or_else(|| {
            yuhua_fs::layout::WorkspaceLayout::volume_dir_name(vol.sort, &vol.title)
        });
    let rel = format!("manuscript/{dir_name}");

    let layout = lock_session(&s)?.layout().clone();
    let trash = yuhua_fs::trash::TrashManager::new(layout.clone());
    // 目录不存在时（例如空卷还没建目录）跳过回收站 —— 但**不静默**：
    // 卷仍然会从内存、配置与索引里移除，只是没有任何文件被移动。
    // 一条 at-least-once 的说明比一个"成功"更诚实。
    let dir_exists = layout.manuscript_dir().join(&dir_name).exists();
    if dir_exists {
        trash.move_to_trash(&rel, &vol.title, vid.as_str(), "volume")?;
    } else {
        // 「UI 说删了、其实没删且没人知道」是明确禁止的状态。
        // 卷此刻确实不在磁盘上，因此删除是**真的完成了**；
        // 但用户若以为有文件被移进回收站，需要能从这里看出来。
        eprintln!(
            "[删除卷] 卷「{}」在磁盘上没有对应目录（{}），卷信息已移除，未移动任何文件。",
            vol.title, rel
        );
    }

    state.with_document_mut(|doc| {
        doc.chapters.retain(|c| c.volume_id != vid);
        doc.volumes.retain(|v| v.id != vid);
        doc.renumber_volumes();
        Ok(())
    })?;

    // 从配置里移除这一卷。必须在重扫之前：重扫是「配置优先」的，
    // 配置里还留着它的话，这一卷会连同它的目录名一起被重新建出来。
    persist_volumes(state)?;

    // 索引里也要清掉这些章节
    reload_and_sync(state)?;
    Ok(state.document()?.outline())
}

/// 新建一章。
#[tauri::command]
pub fn create_chapter(
    state: State<'_, AppState>,
    volume_id: String,
    title: String,
) -> CmdResult<Vec<OutlineNode>> {
    create_chapter_impl(&state, volume_id, title)
}

/// [`create_chapter`] 的实现（不含 Tauri 外壳，便于测试）。
fn create_chapter_impl(
    state: &AppState,
    volume_id: String,
    title: String,
) -> CmdResult<Vec<OutlineNode>> {
    let s = session(state)?;
    let vid = VolumeId::parse(volume_id)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;

    let doc_before = state.document()?;
    let vol = doc_before.find_volume(&vid).ok_or_else(|| {
        CommandError::Domain(yuhua_core::YuhuaError::NotFound {
            kind: "volume",
            id: vid.to_string(),
        })
    })?;

    let title = title.trim().to_string();
    let title = if title.is_empty() {
        // 用户没填标题时给一个合理默认，而不是报错
        let n = doc_before.chapters_in_volume(&vid).len() + 1;
        format!("第 {n} 章")
    } else {
        title
    };

    let next_sort = doc_before
        .chapters_in_volume(&vid)
        .iter()
        .map(|c| c.sort)
        .max()
        .unwrap_or(-1)
        + 1;

    // 目标目录必须取自配置里的 `dir_name`，理由与 `delete_volume` 相同：
    // 现拼 `volume_dir_name(vol.sort, &vol.title)` 在卷被重命名或重排后
    // 会指向**旧目录名**（重命名后）或**另一个卷的目录**（重排后），
    // 于是新章节文件被建进一个孤儿目录，或者串到别的卷里去。
    let dir_name = lock_session(&s)?
        .config()
        .volumes
        .iter()
        .find(|r| r.id == vid.as_str())
        .map(|r| r.dir_name.clone())
        .unwrap_or_else(|| {
            yuhua_fs::layout::WorkspaceLayout::volume_dir_name(vol.sort, &vol.title)
        });
    let file_name = yuhua_fs::layout::WorkspaceLayout::chapter_file_name(next_sort, &title);
    let chapter_dir = yuhua_fs::layout::WorkspaceLayout::chapter_dir_name(next_sort, &title);
    let rel = format!("manuscript/{dir_name}/{chapter_dir}/{file_name}");

    // 先写文件（真源），再更新内存与索引
    let now = now_local();
    let chapter =
        yuhua_core::model::Chapter::new(&doc_before.book.id, &vid, &title, &rel, next_sort, now);
    let abs = lock_session(&s)?.layout().resolve(&rel)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::io(parent, e)))?;
    }
    let cf = yuhua_fs::chapter_io::ChapterFile {
        meta: chapter.meta.clone(),
        body: String::new(),
        had_front_matter: true,
    };
    yuhua_fs::chapter_io::write_chapter(&abs, &cf).map_err(CommandError::Domain)?;

    reload_and_sync(state)?;
    Ok(state.document()?.outline())
}

/// 重命名一章。
#[tauri::command]
pub fn rename_chapter(
    state: State<'_, AppState>,
    chapter_id: String,
    title: String,
) -> CmdResult<Vec<OutlineNode>> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(
            "章节标题不能为空".into(),
        )));
    }
    let cid = ChapterId::parse(chapter_id)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;

    let s = session(&state)?;
    let doc = state.document()?;
    let chapter = doc.find_chapter(&cid).ok_or_else(|| {
        CommandError::Domain(yuhua_core::YuhuaError::NotFound {
            kind: "chapter",
            id: cid.to_string(),
        })
    })?;

    // 只改 Front Matter 里的标题，**不重命名文件**。
    // 理由：重命名文件会让用户的云盘同步产生「删除 + 新增」，
    // 也会让正在别处打开这个文件的编辑器失效。标题与文件名解耦更安全。
    let abs = lock_session(&s)?.layout().resolve(&chapter.path)?;
    let mut cf = yuhua_fs::chapter_io::read_chapter(&abs)?;
    cf.meta.title = title;
    cf.meta.updated = now_local();
    yuhua_fs::chapter_io::write_chapter(&abs, &cf)?;

    reload_and_sync(&state)?;
    Ok(state.document()?.outline())
}

/// 删除一章（移入回收站）。
#[tauri::command]
pub fn delete_chapter(
    state: State<'_, AppState>,
    chapter_id: String,
) -> CmdResult<Vec<OutlineNode>> {
    let s = session(&state)?;
    let cid = ChapterId::parse(chapter_id)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;

    let doc_before = state.document()?;
    let chapter = doc_before.find_chapter(&cid).ok_or_else(|| {
        CommandError::Domain(yuhua_core::YuhuaError::NotFound {
            kind: "chapter",
            id: cid.to_string(),
        })
    })?;

    let layout = lock_session(&s)?.layout().clone();
    let trash = yuhua_fs::trash::TrashManager::new(layout);
    // New chapters are directories containing the manuscript and optional
    // `tips.md`. Move the directory as a unit so notes are not orphaned.
    let source = chapter_storage_path(&chapter.path);
    trash.move_to_trash(&source, &chapter.meta.title, cid.as_str(), "chapter")?;

    reload_and_sync(&state)?;
    Ok(state.document()?.outline())
}

/// 调整章节顺序（拖拽排序后调用）。
///
/// \`ordered_ids\` 是该卷内章节的新顺序。
#[tauri::command]
pub fn reorder_chapters(
    state: State<'_, AppState>,
    volume_id: String,
    ordered_ids: Vec<String>,
) -> CmdResult<Vec<OutlineNode>> {
    let vid = VolumeId::parse(volume_id)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;

    state.with_document_mut(|doc| {
        for (i, id) in ordered_ids.iter().enumerate() {
            let Ok(cid) = ChapterId::parse(id.clone()) else {
                continue;
            };
            if let Some(ch) = doc
                .chapters
                .iter_mut()
                .find(|c| c.meta.id == cid && c.volume_id == vid)
            {
                ch.sort = i as i32;
            }
        }
        doc.renumber_volume(&vid);
        doc.validate()?;
        Ok(())
    })?;

    reload_and_sync(&state)?;
    Ok(state.document()?.outline())
}

/// 调整卷顺序。
#[tauri::command]
pub fn reorder_volumes(
    state: State<'_, AppState>,
    ordered_ids: Vec<String>,
) -> CmdResult<Vec<OutlineNode>> {
    reorder_volumes_impl(&state, ordered_ids)
}

/// [`reorder_volumes`] 的实现（不含 Tauri 外壳，便于测试）。
fn reorder_volumes_impl(state: &AppState, ordered_ids: Vec<String>) -> CmdResult<Vec<OutlineNode>> {
    state.with_document_mut(|doc| {
        for (i, id) in ordered_ids.iter().enumerate() {
            let Ok(vid) = VolumeId::parse(id.clone()) else {
                continue;
            };
            if let Some(v) = doc.volumes.iter_mut().find(|v| v.id == vid) {
                v.sort = i as i32;
            }
        }
        doc.renumber_volumes();
        doc.validate()?;
        Ok(())
    })?;

    // 与重命名同理：先落盘再重扫，否则新的 sort 会被扫描结果覆盖
    persist_volumes(state)?;

    reload_and_sync(state)?;
    Ok(state.document()?.outline())
}

// ============================================================================
//  章节内容
// ============================================================================

/// 章节内容（正文 + 元数据）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterContent {
    /// 章节 ID。
    pub id: String,
    /// 标题。
    pub title: String,
    /// 正文。
    pub body: String,
    /// 字数（三口径）。
    pub words: yuhua_core::WordCount,
    /// 最后修改时间（Unix 毫秒）。
    pub mtime: i64,
    /// 内容哈希（保存时回传，用于乐观并发检查）。
    pub content_hash: String,
}

/// 读取章节正文。
///
/// 正文取自**磁盘文件**而非内存文稿：内存里的 \`Chapter.body\` 已被扫描
/// 流程刻意丢弃（见 \`scan\` 模块），磁盘才是真源。
#[tauri::command]
pub fn read_chapter(state: State<'_, AppState>, chapter_id: String) -> CmdResult<ChapterContent> {
    let s = session(&state)?;
    let cid = ChapterId::parse(chapter_id)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;

    let doc = state.document()?;
    let chapter = doc.find_chapter(&cid).ok_or_else(|| {
        CommandError::Domain(yuhua_core::YuhuaError::NotFound {
            kind: "chapter",
            id: cid.to_string(),
        })
    })?;

    let abs = lock_session(&s)?.layout().resolve(&chapter.path)?;
    let cf = yuhua_fs::chapter_io::read_chapter(&abs)?;
    let words = yuhua_core::count_words(&cf.body);

    Ok(ChapterContent {
        id: cid.to_string(),
        title: cf.meta.title,
        body: cf.body,
        words,
        mtime: chapter.mtime,
        content_hash: chapter.content_hash.clone(),
    })
}

/// 保存前的乐观并发检查。
///
/// ## 为什么抽成独立函数
///
/// 这段逻辑有三条容易写错的分支（哈希不符、读不出来、空哈希放行），
/// 而它恰好是「绝不静默覆盖」这条不变量的**唯一**落地点。放在
/// `save_chapter` 里就永远只能靠集成测试覆盖 —— 而 `State<'_, AppState>`
/// 没有公开构造方式，命令函数在单测里根本调不到。
///
/// 抽出来之后每条分支都能用一个临时目录直接钉死（见本模块的测试）。
///
/// ## 三条分支的语义
///
/// | `expected` | 行为 |
/// | --- | --- |
/// | `None` / `""` | 无条件放行（向后兼容：调用方没做并发控制时的既有行为） |
/// | 非空且与磁盘一致 | 放行 |
/// | 非空且与磁盘不一致 | 拒绝 —— 文件被外部改过 |
/// | 非空但**读不出磁盘** | 拒绝 —— 见下面「为什么读失败不能放行」 |
///
/// ## 为什么读失败不能放行
///
/// 「不知道磁盘上是什么」与「磁盘上和我读到的一样」是两回事。
/// 把读失败塌成空串再判「空串即无冲突」，恰好会在文件被云盘锁住
/// 或被误删时放行一次覆盖，把用户的稿子冲掉 —— 而那正是这条防护
/// 存在的理由。因此读失败必须中止保存。
fn check_no_external_conflict(abs: &std::path::Path, expected: Option<&str>) -> CmdResult<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if expected.is_empty() {
        // 空哈希是调用方的明确声明「我不做并发控制」，不是「磁盘上没内容」。
        // 这个分支必须保留原样：前端有调用点只传正文。
        return Ok(());
    }

    let cf = yuhua_fs::chapter_io::read_chapter(abs).map_err(|e| {
        CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(format!(
            "无法读取磁盘上的章节内容，为安全起见本次保存已取消：{e}"
        )))
    })?;

    // 用「正文」而非「整个文件」算哈希：Front Matter 里的 updated 每次
    // 保存都会变，算进去会让每次保存都误判为「内容变了」。
    let current = yuhua_store::index::content_hash(&cf.body);
    if current != expected {
        return Err(CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(
            "该章节已被外部修改（可能来自云盘同步或其它编辑器），为避免覆盖你的改动，本次保存已取消。请重新打开该章查看最新内容。"
                .into(),
        )));
    }
    Ok(())
}

/// 保存章节正文。
///
/// ## 保存流程（对应计划书 4.4 节的四种机制）
///
/// 1. 写崩溃日志（begin）
/// 2. 轮转备份（距上次快照 > 5 分钟时）
/// 3. 原子写文件
/// 4. 更新内存与索引
/// 5. 清除崩溃日志（commit）
///
/// ## 乐观并发检查
///
/// \`expected_hash\` 非空时，若磁盘上的当前内容哈希与它不符，
/// 说明文件被外部（云盘 / 别的编辑器）改过。此时**拒绝覆盖**并报错，
/// 由前端提示用户处理 —— 这正是不变量「绝不静默覆盖」的落地。
/// 具体判定见 [`check_no_external_conflict`]。
#[tauri::command]
pub fn save_chapter(
    state: State<'_, AppState>,
    chapter_id: String,
    body: String,
    expected_hash: Option<String>,
) -> CmdResult<ChapterContent> {
    let s = session(&state)?;
    let cid = ChapterId::parse(chapter_id)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;

    let doc = state.document()?;
    let chapter = doc.find_chapter(&cid).ok_or_else(|| {
        CommandError::Domain(yuhua_core::YuhuaError::NotFound {
            kind: "chapter",
            id: cid.to_string(),
        })
    })?;
    let rel = chapter.path.clone();

    // 一次加锁把需要的会话数据复制出来，之后所有慢操作都在锁外进行。
    // 这正是「绝不跨慢操作持锁」这条纪律的落地：保存路径按设计要跑
    // 备份轮转与原子写，可能耗时数十毫秒，不应阻塞其它命令。
    let layout = lock_session(&s)?.layout().clone();
    let abs = layout.resolve(&rel)?;

    // ---- 乐观并发检查 ----
    check_no_external_conflict(&abs, expected_hash.as_deref())?;

    // ---- 崩溃日志：begin ----
    let journal = yuhua_fs::journal::Journal::new(layout.journal_dir());
    let entry_id = journal
        .begin(
            yuhua_fs::journal::JournalKind::ChapterSave,
            vec![rel.clone()],
            format!("保存《{}》", chapter.meta.title),
        )
        .ok();

    // ---- 轮转备份 ----
    let backup = yuhua_fs::backup::BackupManager::new(layout.backup_dir());
    let _ = backup.snapshot_if_due(&abs, &rel, now_local());

    // ---- 原子写 ----
    let mut cf = yuhua_fs::chapter_io::read_chapter(&abs)?;
    cf.meta.updated = now_local();
    cf.body = body.clone();
    if let Err(e) = yuhua_fs::chapter_io::write_chapter(&abs, &cf) {
        // 保存失败：清掉崩溃日志，避免下次启动误报「上次有未完成操作」
        if let Some(id) = &entry_id {
            let _ = journal.commit(id);
        }
        return Err(CommandError::Domain(e));
    }

    // ---- 清崩溃日志：commit ----
    if let Some(id) = &entry_id {
        let _ = journal.commit(id);
    }

    // ---- 更新内存与索引 ----
    let mtime = std::fs::metadata(&abs)
        .ok()
        .map(|m| yuhua_store::index::mtime_millis(&m))
        .unwrap_or(0);
    let hash = yuhua_store::index::content_hash(&body);
    let words = yuhua_core::count_words(&body);

    {
        // 直接更新索引（不重新扫描整个工作区，保存路径要快）
        let mut updated = chapter.clone();
        updated.body = body.clone();
        updated.meta.updated = cf.meta.updated;
        updated.mtime = mtime;
        updated.content_hash = hash.clone();
        let guard = lock_session(&s)?;
        guard.index().upsert_chapter(&updated)?;
    }

    let new_title = cf.meta.title.clone();
    state.with_document_mut(|doc| {
        if let Some(ch) = doc.find_chapter_mut(&cid) {
            ch.body = body.clone();
            ch.meta.updated = cf.meta.updated;
            ch.mtime = mtime;
            ch.content_hash = hash.clone();
        }
        Ok(())
    })?;

    Ok(ChapterContent {
        id: cid.to_string(),
        title: new_title,
        body,
        words,
        mtime,
        content_hash: hash,
    })
}

/// 更新章节元数据（摘要、便签、状态、目标字数）。
#[tauri::command]
pub fn update_chapter_meta(
    state: State<'_, AppState>,
    chapter_id: String,
    summary: Option<String>,
    notes: Option<String>,
    status: Option<String>,
    word_goal: Option<u32>,
) -> CmdResult<ChapterSummary> {
    let s = session(&state)?;
    let cid = ChapterId::parse(chapter_id)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;

    let doc = state.document()?;
    let chapter = doc.find_chapter(&cid).ok_or_else(|| {
        CommandError::Domain(yuhua_core::YuhuaError::NotFound {
            kind: "chapter",
            id: cid.to_string(),
        })
    })?;
    let abs = lock_session(&s)?.layout().resolve(&chapter.path)?;

    let mut cf = yuhua_fs::chapter_io::read_chapter(&abs)?;
    if let Some(v) = summary {
        cf.meta.summary = v;
    }
    if let Some(v) = notes {
        cf.meta.notes = v;
    }
    if let Some(v) = status {
        cf.meta.status = yuhua_core::ChapterStatus::parse(&v).ok_or_else(|| {
            CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(format!(
                "未知的章节状态：{v}（可选：draft / done / revising）"
            )))
        })?;
    }
    if let Some(v) = word_goal {
        cf.meta.word_goal = v;
    }
    cf.meta.updated = now_local();
    yuhua_fs::chapter_io::write_chapter(&abs, &cf)?;

    // 同步索引
    let mut updated = chapter.clone();
    updated.meta = cf.meta.clone();
    lock_session(&s)?.index().upsert_chapter(&updated)?;

    // 同步内存
    state.with_document_mut(|doc| {
        if let Some(ch) = doc.find_chapter_mut(&cid) {
            ch.meta = cf.meta.clone();
        }
        Ok(())
    })?;

    // 摘要从内存文稿取：那里是「刚写完磁盘后的」状态。
    // 取不到时（理论上不会发生）退回用索引里那一份。
    let fresh = state.document()?;
    Ok(fresh
        .find_chapter(&cid)
        .map(|c| c.to_summary())
        .unwrap_or_else(|| updated.to_summary()))
}

// ============================================================================
//  检索
// ============================================================================

/// 全局检索。
#[tauri::command]
pub fn search_chapters(
    state: State<'_, AppState>,
    keyword: String,
    limit: Option<u32>,
    offset: Option<u32>,
    title_only: Option<bool>,
    volume_id: Option<String>,
) -> CmdResult<SearchResults> {
    let s = session(&state)?;
    let query = SearchQuery {
        keyword,
        limit,
        offset,
        title_only: title_only.unwrap_or(false),
        volume_id,
    };
    let guard = lock_session(&s)?;
    Ok(yuhua_store::search::search(
        guard.index().connection(),
        &query,
    )?)
}

// ============================================================================
//  写作统计（M8）
// ============================================================================

/// 按天统计记录（IPC 形状）。
///
/// ## 为什么单独建一个 DTO 而不是直接序列化 `DayRecord`
///
/// `DayRecord` 里的 `chapters` 是「章节 ID → 当日新增字数」的映射、
/// `peaks` 是「章节 ID → 当日峰值」的基线。这两个字段是**采集用的
/// 内部状态**，前端一个都不需要 —— 日历与热力图只关心"这一天写了多少字"。
///
/// 直接把内部结构发过去有三个代价：载荷随章节数增长、把内部字段变成
/// 事实上的公开契约（以后不能自由改）、以及迫使前端理解"peaks 是什么"。
/// 因此在这里折算成前端真正需要的四个数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsDayDto {
    /// 日期，`YYYY-MM-DD`。
    pub date: String,
    /// 当日新增字数。
    pub words: u64,
    /// 当日写作时长（分钟）。
    pub minutes: u64,
    /// 当日涉及的章节数。
    pub chapters: usize,
}

/// `get_stats_summary` 的完整返回值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsPayloadDto {
    /// 全部按天记录，按日期升序。
    pub days: Vec<StatsDayDto>,
    /// 汇总。
    pub summary: yuhua_stats::summary::Summary,
    /// 统计分片目录（相对工作区根的路径）。
    pub stats_dir: String,
    /// 计算连续天数时使用的阈值。
    pub streak_threshold: u32,
}

/// 取写作统计的完整视图（T8.6）。
///
/// ## 为什么一口气返回全部按天记录
///
/// 因为前端的年热力图需要**一整年 365 格**的数据才能一次画出来
/// （计划书要求 365 格放在同一个 SVG 里、P11 ≤ 200 ms、逐格不动画）。
/// 分页取会让热力图必须发多次请求再拼，那既慢又让"某一天的格子
/// 是空的还是没加载"变得不可区分。
///
/// 代价是载荷大小。一条记录约 40 字节，十年也不过 ~150 KB，
/// 而这是**低频且用户主动打开**的页面 —— 可以接受。
///
/// ## 为什么在这里折算而不是让前端算
///
/// 汇总口径（连续天数阈值、平均日更的分母、近 7 日是否含今天）
/// 在 `yuhua-stats` 里已经有测试钉死。前端再算一遍必然会在
/// 某个边界上与后端漂移，而那种漂移表现为"统计数字对不上"，
/// 用户看到会直接怀疑数据丢了。
#[tauri::command]
pub fn get_stats_summary(state: State<'_, AppState>) -> CmdResult<StatsPayloadDto> {
    let s = session(&state)?;
    let store = yuhua_stats::StatsStore::new(lock_session(&s)?.layout().clone());

    // 读全部月份并合并。`load_all_days` 内部会处理冲突副本的单调合并，
    // 因此这里拿到的是"两台设备都算上"的正确结果（T8.4）
    let days = store.load_all_days()?;
    let today = now_local().date_naive();
    let summary = yuhua_stats::summary::summarize(&days, today);

    let list: Vec<StatsDayDto> = days
        .iter()
        .map(|(date, record)| StatsDayDto {
            date: date.format("%Y-%m-%d").to_string(),
            // 两个访问器返回 u32（单日增量不可能触及 42 亿），
            // 这里提升成 u64 以匹配 DTO —— 前端统一用 number，
            // 不必关心后端用的是哪个整型宽度
            words: u64::from(record.words()),
            minutes: u64::from(record.minutes()),
            chapters: record.chapters.len(),
        })
        .collect();

    Ok(StatsPayloadDto {
        days: list,
        streak_threshold: summary.streak_threshold,
        summary,
        stats_dir: format!(
            "{}/{}",
            yuhua_fs::layout::ENGINE_DIR,
            yuhua_fs::layout::STATS_DIR
        ),
    })
}

// ============================================================================
//  数据安全
// ============================================================================

/// 修复结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    /// 操作的说明。
    pub message: String,
    /// 受影响的条目数。
    pub affected: usize,
}

/// 重建索引。
#[tauri::command]
pub fn rebuild_index(state: State<'_, AppState>) -> CmdResult<RepairResult> {
    let s = session(&state)?;
    let doc = state.document()?;
    let guard = lock_session(&s)?;
    let root = guard.root_str();
    let out = guard
        .index()
        .rebuild(&doc.book, &root, &doc.volumes, &doc.chapters)?;
    Ok(RepairResult {
        message: format!(
            "索引已重建：新增 {} 章，更新 {} 章，移除 {} 章",
            out.inserted, out.updated, out.removed
        ),
        affected: out.inserted + out.updated + out.removed,
    })
}

/// 列出回收站条目。
#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> CmdResult<Vec<yuhua_core::TrashEntry>> {
    let s = session(&state)?;
    let tm = yuhua_fs::trash::TrashManager::new(lock_session(&s)?.layout().clone());
    Ok(tm.list().into_iter().map(|i| i.entry).collect())
}

/// 恢复回收站条目。
#[tauri::command]
pub fn restore_trash(
    state: State<'_, AppState>,
    trash_dir_name: String,
) -> CmdResult<RepairResult> {
    let s = session(&state)?;
    let tm = yuhua_fs::trash::TrashManager::new(lock_session(&s)?.layout().clone());
    let path = tm.restore(&trash_dir_name)?;
    reload_and_sync(&state)?;
    Ok(RepairResult {
        message: format!("已恢复到 {}", path.display()),
        affected: 1,
    })
}

/// 永久删除回收站条目。
#[tauri::command]
pub fn purge_trash(state: State<'_, AppState>, trash_dir_name: String) -> CmdResult<()> {
    let s = session(&state)?;
    let tm = yuhua_fs::trash::TrashManager::new(lock_session(&s)?.layout().clone());
    tm.purge(&trash_dir_name)?;
    Ok(())
}

/// 清空回收站。
#[tauri::command]
pub fn empty_trash(state: State<'_, AppState>) -> CmdResult<RepairResult> {
    let s = session(&state)?;
    let tm = yuhua_fs::trash::TrashManager::new(lock_session(&s)?.layout().clone());
    let n = tm.empty()?;
    Ok(RepairResult {
        message: format!("已永久删除 {n} 个条目"),
        affected: n,
    })
}

/// 重新扫描工作区并同步索引。
#[tauri::command]
pub fn rescan_workspace(state: State<'_, AppState>) -> CmdResult<Vec<OutlineNode>> {
    reload_and_sync(&state)?;
    Ok(state.document()?.outline())
}

/// 列出检测到的冲突副本（只提示，绝不删除）。
#[tauri::command]
pub fn list_conflicts(state: State<'_, AppState>) -> CmdResult<Vec<ConflictDto>> {
    let s = session(&state)?;
    // 冲突识别是纯扫描，不依赖内存文稿，也不依赖索引
    let guard = lock_session(&s)?;
    let found = yuhua_fs::conflict::detect_conflicts(
        guard.layout().manuscript_dir().as_path(),
        guard.root(),
    );
    Ok(found.into_iter().map(Into::into).collect())
}

/// 列出最近打开的工作区。
///
/// 「最近列表」存在系统应用数据目录，与当前会话无关；这里的 \`State\` 参数
/// 只为保持「所有命令签名一致」的调用惯例（前端统一 invoke 带上下文）。
#[tauri::command]
pub fn list_recent_workspaces(_state: State<'_, AppState>) -> Vec<WorkspaceSummary> {
    crate::recent::load()
        .into_iter()
        .map(|r| yuhua_fs::workspace::Workspace::summarize(&r.root))
        .collect()
}

// ============================================================================
//  导出引擎（M7）
// ============================================================================

/// 导出范围的 IPC 形状。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExportScopeDto {
    /// 当前章。
    #[serde(rename_all = "camelCase")]
    Single {
        /// 章节 ID。
        chapter_id: String,
    },
    /// 选中章节。
    #[serde(rename_all = "camelCase")]
    Selected {
        /// 章节 ID 列表。
        chapter_ids: Vec<String>,
    },
    /// 整卷。
    #[serde(rename_all = "camelCase")]
    Volume {
        /// 卷 ID。
        volume_id: String,
    },
    /// 整书。
    Whole,
}

/// 导出格式的 IPC 形状。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormatDto {
    /// 纯文本。
    Txt,
    /// Markdown。
    Markdown,
    /// HTML。
    Html,
    /// Word 文档。
    Docx,
    /// PDF。
    Pdf,
    /// 电子书。
    Epub,
}

impl ExportFormatDto {
    fn to_domain(self) -> ExportFormat {
        match self {
            Self::Txt => ExportFormat::Txt,
            Self::Markdown => ExportFormat::Markdown,
            Self::Html => ExportFormat::Html,
            Self::Docx => ExportFormat::Docx,
            Self::Pdf => ExportFormat::Pdf,
            Self::Epub => ExportFormat::Epub,
        }
    }
}

/// 导出结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResultDto {
    /// 输出文件的绝对路径。
    pub path: String,
    /// 产物字节数。
    pub bytes: usize,
    /// 降级提示（表格 / 代码块等不支持语法的处理）。
    pub degradations: Vec<DegradationDto>,
}

/// 降级记录的 IPC 形状。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradationDto {
    /// 章节标题。
    pub chapter_title: String,
    /// 降级类型（table / codeBlock / image 等）。
    pub kind: String,
    /// 具体描述。
    pub detail: String,
}

/// 导出文档。
///
/// ## 参数
///
/// - `format`：目标格式（txt / markdown / html / docx / pdf / epub）
/// - `scope`：导出范围（当前章 / 选中章节 / 整卷 / 整书）
/// - `output_path`：输出文件的绝对路径
///
/// ## 返回
///
/// 返回实际写入的路径、字节数与降级记录。降级记录非空时前端应当提示用户
/// （例如「表格已转换为纯文本」），确保不静默丢弃内容。
///
/// ## 错误
///
/// - `FONT_UNAVAILABLE`：PDF 导出时找不到可用的中文字体
/// - `INVALID_INPUT`：范围为空（选中 0 章 / 整卷但卷下无章）
/// - `IO_ERROR`：无法写入目标路径
#[tauri::command]
pub fn export_document(
    state: State<'_, AppState>,
    format: ExportFormatDto,
    scope: ExportScopeDto,
    output_path: String,
) -> CmdResult<ExportResultDto> {
    let doc = state.document()?;

    // 1. 翻译 IPC 范围到领域范围
    let domain_scope = match scope {
        ExportScopeDto::Single { chapter_id } => {
            let cid = ChapterId::parse(chapter_id)
                .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;
            ExportScope::Single(cid)
        }
        ExportScopeDto::Selected { chapter_ids } => {
            let ids: Result<Vec<_>, _> = chapter_ids
                .into_iter()
                .map(|s| ChapterId::parse(s))
                .collect();
            let ids =
                ids.map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;
            ExportScope::Selected(ids)
        }
        ExportScopeDto::Volume { volume_id } => {
            let vid = VolumeId::parse(volume_id)
                .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(e)))?;
            ExportScope::Volume(vid)
        }
        ExportScopeDto::Whole => ExportScope::Whole,
    };

    // 2. 装配 IR（按章读正文，不会整书载入内存）
    let ir = yuhua_export::scope::assemble(&doc, &domain_scope)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::export_failed(e.to_string())))?;

    // 3. 渲染并原子写盘
    let target = std::path::PathBuf::from(output_path);
    let result = yuhua_export::render_to_path(format.to_domain(), &ir, &target)
        .map_err(|e| CommandError::Domain(yuhua_core::YuhuaError::export_failed(e.to_string())))?;

    // 4. 翻译降级记录
    let degradations = ir
        .degradations
        .into_iter()
        .map(|d| DegradationDto {
            chapter_title: d.chapter_title,
            kind: format!("{:?}", d.kind),
            detail: d.detail,
        })
        .collect();

    Ok(ExportResultDto {
        path: result.path.to_string_lossy().to_string(),
        bytes: result.bytes,
        degradations,
    })
}

/// 列出所有可用的导出格式。
///
/// 返回格式的 ID、显示名、扩展名与可用性。前端据此构建导出面板的格式选择器。
#[tauri::command]
pub fn list_export_formats(_state: State<'_, AppState>) -> Vec<ExportFormatInfoDto> {
    ExportFormat::ALL
        .iter()
        .map(|&fmt| ExportFormatInfoDto {
            id: fmt.id().to_string(),
            display_name: fmt.display_name().to_string(),
            extension: fmt.extension().to_string(),
            available: fmt.is_available(),
        })
        .collect()
}

/// 导出格式信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFormatInfoDto {
    /// 格式标识符（txt / md / html / docx / pdf / epub）。
    pub id: String,
    /// 面向用户的格式名。
    pub display_name: String,
    /// 默认文件扩展名（不含点）。
    pub extension: String,
    /// 该格式是否已可用。
    pub available: bool,
}

// ============================================================================
//  内部工具
// ============================================================================

/// 把当前内存文稿的卷清单写入 `workspace.json`。
///
/// ## 为什么所有改卷的命令都要在重扫**之前**调用它
///
/// 扫描是「配置优先、目录名兜底」的（见 `scan` 模块）。因此
/// 「改内存 → 写配置 → 重扫」是唯一能保住改动的顺序：
///
/// - 先重扫：扫描按**旧**配置重建卷，刚做的重命名 / 重排当场丢失
/// - 不写配置：同上，目录名里的旧标题会把新标题盖掉
///
/// 这正是「重命名被静默丢弃」这个缺陷的根因，也是本次修复的核心。
fn persist_volumes(state: &AppState) -> CmdResult<()> {
    let s = session(state)?;
    let doc = state.document()?;
    // 先把结果取出来再返回：若直接 `lock_session(&s)?.save_volumes(&doc)`，
    // 末尾表达式里的临时守卫会比 `s` 活得更久，借用检查会拒绝。
    // `save_volumes` 需要 `&mut`，而 `MutexGuard` 的 DerefMut 正好提供它。
    let result = lock_session(&s)?.save_volumes(&doc);
    result
}

/// 重新扫描磁盘并同步索引与内存文稿。
///
/// 所有会改变结构的操作（新建 / 删除 / 重命名 / 排序）走完磁盘写入后
/// 都调用它一次。这样做而不是做增量更新，是因为结构变更的频率很低
/// （用户不会每秒建一章），而重新扫描能保证内存、索引、磁盘三者
/// **在任何时候都强一致** —— 这是数据安全场景下值得的开销。
///
/// 扫描本身要读全部章节文件，是这里唯一的慢操作；因此把它放在
/// **锁外**执行（先克隆出布局，扫完再加锁写索引）。
fn reload_and_sync(state: &AppState) -> CmdResult<()> {
    let s = session(state)?;
    let fresh = {
        let guard = lock_session(&s)?;
        // 扫描全程持锁：scan_workspace 只读工作区与磁盘，不回调命令层，
        // 不会自我加锁；而它读的正是当前会话的工作区，
        // 中途换工作区会让扫描结果张冠李戴。
        let fresh = crate::scan::scan_workspace(guard.workspace())?;
        fresh
    };
    fresh.validate()?;

    {
        let guard = lock_session(&s)?;
        let root = guard.root_str();
        guard.index().upsert_book(&fresh.book, &root)?;
        guard.index().sync_volumes(&fresh.volumes)?;
        guard
            .index()
            .sync_document(&fresh.book, &root, &fresh.chapters)?;
    }

    state.replace_document(fresh)
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

/// 统计三口径（供前端字数面板使用）。
#[tauri::command]
pub fn get_count_modes() -> Vec<CountModeDto> {
    CountMode::all()
        .into_iter()
        .map(|m| CountModeDto {
            id: match m {
                CountMode::WithPunctuation => "withPunctuation",
                CountMode::WithoutPunctuation => "withoutPunctuation",
                CountMode::WordsForEnglish => "wordsForEnglish",
            }
            .to_string(),
            label: m.label().to_string(),
        })
        .collect()
}

/// 字数口径的可选项。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountModeDto {
    /// 机器可读 ID。
    pub id: String,
    /// 用户可读名称。
    pub label: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    //  任务 C：覆盖防护的三条分支
    //
    //  这些用例针对 `check_no_external_conflict` 而不是 `save_chapter`：
    //  `State<'_, AppState>` 没有公开构造方式（tauri::State 的字段私有、
    //  也没有 `From<&T>`），因此命令函数在单测里调不到。原实现把这段
    //  逻辑内联在 `save_chapter` 里，于是它**一行测试都没有** ——
    //  这正是「读失败即放行」能活到现在的原因。抽成纯函数后每条分支
    //  都能用临时目录钉死。
    // ========================================================================

    /// 造一个已存在的章节文件，返回（临时目录, 绝对路径）。
    ///
    /// 临时目录必须由调用方持有：它一 drop 目录就没了。
    fn chapter_file(body: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("001-第一章.md");
        let cf = yuhua_fs::chapter_io::ChapterFile {
            // ChapterMeta 没有 Default（id 必须成对生成），走它的构造函数
            meta: yuhua_core::ChapterMeta::new("第一章", now_local()),
            body: body.to_string(),
            had_front_matter: true,
        };
        yuhua_fs::chapter_io::write_chapter(&path, &cf).unwrap();
        (dir, path)
    }

    #[test]
    fn conflict_check_aborts_when_file_missing() {
        // 文件不存在（被云盘挪走 / 被误删）时必须中止，**不能**当成
        // 「没有冲突」放行 —— 那会在下一行创建出一个空壳文件把稿子顶掉
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("不存在.md");

        let err = check_no_external_conflict(&missing, Some("任意哈希")).unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        // 核心断言之二：失败路径**没有**顺手把文件建出来
        assert!(!missing.exists(), "读失败时不能创建任何文件");
    }

    #[test]
    fn conflict_check_rejects_modified_file() {
        // 这条是核心回归：磁盘内容与调用方手里的哈希不符 = 被外部改过
        let (_dir, path) = chapter_file("磁盘上的新内容");
        let stale = yuhua_store::index::content_hash("调用方以为的内容");

        let err = check_no_external_conflict(&path, Some(&stale)).unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
        assert!(
            err.to_string().contains("已被外部修改"),
            "错误文案要能让用户看懂发生了什么，got {err}"
        );
        // 磁盘内容必须保持原样 —— 检查函数只能是只读的
        let after = yuhua_fs::chapter_io::read_chapter(&path).unwrap();
        assert_eq!(after.body, "磁盘上的新内容");
    }

    #[test]
    fn conflict_check_allows_matching_hash() {
        let (_dir, path) = chapter_file("一致的内容");
        let expected = yuhua_store::index::content_hash("一致的内容");
        assert!(check_no_external_conflict(&path, Some(&expected)).is_ok());
    }

    #[test]
    fn conflict_check_allows_none_and_empty_hash() {
        // 向后兼容：这两个取值是调用方在说「我不做并发控制」，
        // 必须无条件放行，且**不应**去读磁盘（文件不存在也要通过）
        let missing = std::path::Path::new("D:/definitely/not/here.md");
        assert!(check_no_external_conflict(missing, None).is_ok());
        assert!(check_no_external_conflict(missing, Some("")).is_ok());
    }

    #[test]
    fn conflict_hash_ignores_front_matter_updated_field() {
        // 哈希算的是正文而非整个文件：Front Matter 里的 updated 每次保存
        // 都会变，算进去会让「自己保存后立刻再保存」误判为外部修改。
        // 这里改一下 meta 再写回，哈希必须不变
        let (_dir, path) = chapter_file("正文没变");
        let expected = yuhua_store::index::content_hash("正文没变");

        let mut cf = yuhua_fs::chapter_io::read_chapter(&path).unwrap();
        cf.meta.updated = now_local();
        yuhua_fs::chapter_io::write_chapter(&path, &cf).unwrap();

        assert!(
            check_no_external_conflict(&path, Some(&expected)).is_ok(),
            "只改 Front Matter 不应被判为外部修改"
        );
    }

    // ========================================================================
    //  文案：嵌入的源码缩进不得泄漏给用户
    // ========================================================================

    #[test]
    fn user_facing_messages_have_no_embedded_indent() {
        // 字面量折行时把源码缩进（21 个空格）带进字符串，会原样显示给用户。
        // 这条测试盯的是「文案里不该出现连续空白」这个**通用**规则，
        // 因此新增同类文案时也会被它抓到。
        let (_dir, path) = chapter_file("磁盘内容");
        let stale = yuhua_store::index::content_hash("别的内容");
        let msg = check_no_external_conflict(&path, Some(&stale))
            .unwrap_err()
            .to_string();
        assert!(
            !msg.contains("  "),
            "用户可见文案里出现了连续空格（多半是折行时带进了源码缩进）：{msg}"
        );
    }

    #[test]
    fn future_format_version_message_has_no_embedded_indent() {
        // 同型 bug 的第二处：workspace.rs 的「版本过高」提示
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let ws = yuhua_fs::workspace::Workspace::create(&root, "书").unwrap();

        let mut cfg = ws.config.clone();
        cfg.format_version = yuhua_fs::layout::FORMAT_VERSION + 5;
        std::fs::write(
            root.join(".yuhua/workspace.json"),
            serde_json::to_string_pretty(&cfg).unwrap(),
        )
        .unwrap();

        let err = yuhua_fs::workspace::Workspace::open(&root).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("高于本软件支持"), "got {msg}");
        assert!(
            !msg.contains("  "),
            "版本过高提示里出现了连续空格（折行带进了源码缩进）：{msg}"
        );
    }

    // ========================================================================
    //  任务 B：卷名 / 卷序的持久化（对着计划 2.3 的五条验收标准）
    //
    //  这些用例调的是 `*_impl(&AppState, …)` 而不是 `#[tauri::command]`
    //  函数：`State<'_, T>` 没有公开构造方式，命令函数在单测里调不到。
    //  命令壳现在只做参数解包，逻辑全在 `*_impl` 里。
    // ========================================================================

    /// 打开一个测试用工作区，返回（临时目录, 状态）。
    fn opened_workspace() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new();
        state
            .create(dir.path().join("ws"), "测试书".into())
            .unwrap();
        (dir, state)
    }

    /// 取当前文稿里所有卷的 (id, title, sort)，**按 sort 升序**。
    ///
    /// 按 sort 排序而不是按存储顺序：界面上看到的就是 sort 序
    /// （`Document::outline` 与 `to_summary` 都按它排），
    /// 而 `doc.volumes` 的存储顺序在一次重扫后是**目录枚举序**，
    /// 两者在重排后并不相同 —— 断言时用错那个会得到假失败。
    fn volume_triples(state: &AppState) -> Vec<(String, String, i32)> {
        let mut out: Vec<(String, String, i32)> = state
            .document()
            .unwrap()
            .volumes
            .iter()
            .map(|v| (v.id.to_string(), v.title.clone(), v.sort))
            .collect();
        out.sort_by_key(|(_, _, sort)| *sort);
        out
    }

    /// 取某一卷对应的磁盘目录名（从配置里读，与命令层同一套规则）。
    fn configured_dir_name(state: &AppState, volume_id: &str) -> String {
        let s = state.current().unwrap();
        let guard = s.lock().unwrap();
        guard
            .config()
            .volumes
            .iter()
            .find(|r| r.id == volume_id)
            .map(|r| r.dir_name.clone())
            .unwrap_or_else(|| panic!("配置里找不到卷 {volume_id}"))
    }

    /// 列出 `manuscript/` 下的子目录名（已排序）。
    fn manuscript_subdirs(state: &AppState) -> Vec<String> {
        let s = state.current().unwrap();
        let guard = s.lock().unwrap();
        let manuscript = guard.layout().manuscript_dir();
        let mut names: Vec<String> = std::fs::read_dir(&manuscript)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    /// 验收 1：`rename_volume` 之后卷名是新名字（**修复前会失败**）。
    ///
    /// 修复前的链路是「改内存 → 重扫」，而重扫从目录名重建标题，
    /// 于是新名字被旧目录名覆盖。
    #[test]
    fn rename_volume_survives_rescan() {
        let (_dir, state) = opened_workspace();
        let vid = volume_triples(&state)[0].0.clone();

        rename_volume_impl(&state, vid.clone(), "改过的卷名".into()).unwrap();

        // 直接看内存（重扫已经发生过）
        let triple = volume_triples(&state)
            .into_iter()
            .find(|(id, _, _)| *id == vid)
            .expect("卷不见了");
        assert_eq!(triple.1, "改过的卷名", "重命名被重扫冲掉了");

        // 再从磁盘配置确认它真的持久化了 —— 只在内存里对不算数
        let config_text = std::fs::read_to_string(
            state
                .current()
                .unwrap()
                .lock()
                .unwrap()
                .layout()
                .config_path(),
        )
        .unwrap();
        assert!(
            config_text.contains("改过的卷名"),
            "卷名没有写进 workspace.json：{config_text}"
        );
    }

    /// 验收 2：`rename_volume` 之后 `create_chapter`，
    /// 新章节落在**该卷真实的目录**里，且没有新建多余目录。
    #[test]
    fn create_chapter_after_rename_lands_in_the_real_directory() {
        let (_dir, state) = opened_workspace();
        let vid = volume_triples(&state)[0].0.clone();

        // 目录名带着旧标题
        let dir_before_rename = configured_dir_name(&state, &vid);
        let subdirs_before = manuscript_subdirs(&state);

        rename_volume_impl(&state, vid.clone(), "全新的卷名".into()).unwrap();

        // 重命名**不碰目录名**：目录名退化为纯哈希键，这是本方案的取舍
        let dir_after_rename = configured_dir_name(&state, &vid);
        assert_eq!(
            dir_before_rename, dir_after_rename,
            "重命名不应改动磁盘目录名（否则云盘会看到删除+新增）"
        );

        create_chapter_impl(&state, vid.clone(), "新章".into()).unwrap();

        // 新章节文件必须落在**同一个**目录里
        let subdirs_after = manuscript_subdirs(&state);
        assert_eq!(
            subdirs_before, subdirs_after,
            "新建章节不该在 manuscript/ 下多出目录"
        );

        let chapter = state
            .document()
            .unwrap()
            .chapters
            .iter()
            .find(|c| c.volume_id.to_string() == vid)
            .expect("新章没有挂到目标卷上")
            .clone();
        assert!(
            chapter
                .path
                .starts_with(&format!("manuscript/{dir_after_rename}/")),
            "新章路径 {} 不在该卷目录 {} 下",
            chapter.path,
            dir_after_rename
        );
        // 文件必须真的存在
        let s = state.current().unwrap();
        let guard = s.lock().unwrap();
        assert!(
            guard.layout().resolve(&chapter.path).unwrap().is_file(),
            "章节文件没有被真的创建出来"
        );
    }

    /// 验收 3：`reorder_volumes` 之后重开工作区，顺序保持。
    #[test]
    fn reorder_volumes_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let state = AppState::new();
        state.create(root.clone(), "测试书".into()).unwrap();

        // 建到三卷，再整体倒序
        create_volume_impl(&state, "乙卷".into()).unwrap();
        create_volume_impl(&state, "丙卷".into()).unwrap();
        let before = volume_triples(&state);
        assert_eq!(before.len(), 3);

        let reversed: Vec<String> = before.iter().rev().map(|(id, _, _)| id.clone()).collect();
        reorder_volumes_impl(&state, reversed.clone()).unwrap();

        let titles_after_reorder: Vec<String> = volume_triples(&state)
            .into_iter()
            .map(|(_, t, _)| t)
            .collect();
        assert_eq!(
            titles_after_reorder,
            vec!["丙卷", "乙卷", "第一卷"],
            "重排后的顺序不对"
        );

        // 重开工作区（第二次 AppState::open），顺序必须保持
        state.open(root).unwrap();
        let after_reopen: Vec<(String, String, i32)> = volume_triples(&state);

        assert_eq!(
            after_reopen
                .iter()
                .map(|(_, t, _)| t.clone())
                .collect::<Vec<_>>(),
            titles_after_reorder,
            "重开工作区后卷序丢了"
        );
        // ID 也必须保持稳定，否则索引里引用它们的章节会变成孤儿
        assert_eq!(
            after_reopen
                .iter()
                .map(|(id, _, _)| id.clone())
                .collect::<Vec<_>>(),
            reversed,
            "重开后卷 ID 变了"
        );
    }

    /// 验收 4：旧格式兼容 —— 手工写一个**不含 `volumes`** 的 workspace.json，
    /// 能正常打开、卷从目录名推导、且回填后再次打开得到相同结果。
    #[test]
    fn opens_legacy_config_without_volumes_field() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        let state = AppState::new();
        state.create(root.clone(), "旧书".into()).unwrap();

        // 造一个卷目录 + 章节（用旧版本的目录名规则）
        let legacy_dir = root.join("manuscript/001-第一卷 风起");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("001-第一章.md"), "正文").unwrap();

        // 手工把配置改回"旧格式"：删掉 volumes 字段。
        // 用 serde_json 的 Value 删而不是写死一段 JSON —— 这样
        // formatVersion / workspaceId 之类的字段保持原样，测试
        // 只改它想改的那一处。
        let config_path = root.join(".yuhua/workspace.json");
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        value.as_object_mut().unwrap().remove("volumes");
        std::fs::write(&config_path, serde_json::to_string_pretty(&value).unwrap()).unwrap();

        // 前提校验：这份配置确实缺字段，且缺字段本身不会让它解析失败
        let raw = std::fs::read_to_string(&config_path).unwrap();
        assert!(!raw.contains("volumes"), "前提：配置里不该有 volumes");

        // 第一次打开：从目录名推导，并回填。
        //
        // 注意会有**两个**卷：`state.create` 在零卷时补了一个默认的
        // 「第一卷」（它此刻已有磁盘目录，见 `AppState::open` 的补齐逻辑），
        // 再加上我们手工建的那个目录。这里刻意不断言"恰好一个"，
        // 而是断言两个来源都正确 —— 否则测试会依赖一个无关的细节。
        state.open(root.clone()).unwrap();
        let first = volume_triples(&state);
        assert_eq!(first.len(), 2, "应当从目录名推导出两个卷：{first:?}");
        assert!(
            first.iter().any(|(_, t, _)| t == "第一卷 风起"),
            "手工建的目录没有被推导成卷：{first:?}"
        );
        assert!(
            first.iter().any(|(_, t, _)| t == "第一卷"),
            "默认卷不该在旧格式打开时丢失：{first:?}"
        );
        assert_eq!(state.document().unwrap().chapters.len(), 1);

        // 回填后磁盘上应当有 volumes 了
        let after_backfill = std::fs::read_to_string(&config_path).unwrap();
        assert!(
            after_backfill.contains("第一卷 风起"),
            "旧格式没有被回填：{after_backfill}"
        );

        // 第二次打开：结果必须与第一次**完全相同**
        state.open(root).unwrap();
        let second = volume_triples(&state);
        assert_eq!(first, second, "回填后再次打开的结果与第一次不一致");
    }

    /// 验收 5：`delete_volume` 在目录不存在时，卷确实从大纲里消失。
    #[test]
    fn delete_volume_without_directory_still_removes_it() {
        let (_dir, state) = opened_workspace();
        create_volume_impl(&state, "乙卷".into()).unwrap();

        let target = volume_triples(&state)
            .into_iter()
            .find(|(_, t, _)| t == "乙卷")
            .expect("找不到乙卷")
            .0;

        // 手工把目录删掉，模拟"空卷还没建目录"或"用户在文件管理器里删了"
        let dir_name = configured_dir_name(&state, &target);
        let s = state.current().unwrap();
        let manuscript = s.lock().unwrap().layout().manuscript_dir();
        std::fs::remove_dir_all(manuscript.join(&dir_name)).unwrap();
        assert!(!manuscript.join(&dir_name).exists(), "前提：目录已被删除");

        delete_volume_impl(&state, target.clone()).unwrap();

        // 卷必须从内存与大纲里消失 —— 这是「UI 说删了、其实没删」的反面
        let remaining = volume_triples(&state);
        assert!(
            !remaining.iter().any(|(id, _, _)| *id == target),
            "目录不存在时卷没有被移除：{remaining:?}"
        );
        assert!(
            !state
                .document()
                .unwrap()
                .outline()
                .iter()
                .any(|n| n.volume_id.to_string() == target),
            "卷仍然出现在大纲里"
        );
        // 配置里也不该再留着它，否则下次扫描会把它重新建出来
        let config_text = std::fs::read_to_string(
            state
                .current()
                .unwrap()
                .lock()
                .unwrap()
                .layout()
                .config_path(),
        )
        .unwrap();
        assert!(
            !config_text.contains(&target),
            "已删除的卷仍留在 workspace.json 里：{config_text}"
        );
    }

    #[test]
    fn count_modes_cover_all_three() {
        let modes = get_count_modes();
        assert_eq!(modes.len(), 3);
        assert!(modes.iter().any(|m| m.id == "withPunctuation"));
        assert!(modes.iter().any(|m| m.id == "withoutPunctuation"));
        assert!(modes.iter().any(|m| m.id == "wordsForEnglish"));
        assert!(modes.iter().all(|m| !m.label.is_empty()));
    }

    #[test]
    fn conflict_dto_carries_label_text() {
        // 直接从领域结构构造，验证字段翻译一一对应
        let c = yuhua_fs::conflict::DetectedConflict {
            path: std::path::PathBuf::from("D:/ws/manuscript/第一章 落羽 的冲突副本.md"),
            relative_path: "manuscript/第一章 落羽 的冲突副本.md".into(),
            file_name: "第一章 落羽 的冲突副本.md".into(),
            original_file_name: "第一章 落羽.md".into(),
            pattern: yuhua_fs::conflict::ConflictPattern::ChineseConflictCopy,
        };
        let dto: ConflictDto = c.into();
        assert_eq!(dto.file_name, "第一章 落羽 的冲突副本.md");
        assert_eq!(dto.original_file_name, "第一章 落羽.md");
        assert_eq!(dto.pattern_label, "云盘冲突副本");
    }
}
