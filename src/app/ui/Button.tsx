/**
 * 按钮。
 *
 * ## 与设计系统的关系（重要）
 *
 * 计划书里按钮属于 `src/design/primitives/`，那一块由另一个代理负责。
 * 为了不互相阻塞、不产生合并冲突，**这里先放一个最小可用的自研实现**，
 * 直接消费计划书 5.2 节定义的设计令牌（`var(--c-*)` / `var(--sp-*)` /
 * `var(--r-*)` / `var(--d-*)`）。
 *
 * 合流方式：等 design/primitives 落地后，把本文件的导入路径改成
 * 设计系统版本即可，**调用点的参数名刻意与常见约定保持一致**。
 * 待办已记录在报告里。
 *
 * ## 动效约束
 *
 * 计划书 5.4 节：只动画 `transform` 与 `opacity`。
 * 因此悬停的背景色变化走 CSS 变量过渡（不是动画），
 * 按下的反馈走 `transform: scale(0.97)`。
 */

import { splitProps, type JSX } from "solid-js";

/** 按钮外观。 */
export type ButtonVariant = "solid" | "ghost" | "outline" | "danger";

/** 按钮尺寸。 */
export type ButtonSize = "sm" | "md";

/** 按钮属性。 */
export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 外观，默认 ghost（写作软件里绝大多数按钮都该退到背景）。 */
  variant?: ButtonVariant;
  /** 尺寸，默认 md。 */
  size?: ButtonSize;
  /** 是否占满父容器宽度。 */
  block?: boolean;
}

/** 一个可点击按钮。 */
export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["variant", "size", "block", "class", "children", "type"]);
  const classes = () =>
    [
      "btn",
      `btn--${local.variant ?? "ghost"}`,
      local.size === "sm" ? "btn--sm" : "",
      local.block ? "btn--block" : "",
      local.class ?? "",
    ]
      .filter(Boolean)
      .join(" ");

  return (
    // 默认 type=button：按钮几乎总在表单外使用，默认 submit 会引发意外提交
    <button type={local.type ?? "button"} class={classes()} {...rest}>
      {local.children}
    </button>
  );
}
