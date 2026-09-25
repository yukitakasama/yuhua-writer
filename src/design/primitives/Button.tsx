/**
 * 按钮。
 *
 * 设计决策：
 * - 用原生 <button> 而不是 div+role：原生元素自带键盘激活、Enter/Space 语义、
 *   焦点管理与表单提交行为，重新实现一遍只会引入缺口（T1.8 要求全键盘可达）。
 * - disabled 用原生 disabled 属性：原生 disabled 会把元素移出 Tab 序，
 *   这是用户对「不可用按钮」的预期。代价是浏览器不再派发 click，
 *   所以「为什么点不动」需要靠 Tooltip 等外部提示，这是刻意的取舍。
 * - 加载态用 <span role="status"> 播报，而不是只换图标：动效永不作为唯一反馈（5.6）。
 * - 按压回弹 80ms、只动 transform（5.4 / 5.5）。
 */

import { splitProps, Show, type Component, type JSX } from "solid-js";
import { cx, usePrimitivesStyle } from "./styles";

/** 按钮视觉变体。 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** 按钮尺寸。 */
export type ButtonSize = "sm" | "md" | "lg";

/** {@link Button} 的 props。 */
export interface ButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type" | "class" | "children"> {
  /** 视觉变体，默认 primary。 */
  variant?: ButtonVariant;
  /** 尺寸，默认 md。 */
  size?: ButtonSize;
  /** 禁用。禁用后不会被 Tab 聚焦，调用方需要另行说明原因。 */
  disabled?: boolean;
  /** 加载中。会同时拦住点击并播报状态，避免重复提交（例如重复保存同一章）。 */
  loading?: boolean;
  /** 撑满父容器宽度。 */
  block?: boolean;
  /** 原生 type，默认 "button"。默认值刻意不取 submit：表单里的普通按钮最常被误当提交。 */
  type?: "button" | "submit" | "reset";
  /** 点击回调。loading 或 disabled 时不会被调用。 */
  onClick?: (event: MouseEvent) => void;
  /** 调用方自定义类名，透传到根元素。 */
  class?: string;
  /** 按钮内容。 */
  children?: JSX.Element;
}

/**
 * 通用按钮。
 *
 * @example
 * <Button variant="primary" onClick={save}>保存</Button>
 */
export const Button: Component<ButtonProps> = (props) => {
  usePrimitivesStyle();

  // 我们自己消费的字段拆出来，其余原样透传给原生 button
  // （含 aria-*、form、name、autofocus 等调用方可能用到的属性）。
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "disabled",
    "loading",
    "block",
    "type",
    "onClick",
    "class",
    "children",
  ]);

  const isDisabled = (): boolean => local.disabled === true;
  const isLoading = (): boolean => local.loading === true;
  // 加载中也要拦住点击：真实业务里重复提交是最常见的线上事故。
  const isInert = (): boolean => isDisabled() || isLoading();

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      disabled={isDisabled()}
      aria-busy={isLoading() ? "true" : undefined}
      aria-disabled={isLoading() ? "true" : undefined}
      data-loading={isLoading() ? "true" : undefined}
      class={cx(
        "yh-btn",
        "yh-pressable",
        "yh-btn--" + (local.variant ?? "primary"),
        "yh-btn--" + (local.size ?? "md"),
        local.block ? "yh-btn--block" : undefined,
        local.class,
      )}
      onClick={(event) => {
        if (isInert()) {
          // 原生 disabled 的元素不会进这里；但加载态仍可点击，
          // 必须显式拦截并阻止冒泡，否则外层表单仍会被提交。
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        local.onClick?.(event);
      }}
    >
      <Show when={isLoading()}>
        {/* 转圈是纯装饰（aria-hidden），真正的状态由后面的 status 文本播报，
            避免屏幕阅读器把「一个旋转的图形」念成无意义内容。 */}
        <span class="yh-spinner" aria-hidden="true" />
        <span class="yh-visually-hidden" role="status">
          正在处理
        </span>
      </Show>
      {local.children}
    </button>
  );
};
