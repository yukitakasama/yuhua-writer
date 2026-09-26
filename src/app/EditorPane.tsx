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

import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";

import { t } from "@/strings";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyEditor } from "@/app/ui/illustrations";
import { Button } from "@/app/ui/Button";
import { AutosaveScheduler } from "@/features/editor/autosave";
import { captureCursor, recallCursor, rememberCursor, resolveCursor, isCursorResolvable, type CursorStore } from "@/features/editor/cursor-memory";
import { MarkdownEditor, type EditorHandle } from "@/features/editor/MarkdownEditor";
import { focusModeClass } from "@/features/editor/focus";
import { consumeJump, pendingJump } from "@/features/search/search-store";
import { selectedChapter, editingChapter, loadChapterBody, createFirstChapter, saveChapterBody } from "./workspace-store";

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
export function EditorPane(): JSX.Element {
  const [loading, setLoading] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  let handle: EditorHandle | null = null;
  /** 已挂载的编辑器对应的章 ID。用于判断"这次变化是不是换了章"。 */
  let mountedChapterId: string | null = null;

  const chapter = createMemo(() => selectedChapter());

  /**
   * 保存当前草稿。
   *
   * 抽成函数是因为有三个调用点：自动保存、切章前的 flush、卸载前的 flush。
   */
  const persist = async (): Promise<void> => {
    const id = mountedChapterId;
    if (id === null) return;
    const body = draft();
    setDirty(false);
    const ok = await saveChapterBody(id, body);
    if (!ok) setDirty(true);
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
    rememberCursor(cursorStore, mountedChapterId, captureCursor(text, sel.anchor, sel.head, line));
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

  /** 把 loader 读回来的正文灌进编辑器。 */
  createEffect(() => {
    const current = chapter();
    const editing = editingChapter();
    if (!current) {
      mountedChapterId = null;
      return;
    }
    // 正文还没读回来（或在读别的章）时什么都别做
    if (editing === null || editing.id !== current.id || editing.loading) return;

    const next = editing.body;

    if (mountedChapterId === current.id) {
      // 同一章：只可能是保存后回写。此时**不要**覆盖用户正在打的内容
      if (handle !== null && handle.getValue() !== next && !dirty()) {
        handle.setValue(next);
      }
      return;
    }

    mountedChapterId = current.id;
    setDraft(next);
    setDirty(false);
    handle?.setValue(next);
    restorePosition(current.id, next);
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
    if (editing === null || editing.id !== target.chapterId || editing.loading) return;

    // 锚点校正：偏移是「片段内的下标」，需要在正文里重新定位
    const text = handle.getValue();
    const offset = resolveJumpOffset(text, target.offset);
    handle.revealOffset(offset);
    consumeJump(target.token);
  });

  onMount(() => {
    scheduler = new AutosaveScheduler({
      save: () => persist(),
      read: () => draft(),
      // IME 组合期间不保存（T4.4）
      canSave: () => !(handle?.isComposing() ?? false),
    });

    const first = selectedChapter();
    if (first && editingChapter()?.id !== first.id) {
      setLoading(true);
      void loadChapterBody(first.id).finally(() => setLoading(false));
    }
  });

  onCleanup(() => {
    scheduler?.dispose();
    scheduler = null;
    // 卸载前保存：否则关掉应用的最后一段字会丢
    if (dirty()) void persist();
  });

  /**
   * 换章时先把上一章存下来。
   *
   * 用一个独立的 effect 追踪选中的章 ID，与上面的"灌正文"effect 分开 ——
   * 合并写的话，"保存"必须在"载入新章"之前跑完，
   * 而 effect 的执行顺序很难在这种耦合下保持正确。
   */
  let lastChapterId: string | null = null;
  createEffect(() => {
    const current = chapter();
    const id = current?.id ?? null;
    if (lastChapterId !== null && lastChapterId !== id) {
      rememberPosition();
      // flush 是异步的，但我们不 await —— 切章不能被 IO 阻塞。
      // 保存失败时 scheduler 会保持 dirty 并在下次重试
      void scheduler?.flushNow();
      scheduler?.reset();
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
    scheduler?.markDirty();
  };

  /** 视口滚动：顺带更新光标记忆里的行号，供恢复时用。 */
  const handleScrollLine = (line: number): void => {
    if (handle === null || mountedChapterId === null) return;
    const saved = recallCursor(cursorStore, mountedChapterId);
    if (saved === null) return;
    rememberCursor(cursorStore, mountedChapterId, { ...saved, line });
  };

  /** 编辑器就绪。 */
  const handleReady = (editorHandle: EditorHandle): void => {
    handle = editorHandle;
    const current = chapter();
    if (current === null) return;
    const editing = editingChapter();
    if (editing !== null && editing.id === current.id && !editing.loading) {
      mountedChapterId = current.id;
      setDraft(editing.body);
      editorHandle.setValue(editing.body);
      restorePosition(current.id, editing.body);
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

  const body = createMemo(() => {
    const current = chapter();
    const editing = editingChapter();
    if (!current || editing === null || editing.id !== current.id) return "";
    return editing.body;
  });

  return (
    <main class={["editor", focusModeClass()].filter(Boolean).join(" ")} aria-label={t("a11y.mainRegion")}>
      <Show
        when={chapter()}
        fallback={
          <EmptyState
            illustration={<IllustrationEmptyEditor size={148} />}
            title={t("editor.noChapter")}
            body={t("editor.placeholderBody")}
            action={
              <Button variant="outline" onClick={() => void createFirstChapter()}>
                {t("editor.selectHint")}
              </Button>
            }
          />
        }
      >
        {(current) => (
          <article class="editor__page">
            <h1 class="editor__title">{current().title}</h1>
            <Show
              when={!loading()}
              fallback={<p class="editor__loading">{t("app.booting")}</p>}
            >
              <MarkdownEditor
                initialValue={body()}
                onChange={handleChange}
                onUserEdit={handleUserEdit}
                onScrollLine={handleScrollLine}
                onReady={handleReady}
                class="editor__cm"
              />
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
