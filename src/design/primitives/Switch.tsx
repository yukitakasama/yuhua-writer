/**
 * 开关。
 *
 * 为什么用 role="switch" 的自绘元素而不是原生 checkbox：
 * 视觉上开关是一条轨道加一个滑块，用 checkbox 需要覆盖掉所有原生外观，
 * 反而更容易出现跨平台渲染差异。这里保留原生按钮语义即可：
 * role="switch" + aria-checked，键盘用 Space / Enter 切换（原生 button 自带）。
 *
 * 滑块位移只动 transform，符合 5.4「只动画 transform 与 opacity」。
 */

import { Show, splitProps, type Component, type JSX } from "solid-js";
import { cx, usePrimitivesStyle } from "./styles";

/** {@link Switch} 的 props。 */
export interface SwitchProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "onClick" | "class" | "children" | "type"> {
  /** 是否打开。 */
  checked?: boolean;
  /** 切换回调。 */
  onChange?: (checked: boolean, event: MouseEvent | KeyboardEvent) => void;
  /** 是否禁用。 */
  disabled?: boolean;
  /** 标签内容。 */
  children?: JSX.Element;
  /** 调用方自定义类名，透传到根元素。 */
  class?: string;
}

/**
 * 开关（用于「自动保存」「跟随系统主题」这类即时生效的二元设置）。
 *
 * @example
 * <Switch checked={auto()} onChange={setAuto}>自动保存</Switch>
 */
export const Switch: Component<SwitchProps> = (props) => {
  usePrimitivesStyle();

  const [local, rest] = splitProps(props, ["checked", "onChange", "disabled", "children", "class"]);

  const isChecked = (): boolean => local.checked === true;

  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={isChecked() ? "true" : "false"}
      disabled={local.disabled === true}
      data-checked={isChecked() ? "true" : "false"}
      data-disabled={local.disabled ? "true" : undefined}
      class={cx("yh-switch", "yh-pressable", local.class)}
      onClick={(event) => {
        if (local.disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        local.onChange?.(!isChecked(), event);
      }}
    >
      <span class="yh-switch__track" aria-hidden="true">
        <span class="yh-switch__thumb" />
      </span>
      <Show when={local.children}>
        <span>{local.children}</span>
      </Show>
    </button>
  );
};
