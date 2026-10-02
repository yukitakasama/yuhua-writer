/**
 * 章节写作状态标记。
 *
 * ## 为什么图形 + 文字，而不是只用颜色
 *
 * 计划书 5.6 节明确「动效永不作为唯一反馈」，色彩同理。
 * 状态用**形状**区分（草稿为空心圆、完成为实心点、修订中为双环），
 * 色觉障碍用户同样能分辨。文字标签在悬停时给出。
 */

import type { JSX } from "solid-js";

import type { ChapterStatus } from "@/lib/ipc";
import { t } from "@/strings";

/** 状态标记属性。 */
export interface StatusDotProps {
  /** 状态。 */
  status: ChapterStatus;
  /** 是否显示文字标签。 */
  withLabel?: boolean;
}

/** 取状态的本地化名称。 */
export function statusLabel(status: ChapterStatus): string {
  return t(`status.${status}`);
}

/** 一个小圆点，形状随状态变化。 */
export function StatusDot(props: StatusDotProps): JSX.Element {
  const label = () => statusLabel(props.status);
  return (
    <span
      class={`status-dot status-dot--${props.status}`}
      role="img"
      aria-label={label()}
      title={label()}
    >
      {/* 形状在 CSS 里用伪元素画，避免多一层 DOM */}
      <span class="status-dot__mark" aria-hidden="true" />
      {props.withLabel ? (
        <span class="status-dot__label">{label()}</span>
      ) : null}
    </span>
  );
}
