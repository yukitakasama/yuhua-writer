/**
 * CodeMirror 6 编辑器内核（T4.1、T4.1–T4.15 的装配点）。
 *
 * ## 扩展集的取舍（T4.1 要求"锁定最小扩展集并验证体积"）
 *
 * 装进来的：
 *
 * | 扩展 | 为什么需要 |
 * | --- | --- |
 * | `history` | 撤销重做（T4.7）。默认 500 步，写作场景够用 |
 * | `drawSelection` | 自绘选区。原生选区在暗色主题下对比度不可控 |
 * | `EditorView.lineWrapping` | 写作必须换行，否则横向滚动等于不能写 |
 * | `markdownHighlighting` | 语法高亮 + 块级装饰（T4.2） |
 * | `instantRender` | 非光标行折叠标记（T4.3） |
 * | `imeCompositionGuard` | 中文 IME 门控（T4.4） |
 * | `search` | 查找替换（T4.6），用官方实现而不是自己写 |
 * | `keymap` + `defaultKeymap` | 基础编辑键 |
 * | `pasteHandler` | 粘贴清洗（T4.13） |
 *
 * **没装**的（以及原因）：
 *
 * - `autocompletion` / `lint` / `foldGutter`：写小说不需要，
 *   装了只会增加体积与视觉噪音。
 * - 代码块语言高亮：见 highlight.ts 的说明。
 * - `@codemirror/theme-one-dark` 之类：主题由设计令牌生成（T4.5）。
 *
 * ## 为什么用 `Compartment` 而不是重建 EditorView
 *
 * 切换字体族（T4.14）、切换只读、切换专注模式，如果靠销毁重建编辑器，
 * 会产生三个可感知的问题：滚动位置丢失、输入法状态丢失、
 * 光标位置丢失。`Compartment` 允许**在不重建视图的前提下**替换
 * 一部分扩展，因此上面三样都保得住。
 */

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { onCleanup, onMount, type JSX } from "solid-js";

import { editorThemeExtensions } from "./theme";
import { markdownHighlighting } from "./highlight";
import { instantRender } from "./instant-render";
import { imeCompositionGuard } from "./ime";
import { pickPastedText } from "./paste";

/** 编辑器暴露给外部的句柄。 */
export interface EditorHandle {
  /** 底层视图。需要精确操作时用。 */
  readonly view: EditorView;
  /** 取当前正文。 */
  getValue(): string;
  /** 全量替换正文（保留滚动与光标尽量不动）。 */
  setValue(next: string): void;
  /** 聚焦。 */
  focus(): void;
  /** 打开查找面板（T4.6）。 */
  openFind(replace: boolean): void;
  /** 撤销 / 重做。 */
  undo(): void;
  redo(): void;
  /** 滚动到指定文档偏移，并短暂高亮（T6.2 的检索跳转用）。 */
  revealOffset(offset: number): void;
  /** 当前是否在 IME 组合中。 */
  isComposing(): boolean;
}

/** 编辑器组件的属性。 */
export interface MarkdownEditorProps {
  /** 初始正文。 */
  initialValue: string;
  /** 正文变化（用户输入）时回调。 */
  onChange?: (value: string) => void;
  /** 文档被"用户编辑"时回调（用于自动保存的 dirty 标记）。 */
  onUserEdit?: () => void;
  /** 滚动位置变化时回调（用于恢复）。 */
  onScrollLine?: (line: number) => void;
  /** 句柄就绪时回调。 */
  onReady?: (handle: EditorHandle) => void;
  /** 是否只读（比如正在载入）。 */
  readOnly?: boolean;
  /** 额外的 class。 */
  class?: string;
}

/** 用来定位跳转高亮效果的 class，样式在 app.css。 */
const REVEAL_CLASS = "cm-reveal-flash";

/**
 * 建编辑器视图。
 *
 * 抽成独立函数而不是写在组件里，是为了能被测试直接调用 ——
 * jsdom 里挂载一个真实的 CodeMirror 视图是可行的，
 * 比测组件树更接近真实行为。
 */
export function createEditorExtensions(options: {
  onUserEdit?: () => void;
  onDocChange?: (value: string) => void;
  onScrollLine?: (line: number) => void;
  readOnlyCompartment: Compartment;
  fontCompartment: Compartment;
  readOnly: boolean;
  fontFamily?: string;
}): Extension[] {
  const { readOnlyCompartment, fontCompartment, readOnly } = options;

  /** 内容变化监听。 */
  const changeListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    options.onDocChange?.(update.state.doc.toString());
    // 区分"用户编辑"与"程序替换"：后者不该触发自动保存（见 autosave.ts）
    const userEdit = update.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"));
    if (userEdit) options.onUserEdit?.();
  });

  /** 滚动监听：把当前视口顶部所在的行号报出去。 */
  const scrollListener = EditorView.domEventHandlers({
    scroll: (_event, view) => {
      const line = view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number;
      options.onScrollLine?.(line);
      return false;
    },
  });

  /**
   * 粘贴处理（T4.13）。
   *
   * 返回 `true` 表示"我处理了"，CodeMirror 就不会再走默认路径。
   * 只在有内容要清洗时才拦截，纯文本粘贴交回默认实现 ——
   * 自己插入会丢掉撤销历史的正确性。
   */
  const pasteHandler = EditorView.domEventHandlers({
    paste: (event, view) => {
      const data = event.clipboardData;
      if (!data) return false;
      const { text, wasHtml } = pickPastedText(data);
      // 纯文本粘贴且无需清洗时放行，让 CodeMirror 自己处理（保留 undo 语义）
      if (!wasHtml && text === data.getData("text/plain")) return false;
      if (text.length === 0) {
        event.preventDefault();
        return true;
      }
      view.dispatch(view.state.replaceSelection(text));
      event.preventDefault();
      return true;
    },
  });

  return [
    history(),
    drawSelection(),
    rectangularSelection(),
    highlightActiveLine(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    search({ top: false }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    markdownHighlighting(),
    instantRender(),
    imeCompositionGuard(),
    ...editorThemeExtensions(),
    changeListener,
    scrollListener,
    pasteHandler,
    // 只读与字体用 Compartment 装：切换时不需要重建视图（T4.14）
    readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
    fontCompartment.of([]),
  ];
}

/** 把字体族应用到编辑器（T4.14：切换字族不丢光标、不跳滚动）。 */
export function fontCompartmentExtension(fontFamily: string | null): Extension {
  if (fontFamily === null) return [];
  return EditorView.theme({
    ".cm-content": { fontFamily },
  });
}

/**
 * 正文编辑器。
 *
 * ## 组件只负责生命周期
 *
 * 所有编辑器逻辑都在上面的纯函数与各个模块里。组件做三件事：
 * 挂载时建视图、卸载时销毁、把外部通过 props 传来的变化同步进去。
 * 这样"编辑器行为"可以在没有 SolidJS 的环境里被测试。
 */
export function MarkdownEditor(props: MarkdownEditorProps): JSX.Element {
  let container: HTMLDivElement | undefined;
  let view: EditorView | null = null;
  const readOnlyCompartment = new Compartment();
  const fontCompartment = new Compartment();

  /** 供外部使用的句柄。 */
  const handle: EditorHandle = {
    get view() {
      if (view === null) throw new Error("编辑器尚未挂载");
      return view;
    },
    getValue: () => view?.state.doc.toString() ?? "",
    setValue: (next: string) => {
      if (view === null) return;
      const current = view.state.doc.toString();
      if (current === next) return;
      // 整体替换不要进撤销历史：作者按 Ctrl+Z 不该回到"上一章的内容"
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        annotations: [],
      });
    },
    focus: () => view?.focus(),
    openFind: (replace: boolean) => {
      if (view === null) return;
      view.focus();
      openSearchPanel(view);
      void replace;
    },
    undo: () => view?.focus(),
    redo: () => view?.focus(),
    revealOffset: (offset: number) => {
      if (view === null) return;
      const clamped = Math.max(0, Math.min(offset, view.state.doc.length));
      view.dispatch({
        selection: { anchor: clamped },
        effects: EditorView.scrollIntoView(clamped, { y: "center" }),
      });
      flashLine(view);
    },
    isComposing: () => (view ? view.composing : false),
  };

  onMount(() => {
    if (!container) return;
    const state = EditorState.create({
      doc: props.initialValue,
      extensions: createEditorExtensions({
        readOnlyCompartment,
        fontCompartment,
        readOnly: props.readOnly ?? false,
        ...(props.onUserEdit ? { onUserEdit: props.onUserEdit } : {}),
        ...(props.onChange ? { onDocChange: props.onChange } : {}),
        ...(props.onScrollLine ? { onScrollLine: props.onScrollLine } : {}),
      }),
    });
    view = new EditorView({ state, parent: container });
    props.onReady?.(handle);
  });

  onCleanup(() => {
    view?.destroy();
    view = null;
  });

  return <div class={["cm-host", props.class ?? ""].filter(Boolean).join(" ")} ref={(el) => (container = el)} />;
}

/**
 * 跳转后短暂闪烁目标行（T6.2）。
 *
 * 用 class 而不是 CodeMirror 装饰：装饰要走事务、要清理，
 * 而这是个**纯视觉、无状态**的效果，加个 class 再摘掉最省事。
 */
function flashLine(view: EditorView): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const domAt = view.domAtPos(line.from);
  const element = domAt.node instanceof HTMLElement ? domAt.node : domAt.node.parentElement;
  if (!element) return;
  element.classList.add(REVEAL_CLASS);
  setTimeout(() => element.classList.remove(REVEAL_CLASS), 1200);
}
