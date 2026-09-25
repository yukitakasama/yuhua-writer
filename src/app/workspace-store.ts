/**
 * 工作区状态。
 *
 * ## 为什么用 Solid 的 createStore 而不是多个 createSignal
 *
 * 卷章树的数据是**嵌套且局部更新**的：重命名一章只影响那一个节点，
 * 排序只改若干节点的 sort。用 store 可以精确地只触发受影响的行重渲染；
 * 用一个大 signal 装整棵树，每次都要重建整个对象，300 章的书会明显卡顿。
 *
 * ## 单例模式
 *
 * 这里导出的是模块级单例而不是 Context。理由：
 *
 * - 第一阶段「一个应用实例只开一个工作区」是硬约束（见 Rust 侧 AppState）
 * - 界面里几乎所有面板都要读它，Context 会让每个组件多一层样板
 * - 测试可以直接调用 reset 拿到干净状态，不需要挂载组件树
 *
 * 将来若要做多窗口 / 多工作区，把这里换成 Context 是局部改动。
 */

import { createStore, produce, type SetStoreFunction } from "solid-js/store";
import { createSignal } from "solid-js";

import * as ipc from "@/lib/ipc";
import type { ChapterContent, ChapterStatus, ChapterSummary, Volume, WorkspaceDocument } from "@/lib/ipc";

/** 工作区加载状态。 */
export type WorkspaceStatus = "idle" | "loading" | "ready" | "error";

/** 工作区状态形状。 */
export interface WorkspaceState {
  /** 当前状态。 */
  status: WorkspaceStatus;
  /** 工作区根路径。 */
  root: string;
  /** 文稿结构。 */
  document: WorkspaceDocument | null;
  /** 最近打开列表。 */
  recents: ipc.WorkspaceSummary[];
  /** 最近一次错误消息（已本地化）。 */
  error: ipc.IpcError | null;
}

/** 初始状态。 */
function initialState(): WorkspaceState {
  return {
    status: "idle",
    root: "",
    document: null,
    recents: [],
    error: null,
  };
}

const [state, setState] = createStore<WorkspaceState>(initialState());

export { state as workspaceState };

/** 直接暴露 setter：卷章树的局部更新需要它，包一层函数只会更啰嗦。 */
export const setWorkspaceState: SetStoreFunction<WorkspaceState> = setState;

/** 是否有已打开的工作区。 */
export function hasOpenWorkspace(): boolean {
  return state.status === "ready" && state.document !== null;
}

/** 当前书。未打开时返回 null。 */
export function currentBook(): WorkspaceDocument["book"] | null {
  return state.document?.book ?? null;
}

/** 全部卷，按 sort 升序。 */
export function volumes(): Volume[] {
  const doc = state.document;
  if (!doc) return [];
  return doc.volumes.slice().sort((a, b) => a.sort - b.sort);
}

/** 某一卷下的章节摘要，按 sort 升序。 */
export function chaptersIn(volumeId: string): ChapterSummary[] {
  const doc = state.document;
  if (!doc) return [];
  return doc.chapters.filter((c) => c.volumeId === volumeId).sort((a, b) => a.sort - b.sort);
}

/** 全书章节总数。 */
export function totalChapters(): number {
  return state.document?.chapters.length ?? 0;
}

/** 全书总字数（用各章缓存的默认口径字数求和）。 */
export function totalWords(): number {
  const doc = state.document;
  if (!doc) return 0;
  let sum = 0;
  for (const c of doc.chapters) sum += c.wordCount;
  return sum;
}

/** 重新载入最近工作区列表。 */
export async function refreshRecents(): Promise<void> {
  try {
    const list = await ipc.listRecentWorkspaces();
    setState("recents", list);
  } catch (err) {
    // 最近列表拿不到不是致命问题（比如首次启动），只记录不打断
    setState("error", ipc.toFailure(err).error);
  }
}

/** 打开一个已有工作区。 */
export async function openWorkspace(root: string): Promise<boolean> {
  setState({ status: "loading", error: null });
  try {
    const result = await ipc.openWorkspace(root);
    setState({ status: "ready", root: result.root, document: result.document, error: null });
    return true;
  } catch (err) {
    setState({ status: "error", error: ipc.toFailure(err).error });
    return false;
  }
}

/** 新建一个工作区。 */
export async function createWorkspace(root: string, title: string): Promise<boolean> {
  setState({ status: "loading", error: null });
  try {
    const result = await ipc.createWorkspace(root, title);
    setState({ status: "ready", root: result.root, document: result.document, error: null });
    await refreshRecents();
    return true;
  } catch (err) {
    setState({ status: "error", error: ipc.toFailure(err).error });
    return false;
  }
}

/** 关闭当前工作区，回到书架。 */
export async function closeWorkspace(): Promise<void> {
  await ipc.closeWorkspace();
  setState(initialState());
}

/** 清除错误提示。 */
export function clearError(): void {
  setState("error", null);
}

/** 重置为初始状态（测试用）。 */
export function __resetWorkspaceState(): void {
  setState(initialState());
}

// ---------------------------------------------------------------------------
// 卷的增删改（乐观更新：先在内存里改，界面立刻响应，再落盘）
// ---------------------------------------------------------------------------

/**
 * 应用一次卷列表的替换。
 *
 * 所有卷操作都收敛到这里，好处是「内存结构与后端一致」这件事
 * 只需要在一个地方保证。失败时调用 {@link reloadDocument} 整体回滚，
 * 而不是逐个撤销 —— 前端不做事务日志，整体重读更简单也更可靠。
 */
function setVolumes(volumes: Volume[]): void {
  setState("document", "volumes", volumes);
}

/** 新建一卷。 */
export async function addVolume(title: string, sort?: number): Promise<boolean> {
  try {
    await ipc.createVolume(sort === undefined ? { title } : { title, sort });
    await reloadDocument();
    return true;
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
    return false;
  }
}

/** 重命名一卷：先本地改（内联编辑要即时反馈），失败再回滚。 */
export async function renameVolumeLocal(volumeId: string, title: string): Promise<boolean> {
  const before = state.document?.volumes ?? [];
  setVolumes(before.map((v) => (v.id === volumeId ? { ...v, title } : v)));
  try {
    await ipc.renameVolume(volumeId, title);
    return true;
  } catch (err) {
    setVolumes(before);
    setState("error", ipc.toFailure(err).error);
    return false;
  }
}

/** 移动一卷到新位置。 */
export async function moveVolumeTo(volumeId: string, toIndex: number): Promise<boolean> {
  try {
    await ipc.moveVolume(volumeId, toIndex);
    await reloadDocument();
    return true;
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
    return false;
  }
}

/** 删除一卷（连同章节进回收站）。 */
export async function removeVolume(volumeId: string): Promise<boolean> {
  try {
    await ipc.deleteVolume(volumeId);
    await reloadDocument();
    return true;
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 章的增删改
// ---------------------------------------------------------------------------

/** 新建一章，返回新章 ID（供界面自动选中并进入内联编辑）。 */
export async function addChapter(volumeId: string, title?: string, sort?: number): Promise<ChapterSummary | null> {
  try {
    const input: ipc.CreateChapterInput = { volumeId };
    if (title !== undefined) input.title = title;
    if (sort !== undefined) input.sort = sort;
    const created = await ipc.createChapter(input);
    await reloadDocument();
    return created;
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
    return null;
  }
}

/** 重命名一章：先本地改，失败回滚。 */
export async function renameChapterLocal(chapterId: string, title: string): Promise<boolean> {
  const before = state.document?.chapters ?? [];
  setState(
    "document",
    "chapters",
    before.map((c) => (c.id === chapterId ? { ...c, title } : c)),
  );
  try {
    await ipc.renameChapter(chapterId, title);
    return true;
  } catch (err) {
    setState("document", "chapters", before);
    setState("error", ipc.toFailure(err).error);
    return false;
  }
}

/** 设置章节状态。 */
export async function setStatus(chapterId: string, status: ChapterStatus): Promise<boolean> {
  try {
    await ipc.setChapterStatus(chapterId, status);
    setState(
      "document",
      "chapters",
      (c) => c.id === chapterId,
      produce((c) => {
        c.status = status;
      }),
    );
    return true;
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
    return false;
  }
}

/** 删除一章（移入回收站）。 */
export async function removeChapter(chapterId: string): Promise<boolean> {
  try {
    await ipc.deleteChapter(chapterId);
    await reloadDocument();
    return true;
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
    return false;
  }
}

/** 移动一章到别的卷 / 别的次序。 */
export async function moveChapterTo(chapterId: string, toVolumeId: string, toIndex: number): Promise<boolean> {
  try {
    await ipc.moveChapter(chapterId, toVolumeId, toIndex);
    await reloadDocument();
    return true;
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
    return false;
  }
}

/**
 * 重读整个文稿。
 *
 * 增删改之后统一走这条路：后端已经保证了排序序号连续、
 * 路径与卷名同步，前端**不自己推断**新结构，避免两套逻辑漂移。
 * 代价是一次多余的读盘，但卷章操作是低频动作，可以接受。
 */
export async function reloadDocument(): Promise<void> {
  if (state.root === "") return;
  try {
    const result = await ipc.openWorkspace(state.root);
    setState("document", result.document);
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
  }
}

// ---------------------------------------------------------------------------
// 当前选中的章节
// ---------------------------------------------------------------------------

const [selectedChapterId, setSelectedChapterId] = createSignal<string | null>(null);
export { selectedChapterId };

/** 选中一章。 */
export function selectChapter(chapterId: string | null): void {
  setSelectedChapterId(chapterId);
}

/** 当前选中的章节摘要（未选中或已被删除时返回 null）。 */
export function selectedChapter(): ChapterSummary | null {
  const id = selectedChapterId();
  if (id === null) return null;
  return state.document?.chapters.find((c) => c.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// 正在编辑的章节正文
// ---------------------------------------------------------------------------

/**
 * 正文**单独存**，不放进 document。
 *
 * 理由与 IPC 契约一致：列表只需要摘要，把正文塞进 store 的章节数组会让
 * 「树的数据」和「编辑器的数据」耦合在一起 —— 关掉编辑器后正文还得留着，
 * 而刷新树时又会把它带上。分开之后各有各的生命周期。
 *
 * `hash` 用于保存时的乐观并发检测（见 ipc.saveChapter）。
 */
export interface EditingChapter {
  /** 章 ID。 */
  id: string;
  /** 正文。 */
  body: string;
  /** 读取时的内容哈希。 */
  hash: string;
  /** 是否正在载入。 */
  loading: boolean;
}

const [editing, setEditing] = createSignal<EditingChapter | null>(null);

export { editing as editingChapter };

/** 读取一章正文并放进编辑器状态。 */
export async function loadChapterBody(chapterId: string): Promise<void> {
  setEditing({ id: chapterId, body: "", hash: "", loading: true });
  try {
    const content: ChapterContent = await ipc.readChapter(chapterId);
    setEditing({ id: chapterId, body: content.body, hash: content.contentHash, loading: false });
  } catch (err) {
    setEditing(null);
    setState("error", ipc.toFailure(err).error);
  }
}

/** 保存当前编辑的正文。 */
export async function saveChapterBody(chapterId: string, body: string): Promise<boolean> {
  const current = editing();
  const expected = current?.id === chapterId ? current.hash : undefined;
  try {
    const content = await ipc.saveChapter(chapterId, body, expected);
    setEditing({ id: chapterId, body: content.body, hash: content.contentHash, loading: false });
    // 字数变了，摘要里的数值要同步刷新
    setState(
      "document",
      "chapters",
      (c) => c.id === chapterId,
      produce((c) => {
        c.wordCount = content.words.withoutPunctuation;
      }),
    );
    return true;
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 快捷入口
// ---------------------------------------------------------------------------

/**
 * 在第一卷新建一章并选中它。
 *
 * 工具栏的「新建章」与编辑器空状态的按钮都调它。
 * 放在 store 而不是组件里：它需要同时改「章节列表」与「当前选中」，
 * 而这两份状态都在 store 里，让组件去编排会漏掉一半。
 */
export async function createFirstChapter(): Promise<void> {
  const first = volumes()[0];
  if (!first) return;
  const created = await addChapter(first.id);
  if (created) selectChapter(created.id);
}
