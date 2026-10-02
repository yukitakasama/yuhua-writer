/**
 * 带命中高亮的片段文本（T6.1）。
 *
 * 刻意做成一个只有二十行的组件：它是「用户正文 → JSX」这条路径上
 * 唯一的出口，因此必须小到能被一眼看完 —— 任何往这里加
 * `innerHTML`、`eval`、"临时渲染成字符串"的改动都是安全问题，
 * 而不是性能优化。
 *
 * 高亮用 `<mark>`：它有语义（读屏会念出「高亮」），也是浏览器
 * 默认的高亮元素，不必自己造一个 span 再解释它是什么。
 */

import { For, Show, type JSX } from "solid-js";

import type { HighlightSnippet } from "@/lib/ipc";
import { splitHighlight, type Segment } from "./highlight";

/** 片段文本属性。 */
export interface SnippetTextProps {
  /** 后端给出的片段（ranges 已是字符区间）。 */
  snippet: HighlightSnippet;
}

/** 渲染一段带高亮的匹配片段。 */
export function SnippetText(props: SnippetTextProps): JSX.Element {
  const segments = (): Segment[] =>
    splitHighlight(props.snippet.text, props.snippet.ranges);

  return (
    <span class="hit__snippet">
      <For each={segments()}>
        {(segment) => (
          <Show when={segment.hit} fallback={<span>{segment.text}</span>}>
            <mark class="hit__mark">{segment.text}</mark>
          </Show>
        )}
      </For>
    </span>
  );
}
