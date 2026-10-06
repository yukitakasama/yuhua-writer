/**
 * 中间编辑区（M4 接入 CodeMirror）。
 *
 * ## 从"只读预览"到真编辑器的变化
 *
 * M5 阶段这里是一个 `<pre>`，只展示从后端读回来的正文。
 * 现在换成真正的编辑器，同时把 M4 的各个能力接上：
 *
 * | 能力 | 接线点 |
 * | --- | --- |
 * | 高亮 / 即时渲染 | `MarkdownEditor` 内部扩展 |
 * | IME 门控 | `autosave` 的 `canSave` |
 * | 自动保存 | `AutosaveScheduler` + 各触发点 |
 * | 光标记忆 | `cursor-memory` + 切章时存取 |
 * | 专注模式 | `focus.ts` |
 *
 * ## 为什么草稿存在本地 signal 而不是 workspace-store
 *
 * 因为草稿是**编辑器私有的、高频变化**的状态。放进全局 store 会让
 * 每次按键都触发 store 的订阅者重算，而它们（卷章树、元数据面板）
 * 大部分不关心草稿内容。编辑器自己持有，保存时才写回 store。
 *
 * ## 切章时为什么必须 flush
 *
 * 作者在第 3 章打了一段字，直接点了第 7 章 —— 如果不先 flush，
 * 第 3 章的这段字会随 signal 被覆盖而永久丢失。
 * 这是整篇文档里最容易丢字的地方，因此做成**切章流程的第一步**。
 */

import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import { t } from "@/strings";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyEditor } from "@/app/ui/illustrations";
import { Button } from "@/app/ui/Button";
import { AutosaveScheduler } from "@/features/editor/autosave";
import {
  captureCursor,
  recallCursor,
  rememberCursor,
  resolveCursor,
  isCursorResolvable,
  type CursorStore,
} from "@/features/editor/cursor-memory";
import {
  MarkdownEditor,
  type EditorHandle,
} from "@/features/editor/MarkdownEditor";
import { focusModeClass } from "@/features/editor/focus";
import { finishChapterOpen } from "./perf";
import { consumeJump, pendingJump } from "@/features/search/search-store";
import {
  selectedChapter,
  editingChapter,
  loadChapterBody,
  createFirstChapter,
  saveChapterBody,
} from "./workspace-store";

export type EditorSaveState = "idle" | "saving" | "dirty" | "failed";

export interface EditorPaneProps {
  onSaveStateChange?: (state: EditorSaveState) => void;
  onSaveReady?: (save: () => Promise<void>) => void;
}

/** 每章的光标记忆表。模块级单例：它与编辑器实例的生命周期无关。 */
const cursorStore: CursorStore = new Map();

/** 当前正在自动保存的调度器（跨章共用；换章时 reset）。 */
let scheduler: AutosaveScheduler | null = null;

/**
 * 把检索面板给出的偏移校正到真实正文里。
 *
 * ## 为什么需要校正
 *
 * 检索结果只带**片段**（命中位置前后各约 24 字的窗口），不带它在正文
 * 里的绝对偏移 —— 后端也不知道正文此刻的形态。因此面板传来的是一个
 * **近似**值（片段内的下标），这里用两种策略把它落到正文上：
 *
 * 1. 偏移本身就落在正文范围内：直接用（绝大多数情况下都对）
 * 2. 超出范围（片段窗口的尾部）：夹到文档末尾，至少停在附近
 *
 * 刻意不做模糊匹配：跳错位置比跳到章首更让人困惑。
 */
export function resolveJumpOffset(text: string, offset: number): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  return Math.min(Math.round(offset), text.length);
}

/** 供测试读取光标表。 */
export function __cursorStore(): CursorStore {
  return cursorStore;
}

/**
 * 中间编辑区。
 */
export function EditorPane(props: EditorPaneProps = {}): JSX.Element {
  const [draft, setDraft] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  const [saveState, setSaveState] = createSignal<EditorSaveState>("idle");
  let handle: EditorHandle | null = null;
  /** 已挂载的编辑器对应的章 ID。用于判断"这次变化是不是换了章"。 */
  let mountedChapterId: string | null = null;

  const chapter = createMemo(() => selectedChapter());

  /**
   * 保存指定章节的正文。
   *
   * 章 ID 与正文都由调用方**显式传入**，不在函数内部读实时状态 ——
   * 保存是异步的，等它落地时用户很可能已经切到别的章，那时再读
   * `mountedChapterId` / `draft()` 就会把新章的正文写进旧章的文件。
   *
   * 抽成函数是因为有三个调用点：自动保存、手动保存、卸载前的 flush。
   * 切章那条路**不走这里**，理由见下面切章 effect 的说明。
   */
  const persist = async (id: string | null, body: string): Promise<void> => {
    if (id === null) return;
    setDirty(false);
    setSaveState("saving");
    const ok = await saveChapterBody(id, body);
    if (!ok) {
      setDirty(true);
      setSaveState("failed");
      throw new Error("Unable to save chapter");
    }
    setSaveState(dirty() ? "dirty" : "idle");
  };

  const saveNow = async (): Promise<void> => {
    rememberPosition();
    if (scheduler !== null) {
      await scheduler.flushNow();
      return;
    }
    if (dirty()) await persist(mountedChapterId, draft());
  };

  /**
   * 记住当前光标位置。
   *
   * 切章、卸载、失焦时都要做 —— 少一处，作者切回来就找不到自己写哪了。
   */
  const rememberPosition = (): void => {
    if (handle === null || mountedChapterId === null) return;
    const text = handle.getValue();
    const view = handle.view;
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head).number;
    rememberCursor(
      cursorStore,
      mountedChapterId,
      captureCursor(text, sel.anchor, sel.head, line),
    );
  };

  /**
   * 把光标恢复到该章上次的位置。
   *
   * 用 `queueMicrotask` 而不是立刻做：编辑器刚 `setValue` 完，
   * DOM 测量（`scrollIntoView` 需要行高）还没完成，
   * 同步滚动会算在旧布局上。
   */
  const restorePosition = (chapterId: string, text: string): void => {
    if (handle === null) return;
    const saved = recallCursor(cursorStore, chapterId);
    if (saved === null) return;
    if (!isCursorResolvable(text, saved)) return;
    const offset = resolveCursor(text, saved);
    queueMicrotask(() => {
      if (handle === null) return;
      try {
        handle.revealOffset(offset);
      } catch {
        // 编辑器可能已被卸载（快速连续切章），忽略即可
      }
    });
  };

  /**
   * 发起一次读章。effect 与「重新读取」按钮共用这一个入口。
   *
   * 这里**不再自己记 loading**：`loadChapterBody` 一进来就把
   * `editing` 置成 `{ id, loading: true }`，那就是唯一可靠的读取状态 ——
   * 面板自己再记一份会出现两个答案不一致的窗口（比如失败后）。
   */
  let attemptedChapterId: string | null = null;
  const requestChapterLoad = (chapterId: string): void => {
    attemptedChapterId = chapterId;
    void loadChapterBody(chapterId);
  };

  /**
   * 选中哪一章，就读哪一章的正文。
   *
   * ## 为什么必须是 effect 而不是 onMount
   *
   * 读章曾经只在 `onMount` 里发起一次。而 EditorPane 本身不随换章重建
   * （只有里面那个 `<Show when={chapter()}>` 会挂载编辑器），于是
   * 「工作区已经开着、再点某一章」这条**最主要的路径**根本不会发起读章：
   * 编辑器继续显示上一章的文档，作者以为自己在写第 7 章，
   * 敲下去的字却进了第 6 章的草稿。
   *
   * effect 在首帧之后运行，因此既保住了原来那句注释想要的
   * 「不阻塞首次渲染」，又能跟着选中状态走。
   *
   * ## 为什么用 `editing()` 的 ID 做幂等判断
   *
   * `loadChapterBody` 一进来就把 `editing` 置成 `{ id, loading: true }`，
   * 所以同一个章不会因 effect 重跑而被读两次；换章时 ID 不同，正好发起新的读。
   *
   * ## 为什么还要另外记 `attemptedChapterId`
   *
   * 读**失败**时 store 会把 `editing` 清成 `null`。只认 `editing` 的话，
   * effect 立刻又会觉得「这章还没读」，于是再发一次请求 —— 失败得越快
   * （文件被锁、路径不存在都是瞬时失败）重试就越密，等于对着磁盘打一个
   * 无退避的死循环，界面上还永远停在「正在打开」。失败的那一章要由
   * 作者按下「重新读取」再来，不是由我们自动轰炸。
   */
  createEffect(() => {
    const current = chapter();
    if (current === null) {
      attemptedChapterId = null;
      return;
    }
    if (editingChapter()?.id === current.id) return;
    if (attemptedChapterId === current.id) return;
    requestChapterLoad(current.id);
  });

  /**
   * 灌入新章正文。
   *
   * 用 `resetDocument` 而不是 `setValue`：换章要**连撤销历史一起换掉**。
   * 留着上一章的历史，作者切过来后按一次 Ctrl+Z 就把上一章的正文灌进
   * 这一章，紧接着自动保存会把它写进这一章的文件 —— 两章都坏。
   */
  const mountChapter = (chapterId: string, text: string): void => {
    mountedChapterId = chapterId;
    setDraft(text);
    setDirty(false);
    handle?.resetDocument(text);
    restorePosition(chapterId, text);
    // P4 的终点：正文已经在编辑器视图里了（见 workspace-store 的起点注释）
    finishChapterOpen(chapterId);
  };

  /**
   * 把 loader 读回来的正文灌进编辑器。
   *
   * ## 为什么读失败时必须清掉 `mountedChapterId`
   *
   * 失败后 `editing` 是 `null`，界面上标题已经换成新章、编辑器里却是
   * 上一章的文档。留着旧 ID，自动保存就会把「在新章标题下打的字」
   * 写进**上一章的文件**（`persist` 用的就是它）—— 一次读失败换来一次丢稿。
   * 清成 `null` 之后 `persist` 直接返回，写不到任何文件上；
   * 同时编辑器处于只读（见下面 `readOnly` 的判据），根本打不进字。
   */
  createEffect(() => {
    const current = chapter();
    const editing = editingChapter();
    if (!current) {
      mountedChapterId = null;
      return;
    }
    if (editing === null) {
      mountedChapterId = null;
      return;
    }
    // 还在读（或在读别的章）时什么都别做
    if (editing.id !== current.id || editing.loading) return;

    const next = editing.body;

    if (mountedChapterId === current.id) {
      // 同一章：只可能是保存后回写。此时**不要**覆盖用户正在打的内容
      if (handle !== null && handle.getValue() !== next && !dirty()) {
        handle.setValue(next);
      }
      return;
    }

    mountChapter(current.id, next);
  });

  /**
   * 消费检索跳转（T6.2）。
   *
   * ## 为什么要在这里而不是在检索面板里做
   *
   * 「滚到并闪烁高亮某一行」需要编辑器的视图对象，而它是编辑器私有的。
   * 面板只发布一个「第几章、第几个字符」的意图，由真正能看到正文的
   * 这一方执行 —— 这也让跳转在"正文还没载入完"时天然地等到下一轮。
   *
   * ## 为什么换章时不立刻跳
   *
   * 目标章与当前编辑的章不同时，正文要先读回来（异步）。
   * 这里直接返回、**不消费**目标，等那个 effect 再次跑过来 ——
   * 消费掉就等于把这次跳转丢了。
   */
  createEffect(() => {
    const target = pendingJump();
    if (target === null || handle === null) return;
    const current = chapter();
    if (current === null || current.id !== target.chapterId) return;
    const editing = editingChapter();
    if (editing === null || editing.id !== target.chapterId || editing.loading)
      return;

    // 锚点校正：偏移是「片段内的下标」，需要在正文里重新定位
    const text = handle.getValue();
    const offset = resolveJumpOffset(text, target.offset);
    handle.revealOffset(offset);
    consumeJump(target.token);
  });

  onMount(() => {
    scheduler = new AutosaveScheduler({
      // 正文由调度器在**发起那一刻**读出并传入（见 autosave.ts 的
      // performSave 说明）；章 ID 同样必须在那一刻固定下来。
      save: (body) => persist(mountedChapterId, body),
      read: () => draft(),
      // IME 组合期间不保存（T4.4）
      canSave: () => !(handle?.isComposing() ?? false),
    });
    props.onSaveReady?.(saveNow);
  });

  onCleanup(() => {
    scheduler?.dispose();
    scheduler = null;
    // 卸载前保存：否则关掉应用的最后一段字会丢
    if (dirty()) void persist(mountedChapterId, draft()).catch(() => undefined);
  });

  /**
   * 换章时先把上一章存下来。
   *
   * 用一个独立的 effect 追踪选中的章 ID，与上面的"灌正文"effect 分开 ——
   * 合并写的话，"保存"必须在"载入新章"之前跑完，
   * 而 effect 的执行顺序很难在这种耦合下保持正确。
   *
   * ## 为什么这里绕开 scheduler 直接保存
   *
   * 三件事必须在**同一个同步块**里定下来，否则就会丢字：
   *
   * 1. 旧章的 ID 与正文要当场捕获成快照。等异步保存真跑起来时，
   *    `draft()` 与 `mountedChapterId` 都已经是新章的了。
   * 2. `scheduler.reset()` 要在发起保存**之前**调。反过来的话，
   *    调度器还留着 dirty 状态，稍后可能拿新章的正文再存一次旧章。
   * 3. 不能像从前那样 `void flushNow()` 之后紧跟 `reset()` ——
   *    flushNow 在有在途保存时会先 await，而 reset 是同步的，
   *    它会把 flush 还没读到的 dirty 清掉，那次改动就再也没人存了。
   *
   * ## 为什么不走 `persist`
   *
   * `persist` 会写 `dirty` 与 `saveState`，而这两个信号此刻已经属于
   * **新章**。旧章保存失败时若照写，界面就会对着一个干净的章说
   * 「有未保存的改动」。失败改由 store 的错误横幅报出
   * （`saveChapterBody` 内部已 `setState("error", …)`）。
   *
   * 保存本身不 await：切章不该被 IO 阻塞。磁盘上的旧章内容因为
   * 原子写并未损坏，用户按提示重开该章即可。
   */
  let lastChapterId: string | null = null;
  createEffect(() => {
    const current = chapter();
    const id = current?.id ?? null;
    if (lastChapterId !== null && lastChapterId !== id) {
      const previousId = lastChapterId;
      const previousBody = draft();
      const hadUnsaved = scheduler?.isDirty() ?? false;
      rememberPosition();
      scheduler?.reset();
      if (hadUnsaved) void saveChapterBody(previousId, previousBody);
    }
    lastChapterId = id;
  });

  /** 编辑器内容变化（用户输入）。 */
  const handleChange = (value: string): void => {
    setDraft(value);
  };

  /** 用户编辑（用于标记 dirty 并排自动保存）。 */
  const handleUserEdit = (): void => {
    setDirty(true);
    setSaveState("dirty");
    scheduler?.markDirty();
  };

  /** 视口滚动：顺带更新光标记忆里的行号，供恢复时用。 */
  const handleScrollLine = (line: number): void => {
    if (handle === null || mountedChapterId === null) return;
    const saved = recallCursor(cursorStore, mountedChapterId);
    if (saved === null) return;
    rememberCursor(cursorStore, mountedChapterId, { ...saved, line });
  };

  /**
   * 编辑器就绪。
   *
   * 只有一种情况需要在这里补灌：编辑器挂载时正文**已经**读回来了
   * （离开写作台再回来，store 里的 `editing` 还是这一章）。
   * 走 `mountChapter` 而不是自己写一遍，是为了让 P4 的终点、
   * dirty 清零与撤销历史归零这三件事只有一条实现路径。
   */
  const handleReady = (editorHandle: EditorHandle): void => {
    handle = editorHandle;
    const current = chapter();
    if (current === null) return;
    const editing = editingChapter();
    if (editing !== null && editing.id === current.id && !editing.loading) {
      mountChapter(current.id, editing.body);
    }
  };

  /** 失焦与关窗都要落盘（T4.8）。 */
  const handleBlur = (): void => {
    rememberPosition();
    void scheduler?.flushNow();
  };

  onMount(() => {
    const onBeforeUnload = (): void => {
      rememberPosition();
      void scheduler?.flushNow();
    };
    window.addEventListener("blur", handleBlur);
    window.addEventListener("beforeunload", onBeforeUnload);
    onCleanup(() => {
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("beforeunload", onBeforeUnload);
    });
  });

  createEffect(() => {
    props.onSaveStateChange?.(saveState());
  });

  const body = createMemo(() => {
    const current = chapter();
    const editing = editingChapter();
    if (!current || editing === null || editing.id !== current.id) return "";
    return editing.body;
  });

  /**
   * 编辑器里现在是**这一章**的正文了吗。
   *
   * 否有两种情形：还在读（转状态提示），以及读失败 / 读的是别的章
   * （给「重新读取」）。两种情形编辑器都只读 —— 见下面 `readOnly` 的理由。
   */
  const ready = createMemo(() => {
    const current = chapter();
    if (current === null) return false;
    const editing = editingChapter();
    return editing !== null && editing.id === current.id && !editing.loading;
  });

  return (
    <main
      class={["editor", focusModeClass()].filter(Boolean).join(" ")}
      aria-label={t("a11y.mainRegion")}
    >
      <Show
        when={chapter()}
        fallback={
          <EmptyState
            illustration={<IllustrationEmptyEditor size={148} />}
            title={t("editor.noChapter")}
            body={t("editor.placeholderBody")}
            action={
              <Button
                variant="outline"
                onClick={() => void createFirstChapter()}
              >
                {t("editor.selectHint")}
              </Button>
            }
          />
        }
      >
        {(current) => (
          <article class="editor__page">
            <h1 class="editor__title">{current().title}</h1>
            {/*
              编辑器**一直挂着**，读章期间置为只读。
              用「卸载再重挂」表达「正在读」会在切章流程的中间销毁视图，
              而上一次切章的光标记忆与保存都还要读它；每个章都重建一次
              CodeMirror，代价直接落在 P4 的耗时上。
              只读还挡掉另一件事：正文没到位时打字，字会落进
              一个既不属于这章、也没地方保存的文档里。
            */}
            <MarkdownEditor
              initialValue={body()}
              readOnly={!ready()}
              onChange={handleChange}
              onUserEdit={handleUserEdit}
              onScrollLine={handleScrollLine}
              onReady={handleReady}
              class="editor__cm"
            />
            <Show when={!ready()}>
              <Show
                when={editingChapter()?.loading ?? false}
                fallback={
                  <div class="editor__failed">
                    <p role="alert">{t("editor.readFailed")}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => requestChapterLoad(current().id)}
                    >
                      {t("editor.retry")}
                    </Button>
                  </div>
                }
              >
                <p class="editor__loading" role="status">
                  {t("editor.loading")}
                </p>
              </Show>
            </Show>
            <Show when={dirty()}>
              <p class="editor__hint" role="status">
                {t("saveState.dirty")}
              </p>
            </Show>
          </article>
        )}
      </Show>
    </main>
  );
}
