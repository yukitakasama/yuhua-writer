/**
 * 文本输入框与内联编辑输入。
 *
 * 内联编辑（在树节点上直接改名）与普通输入框的差别只在尺寸与
 * 自动聚焦行为，因此共用一个组件、用 `inline` 区分，
 * 而不是写两份几乎一样的样式。
 */

import { splitProps, type JSX } from "solid-js";

/** 输入框属性。 */
export interface TextFieldProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  /** 内联（紧凑）模式，用于树节点上的重命名。 */
  inline?: boolean;
  /** 无障碍标签，可选；有 label 元素时可以省略。 */
  label?: string;
}

/** 一个受控文本输入框。 */
export function TextField(props: TextFieldProps): JSX.Element {
  const [local, rest] = splitProps(props, ["inline", "class", "label"]);
  const classes = () => ["field", local.inline ? "field--inline" : "", local.class ?? ""].filter(Boolean).join(" ");
  return <input class={classes()} aria-label={local.label} {...rest} />;
}
