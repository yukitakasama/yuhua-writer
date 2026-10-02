/**
 * 编辑器主题：由设计令牌生成（T4.5）。
 *
 * ## 为什么要"生成"而不是写一份 CodeMirror 主题 CSS
 *
 * 计划书 5.2 节要求「主题切换只改一处变量」。如果编辑器主题写成
 * 单独一份硬编码色值的 CSS，切换暗色主题时它就不会跟着变 ——
 * 这是个非常容易在演示时被抓住的破绽。
 *
 * 因此这里**不取任何具体色值**，只把 CodeMirror 的样式挂到
 * CSS 变量上（`var(--c-accent)` 之类）。变量变了，主题自然跟着变，
 * 一行 JS 都不用跑。
 *
 * ## 为什么不给编辑区做折叠标记的独立样式类
 *
 * 即时渲染（T4.3）折叠标记用的是 CodeMirror 的 `Decoration.replace`，
 * 它把标记**从 DOM 里拿掉**，因此没有可以挂样式的元素。
 * 需要"看起来变淡但还在"的内容（比如链接地址）才用 `mark` 装饰。
 */

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * 编辑器的基础主题。
 *
 * 只声明 CodeMirror 自己的那些类名（`.cm-*`），不碰全局。
 * 正文的字体、字号、行高、最大宽度由外层 `.editor__page` 控制
 * （见 app.css），这样"编辑器换实现"不会影响排版决策。
 */
export const editorTheme: Extension = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--c-text)",
    height: "100%",
  },
  "&.cm-focused": {
    // 焦点环画在容器上会让整块正文区出现一圈描边，很吵。
    // 计划书 5.6 节要的是"焦点可见"，而编辑器的光标本身就是
    // 最明确的焦点指示，因此这里显式去掉外框。
    outline: "none",
  },
  ".cm-content": {
    fontFamily: "var(--font-body)",
    fontSize: "var(--fs-body, 17px)",
    lineHeight: "var(--lh-read)",
    padding: "0",
    caretColor: "var(--c-accent)",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "var(--lh-read)",
    overflow: "auto",
  },
  ".cm-line": {
    padding: "0",
  },
  // 中文排版：段落间距靠 CSS 的 margin 而不是空行，
  // 后者会让作者的真空行与视觉空行混淆
  ".cm-paragraph": {
    marginBottom: "var(--sp-3)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--c-accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "var(--c-accent-subtle)",
    },
  ".cm-activeLine": {
    // 当前行高亮做到几乎看不见：写作时视线在字上，不该有一块色带
    backgroundColor: "transparent",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--c-accent-subtle)",
    outline: "1px solid var(--c-accent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--c-accent)",
    color: "var(--c-surface)",
  },
  ".cm-panels": {
    backgroundColor: "var(--c-surface)",
    color: "var(--c-text)",
    borderColor: "var(--c-border)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--c-surface)",
    border: "1px solid var(--c-border)",
    borderRadius: "var(--r-md)",
    boxShadow: "var(--shadow-md)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--c-accent-subtle)",
    color: "var(--c-text)",
  },
});

/** 语法高亮样式：一律走 CSS 变量。 */
export const highlightTheme: Extension = EditorView.theme({
  ".cm-heading-1": {
    fontFamily: "var(--font-heading)",
    fontSize: "1.6em",
    fontWeight: "700",
  },
  ".cm-heading-2": {
    fontFamily: "var(--font-heading)",
    fontSize: "1.35em",
    fontWeight: "700",
  },
  ".cm-heading-3": {
    fontFamily: "var(--font-heading)",
    fontSize: "1.15em",
    fontWeight: "700",
  },
  ".cm-heading-4, .cm-heading-5, .cm-heading-6": {
    fontFamily: "var(--font-heading)",
    fontWeight: "700",
  },
  ".cm-strong": { fontWeight: "700" },
  ".cm-emphasis": { fontStyle: "italic" },
  ".cm-strikethrough": {
    textDecoration: "line-through",
    color: "var(--c-text-muted)",
  },
  ".cm-link": { color: "var(--c-accent)", textDecoration: "underline" },
  ".cm-url": { color: "var(--c-text-muted)" },
  ".cm-monospace": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
    backgroundColor: "var(--c-bg-subtle)",
    borderRadius: "var(--r-sm)",
    padding: "0 3px",
  },
  ".cm-blockquote": {
    color: "var(--c-text-muted)",
    borderLeft: "3px solid var(--c-border)",
    paddingLeft: "var(--sp-3)",
  },
  ".cm-list-marker": { color: "var(--c-text-muted)" },
  ".cm-hr": { color: "var(--c-border)" },
  ".cm-image-alt": { color: "var(--c-text-muted)", fontStyle: "italic" },
});

/** 主题扩展集合，供 EditorView 一次性装入。 */
export function editorThemeExtensions(): Extension[] {
  return [editorTheme, highlightTheme];
}
