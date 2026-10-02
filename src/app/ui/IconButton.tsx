/**
 * 图标按钮。
 *
 * 无文字按钮对屏幕阅读器是不可见的，因此**强制要求 `label`**：
 * 不是可选的，而是类型上必填。这样「忘了加 aria-label」变成编译错误。
 */

import { splitProps, type JSX } from "solid-js";

/** 图标按钮属性。 */
export interface IconButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 无障碍标签，必填。会同时作为 title 提示。 */
  label: string;
  /** 视觉尺寸，默认 md（28px 点击区）。 */
  size?: "sm" | "md";
  /** 是否处于激活（选中）状态。 */
  active?: boolean;
  /** 危险操作（删除等）用警示色。 */
  danger?: boolean;
}

/** 一个只含图形的按钮。 */
export function IconButton(props: IconButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "label",
    "size",
    "active",
    "danger",
    "class",
    "children",
    "type",
  ]);
  const classes = () =>
    [
      "icon-btn",
      local.size === "sm" ? "icon-btn--sm" : "",
      local.active ? "is-active" : "",
      local.danger ? "is-danger" : "",
      local.class ?? "",
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <button
      type={local.type ?? "button"}
      class={classes()}
      aria-label={local.label}
      title={local.label}
      {...rest}
    >
      {local.children}
    </button>
  );
}
