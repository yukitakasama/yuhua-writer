/**
 * 带数值显示的滑杆。
 *
 * ## 为什么用原生 <input type="range">
 *
 * 原生 range 自带：键盘方向键 / Home / End / PageUp/PageDown 调整、
 * 读屏朗读当前值、触摸拖拽、以及平台一致的滑块手感。
 * 自绘滑杆要重新实现这一整套，而且很难做到键盘行为完全等价 ——
 * 与 Select 选择原生元素的理由一致。
 *
 * 这里只做三件原生没做的事：
 * 1. 用 `aria-valuetext` 把裸数字变成有单位的说明（读屏会念「字号 17 像素」
 *    而不是「17」）；
 * 2. 右侧显示当前值，让鼠标用户不必拖动就知道精确数值；
 * 3. 把 `<label>` 显式关联到 input，点击文字也能聚焦滑杆。
 */

import { createUniqueId, type JSX } from "solid-js";

import { t } from "@/strings";

/** {@link RangeField} 的 props。 */
export interface RangeFieldProps {
  /** 可见标签。 */
  label: string;
  /** 当前值。 */
  value: number;
  /** 最小值。 */
  min: number;
  /** 最大值。 */
  max: number;
  /** 步长。 */
  step: number;
  /** 单位后缀，会同时用于显示与读屏。 */
  unit?: string;
  /** 数值变化回调。 */
  onChange: (value: number) => void;
  /** 该控件处于「本书覆盖」状态时显示标记。 */
  overridden?: boolean;
  /** 是否有本书覆盖能力（未打开工作区时为 false）。 */
  canOverride?: boolean;
  /** 请求恢复继承全局（仅本书覆盖时显示）。 */
  onInherit?: () => void;
  /** 无障碍补充说明。 */
  hint?: string;
}

/**
 * 数值滑杆。
 *
 * @example
 * <RangeField label="字号" value={17} min={14} max={24} step={1} unit="px" onChange={setSize} />
 */
export function RangeField(props: RangeFieldProps): JSX.Element {
  const id = createUniqueId();
  const hintId = id + "-hint";

  /** 读屏念的完整值，例如「17 像素」。 */
  const valueText = (): string =>
    props.unit ? `${props.value} ${props.unit}` : String(props.value);

  return (
    <div
      class="range-field"
      data-overridden={props.overridden ? "true" : undefined}
    >
      <div class="range-field__head">
        <label class="range-field__label" for={id}>
          {props.label}
        </label>
        <span class="range-field__value yh-num" aria-hidden="true">
          {props.value}
          {props.unit ?? ""}
        </span>
      </div>

      <input
        id={id}
        class="range-field__input"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        aria-valuetext={valueText()}
        aria-describedby={props.hint ? hintId : undefined}
        onInput={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) props.onChange(next);
        }}
      />

      {props.hint && (
        <span class="range-field__hint" id={hintId}>
          {props.hint}
        </span>
      )}

      {props.canOverride && props.overridden && (
        <button
          type="button"
          class="settings-link"
          onClick={() => props.onInherit?.()}
        >
          {t("settings.level.inherit")}
        </button>
      )}
    </div>
  );
}
