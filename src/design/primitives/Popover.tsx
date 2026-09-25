/**
 * 弹出层。
 *
 * 与 Tooltip 的区别：Popover 承载可交互内容，因此
 * 1. 不延迟出现（用户是主动点击打开的，没有「划过误触」问题）；
 * 2. 打开时把焦点移入面板，关闭时归还 —— 否则键盘用户点了按钮后
 *    焦点还留在按钮上，按 Tab 直接跳到后面，面板内容永远够不着；
 * 3. 点击外部 / Esc 关闭，两个通道都要有。
 *
 * 定位策略与 Tooltip 一样用 position: absolute 相对包裹元素，
 * 但包裹元素是 inline-block 的定位容器，这样弹层会随触发按钮一起滚动，
 * 适合「贴在按钮下方」的短生命周期面板。
 */

import { createEffect, createSignal, onCleanup, Show, splitProps, type Component, type JSX } from "solid-js";
import { focusableCandidates, getFocusableElements } from "./focusTrap";
import { motionPolicy } from "./reducedMotion";
import { cx, usePrimitivesStyle } from "./styles";

/** 弹层相对触发元素的位置。 */
export type PopoverPlacement = "top" | "bottom" | "left" | "right";

/** {@link Popover} 的 props。 */
export interface PopoverProps {
  /** 是否打开。受控。 */
  open: boolean;
  /** 打开状态变化回调（点击外部、Esc 都会调用）。 */
  onOpenChange: (open: boolean) => void;
  /** 弹层内容。 */
  content?: JSX.Element;
  /** 位置，默认 bottom。 */
  placement?: PopoverPlacement;
  /** 打开后是否把焦点移入面板。默认 true。不可交互的纯展示面板可关掉。 */
  autoFocus?: boolean;
  /** 点击外部是否关闭，默认 true。 */
  closeOnOutsideClick?: boolean;
  /** Esc 是否关闭，默认 true。 */
  closeOnEscape?: boolean;
  /** 调用方自定义类名，透传到弹层。 */
  class?: string;
  /** 触发元素。 */
  children?: JSX.Element;
}

/**
 * 弹出层。
 *
 * @example
 * <Popover open={open()} onOpenChange={setOpen} content={<p>说明</p>}><Button>详情</Button></Popover>
 */
export const Popover: Component<PopoverProps> = (props) => {
  usePrimitivesStyle();

  const [local, rest] = splitProps(props, [
    "open",
    "onOpenChange",
    "content",
    "placement",
    "autoFocus",
    "closeOnOutsideClick",
    "closeOnEscape",
    "class",
    "children",
  ]);

  let wrapper: HTMLDivElement | undefined;
  let panel: HTMLDivElement | undefined;
  const [visible, setVisible] = createSignal(false);

  const requestClose = (): void => {
    setVisible(false);
    local.onOpenChange(false);
  };

  // 安装期间才挂全局监听：常驻的 document 监听在弹层多的界面里
  // 会变成一串永远在跑的处理器，每次点击都要过一遍。
  createEffect(() => {
    if (!local.open) {
      setVisible(false);
      return undefined;
    }
    // 下一帧再置 visible，让 data-state 从 closed 变 open 时能触发过渡，
    // 否则同一帧内插入即终态，动画不会播。
    queueMicrotask(() => {
      setVisible(true);
      if (local.autoFocus !== false && panel) {
        // 面板内的元素可能带 tabindex="-1"，用 focusableCandidates 才能在
        // 没有天然可聚焦元素时仍把焦点送进面板；都没有则聚焦面板本身。
        const target = focusableCandidates(panel)[0] ?? panel;
        target.focus();
      }
    });

    const onPointerDown = (event: MouseEvent): void => {
      if (local.closeOnOutsideClick === false) return;
      if (wrapper?.contains(event.target as Node)) return;
      requestClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || local.closeOnEscape === false) return;
      requestClose();
    };

    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  });

  // 关闭时把焦点还给触发元素，键盘用户才不会「点开一次就丢位置」。
  createEffect(() => {
    if (local.open) return;
    if (panel?.contains(document.activeElement) && wrapper) {
      const trigger = getFocusableElements(wrapper).find((element) => !panel?.contains(element));
      trigger?.focus();
    }
  });

  onCleanup(() => setVisible(false));

  const layerStyle = (): JSX.CSSProperties => {
    const placement = local.placement ?? "bottom";
    const policy = motionPolicy({ duration: 120 });
    const base: JSX.CSSProperties = { position: "absolute" };
    const offset = policy.allowTransform ? "4px" : "0px";
    const closedTransform =
      placement === "top"
        ? "translateY(" + offset + ")"
        : placement === "left"
          ? "translateX(" + offset + ")"
          : placement === "right"
            ? "translateX(calc(-1 * " + offset + "))"
            : "translateY(calc(-1 * " + offset + "))";
    const edge: JSX.CSSProperties =
      placement === "top"
        ? { bottom: "100%", left: "0", "margin-bottom": "4px" }
        : placement === "left"
          ? { right: "100%", top: "0", "margin-right": "4px" }
          : placement === "right"
            ? { left: "100%", top: "0", "margin-left": "4px" }
            : { top: "100%", left: "0", "margin-top": "4px" };
    return {
      ...base,
      ...edge,
      "transition-duration": policy.duration + "ms",
      transform: visible() ? "none" : closedTransform,
      opacity: visible() ? "1" : "0",
    };
  };

  return (
    <div
      {...rest}
      ref={wrapper}
      class="yh-popover-anchor"
      style={{ position: "relative", display: "inline-block" }}
    >
      {local.children}
      <Show when={local.open && local.content}>
        <div
          ref={panel}
          role="dialog"
          tabindex="-1"
          data-state={visible() ? "open" : "closed"}
          class={cx("yh-layer yh-popover", local.class)}
          style={layerStyle()}
        >
          {local.content}
        </div>
      </Show>
    </div>
  );
};
