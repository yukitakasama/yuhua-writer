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
use yuhua_fs::conflict::DetectedConflict;
use yuhua_fs::workspace::WorkspaceSummary;
use yuhua_store::search::{SearchQuery, SearchResults};
use yuhua_store::stats::WordStats;

use crate::error::CommandError;
use crate::state::{poisoned, AppState, SessionHandle, WorkspaceSession};

/// 命令层统一的 Result。
type CmdResult<T> = std::result::Result<T, CommandError>;

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
#[tauri::command]
pub fn create_volume(state: State<'_, AppState>, title: String) -> CmdResult<Vec<OutlineNode>> {
    let s = session(&state)?;
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

    // 同步索引
    reload_and_sync(&state)?;
    Ok(state.document()?.outline())
}

/// 重命名一卷。
#[tauri::command]
pub fn rename_volume(
    state: State<'_, AppState>,
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

    reload_and_sync(&state)?;
    Ok(state.document()?.outline())
}

/// 删除一卷（移入回收站）。
#[tauri::command]
pub fn delete_volume(state: State<'_, AppState>, volume_id: String) -> CmdResult<Vec<OutlineNode>> {
    let s = session(&state)?;
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

    // 找到磁盘目录
    let dir_name = yuhua_fs::layout::WorkspaceLayout::volume_dir_name(vol.sort, &vol.title);
    let rel = format!("manuscript/{dir_name}");

    let layout = lock_session(&s)?.layout().clone();
    let trash = yuhua_fs::trash::TrashManager::new(layout.clone());
    // 目录不存在时跳过回收站（例如空卷还没建目录）
    if layout.manuscript_dir().join(&dir_name).exists() {
        trash.move_to_trash(&rel, &vol.title, vid.as_str(), "volume")?;
    }

    state.with_document_mut(|doc| {
        doc.chapters.retain(|c| c.volume_id != vid);
        doc.volumes.retain(|v| v.id != vid);
        doc.renumber_volumes();
        Ok(())
    })?;

    // 索引里也要清掉这些章节
    reload_and_sync(&state)?;
    Ok(state.document()?.outline())
}

/// 新建一章。
#[tauri::command]
pub fn create_chapter(
    state: State<'_, AppState>,
    volume_id: String,
    title: String,
) -> CmdResult<Vec<OutlineNode>> {
    let s = session(&state)?;
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

    let dir_name = yuhua_fs::layout::WorkspaceLayout::volume_dir_name(vol.sort, &vol.title);
    let file_name = yuhua_fs::layout::WorkspaceLayout::chapter_file_name(next_sort, &title);
    let rel = format!("manuscript/{dir_name}/{file_name}");

    // 先写文件（真源），再更新内存与索引
    let now = now_local();
    let chapter =
        yuhua_core::model::Chapter::new(&doc_before.book.id, &vid, &title, &rel, next_sort, now);
    let abs = lock_session(&s)?.layout().resolve(&rel)?;
    let cf = yuhua_fs::chapter_io::ChapterFile {
        meta: chapter.meta.clone(),
        body: String::new(),
        had_front_matter: true,
    };
    yuhua_fs::chapter_io::write_chapter(&abs, &cf).map_err(CommandError::Domain)?;

    reload_and_sync(&state)?;
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
    trash.move_to_trash(&chapter.path, &chapter.meta.title, cid.as_str(), "chapter")?;

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

    reload_and_sync(&state)?;
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
    if let Some(expected) = expected_hash.as_deref() {
        if !expected.is_empty() {
            let current = yuhua_fs::chapter_io::read_chapter(&abs)
                .map(|cf| yuhua_store::index::content_hash(&cf.body))
                .unwrap_or_default();
            if current != expected && !current.is_empty() {
                return Err(CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(
                    "该章节已被外部修改（可能来自云盘同步或其它编辑器），                     为避免覆盖你的改动，本次保存已取消。请重新打开该章查看最新内容。"
                        .into(),
                )));
            }
        }
    }

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
//  内部工具
// ============================================================================

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
