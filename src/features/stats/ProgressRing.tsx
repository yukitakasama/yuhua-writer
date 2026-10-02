/**
 * 进度环（T5.5 / T8.11）。
 *
 * ## 为什么用 SVG 的 dasharray 而不是两条弧
 *
 * 用 `<circle>` 加 `stroke-dasharray` 画进度有两个好处：
 *
 * 1. 进度大于 100% 时不会画出"回头"的弧线 —— 弧线的角度计算在
 *    超过一整圈后需要特殊处理，而 dasharray 天然只画到周长为止
 * 2. 动画只需要改一个属性，且默认过渡的是 `stroke-dasharray`；
 *    计划书 5.4 只允许动画 transform 与 opacity，因此这里
 *    **逐帧不动画**：进度变化是低频的（保存时才跳一次），
 *    直接切值比补间更省事也更符合约束。
 *
 * ## 无障碍
 *
 * 环本身是纯视觉，真正的信息由 `aria-label` 给出完整句子
 * （「今日目标：已写 1200 字，目标 2000 字，已完成 60%」）。
 * 只显示一个数字对读屏用户毫无意义。
 */

import { Show, type JSX } from "solid-js";

import { progressRing } from "./model";

/** 进度环属性。 */
export interface ProgressRingProps {
  /** 已完成量。 */
  done: number;
  /** 目标量；小于等于 0 时环进入「未设目标」态。 */
  goal: number;
  /** 环直径（像素）。 */
  size?: number;
  /** 环宽。 */
  thickness?: number;
  /** 中心显示的主文字。 */
  centerText?: string;
  /** 中心显示的次要文字。 */
  caption?: string;
  /** 无障碍标签。 */
  label: string;
  /** 已完成的百分比文本，用于 aria。 */
  percentText?: string;
}

/**
 * 环形进度。
 *
 * @example
 * <ProgressRing done={1200} goal={2000} label="今日目标" />
 */
export function ProgressRing(props: ProgressRingProps): JSX.Element {
  const size = (): number => props.size ?? 68;
  const thickness = (): number => props.thickness ?? 7;
  // 圆心到描边中心线的半径。减掉半个线宽，环才不会溢出画布
  const radius = (): number => Math.max((size() - thickness()) / 2, 0);
  const progress = (): number => {
    if (!Number.isFinite(props.goal) || props.goal <= 0) return 0;
    return props.done / props.goal;
  };
  const geometry = (): { dashArray: string; circumference: number } =>
    progressRing(radius(), progress());
  const reached = (): boolean => props.goal > 0 && props.done >= props.goal;

  const aria = (): string => {
    if (!Number.isFinite(props.goal) || props.goal <= 0) return props.label;
    return `${props.label}，${props.percentText ?? ""}`;
  };

  return (
    <div class="ring" style={{ width: `${size()}px` }}>
      <svg
        class="ring__svg"
        width={size()}
        height={size()}
        viewBox={`0 0 ${size()} ${size()}`}
        role="img"
        aria-label={aria()}
      >
        {/* 底环：给出"总量"的视觉参照，否则空环读不出进度 */}
        <circle
          class="ring__track"
          cx={size() / 2}
          cy={size() / 2}
          r={radius()}
          fill="none"
          stroke-width={thickness()}
        />
        <circle
          class="ring__value"
          classList={{ "is-reached": reached() }}
          cx={size() / 2}
          cy={size() / 2}
          r={radius()}
          fill="none"
          stroke-width={thickness()}
          stroke-linecap="round"
          stroke-dasharray={geometry().dashArray}
          // 从 12 点方向起画：默认起点在 3 点，读起来像"已经过了四分之一"
          transform={`rotate(-90 ${size() / 2} ${size() / 2})`}
        />
      </svg>
      <div class="ring__center" aria-hidden="true">
        <Show
          when={props.centerText}
          fallback={
            <span class="ring__text ring__text--muted">{props.caption}</span>
          }
        >
          <span class="ring__text yh-num">{props.centerText}</span>
          <Show when={props.caption}>
            <span class="ring__caption">{props.caption}</span>
          </Show>
        </Show>
      </div>
    </div>
  );
}
