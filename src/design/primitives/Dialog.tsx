/**
 * 模态对话框。
 *
 * 必须满足的两条硬要求（T1.5 / T1.8）：焦点陷阱与 Esc 关闭。
 * 两者都实现在 Modal 底座里，这里只负责结构与外观，避免第三份实现走偏。
 *
 * 动效遵循 5.5：打开 scale(0.96 到 1) 加 opacity，180ms；
 * 关闭时反向 120ms、曲线换成 accelerate。下降沿比上升沿快的道理：
 * 用户已经决定关闭，等待只会觉得卡；打开则需要一点时间让眼睛跟上。
 *
 * 关闭后延迟卸载：先播完退出动画再移除 DOM。延迟时长与 CSS 里的
 * 关闭时长严格一致，否则会出现「画面已经消失但元素还在拦截点击」的空窗。
 */

import {
  createEffect,
  createSignal,
  createUniqueId,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js";
import { ModalShell } from "./Modal";
import { motionPolicy } from "./reducedMotion";
import { cx } from "./styles";

/** {@link Dialog} 的 props。 */
export interface DialogProps {
  /** 是否打开。 */
  open: boolean;
  /** 关闭请求。Esc、点击遮罩、点关闭按钮都会触发它。 */
  onClose: () => void;
  /** 标题。提供后会自动关联 aria-labelledby。 */
  title?: JSX.Element;
  /** 副标题 / 说明文字。 */
  description?: JSX.Element;
  /** 是否允许 Esc 关闭。默认 true。正在执行不可中断操作时才应关掉。 */
  closeOnEscape?: boolean;
  /** 是否允许点击遮罩关闭。默认 true。 */
  closeOnOverlayClick?: boolean;
  /** 打开后初始聚焦的元素。不传则聚焦第一个可聚焦元素。 */
  initialFocus?: () => HTMLElement | null;
  /** 面板宽度（像素）。默认由 CSS 的 max-width 决定。 */
  width?: number;
  /** 调用方自定义类名，透传到面板。 */
  class?: string;
  /** 正文内容。 */
  children?: JSX.Element;
  /** 底部操作区。 */
  footer?: JSX.Element;
}

/**
 * 模态对话框。
 *
 * @example
 * <Dialog open={open()} onClose={close} title="删除章节" footer={<Button>确定</Button>}>…</Dialog>
 */
export const Dialog: Component<DialogProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "open",
    "onClose",
    "title",
    "description",
    "closeOnEscape",
    "closeOnOverlayClick",
    "initialFocus",
    "width",
    "class",
    "children",
    "footer",
  ]);

  const titleId = createUniqueId();
  const descId = createUniqueId();

  // 关闭时先播退场动画再卸载。初值取 open，避免首次挂载就播一次退场。
  const [mounted, setMounted] = createSignal(local.open);

  createEffect(() => {
    if (local.open) {
      setMounted(true);
      return undefined;
    }
    if (!mounted()) return undefined;
    // 退场动画时长：正常 120ms，降级环境 80ms（且无位移）。
    const delay = motionPolicy({ duration: 120 }).duration;
    const timer = window.setTimeout(() => setMounted(false), delay);
    return () => window.clearTimeout(timer);
  });

  return (
    <Show when={mounted()}>
      <ModalShell
        {...rest}
        open={local.open}
        onClose={local.onClose}
        closeOnEscape={local.closeOnEscape}
        closeOnOverlayClick={local.closeOnOverlayClick}
        initialFocus={local.initialFocus}
        role="dialog"
        panelClass={cx("yh-dialog", local.class)}
        panelStyle={local.width ? { width: local.width + "px" } : undefined}
        labelledBy={local.title ? titleId : undefined}
        describedBy={local.description ? descId : undefined}
      >
        <Show when={local.title || local.description}>
          <header class="yh-dialog__header">
            <Show when={local.title}>
              <h2 class="yh-dialog__title" id={titleId}>
                {local.title}
              </h2>
            </Show>
            <Show when={local.description}>
              <p class="yh-dialog__desc" id={descId}>
                {local.description}
              </p>
            </Show>
          </header>
        </Show>
        <div class="yh-dialog__body">{local.children}</div>
        <Show when={local.footer}>
          <footer class="yh-dialog__footer">{local.footer}</footer>
        </Show>
      </ModalShell>
    </Show>
  );
};
