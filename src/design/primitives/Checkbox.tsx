/**
 * 复选框。
 *
 * 关键决策：内部用原生 <input type="checkbox">，只是把它视觉隐藏（不是 display:none）。
 * 为什么不用 role="checkbox" 的 div：
 * - 原生 checkbox 自带 Space 切换、表单关联、:checked 语义、以及 Chrome 的
 *   原生「不确定态」呈现。自绘这些行为的代码量远大于收益。
 * - display:none 会让元素脱离可达性树，所以用 opacity:0 加绝对定位压到自绘方块上，
 *   焦点环通过 :focus-visible 加兄弟选择器画在外层方块上。
 * - indeterminate 是 DOM 属性而非 HTML 属性，必须在 ref 里显式赋值。
 */

import {
  createUniqueId,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js";
import { cx, usePrimitivesStyle } from "./styles";

/** {@link Checkbox} 的 props。 */
export interface CheckboxProps extends Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "type" | "checked" | "onChange" | "class" | "children"
> {
  /** 是否选中。 */
  checked?: boolean;
  /** 不确定态（例如「部分章节已选」）。视觉上是横杠，与选中/未选形成形状差异。 */
  indeterminate?: boolean;
  /** 变更回调。 */
  onChange?: (checked: boolean, event: Event) => void;
  /** 是否禁用。 */
  disabled?: boolean;
  /** 错误态：边框转危险色。 */
  invalid?: boolean;
  /** 标签内容。 */
  children?: JSX.Element;
  /** 调用方自定义类名，透传到根 label。 */
  class?: string;
}

/**
 * 复选框。
 *
 * @example
 * <Checkbox checked={all()} indeterminate={some()} onChange={setAll}>全选</Checkbox>
 */
export const Checkbox: Component<CheckboxProps> = (props) => {
  usePrimitivesStyle();

  const [local, rest] = splitProps(props, [
    "checked",
    "indeterminate",
    "onChange",
    "disabled",
    "invalid",
    "children",
    "class",
  ]);

  const inputId = createUniqueId();

  const isChecked = (): boolean => local.checked === true;
  const isIndeterminate = (): boolean => local.indeterminate === true;

  /**
   * 把响应式的 indeterminate 同步到 DOM 属性。
   * Solid 的 JSX 不认识 indeterminate，只能走 ref；
   * 由于此处在 JSX 里以内联函数读取 local.indeterminate()，
   * 它会在该属性变化时自动重跑。
   */
  const syncIndeterminate = (element: HTMLInputElement): void => {
    element.indeterminate = isIndeterminate();
  };

  return (
    <label
      class={cx(
        "yh-checkbox",
        local.invalid ? "yh-checkbox--invalid" : undefined,
        local.class,
      )}
      data-checked={isChecked() ? "true" : "false"}
      data-indeterminate={isIndeterminate() ? "true" : "false"}
      data-disabled={local.disabled ? "true" : undefined}
      for={inputId}
    >
      <input
        {...rest}
        ref={syncIndeterminate}
        id={inputId}
        type="checkbox"
        checked={isChecked()}
        disabled={local.disabled === true}
        aria-invalid={local.invalid ? "true" : undefined}
        class="yh-checkbox__input"
        style={{
          position: "absolute",
          opacity: "0",
          width: "16px",
          height: "16px",
          margin: "0",
          cursor: local.disabled ? "not-allowed" : "pointer",
        }}
        onChange={(event) => {
          // 显式再判一次 disabled：真实浏览器不会为禁用控件派发 change，
          // 但 jsdom（以及某些通过脚本合成事件的场景）会。
          // 组件契约是「禁用即不回调」，判定放在这里才与契约一致。
          if (local.disabled) return;
          local.onChange?.(event.currentTarget.checked, event);
        }}
      />
      {/* 自绘方块：勾与横杠都是纯 CSS 形状，不引入 SVG 也不引入图标字体。 */}
      <span class="yh-checkbox__box" aria-hidden="true">
        <span class="yh-checkbox__tick" />
        <span class="yh-checkbox__dash" />
      </span>
      {/* 标签文字为空时不渲染 span，否则会在布局里留下一个多余的空隙。 */}
      <Show when={local.children}>
        <span>{local.children}</span>
      </Show>
    </label>
  );
};
