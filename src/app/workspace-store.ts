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
import { startChapterOpen } from "./perf";
import { __resetTreeUi } from "@/features/chapters/tree-ui-store";

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
 * ## 作者与简介从摘要来
 *
 * `WorkspaceSummary` 带 `author` / `description`（后端存在
 * `.yuhua/workspace.json`），所以打开工作区时署名是**读回来的**，不是伪造的。
 * 空串表示这本书还没填过 —— 界面据此显示空输入框，而不是显示「佚名」这类
 * 占位名字：显示一个假作者名比显示空白更糟。填的入口在导出面板
 * （{@link saveBookMeta}），展示的地方在右侧「本书信息」。
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
      author: workspace.author,
      description: workspace.description,
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
    resetEditingState();
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
    resetEditingState();
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
  resetEditingState();
  setState(initialState());
}

/** 清除错误提示。 */
export function clearError(): void {
  setState("error", null);
}

/** 重置为初始状态（测试用）。 */
export function __resetWorkspaceState(): void {
  resetEditingState();
  // 选中项同样是模块级的：漏清它，下一个用例会带着上一个用例选中的那一章
  // 去挂载，编辑器一挂上就自己去读那一章 —— 读请求发生在用例设置桩**之前**，
  // 于是拿到 undefined 正文、界面上冒出「这一章的正文没能打开」，
  // 而用例本身看起来像是被测出了冲突。串味的用例比失败的用例更难查。
  setSelectedChapterId(null);
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
    pruneKnownHashes();
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
    pruneKnownHashes();
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

/**
 * 保存被判定为「外部修改冲突」的章 ID（没有冲突时为 `null`）。
 *
 * ## 为什么要单独记一个信号
 *
 * 冲突与其它保存失败的**出路不同**：原样重试永远不会成功，只有作者
 * 能决定两个版本怎么合。界面据此给出「以我的稿子为准 / 改用磁盘版本」
 * 两个按钮 —— 而这两个按钮出现在一次普通的磁盘写失败上就是误导。
 *
 * ## 为什么不能靠 `state.error.code` 判断
 *
 * 那个字段是**全局唯一**的一份：作者在冲突之后点了别的操作（新建卷、
 * 重命名），它就被换掉了，而冲突本身还在 —— 这一章依然存不下去。
 * 出路必须挂在「哪一章冲突了」上，而不是「最后一次错误是什么」。
 */
const [conflictedId, setConflictedId] = createSignal<string | null>(null);

export { conflictedId as conflictedChapterId };

/**
 * 每章「最后一次已知内容哈希」的账本，章 ID → 哈希。
 *
 * ## 为什么不能只靠 `editing()` 里的 hash
 *
 * `editing` 只装**当前**这一章。而自动保存是异步的：作者在第三章打了字，
 * 直接点第七章 —— 切章流程会 flush 第三章，等那次保存真正落到
 * `saveChapterBody` 时，`editing()` 已经指向第七章了。此时若从
 * `editing()` 取哈希，就会因为「ID 不匹配」拿到 `undefined`，
 * 而后端把 `undefined` 理解为**调用方声明不做并发控制**、无条件放行
 * （见 `commands.rs` 的 `check_no_external_conflict`）。
 *
 * 结果是：一次本该被拦下的覆盖被静默放行。若此刻云盘正好把第三章
 * 同步成了另一台设备的版本，那次写入就会把它冲掉 —— 与本软件
 * 「零丢失 / 绝不静默覆盖」的核心取向直接冲突。
 *
 * 账本按章 ID 存，切章不会丢，因此保存请求总能带上**它发起时那一章**
 * 的基线哈希。
 */
const knownHashes = new Map<string, string>();

/** 丢掉已不在大纲里的章（删章 / 删卷后调），避免账本随会话无限增长。 */
function pruneKnownHashes(): void {
  const alive = new Set((state.document?.chapters ?? []).map((c) => c.id));
  for (const id of knownHashes.keys()) {
    if (!alive.has(id)) knownHashes.delete(id);
  }
}

/**
 * 清掉与「当前这本工作区」绑定的编辑态。
 *
 * 哈希账本与 `editing` 都是**按工作区**有效的：换一本书之后，
 * 上一本的章 ID 与基线哈希全部作废。留着不只是占内存 ——
 * 新工作区里的一次保存可能拿到一个不属于它的基线哈希，
 * 从而误报「已被外部修改」而拒绝写入。
 *
 * 调用点：打开 / 新建 / 关闭工作区，以及测试重置。
 */
function resetEditingState(): void {
  knownHashes.clear();
  setEditing(null);
  setConflictedId(null);
  // 卷的展开选择同样是**按工作区**有效的：卷 ID 是这本书专属的 ULID，
  // 留着上一本的选择只会让这张表无限增长，并在新书里凭空命中同名旧键。
  __resetTreeUi();
}

/**
 * 读章请求的序号。
 *
 * 快速连点两章时两个请求会同时在途，而后端的返回顺序不保证与发起顺序
 * 一致：先发的可能后到。若照单全收，后到的那份会把**上一章**的正文写进
 * `editing`，界面就对着第 7 章显示第 6 章的内容。只认最新一次请求，
 * 过期的结果直接丢弃。
 */
let readSequence = 0;

/** 读取一章正文并放进编辑器状态。 */
export async function loadChapterBody(chapterId: string): Promise<void> {
  const seq = (readSequence += 1);
  // P4 埋点的起点：读章请求发出之前。终点在 EditorPane 把正文灌进
  // 编辑器视图的那一刻 —— 只有 CodeMirror 拿到文档才算「打开完成」，
  // 在 IPC 返回处收工会把渲染耗时漏掉，而那一半才是用户感到的卡。
  startChapterOpen(chapterId);
  // 重读一次就是重新取一份基线：上一次读到的内容已经被这次覆盖，
  // 那条「外部改过」的冲突也跟着作废（出路之一就是「改用磁盘版本」）
  if (conflictedId() === chapterId) setConflictedId(null);
  setEditing({ id: chapterId, body: "", hash: "", loading: true });
  try {
    const content: ChapterContent = await ipc.readChapter(chapterId);
    if (seq !== readSequence) return;
    knownHashes.set(chapterId, content.contentHash);
    setEditing({
      id: chapterId,
      body: content.body,
      hash: content.contentHash,
      loading: false,
    });
  } catch (err) {
    if (seq !== readSequence) return;
    setEditing(null);
    setState("error", ipc.toFailure(err).error);
  }
}

/** {@link saveChapterBody} 的可选参数。 */
export interface SaveOptions {
  /**
   * 以编辑器里的稿子为准，跳过乐观并发检查直接写。
   *
   * 只应由作者在冲突提示上明确点选，绝不自动设置 ——
   * 后端会先把磁盘上的当前版本无条件存进备份再覆盖，
   * 但那终究是「作者拍板丢掉一个版本」，不能由代码替他拍。
   */
  force?: boolean;
}

/** 保存当前编辑的正文。返回是否写入成功。 */
export async function saveChapterBody(
  chapterId: string,
  body: string,
  options: SaveOptions = {},
): Promise<boolean> {
  // 从账本取，不从 `editing()` 取：切章后 `editing()` 已是新章，
  // 而这次保存属于旧章（理由见 knownHashes 的说明）。
  // 账本里没有（如刚新建、尚未读回）时传 undefined，由后端按既有语义放行。
  const expected = knownHashes.get(chapterId);
  try {
    const content = await ipc.saveChapter(
      chapterId,
      body,
      expected,
      options.force,
    );
    knownHashes.set(chapterId, content.contentHash);
    setConflictedId(null);
    // 只有 `editing` 还指着这一章时才回写。
    //
    // 切章会 flush 上一章，那次保存是异步的：等它落地时作者已经在看
    // 新章了，照写会把 `editing` 换成上一章 —— 于是界面对着一个刚打开、
    // 正文明明就在眼前的章说「没能打开」，编辑器还被置成只读，打不进字。
    if (editing()?.id === chapterId) {
      setEditing({
        id: chapterId,
        body: content.body,
        hash: content.contentHash,
        loading: false,
      });
    }
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
    const error = ipc.toFailure(err).error;
    if (error.code === ipc.ERROR_CODES.conflict) setConflictedId(chapterId);
    setState("error", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 书级元数据
// ---------------------------------------------------------------------------

/**
 * 写回作者与简介。返回是否写入成功。
 *
 * ## 为什么以返回值而不是内存为准
 *
 * 后端 `update_book_meta` 先写 `workspace.json` 再改内存文稿，返回的是
 * **磁盘上真正存下的那一份**（已 trim）。这里用返回值刷新 `document.book`，
 * 于是「界面上显示的作者」与「文件里存着的作者」在任何时刻都是同一个：
 * 写失败时一个都不动，写成功时两个一起动。反过来先改内存就会造出一个窗口 ——
 * 界面已经是新署名，导出交出去的还是旧署名，而作者以为填好了。
 *
 * 顺序纪律与本文件其它写路径一致（见 {@link saveChapterBody}）。
 */
export async function saveBookMeta(
  author: string,
  description: string,
): Promise<boolean> {
  try {
    const summary = await ipc.updateBookMeta(author, description);
    if (state.document !== null) {
      setState("document", "book", {
        ...state.document.book,
        author: summary.author,
        description: summary.description,
      });
    }
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
