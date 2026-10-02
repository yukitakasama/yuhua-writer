/**
 * 内联重命名输入。
 *
 * ## 为什么不用弹窗
 *
 * 卷章树里的改名是高频轻量操作，弹窗会打断「扫视 + 改字」的节奏。
 * 直接在原位置换成一个输入框，视觉位置不变，用户的眼睛不用重新定位。
 *
 * ## 交互细节（都是踩过坑的点）
 *
 * - **回车确认 / Esc 取消 / 失焦确认**：三种结束方式都要有，
 *   尤其是失焦——用户点了别处就是默认想结束。
 * - **进入时全选**：改名通常是整体替换（「第一章」→「序章」），
 *   全选后直接打新字比先删再打快。
 * - **Esc 一定要阻止冒泡**：否则会顺带关闭上层面板。
 * - **空值不提交**：交给调用方处理提示，组件本身不静默改成默认名。
 */

import { createEffect, createSignal, onCleanup, type JSX } from "solid-js";

import { t } from "@/strings";
import { validateTitle } from "@/features/chapters/tree-ops";

/** 内联编辑属性。 */
export interface InlineEditProps {
  /** 初始值。 */
  value: string;
  /** 提交（回车或失焦）。空值不会触发，改为调用 onReject。 */
  onCommit: (value: string) => void;
  /** 取消（Esc）。 */
  onCancel: () => void;
  /** 校验失败。参数是错误码，由调用方翻译成文案。 */
  onReject?: (reason: "empty" | "tooLong") => void;
  /** 无障碍标签。 */
  label: string;
  /** 附加类名。 */
  class?: string;
}

/** 一个自动聚焦的内联输入框。 */
export function InlineEdit(props: InlineEditProps): JSX.Element {
  // 用非受控输入 + ref 读取值：受控输入在中文输入法下会吃掉拼音，
  // 这是 WebView 里做内联编辑最容易踩的坑
  const [error, setError] = createSignal<"empty" | "tooLong" | null>(null);
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (inputRef) {
      inputRef.focus();
      inputRef.select();
    }
  });

  // 组件卸载时若还有未结束的编辑，什么也不做：
  // 树的结构变化（比如重排）会让输入框消失，此时静默取消比强行提交安全
  onCleanup(() => {
    inputRef = undefined;
  });

  const commit = (): void => {
    const raw = inputRef?.value ?? "";
    const problem = validateTitle(raw);
    if (problem !== null) {
      // 空值：静默取消而不是留一个悬空的编辑框
      setError(problem);
      if (problem === "empty") {
        props.onReject?.(problem);
        props.onCancel();
        return;
      }
      props.onReject?.(problem);
      return;
    }
    props.onCommit(raw.trim());
  };

  return (
    <input
      ref={inputRef}
      class={[
        "inline-edit",
        error() !== null ? "inline-edit--error" : "",
        props.class ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      type="text"
      value={props.value}
      aria-label={props.label}
      aria-invalid={error() !== null}
      spellcheck={false}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          // 必须阻止冒泡：否则 Esc 会继续向上关掉整个面板
          event.preventDefault();
          event.stopPropagation();
          props.onCancel();
        }
      }}
      onBlur={() => commit()}
      onInput={() => setError(null)}
    />
  );
}

/** 重命名提示文案。 */
export function titleErrorMessage(reason: "empty" | "tooLong"): string {
  return reason === "empty"
    ? t("chapters.renameEmpty")
    : t("chapters.renameTooLong", { max: 200 });
}
