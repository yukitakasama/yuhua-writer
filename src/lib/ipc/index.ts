/**
 * Tauri IPC 绑定层。
 *
 * ## 这一层解决三个问题
 *
 * 1. **类型安全**。组件不直接 `invoke("some_command", {...})` ——
 *    命令名是字符串、参数是裸对象，写错了要跑起来才知道。这里每个命令
 *    都有对应的函数签名，参数与返回值都受 TypeScript 检查。
 * 2. **浏览器降级**。`pnpm dev` 在浏览器里跑时没有 Tauri 运行时，
 *    `invoke` 会直接失败。这里检测 `window.__TAURI_INTERNALS__`，
 *    不存在就切到 {@link ../mock-backend} 的内存数据源，
 *    这样前端开发与 UI 测试完全不需要启动 Tauri 或编译 Rust。
 * 3. **契约收口**。后端命令层一旦落地，只需要改这一个文件
 *    （或换成 tauri-specta 生成产物），所有组件无感。
 *
 * ## 为什么不用 `@tauri-apps/api` 的顶层 import
 *
 * `invoke` 在浏览器里 import 是安全的（它只在调用时才触碰
 * `window.__TAURI_INTERNALS__`），但如果将来换成插件 API 就不一定了。
 * 因此这里保留静态 import 但**只在确认环境后调用**，
 * 兼顾 tree-shaking 与降级能力。
 */

import { invoke } from "@tauri-apps/api/core";

import { createMockBackend, type MockBackend } from "../mock-backend";
import { IpcFailure, normalizeError } from "./errors";
import {
  type ChapterContent,
  type ChapterStatus,
  type ChapterSummary,
  type CountMode,
  type CreateChapterInput,
  type CreateVolumeInput,
  type OpenWorkspaceResult,
  type OutlineNode,
  type RecoveryReport,
  type SearchQuery,
  type SearchResults,
  type StatsDay,
  type StatsPayload,
  type TrashEntry,
  type UpdateChapterMetaInput,
  type WordCount,
  type WordStats,
  type WorkspaceSummary,
  byteRangesToCharRanges,
} from "./types";

export * from "./types";
export { IpcFailure, normalizeError, isIpcError, toFailure } from "./errors";

/**
 * 当前是否运行在 Tauri 里。
 *
 * Tauri 2 注入 `window.__TAURI_INTERNALS__`；v2.0 之前是
 * `window.__TAURI__`，这里两个都认，方便在不同版本下都能正确判定。
 */
export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return w["__TAURI_INTERNALS__"] !== undefined || w["__TAURI__"] !== undefined;
}

/** 当前模式下运行中的后端实现。 */
let mockSingleton: MockBackend | null = null;

/** 惰性创建 mock 后端：只有真的降级时才构造示例数据。 */
function mock(): MockBackend {
  if (mockSingleton === null) mockSingleton = createMockBackend();
  return mockSingleton;
}

/**
 * 重置 mock 后端。
 *
 * 仅供测试使用：每个用例都应该从干净的数据开始，否则用例之间
 * 会因为共享内存数据而互相污染。
 */
export function __resetMockBackend(): void {
  mockSingleton = null;
}

/**
 * 统一调用入口。
 *
 * 所有命令都经过这里，于是「降级判断」与「错误归一化」只写一次。
 * `mockFn` 由调用方传入而不是在内部按命令名分发：
 * 这样每个 mock 实现的类型都与真实命令精确对应，不需要再写一遍映射表。
 */
async function call<T>(
  command: string,
  args: Record<string, unknown>,
  mockFn: (backend: MockBackend) => Promise<T> | T,
): Promise<T> {
  if (!isTauri()) {
    try {
      return await mockFn(mock());
    } catch (err) {
      throw toIpcFailure(err);
    }
  }
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw toIpcFailure(err);
  }
}

/** 把任意异常转成 {@link IpcFailure}，供调用方 catch。 */
function toIpcFailure(err: unknown): IpcFailure {
  return err instanceof IpcFailure ? err : new IpcFailure(normalizeError(err));
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

/** 列出最近打开过的工作区。 */
export function listRecentWorkspaces(): Promise<WorkspaceSummary[]> {
  return call("list_recent_workspaces", {}, (b) => b.listRecentWorkspaces());
}

/** 新建一个工作区并打开。 */
export function createWorkspace(
  root: string,
  title: string,
): Promise<OpenWorkspaceResult> {
  // 参数名必须是 `path`：Rust 签名是
  // `create_workspace(state, path: String, title: String)`。
  // 传 `root` 会让 Tauri 报「缺少 path 参数」—— 而这一点此前
  // 无人发现，因为测试全走 mock 分支（见本文件顶部的降级说明）。
  return call("create_workspace", { path: root, title }, (b) =>
    b.createWorkspace(root, title),
  );
}

/** 打开一个已有工作区。 */
export function openWorkspace(root: string): Promise<OpenWorkspaceResult> {
  // 同 createWorkspace：Rust 的参数名是 `path`（commands.rs 的 open_workspace）
  return call("open_workspace", { path: root }, (b) => b.openWorkspace(root));
}

/** 关闭当前工作区。 */
export function closeWorkspace(): Promise<void> {
  return call("close_workspace", {}, (b) => b.closeWorkspace());
}

/** 当前是否已打开工作区。 */
export function hasWorkspace(): Promise<boolean> {
  return call("has_workspace", {}, (b) => b.hasWorkspace());
}

// ---------------------------------------------------------------------------
// 卷
// ---------------------------------------------------------------------------

/**
 * 新建一卷。
 *
 * ## 返回值为什么是大纲而不是 Volume
 *
 * 后端 `create_volume` 返回的是**整份大纲**（`Vec<OutlineNode>`），
 * 不是新卷本身。这是刻意的：新建卷会改动所有卷的 `sort`，
 * 返回单条会让前端去做"把它插进列表的哪儿"这种推断，
 * 而推断一旦与后端不一致，界面顺序就会与磁盘顺序分叉。
 *
 * 前端在收到大纲后刷新文稿（见 workspace-store 的 `addVolume`）。
 */
export function createVolume(input: CreateVolumeInput): Promise<OutlineNode[]> {
  return call(
    "create_volume",
    { title: input.title },
    (b) => b.createVolume(input) as OutlineNode[] | Promise<OutlineNode[]>,
  );
}

/** 重命名一卷。返回更新后的大纲。 */
export function renameVolume(
  volumeId: string,
  title: string,
): Promise<OutlineNode[]> {
  return call(
    "rename_volume",
    { volumeId, title },
    (b) =>
      b.renameVolume(volumeId, title) as OutlineNode[] | Promise<OutlineNode[]>,
  );
}

/** 删除一卷（连同其下章节一起进回收站）。返回更新后的大纲。 */
export function deleteVolume(volumeId: string): Promise<OutlineNode[]> {
  return call(
    "delete_volume",
    { volumeId },
    (b) => b.deleteVolume(volumeId) as OutlineNode[] | Promise<OutlineNode[]>,
  );
}

/**
 * 调整卷的顺序。
 *
 * ## 为什么是"整份顺序"而不是"把某卷移到第 N 位"
 *
 * 后端提供的是 `reorder_volumes(ordered_ids)`。之所以不像
 * mock 那样做成 `move_volume(volumeId, toIndex)`：
 *
 * - **整份顺序是无歧义的**。`toIndex` 的语义取决于"移除被移动项
 *   之前还是之后"，这是一个真实的、反复出现的一处之差 bug 来源
 * - **拖拽本来就产生整份顺序**。UI 在放下时已经知道最终排列，
 *   再把它折算成一个索引是一次没有收益的信息损失
 *
 * 因此调用方（tree-ops 的 `moveVolume`）负责算出新顺序。
 */
export function reorderVolumes(orderedIds: string[]): Promise<OutlineNode[]> {
  return call(
    "reorder_volumes",
    { orderedIds },
    (b) =>
      b.reorderVolumes(orderedIds) as OutlineNode[] | Promise<OutlineNode[]>,
  );
}

// ---------------------------------------------------------------------------
// 章
// ---------------------------------------------------------------------------

/**
 * 新建一章。
 *
 * 与 `createVolume` 同理，后端返回**整份大纲**而不是新章的摘要 ——
 * 新建一章会改动同卷内所有章的 `sort` 与路径。
 *
 * 调用方需要新章 ID 时，从返回的大纲里按"数量增加了的那一卷"的
 * 末项取（见 workspace-store 的 `addChapter`）。
 */
export function createChapter(
  input: CreateChapterInput,
): Promise<OutlineNode[]> {
  return call(
    "create_chapter",
    { volumeId: input.volumeId, title: input.title ?? "" },
    (b) => b.createChapter(input) as OutlineNode[] | Promise<OutlineNode[]>,
  );
}

/**
 * 取当前书的全部章节摘要（不含正文）。
 *
 * 后端没有独立的 `list_chapters`：**大纲就是章节列表**
 * （`get_outline` 按卷聚合，恰好是前端卷章树需要的形状）。
 * 这里把它拉平，让调用方不必关心聚合方式。
 */
export async function listChapters(): Promise<ChapterSummary[]> {
  const outline = await getOutline();
  return outline.flatMap((node) => node.chapters);
}

/** 读取一章的正文与统计。 */
export function readChapter(chapterId: string): Promise<ChapterContent> {
  return call("read_chapter", { chapterId }, (b) => b.readChapter(chapterId));
}

/**
 * 保存一章的正文。
 *
 * `expectedHash` 是**乐观并发控制**：Rust 侧会比对它和磁盘上的哈希，
 * 不一致说明文件在编辑期间被外部（云盘 / 别的编辑器）改过，
 * 此时拒绝写入并报冲突，而不是静默覆盖用户的稿子 ——
 * 计划书 4.5 节「绝不静默覆盖」就落在这个参数上。
 */
export function saveChapter(
  chapterId: string,
  body: string,
  expectedHash?: string,
): Promise<ChapterContent> {
  return call(
    "save_chapter",
    { chapterId, body, expectedHash: expectedHash ?? null },
    (b) => b.saveChapter(chapterId, body, expectedHash),
  );
}

/** 更新章节元数据。 */
export function updateChapterMeta(
  input: UpdateChapterMetaInput,
): Promise<void> {
  return call("update_chapter_meta", { ...input }, (b) =>
    b.updateChapterMeta(input),
  );
}

/** 重命名一章（元数据快捷方式）。返回更新后的大纲。 */
export function renameChapter(
  chapterId: string,
  title: string,
): Promise<OutlineNode[]> {
  return call("rename_chapter", { chapterId, title }, (b) =>
    b.renameChapter(chapterId, title),
  );
}

/**
 * 设置章节写作状态。
 *
 * 后端没有独立的 `set_chapter_status` —— 状态是**章节元数据的一个
 * 字段**，走统一的 `update_chapter_meta`。这里保留一个语义化的
 * 包装而不是让每个调用点拼 `{ chapterId, status }`：
 * 调用方关心的是"改状态"，不是"哪个命令能改状态"。
 */
export function setChapterStatus(
  chapterId: string,
  status: ChapterStatus,
): Promise<void> {
  return call(
    "update_chapter_meta",
    {
      chapterId,
      title: null,
      status,
      wordGoal: null,
      summary: null,
      notes: null,
    },
    (b) => b.setChapterStatus(chapterId, status),
  );
}

/** 删除一章（移入回收站）。返回更新后的大纲。 */
export function deleteChapter(chapterId: string): Promise<OutlineNode[]> {
  return call(
    "delete_chapter",
    { chapterId },
    (b) => b.deleteChapter(chapterId) as OutlineNode[] | Promise<OutlineNode[]>,
  );
}

/**
 * 调整某一卷内章节的顺序。
 *
 * 与 `reorderVolumes` 同理：拖拽产生的是整份顺序，
 * `toIndex` 是信息损失。跨卷移动由调用方拆成
 * 「源卷 reorder + 目标卷 reorder」两步（见 tree-ops 的 `moveChapter`）。
 */
export function reorderChapters(
  volumeId: string,
  orderedIds: string[],
): Promise<OutlineNode[]> {
  return call(
    "reorder_chapters",
    { volumeId, orderedIds },
    (b) =>
      b.reorderChapters(volumeId, orderedIds) as
        OutlineNode[] | Promise<OutlineNode[]>,
  );
}

// ---------------------------------------------------------------------------
// 大纲 / 统计
// ---------------------------------------------------------------------------

/** 取大纲（按卷聚合的章节摘要）。 */
export function getOutline(): Promise<OutlineNode[]> {
  return call("get_outline", {}, (b) => b.getOutline());
}

/**
 * 取字数统计。
 *
 * ## 为什么要同时给 `volumeId` 与 `chapterId`
 *
 * Rust 的签名是
 * `get_word_stats(state, volume_id: Option<String>, chapter_id: Option<String>)`
 * —— 两个参数**各管一个字段**，`WordStats` 会同时给出
 * `chapter`（该章）、`volume`（该卷）与 `book`（全书）三个数。
 *
 * 因此想同时拿到「这一章」与「它所在卷」的数，就必须两个都传：
 * 只传 `chapterId` 会让 `volume` 恒为 0。这不只是多余的请求问题 ——
 * 它是一个**静默的错数**：界面会显示「本卷 0 字」。
 */
export function getWordStats(
  volumeId?: string,
  chapterId?: string,
): Promise<WordStats> {
  return call(
    "get_word_stats",
    { volumeId: volumeId ?? null, chapterId: chapterId ?? null },
    (b) => b.getWordStats(volumeId, chapterId),
  );
}

/**
 * 取某一章的完整字数统计（三口径）。
 *
 * 后端没有独立的 `get_chapter_word_count`：`read_chapter` 已经把
 * 三口径统计随正文一起返回（见 `ChapterContent.words`）。
 * 这里复用它而不是再加一条命令 —— 多一条命令就多一处要
 * 同步的契约，而正文与统计本来就该一起取（打开一章时两者都要）。
 */
export async function getChapterWordCount(
  chapterId: string,
): Promise<WordCount> {
  const content = await readChapter(chapterId);
  return content.words;
}

/**
 * 取写作统计的完整视图。
 *
 * 返回的是后端已经折算好的结构：按天记录 + 汇总。前端**不重算**，
 * 因为口径（连续天数阈值、平均日更的分母）在 Rust 侧已经用测试钉死，
 * 前端再来一份必然会漂移。
 *
 * Rust 命令层若尚未提供 `get_stats_summary`，mock 后端会抛
 * `UNIMPLEMENTED`；调用方（stats/store.ts）把它当作「功能未接通」
 * 而不是失败，界面显示空状态。
 */
export async function getStatsSummary(): Promise<StatsPayload> {
  return call("get_stats_summary", {}, (b) => b.getStatsSummary());
}

/**
 * 把按天数组折成日期键到记录的映射。
 *
 * 界面里所有查找都是「这一天写了多少」，用对象比每次线性扫描数组快得多，
 * 而 365 天以上的线性扫描在日历翻页时会被反复触发。
 */
export function indexDays(days: readonly StatsDay[]): Record<string, StatsDay> {
  const out: Record<string, StatsDay> = {};
  for (const day of days) out[day.date] = day;
  return out;
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

/** 全文检索。 */
export async function search(query: SearchQuery): Promise<SearchResults> {
  const raw = await call(
    "search_chapters",
    {
      keyword: query.keyword,
      limit: query.limit ?? null,
      offset: query.offset ?? null,
      titleOnly: query.titleOnly ?? false,
      volumeId: query.volumeId ?? null,
    },
    (b) => b.search(query),
  );
  return adaptSearchResults(raw);
}

/**
 * 把检索结果里的字节区间转成字符区间。
 *
 * 在边界处一次性转换，而不是让每个渲染检索结果的组件各自处理 ——
 * 这类「字节还是字符」的坑只应该在层与层的交接处出现一次。
 */
export function adaptSearchResults(results: SearchResults): SearchResults {
  return {
    ...results,
    hits: results.hits.map((hit) => ({
      ...hit,
      snippets: hit.snippets.map((snippet) => ({
        text: snippet.text,
        ranges: byteRangesToCharRanges(snippet.text, snippet.ranges),
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

/** 列出回收站条目。 */
export function listTrash(): Promise<TrashEntry[]> {
  return call("list_trash", {}, (b) => b.listTrash());
}

/** 从回收站恢复一条。 */
export function restoreFromTrash(trashDirName: string): Promise<void> {
  return call("restore_trash", { trashDirName }, (b) =>
    b.restoreFromTrash(trashDirName),
  );
}

/** 永久删除一条回收站条目。 */
export function purgeFromTrash(trashDirName: string): Promise<void> {
  return call("purge_trash", { trashDirName }, (b) =>
    b.purgeFromTrash(trashDirName),
  );
}

/** 清空回收站。 */
export function emptyTrash(): Promise<number> {
  return call("empty_trash", {}, (b) => b.emptyTrash());
}

// ---------------------------------------------------------------------------
// 恢复与索引
// ---------------------------------------------------------------------------

/**
 * 重新读取崩溃恢复报告。
 *
 * 后端没有独立的 `get_recovery_report`：崩溃恢复报告是
 * **打开工作区时**由 `open_workspace` 一并返回的
 * （见 `OpenWorkspaceResult.recovery`）。
 * 这是有意的设计 —— 恢复报告必须在作者看到任何界面之前就绪，
 * 否则"上次崩溃时没保存完"这个提示会迟到。
 *
 * 因此这里重新打开一次工作区取报告。代价是一次目录扫描，
 * 而这个函数只在恢复面板被打开时调用。
 */
export async function getRecoveryReport(): Promise<RecoveryReport> {
  const result = await openWorkspace(currentRoot());
  return result.recovery;
}

/**
 * 当前已打开的工作区根路径。
 *
 * 由 workspace-store 在打开/关闭时写入。放在这里而不是让
 * `ipc` 去依赖 store：依赖方向必须是 store → ipc，
 * 反过来会形成循环（store 本来就要 import ipc）。
 */
let knownRoot = "";

/** 记录当前工作区根路径（由 workspace-store 调用）。 */
export function setCurrentRoot(root: string): void {
  knownRoot = root;
}

/** 取当前工作区根路径。未打开时为空串。 */
export function currentRoot(): string {
  return knownRoot;
}

/** 从 Markdown 重建索引。 */
export function rebuildIndex(): Promise<void> {
  return call("rebuild_index", {}, (b) => b.rebuildIndex());
}

/** 字数口径的中文标签，供 UI 渲染切换控件。 */
export function countModeOptions(): Array<{
  value: CountMode;
  labelKey:
    | "wordCount.withPunctuation"
    | "wordCount.withoutPunctuation"
    | "wordCount.wordsForEnglish";
}> {
  return [
    { value: "withPunctuation", labelKey: "wordCount.withPunctuation" },
    { value: "withoutPunctuation", labelKey: "wordCount.withoutPunctuation" },
    { value: "wordsForEnglish", labelKey: "wordCount.wordsForEnglish" },
  ];
}

// ---------------------------------------------------------------------------
// 导出引擎
// ---------------------------------------------------------------------------

/** 导出范围。 */
export type ExportScope =
  | { type: "single"; chapterId: string }
  | { type: "selected"; chapterIds: string[] }
  | { type: "volume"; volumeId: string }
  | { type: "whole" };

/** 导出格式。 */
export type ExportFormat = "txt" | "markdown" | "html" | "docx" | "pdf" | "epub";

/** 导出格式信息。 */
export interface ExportFormatInfo {
  id: string;
  displayName: string;
  extension: string;
  available: boolean;
}

/** 降级记录。 */
export interface Degradation {
  chapterTitle: string;
  kind: string;
  detail: string;
}

/** 导出结果。 */
export interface ExportResult {
  path: string;
  bytes: number;
  degradations: Degradation[];
}

/**
 * 导出文档。
 *
 * @param format 导出格式
 * @param scope 导出范围
 * @param outputPath 输出文件的绝对路径
 * @returns 导出结果（路径、字节数与降级记录）
 */
export function exportDocument(
  format: ExportFormat,
  scope: ExportScope,
  outputPath: string,
): Promise<ExportResult> {
  return call(
    "export_document",
    { format, scope, outputPath },
    (b) => b.exportDocument(format, scope, outputPath),
  );
}

/**
 * 列出所有可用的导出格式。
 *
 * 返回格式的 ID、显示名、扩展名与可用性。
 */
export function listExportFormats(): Promise<ExportFormatInfo[]> {
  return call("list_export_formats", {}, (b) => b.listExportFormats());
}
