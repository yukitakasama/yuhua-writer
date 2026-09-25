/**
 * 下拉选择。
 *
 * 为什么用原生 <select> 而不是自绘的 listbox：
 * 1. 原生 select 在 Windows/WebView2 上的弹出层由系统绘制，键盘行为（首字母跳转、
 *    Alt+Down 展开、方向键选择）与用户系统习惯完全一致，自绘很难做到等价。
 * 2. 移动端原生 select 会拉起系统选择器，可用性远胜自绘。
 * 3. 省掉一整套 listbox 焦点管理，符合「不臃肿」。
 * 代价是无法自定义下拉面板的样式，因此只在视觉上保留一个纯 CSS 绘制的箭头作为提示。
 *
 * value 为 undefined 时选中的是 placeholder 项，该项带 value=""，与真实选项区分开。
 */

import { createEffect, createUniqueId, For, Show, splitProps, type Component, type JSX } from "solid-js";
import { cx, usePrimitivesStyle } from "./styles";

/** 单个选项。 */
export interface SelectOption {
  /** 选项值。 */
  value: string;
  /** 展示文案。 */
  label: string;
  /** 是否禁用该选项。 */
  disabled?: boolean;
}

/** {@link Select} 的 props。 */
export interface SelectProps
  extends Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "class" | "children"> {
  /** 选项列表。 */
  options: readonly SelectOption[];
  /** 受控值。不传或传 undefined 表示未选择，展示 placeholder。 */
  value?: string;
  /** 选择回调。 */
  onChange?: (value: string, event: Event) => void;
  /** 未选择时的提示文案。 */
  placeholder?: string;
  /** 错误信息。 */
  error?: string;
  /** 辅助说明。 */
  hint?: string;
  /** 可见标签。 */
  label?: string;
  /** 调用方自定义类名，透传到外层包裹 div。 */
  class?: string;
}

/**
 * 原生下拉选择。
 *
 * @example
 * <Select label="卷" value={vol()} options={opts} onChange={setVol} placeholder="选择卷" />
 */
export const Select: Component<SelectProps> = (props) => {
  usePrimitivesStyle();

  const [local, rest] = splitProps(props, [
    "options",
    "value",
    "onChange",
    "placeholder",
    "error",
    "hint",
    "label",
    "class",
  ]);

  const selectId = createUniqueId();
  const errorId = selectId + "-error";
  const hintId = selectId + "-hint";

  /**
   * 显式同步选中值。
   *
   * 为什么不能只靠 JSX 的 value 属性：Solid 会把 value 写成一个 DOM 属性，
   * 但 <select> 的「当前选中项」是 DOM 属性（property）而非 attribute，
   * 浏览器只在选项解析完成时按 attribute 初始化一次。选项通过 <For> 动态生成时，
   * value 属性可能先于选项出现，选中项就会停在第一项上——
   * 表现为「明明传了 value，下拉却显示第一卷」。
   * 在 onMount（此时选项已就绪）显式赋值是唯一可靠的时机。
   */
  let selectRef: HTMLSelectElement | undefined;

  /**
   * 同步选中值。
   *
   * 时机是 <For> 完成选项插入之后——ref 回调跑在子节点挂载之前，
   * 那时赋值只会落到「还没有选项」的空 select 上，随后选项插入时
   * 浏览器会按第一项重新决定选中项，覆盖掉刚写的值。
   * 必须用一个「依赖项变化就重跑」的 effect 把赋值推到插槽之后。
   */
  createEffect(() => {
    const element = selectRef;
    if (!element) return;
    const desired = local.value ?? "";
    if (element.value !== desired) element.value = desired;
  });

  return (
    <div class="yh-field">
      <Show when={local.label}>
        <label class="yh-field__label" for={selectId}>
          {local.label}
        </label>
      </Show>
      <span class={cx("yh-select__wrap", local.class)}>
        <select
          {...rest}
          ref={(element) => {
            selectRef = element;
          }}
          id={rest.id ?? selectId}
          class={cx("yh-select", local.error ? "yh-select--invalid" : undefined)}
          value={local.value ?? ""}
          aria-invalid={local.error ? "true" : undefined}
          aria-describedby={local.error ? errorId : local.hint ? hintId : undefined}
          onChange={(event) => local.onChange?.(event.currentTarget.value, event)}
        >
          {/* placeholder 项只在未选中时出现：一旦有值还留着它，
              用户会以为可以「取消选择」，但原生 select 无法表达这个意图。 */}
          <Show when={local.placeholder && local.value === undefined}>
            <option value="" disabled>
              {local.placeholder}
            </option>
          </Show>
          <For each={local.options}>
            {(option) => (
              <option value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            )}
          </For>
        </select>
        {/* 箭头是纯装饰，点击必须穿透到 select 本身。 */}
        <span class="yh-select__arrow" aria-hidden="true" />
      </span>
      <Show when={local.error}>
        <span class="yh-field__error" id={errorId} role="alert">
          {local.error}
        </span>
      </Show>
      <Show when={!local.error && local.hint}>
        <span class="yh-field__hint" id={hintId}>
          {local.hint}
        </span>
      </Show>
    </div>
  );
};
