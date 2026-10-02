/**
 * 空状态区块。
 *
 * ## 为什么用组件而不是每个地方各写一遍
 *
 * 计划书 T5.6 要求「空状态与首次引导」，全应用至少有 5 处空状态
 * （书架、卷章树、卷下无章、未选章节、搜索无结果）。
 * 它们必须长得一样、动效一样（SVG 插画淡入 + 极低频呼吸），
 * 否则界面会显得拼凑。
 *
 * `illustration` 由调用方传入自绘 SVG —— 本组件不持有任何图标资产，
 * 因为 `src/icons/` 由另一个代理负责。
 */

import type { JSX } from "solid-js";

/** 空状态属性。 */
export interface EmptyStateProps {
  /** 自绘 SVG 插画。必填：没有插画的空状态在这套设计语言里不成立。 */
  illustration: JSX.Element;
  /** 标题。 */
  title: string;
  /** 补充说明。 */
  body?: string;
  /** 可选的操作按钮。 */
  action?: JSX.Element;
  /** 紧凑模式：用于卷下无章这类嵌在树里的小空态。 */
  compact?: boolean;
  /** 布局方向。 */
  align?: "center" | "start";
}

/** 一块空状态提示。 */
export function EmptyState(props: EmptyStateProps): JSX.Element {
  const classes = () =>
    [
      "empty",
      props.compact ? "empty--compact" : "",
      props.align === "start" ? "empty--start" : "",
    ]
      .filter(Boolean)
      .join(" ");
  return (
    <div class={classes()} role="status">
      <div class="empty__art" aria-hidden="true">
        {props.illustration}
      </div>
      <p class="empty__title">{props.title}</p>
      {props.body !== undefined ? (
        <p class="empty__body">{props.body}</p>
      ) : null}
      {props.action !== undefined ? (
        <div class="empty__action">{props.action}</div>
      ) : null}
    </div>
  );
}
