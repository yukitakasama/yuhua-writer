/**
 * 按钮（应用壳版本）。
 *
 * ## 与设计系统的关系（重要）
 *
 * `src/design/primitives/Button.tsx` 是功能更完整的设计系统按钮
 * （含 loading 态、`yh-*` 类名）。这里是应用壳自用的一层，消费同一套
 * 设计令牌（`var(--c-*)` / `var(--sp-*)` / `var(--r-*)` / `var(--d-*)`）
 * 但类名体系不同（`btn--*`），因此**两者暂不能互换**：
 * 迁移需要同时改调用点与 `src/styles/app.css` 的类名。
 *
 * 新代码若只是为了拿到按钮样式，优先用设计系统版本。
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
