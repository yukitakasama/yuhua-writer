/**
 * Markdown 语法高亮（T4.2）。
 *
 * ## 为什么用 `@lezer/markdown` 而不是高亮整个 GFM
 *
 * 高亮必须与**冻结子集**（T4.15）一致。如果高亮支持删除线而导出不支持，
 * 作者就会以为"这个语法能用" —— 正是 R17 描述的失败模式。
 * 因此这里显式列出支持与不支持的扩展，并且**不为不支持的语法加样式**：
 * 它们会以纯文本形式显示，视觉上就与"支持"区分开了。
 *
 * ## 行内装饰怎么加
 *
 * CodeMirror 的语法高亮（`syntaxHighlighting`）只能给 token 加 class，
 * 做不了"改字号""加边框"这类块级效果。因此这里额外用一个
 * `ViewPlugin` 扫可见行，按正则给标题、引用、列表标记挂 class。
 *
 * 为什么愿意付出这个代价：标题需要**真的变大**，否则作者在长文档里
 * 找不到结构。纯 token 着色做不到这一点。
 */

import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

/**
 * 高亮样式表。
 *
 * 只声明 class 名，具体值在 theme.ts 里（那边走 CSS 变量）。
 * 分成两处是为了让"暗色主题适配"只需要改 CSS 变量。
 */
export const yuhuaHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, class: "cm-heading-1" },
  { tag: t.heading2, class: "cm-heading-2" },
  { tag: t.heading3, class: "cm-heading-3" },
  { tag: t.heading4, class: "cm-heading-4" },
  { tag: t.heading5, class: "cm-heading-5" },
  { tag: t.heading6, class: "cm-heading-6" },
  { tag: t.strong, class: "cm-strong" },
  { tag: t.emphasis, class: "cm-emphasis" },
  { tag: t.strikethrough, class: "cm-strikethrough" },
  { tag: t.link, class: "cm-link" },
  { tag: t.url, class: "cm-url" },
  { tag: t.monospace, class: "cm-monospace" },
  { tag: t.quote, class: "cm-blockquote" },
  { tag: t.list, class: "cm-list-marker" },
  { tag: t.contentSeparator, class: "cm-hr" },
]);

/** 块级装饰的 class。 */
const HEADING_DECOS: Record<number, Decoration> = {
  1: Decoration.line({ class: "cm-heading-1" }),
  2: Decoration.line({ class: "cm-heading-2" }),
  3: Decoration.line({ class: "cm-heading-3" }),
  4: Decoration.line({ class: "cm-heading-4" }),
  5: Decoration.line({ class: "cm-heading-5" }),
  6: Decoration.line({ class: "cm-heading-6" }),
};

const QUOTE_LINE = Decoration.line({ class: "cm-blockquote" });
const HR_LINE = Decoration.line({ class: "cm-hr" });

/** 标题行的前缀：最多 6 个 #，后面必须跟空格。 */
const HEADING_RE = /^(#{1,6})\s/;
/** 引用行。 */
const QUOTE_RE = /^\s{0,3}>/;
/** 分隔线：--- / *** / ___，至少三个。 */
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * 给可见行加块级装饰。
 *
 * 只处理 `view.visibleRanges` 之内的行：一篇 10 万字的文档有
 * 上万行，全量扫描会在每次输入时做一遍无用功（T4.11 的性能要求）。
 */
function buildLineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;

      const heading = HEADING_RE.exec(text);
      const deco = heading ? HEADING_DECOS[heading[1]?.length ?? 0] : undefined;
      if (deco) {
        builder.add(line.from, line.from, deco);
      } else if (HR_RE.test(text)) {
        builder.add(line.from, line.from, HR_LINE);
      } else if (QUOTE_RE.test(text)) {
        builder.add(line.from, line.from, QUOTE_LINE);
      }

      if (line.to >= view.state.doc.length) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** 行级装饰插件。 */
const lineDecorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLineDecorations(view);
    }
    update(update: ViewUpdate): void {
      // 只有文档变了或视口动了才重算。光标移动不算 ——
      // 即时渲染（T4.3）会另走一条路径，两者互不干扰
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildLineDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Markdown 语言支持。
 *
 * `codeLanguages: []` 是刻意的：计划书冻结的子集里，代码块只要求
 * 等宽显示，**不要求按语言高亮**。把 shiki / highlight.js 引进来
 * 会给安装包加几百 KB，而这与"写小说"这个场景无关。
 */
export function markdownLanguageSupport(): LanguageSupport {
  return markdown({
    base: markdownLanguage,
    codeLanguages: [],
    addKeymap: false,
  });
}

/** 语法高亮 + 行级装饰的完整扩展。 */
export function markdownHighlighting(): Extension[] {
  return [markdownLanguageSupport(), syntaxHighlighting(yuhuaHighlightStyle), lineDecorationPlugin];
}
