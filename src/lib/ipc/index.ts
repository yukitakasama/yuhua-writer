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
  type TrashEntry,
  type UpdateChapterMetaInput,
  type Volume,
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
async function call<T>(command: string, args: Record<string, unknown>, mockFn: (backend: MockBackend) => Promise<T> | T): Promise<T> {
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
export function createWorkspace(root: string, title: string): Promise<OpenWorkspaceResult> {
  return call("create_workspace", { root, title }, (b) => b.createWorkspace(root, title));
}

/** 打开一个已有工作区。 */
export function openWorkspace(root: string): Promise<OpenWorkspaceResult> {
  return call("open_workspace", { root }, (b) => b.openWorkspace(root));
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

/** 新建一卷。 */
export function createVolume(input: CreateVolumeInput): Promise<Volume> {
  return call("create_volume", { title: input.title, sort: input.sort ?? null }, (b) => b.createVolume(input));
}

/** 重命名一卷。 */
export function renameVolume(volumeId: string, title: string): Promise<void> {
  return call("rename_volume", { volumeId, title }, (b) => b.renameVolume(volumeId, title));
}

/** 删除一卷（连同其下章节一起进回收站）。 */
export function deleteVolume(volumeId: string): Promise<void> {
  return call("delete_volume", { volumeId }, (b) => b.deleteVolume(volumeId));
}

/** 移动一卷到新位置。 */
export function moveVolume(volumeId: string, toIndex: number): Promise<void> {
  return call("move_volume", { volumeId, toIndex }, (b) => b.moveVolume(volumeId, toIndex));
}

// ---------------------------------------------------------------------------
// 章
// ---------------------------------------------------------------------------

/** 新建一章。返回新章的摘要：正文必然是空的，不必传输。 */
export function createChapter(input: CreateChapterInput): Promise<ChapterSummary> {
  return call(
    "create_chapter",
    { volumeId: input.volumeId, title: input.title ?? null, sort: input.sort ?? null },
    (b) => b.createChapter(input),
  );
}

/** 取当前书的全部章节摘要（不含正文）。 */
export function listChapters(): Promise<ChapterSummary[]> {
  return call("list_chapters", {}, (b) => b.listChapters());
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
export function saveChapter(chapterId: string, body: string, expectedHash?: string): Promise<ChapterContent> {
  return call(
    "save_chapter",
    { chapterId, body, expectedHash: expectedHash ?? null },
    (b) => b.saveChapter(chapterId, body, expectedHash),
  );
}

/** 更新章节元数据。 */
export function updateChapterMeta(input: UpdateChapterMetaInput): Promise<void> {
  return call("update_chapter_meta", { ...input }, (b) => b.updateChapterMeta(input));
}

/** 重命名一章（元数据快捷方式）。 */
export function renameChapter(chapterId: string, title: string): Promise<void> {
  return call("rename_chapter", { chapterId, title }, (b) => b.renameChapter(chapterId, title));
}

/** 设置章节写作状态。 */
export function setChapterStatus(chapterId: string, status: ChapterStatus): Promise<void> {
  return call("set_chapter_status", { chapterId, status }, (b) => b.setChapterStatus(chapterId, status));
}

/** 删除一章（移入回收站）。 */
export function deleteChapter(chapterId: string): Promise<void> {
  return call("delete_chapter", { chapterId }, (b) => b.deleteChapter(chapterId));
}

/** 移动一章到指定卷的指定位置。 */
export function moveChapter(chapterId: string, toVolumeId: string, toIndex: number): Promise<void> {
  return call("move_chapter", { chapterId, toVolumeId, toIndex }, (b) => b.moveChapter(chapterId, toVolumeId, toIndex));
}

// ---------------------------------------------------------------------------
// 大纲 / 统计
// ---------------------------------------------------------------------------

/** 取大纲（按卷聚合的章节摘要）。 */
export function getOutline(): Promise<OutlineNode[]> {
  return call("get_outline", {}, (b) => b.getOutline());
}

/** 取字数统计。 */
export function getWordStats(chapterId?: string): Promise<WordStats> {
  return call("get_word_stats", { chapterId: chapterId ?? null }, (b) => b.getWordStats(chapterId));
}

/** 取某一章的完整字数统计（三口径）。 */
export function getChapterWordCount(chapterId: string): Promise<WordCount> {
  return call("get_chapter_word_count", { chapterId }, (b) => b.getChapterWordCount(chapterId));
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

/** 全文检索。 */
export async function search(query: SearchQuery): Promise<SearchResults> {
  const raw = await call(
    "search",
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
  return call("restore_from_trash", { trashDirName }, (b) => b.restoreFromTrash(trashDirName));
}

/** 永久删除一条回收站条目。 */
export function purgeFromTrash(trashDirName: string): Promise<void> {
  return call("purge_from_trash", { trashDirName }, (b) => b.purgeFromTrash(trashDirName));
}

/** 清空回收站。 */
export function emptyTrash(): Promise<number> {
  return call("empty_trash", {}, (b) => b.emptyTrash());
}

// ---------------------------------------------------------------------------
// 恢复与索引
// ---------------------------------------------------------------------------

/** 重新读取崩溃恢复报告。 */
export function getRecoveryReport(): Promise<RecoveryReport> {
  return call("get_recovery_report", {}, (b) => b.getRecoveryReport());
}

/** 从 Markdown 重建索引。 */
export function rebuildIndex(): Promise<void> {
  return call("rebuild_index", {}, (b) => b.rebuildIndex());
}

/** 字数口径的中文标签，供 UI 渲染切换控件。 */
export function countModeOptions(): Array<{ value: CountMode; labelKey: "wordCount.withPunctuation" | "wordCount.withoutPunctuation" | "wordCount.wordsForEnglish" }> {
  return [
    { value: "withPunctuation", labelKey: "wordCount.withPunctuation" },
    { value: "withoutPunctuation", labelKey: "wordCount.withoutPunctuation" },
    { value: "wordsForEnglish", labelKey: "wordCount.wordsForEnglish" },
  ];
}
