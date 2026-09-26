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
import type {
  ChapterContent,
  ChapterStatus,
  ChapterSummary,
  OpenWorkspaceResult,
  Volume,
  WorkspaceDocument,
} from "@/lib/ipc";
import {
  chapterOrderOf,
  moveChapter as moveChapterInTree,
  moveVolume as moveVolumeInTree,
  volumeOrderOf,
} from "@/features/chapters/tree-ops";

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
  return doc.chapters
    .filter((c) => c.volumeId === volumeId)
    .sort((a, b) => a.sort - b.sort);
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

/**
 * 把 `open_workspace` 的返回折成前端内部使用的文稿形状。
 *
 * ## 为什么需要这一次折算
 *
 * Rust 的 `OpenResult` 给的是「工作区摘要 + 大纲 + 全书字数 + 恢复报告」，
 * 而界面需要的是「书 + 卷 + 章摘要」。两边的形状本就不同 ——
 * 折算是契约的一部分，不是临时补丁。
 *
 * 卷列表从大纲里取：`OutlineNode` 已经带了 `volumeId/title/sort`，
 * 不额外发 `get_volumes` 之类的命令（那种命令不存在，也不该为它存在）。
 *
 * ## ⚠️ 已知缺口：`book` 的元数据在 open 路径上不可得
 *
 * `WorkspaceSummary` 只有 `title`，没有作者 / 简介 / 书级更新时间。
 * 这里用一个**最小占位**：`id` 取 `workspaceId`、`title` 取书名，其余空串。
 * **绝不伪造**作者或简介 —— 界面上显示一个假作者名比显示空白更糟。
 *
 * 要真正填上这条缺口，需要后端新增一条返回书级元数据的命令
 * （或在 `OpenResult` 上加字段）。本次修复刻意不扩契约。
 *
 * ## 为什么抽成纯函数
 *
 * 原来这三处直接用 `result.document`，而 `OpenResult` 里没有这个字段 ——
 * 真实 Tauri 路径下 `document` 恒为 `undefined`，一渲染卷章树就抛错。
 * 抽成纯函数后，这个折算过程可以直接用「Rust 的形状」单测，
 * 不必把整个 store 和 Tauri 运行时都拉起来。
 */
export function documentFromOpenResult(
  result: OpenWorkspaceResult,
): WorkspaceDocument {
  const { workspace, outline, recovery } = result;

  // 卷从大纲来。`OutlineNode` 的字段是卷的投影，缺 `bookId` 与 `created`
  // —— 前者这里能补（就是同一本书），后者后端在这一路径上没有提供，
  // 用空串而不是伪造一个时间（见上面的「已知缺口」）。
  const volumes: Volume[] = outline.map((node) => ({
    id: node.volumeId,
    bookId: workspace.workspaceId,
    title: node.title,
    sort: node.sort,
    created: "",
  }));

  return {
    book: {
      id: workspace.workspaceId,
      title: workspace.title,
      author: "",
      description: "",
      created: workspace.created,
      updated: workspace.lastOpened ?? workspace.created,
    },
    volumes,
    chapters: outline.flatMap((node) => node.chapters),
    recovery,
  };
}

/** 打开一个已有工作区。 */
export async function openWorkspace(root: string): Promise<boolean> {
  setState({ status: "loading", error: null });
  try {
    const result = await ipc.openWorkspace(root);
    // 根路径以 `workspace.root` 为准：它来自磁盘上的配置，
    // 而传入的 `root` 是用户手输或对话框给的，两者可能只是写法不同
    // （结尾斜杠、大小写、`..`）。以磁盘那份为准能避免"同一个工作区
    // 被当成两个"这种隐蔽的状态分叉。
    setState({
      status: "ready",
      root: result.workspace.root,
      document: documentFromOpenResult(result),
      error: null,
    });
    return true;
  } catch (err) {
    setState({ status: "error", error: ipc.toFailure(err).error });
    return false;
  }
}

/** 新建一个工作区。 */
export async function createWorkspace(
  root: string,
  title: string,
): Promise<boolean> {
  setState({ status: "loading", error: null });
  try {
    const result = await ipc.createWorkspace(root, title);
    setState({
      status: "ready",
      root: result.workspace.root,
      document: documentFromOpenResult(result),
      error: null,
    });
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
export async function addVolume(
  title: string,
  sort?: number,
): Promise<boolean> {
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
export async function renameVolumeLocal(
  volumeId: string,
  title: string,
): Promise<boolean> {
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

/**
 * 移动一卷到新位置。
 *
 * ## 为什么先本地算出新顺序再发给后端
 *
 * 后端的 `reorder_volumes` 接受的是**完整顺序**，不是"移到第 N 位"
 * （理由见 ipc/index.ts：`toIndex` 的语义取决于移除时机，
 * 是反复出现的一处之差 bug 来源）。
 *
 * 本地用 `moveVolume` 这个**纯函数**算出新顺序，
 * 与拖拽时用于渲染的那份计算是同一个 —— 界面看到的顺序
 * 与发出去的顺序因此必然一致。若让调用方各自实现一遍排序，
 * 两者迟早会分叉。
 */
export async function moveVolumeTo(
  volumeId: string,
  toIndex: number,
): Promise<boolean> {
  const doc = state.document;
  if (doc === null) return false;
  const snapshot = { volumes: doc.volumes, chapters: doc.chapters };
  const result = moveVolumeInTree(snapshot, volumeId, toIndex);
  if (!result.changed) return true;
  try {
    await ipc.reorderVolumes(volumeOrderOf(result.snapshot));
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

/**
 * 新建一章，返回新章的摘要（供界面自动选中并进入内联编辑）。
 *
 * ## 为什么要在返回的大纲里"找"新章
 *
 * 后端返回的是整份大纲（见 ipc/index.ts 的说明），不是新章本身。
 * 找出新章的办法是**取该卷的最后一个**：新建默认追加到卷末，
 * 因此末项就是刚建的那一章。
 *
 * 这里没有用"比较前后 ID 集合"那种更"严格"的做法 ——
 * 它需要一次额外的 `getOutline`（多一次全量扫描），
 * 而对一个低频操作换来的是更复杂的代码。追加到末尾是
 * 后端 `create_chapter` 的既定行为（有测试钉住），依靠它比
 * 每次多扫一遍更划算。
 */
export async function addChapter(
  volumeId: string,
  title?: string,
  sort?: number,
): Promise<ChapterSummary | null> {
  try {
    const input: ipc.CreateChapterInput = { volumeId };
    if (title !== undefined) input.title = title;
    if (sort !== undefined) input.sort = sort;
    const outline = await ipc.createChapter(input);
    await reloadDocument();
    const node = outline.find((n) => n.volumeId === volumeId);
    const created = node?.chapters[node.chapters.length - 1] ?? null;
    // 从大纲里拿不到时退回读一次列表：宁可多一次读，
    // 也不要让"新建章之后没有自动选中"这种交互断裂
    if (created === null) {
      return (
        state.document?.chapters.find((c) => c.volumeId === volumeId) ?? null
      );
    }
    return created;
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
    return null;
  }
}

/** 重命名一章：先本地改，失败回滚。 */
export async function renameChapterLocal(
  chapterId: string,
  title: string,
): Promise<boolean> {
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
export async function setStatus(
  chapterId: string,
  status: ChapterStatus,
): Promise<boolean> {
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

/**
 * 移动一章到别的卷 / 别的次序。
 *
 * ## 为什么跨卷移动要发两次请求
 *
 * 后端的重排命令是**按卷**的（`reorder_chapters(volumeId, ids)`），
 * 而跨卷移动同时改动了两个卷：源卷少一项、目标卷多一项。
 * 因此拆成两步。
 *
 * ## 为什么先发源卷、再发目标卷
 *
 * 顺序不能反。若先往目标卷插入，中途失败（网络、磁盘满）时
 * 就会存在**两份该章**：目标卷里有了，源卷里也还在。
 * 反过来先删源卷，失败时是"这一章暂时不在任何卷里" ——
 * 它仍然在结构里（`document.chapters` 按 volumeId 分组渲染），
 * 重试一次即可恢复，而重复的两份需要作者手工分辨。
 *
 * 这是个真实取舍：两种失败都不好，但"少一份"比"多一份"好处理。
 */
export async function moveChapterTo(
  chapterId: string,
  toVolumeId: string,
  toIndex: number,
): Promise<boolean> {
  const doc = state.document;
  if (doc === null) return false;
  const snapshot = { volumes: doc.volumes, chapters: doc.chapters };
  const result = moveChapterInTree(snapshot, chapterId, {
    volumeId: toVolumeId,
    index: toIndex,
  });
  if (!result.changed) return true;

  const moving = doc.chapters.find((c) => c.id === chapterId);
  if (moving === undefined) return false;

  try {
    // 源卷先重排（见上面的顺序说明）
    await ipc.reorderChapters(
      moving.volumeId,
      chapterOrderOf(result.snapshot, moving.volumeId),
    );
    if (moving.volumeId !== toVolumeId) {
      await ipc.reorderChapters(
        toVolumeId,
        chapterOrderOf(result.snapshot, toVolumeId),
      );
    }
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
    setState("document", documentFromOpenResult(result));
  } catch (err) {
    setState("error", ipc.toFailure(err).error);
  }
}

// ---------------------------------------------------------------------------
// 当前选中的章节
// ---------------------------------------------------------------------------

const [selectedChapterId, setSelectedChapterId] = createSignal<string | null>(
  null,
);
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
    setEditing({
      id: chapterId,
      body: content.body,
      hash: content.contentHash,
      loading: false,
    });
  } catch (err) {
    setEditing(null);
    setState("error", ipc.toFailure(err).error);
  }
}

/** 保存当前编辑的正文。 */
export async function saveChapterBody(
  chapterId: string,
  body: string,
): Promise<boolean> {
  const current = editing();
  const expected = current?.id === chapterId ? current.hash : undefined;
  try {
    const content = await ipc.saveChapter(chapterId, body, expected);
    setEditing({
      id: chapterId,
      body: content.body,
      hash: content.contentHash,
      loading: false,
    });
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
