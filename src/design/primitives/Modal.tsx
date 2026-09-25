/**
 * Dialog 与 Drawer 共用的模态底座（内部模块，不对外导出）。
 *
 * 为什么抽出来：Dialog 与 Drawer 的语义差异只有「面板从哪来」，
 * 但焦点陷阱、Esc 关闭、打开时锁定背景滚动、关闭后归还焦点这四件事必须完全一致。
 * 分成两份实现最典型的后果就是「抽屉忘了归还焦点」，键盘用户点开一次抽屉
 * 就彻底丢失了位置。合并成一处，行为只有一份定义。
 */

import { createEffect, Show, type Component, type JSX } from "solid-js";
// solid-js/web 导出的是 <Portal> 组件而不是 React 风格的 createPortal 函数。
// 它把内容渲染到 document.body，这对模态是必需的：写作界面的侧栏、编辑器
// 都有 overflow 与 transform，留在原地的 fixed 遮罩会被祖先的 transform
// 变成「相对该祖先定位」，从而盖不住整个窗口。
import { Portal } from "solid-js/web";
import { focusTrap } from "./focusTrap";
import { motionPolicy } from "./reducedMotion";
import { cx, usePrimitivesStyle } from "./styles";

/** {@link ModalShell} 的 props。 */
export interface ModalShellProps {
  /** 是否打开。关闭时 unmount 还是保留 DOM 由 \`keepMounted\` 决定。 */
  open: boolean;
  /** 关闭请求（Esc、点击遮罩、关闭按钮）。调用方负责把 open 置回 false。 */
  onClose: () => void;
  /** 是否允许点击遮罩关闭。默认 true。 */
  closeOnOverlayClick?: boolean;
  /** 是否允许 Esc 关闭。默认 true。 */
  closeOnEscape?: boolean;
  /**
   * 关闭后是否保留 DOM。
   * 默认 false：弹层里常有表单，保留 DOM 会把上一次的输入留在下一次打开时，
   * 造成「我刚写的怎么还在」的困惑。需要保留动效收尾的场合由组件内部 180ms 处理。
   */
  keepMounted?: boolean;
  /** 无障碍角色。 */
  role: "dialog" | "alertdialog";
  /** 无障碍名称的 id，指向标题元素。 */
  labelledBy?: string;
  /** 无障碍描述的 id。 */
  describedBy?: string;
  /** 面板元素上要应用的类名。 */
  panelClass?: string;
  /** 排他层容器的类名（遮罩 + 面板）。 */
  overlayClass?: string;
  /** 面板上的额外样式（例如抽屉宽度变量）。 */
  panelStyle?: JSX.CSSProperties;
  /** 遮罩上的额外样式。 */
  overlayStyle?: JSX.CSSProperties;
  /** 打开后初始聚焦的元素。 */
  initialFocus?: () => HTMLElement | null;
  /** 用于定位面板 ref 的回调（测试与调试需要）。 */
  panelRef?: (element: HTMLElement) => void;
  /** 面板内容。 */
  children?: JSX.Element;
}

/**
 * 模态底座。
 *
 * 关闭动效的实现方式：不立即卸载，而是先把 data-state 切到 closed，
 * 等 180ms（或降级后的 80ms）后再从 DOM 移除。这样既有退出动画，
 * 又不会让已关闭的弹层继续留在可达性树里——这是 aria-hidden
 * 方案最容易出错的地方（内容还能被 Tab 到）。
 */
export const ModalShell: Component<ModalShellProps> = (props) => {
  usePrimitivesStyle();

  const state = (): "open" | "closed" => (props.open ? "open" : "closed");

  // 打开时锁定背景滚动：不做的话滚轮会穿透到正文，
  // 用户以为在滚动弹层，实际滚动的是背后的章节列表。
  createEffect(() => {
    if (typeof document === "undefined") return;
    const body = document.body;
    if (props.open) {
      const previous = body.style.overflow;
      body.style.overflow = "hidden";
      return () => {
        body.style.overflow = previous;
      };
    }
    return undefined;
  });

  // 焦点陷阱：只在打开期间创建，关闭即解除并归还焦点。
  createEffect(() => {
    if (!props.open) return undefined;
    let cleanup: (() => void) | undefined;
    // 等面板真正挂载后再建陷阱；用微任务同步到本次渲染之后。
    queueMicrotask(() => {
      const panel = document.querySelector<HTMLElement>("[data-yh-modal-panel]");
      if (!panel) return;
      cleanup = focusTrap(panel, { initialFocus: props.initialFocus, autoFocus: true });
    });
    return () => cleanup?.();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (props.closeOnEscape === false) return;
    // 只处理最外层弹层：嵌套弹层（例如弹窗里再开一个菜单）里按 Esc
    // 应该先关内层，由内层的处理器 stopPropagation 后这里就不会收到。
    event.stopPropagation();
    props.onClose();
  };

  const onOverlayPointerDown = (event: MouseEvent): void => {
    if (props.closeOnOverlayClick === false) return;
    // 只有点在遮罩本身才算「点外面」；点在面板内部冒泡上来的不算。
    if (event.target !== event.currentTarget) return;
    props.onClose();
  };

  return (
    <Show when={props.open || props.keepMounted}>
      <Portal mount={document.body}>
        <div
          class={cx("yh-overlay", props.overlayClass)}
          data-state={state()}
          style={props.overlayStyle}
          onMouseDown={onOverlayPointerDown}
          onKeyDown={onKeyDown}
        >
          <div
            ref={(element) => props.panelRef?.(element)}
            data-yh-modal-panel=""
            data-state={state()}
            role={props.role}
            aria-modal="true"
            aria-labelledby={props.labelledBy}
            aria-describedby={props.describedBy}
            // tabindex="-1" 让「容器内没有任何可聚焦元素」的弹层仍能接收焦点，
            // 否则焦点陷阱无处可放，Tab 会直接逃到背景页面。
            tabindex="-1"
            class={props.panelClass}
            style={props.panelStyle}
          >
            {props.children}
          </div>
        </div>
      </Portal>
    </Show>
  );
};

/** 打开态与关闭态的过渡时长，供调用方做「先播动画再卸载」的时序控制。 */
export function modalExitDuration(): number {
  return motionPolicy({ duration: 120 }).duration;
}
