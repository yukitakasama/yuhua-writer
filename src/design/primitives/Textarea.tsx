/**
 * 多行文本输入。
 *
 * 与 Input 的差异都是刻意的：
 * 1. 不做自动高度（不提供 autoResize）：写作界面里正文高度变化会带动整体布局重排，
 *    5.4 禁止动画 height，同理也应避免在输入过程中反复改变高度造成抖动。
 * 2. 默认 4 行：中文长段落至少要看得到 4 行才便于校对断句。
 * 3. Enter 不提交：多行输入里 Enter 就是换行，提交交给显式按钮
 *    （Ctrl+Enter 由调用方在 onKeyDown 里接管）。
 */

import {
  createUniqueId,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js";
import { cx, usePrimitivesStyle } from "./styles";

/** {@link Textarea} 的 props。 */
export interface TextareaProps extends Omit<
  JSX.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onInput" | "class"
> {
  /** 受控值。 */
  value?: string;
  /** 输入回调。 */
  onInput?: (value: string, event: InputEvent) => void;
  /** 错误信息。 */
  error?: string;
  /** 辅助说明。 */
  hint?: string;
  /** 可见标签。 */
  label?: string;
  /** 可见行数，默认 4。 */
  rows?: number;
  /** 调用方自定义类名。 */
  class?: string;
}

/**
 * 受控多行输入框。
 *
 * @example
 * <Textarea label="本章摘要" value={summary()} onInput={setSummary} rows={6} />
 */
export const Textarea: Component<TextareaProps> = (props) => {
  usePrimitivesStyle();

  const [local, rest] = splitProps(props, [
    "value",
    "onInput",
    "error",
    "hint",
    "label",
    "class",
  ]);

  const areaId = createUniqueId();
  const errorId = areaId + "-error";
  const hintId = areaId + "-hint";

  return (
    <div class="yh-field">
      <Show when={local.label}>
        <label class="yh-field__label" for={areaId}>
          {local.label}
        </label>
      </Show>
      <textarea
        {...rest}
        id={rest.id ?? areaId}
        rows={rest.rows ?? 4}
        class={cx(
          "yh-textarea",
          local.error ? "yh-textarea--invalid" : undefined,
          local.class,
        )}
        value={local.value ?? ""}
        aria-invalid={local.error ? "true" : undefined}
        aria-describedby={
          local.error ? errorId : local.hint ? hintId : undefined
        }
        onInput={(event) => local.onInput?.(event.currentTarget.value, event)}
      />
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
