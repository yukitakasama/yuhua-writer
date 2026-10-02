/**
 * 图标按钮：正方形、只有图形、必须有 aria-label。
 *
 * 为什么 aria-label 是必填而不是可选：只有图形的按钮对屏幕阅读器完全空白，
 * 7.5 节也要求「有语义的图标必须带 aria-label」。设成必填属性后漏写会直接
 * 编译报错，比代码评审靠人眼找可靠得多。
 */

import { splitProps, type Component, type JSX } from "solid-js";
import { cx, usePrimitivesStyle } from "./styles";

/** 图标按钮尺寸：sm 24px / md 30px / lg 38px。 */
export type IconButtonSize = "sm" | "md" | "lg";

/** {@link IconButton} 的 props。 */
export interface IconButtonProps extends Omit<
  JSX.ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "type" | "class" | "children"
> {
  /**
   * 无障碍名称。必填。
   * 读屏只会念出这里的内容，所以要写完整的动作短语
   * （「删除当前章节」优于「删除」，因为图标本身不提供上下文）。
   */
  "aria-label": string;
  /** 尺寸，默认 md。 */
  size?: IconButtonSize;
  /** 禁用。 */
  disabled?: boolean;
  /** 「已选中」的切换按钮。传了才渲染 aria-pressed，不传就是普通按钮。 */
  pressed?: boolean;
  /** 视觉变体，默认 ghost。 */
  variant?: "ghost" | "secondary" | "danger";
  /** 原生 type，默认 "button"。 */
  type?: "button" | "submit" | "reset";
  /** 点击回调。 */
  onClick?: (event: MouseEvent) => void;
  /** 调用方自定义类名。 */
  class?: string;
  /** 图标子节点。调用方直接传 SVG，组件不内置任何图标（零外链、零图标字体）。 */
  children?: JSX.Element;
}

/**
 * 图标按钮。
 *
 * @example
 * <IconButton aria-label="删除当前章节" onClick={remove}><TrashIcon /></IconButton>
 */
export const IconButton: Component<IconButtonProps> = (props) => {
  usePrimitivesStyle();

  const [local, rest] = splitProps(props, [
    "size",
    "disabled",
    "pressed",
    "variant",
    "type",
    "onClick",
    "class",
    "children",
  ]);

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      disabled={local.disabled === true}
      aria-pressed={
        local.pressed === undefined
          ? undefined
          : local.pressed
            ? "true"
            : "false"
      }
      data-variant={local.variant ?? "ghost"}
      class={cx(
        "yh-icon-btn",
        "yh-pressable",
        "yh-icon-btn--" + (local.size ?? "md"),
        local.class,
      )}
      onClick={(event) => {
        if (local.disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        local.onClick?.(event);
      }}
    >
      {/* 图标是纯装饰：语义已由 aria-label 给出，读屏再念一遍 SVG 只会重复。 */}
      <span aria-hidden="true" style={{ display: "inline-flex" }}>
        {local.children}
      </span>
    </button>
  );
};
