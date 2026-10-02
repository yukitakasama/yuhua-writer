/**
 * 单行文本输入。
 *
 * 设计决策：
 * - 受控：value 由外部持有，组件只派发 onInput。写作软件里输入框的值常同时被
 *   「草稿自动保存」「撤销栈」「检索词同步」多处读写，非受控会在这些场景里
 *   出现视图与状态不一致。
 * - 错误态用 aria-invalid 加 role="alert" 的错误文案：视觉上的红边对读屏不可见，
 *   且 5.6 要求动效与颜色永不作为唯一反馈。
 * - label、hint、error 通过 aria-describedby 关联，读屏会连同错误原因一起念出。
 */

import {
  createUniqueId,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js";
import { cx, usePrimitivesStyle } from "./styles";

/** {@link Input} 的 props。 */
export interface InputProps extends Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onInput" | "class"
> {
  /** 受控值。 */
  value?: string;
  /** 输入回调，参数为当前输入框文本。 */
  onInput?: (value: string, event: InputEvent) => void;
  /** 错误信息。非空即进入错误态。 */
  error?: string;
  /** 辅助说明。错误存在时错误优先展示，二者不同时出现，避免信息竞争。 */
  hint?: string;
  /** 可见标签。不传则需调用方自行提供 aria-label。 */
  label?: string;
  /** 调用方自定义类名，透传到外层包裹 div 而不是 input。 */
  class?: string;
}

/**
 * 受控单行输入框。
 *
 * @example
 * <Input label="书名" value={title()} onInput={setTitle} error={err()} />
 */
export const Input: Component<InputProps> = (props) => {
  usePrimitivesStyle();

  const [local, rest] = splitProps(props, [
    "value",
    "onInput",
    "error",
    "hint",
    "label",
    "class",
  ]);

  const inputId = createUniqueId();
  const errorId = inputId + "-error";
  const hintId = inputId + "-hint";

  const describedBy = (): string | undefined => {
    if (local.error) return errorId;
    if (local.hint) return hintId;
    return undefined;
  };

  return (
    <div class="yh-field">
      <Show when={local.label}>
        <label class="yh-field__label" for={inputId}>
          {local.label}
        </label>
      </Show>
      <input
        {...rest}
        id={rest.id ?? inputId}
        class={cx(
          "yh-input",
          local.error ? "yh-input--invalid" : undefined,
          local.class,
        )}
        value={local.value ?? ""}
        aria-invalid={local.error ? "true" : undefined}
        aria-describedby={describedBy()}
        onInput={(event) => local.onInput?.(event.currentTarget.value, event)}
      />
      {/* 错误文案用 role="alert"：用户打字过程中它会被读屏主动播报，
          而不是等焦点移过去才念。这对表单校验的即时反馈很关键。 */}
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
