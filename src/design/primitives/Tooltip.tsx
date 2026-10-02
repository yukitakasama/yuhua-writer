/**
 * 提示气泡。
 *
 * 为什么延迟 300ms 才出现：这是可用性与干扰之间最成熟的经验值。
 * - 太短（<150ms）：鼠标划过工具栏时提示会一路闪个不停，反而看不见内容。
 * - 太长（>700ms）：用户已经点错了还没等到说明。
 * 300ms 接近系统级 tooltip 的通行阈值，配合 60ms 的移出延迟，
 * 让指针短暂掠过间隙时提示不会闪烁重开。
 *
 * 为什么也响应 focus：Tooltip 常常是「为什么这个按钮是灰的」的唯一解释，
 * 键盘用户拿不到悬停，只有 focus 显示才能保证同样的信息可达（T1.8）。
 *
 * 为什么用 fixed 定位而不是 absolute 跟随父元素：写作界面的侧栏、编辑器都有
 * overflow:hidden，absolute 定位的气泡会被裁掉。fixed 配合 getBoundingClientRect
 * 在视觉上更可靠；代价是滚动时需要重算，这里在 open 时算一次并在滚动时关闭，
 * 避免把一次简单交互变成常驻滚动监听。
 */

import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js";
import { motionPolicy } from "./reducedMotion";
import { cx, usePrimitivesStyle } from "./styles";

/** 气泡相对触发元素的位置。 */
export type TooltipPlacement = "top" | "bottom" | "left" | "right";

/** {@link Tooltip} 的 props。 */
export interface TooltipProps {
  /** 提示文案。为空时不渲染气泡（但子元素照常渲染）。 */
  content?: JSX.Element;
  /** 位置，默认 top。 */
  placement?: TooltipPlacement;
  /** 出现延迟（毫秒），默认 300。 */
  delay?: number;
  /** 是否禁用提示。禁用后连 aria-describedby 都不加，避免读屏念出不可见内容。 */
  disabled?: boolean;
  /** 调用方自定义类名，透传到外层包裹 span。 */
  class?: string;
  /** 触发元素。 */
  children?: JSX.Element;
}

/** 计算气泡左上角坐标。用触发元素的矩形与气泡自身尺寸居中。 */
function computePosition(
  anchor: DOMRect,
  layer: DOMRect | { width: number; height: number },
  placement: TooltipPlacement,
): { x: number; y: number } {
  const gap = 8;
  const layerWidth = layer.width;
  const layerHeight = layer.height;
  switch (placement) {
    case "bottom":
      return {
        x: anchor.left + anchor.width / 2 - layerWidth / 2,
        y: anchor.bottom + gap,
      };
    case "left":
      return {
        x: anchor.left - layerWidth - gap,
        y: anchor.top + anchor.height / 2 - layerHeight / 2,
      };
    case "right":
      return {
        x: anchor.right + gap,
        y: anchor.top + anchor.height / 2 - layerHeight / 2,
      };
    case "top":
    default:
      return {
        x: anchor.left + anchor.width / 2 - layerWidth / 2,
        y: anchor.top - layerHeight - gap,
      };
  }
}

/**
 * 悬停 / 聚焦提示。
 *
 * @example
 * <Tooltip content="保存并返回书架"><Button>保存</Button></Tooltip>
 */
export const Tooltip: Component<TooltipProps> = (props) => {
  usePrimitivesStyle();

  const [local, rest] = splitProps(props, [
    "content",
    "placement",
    "delay",
    "disabled",
    "class",
    "children",
  ]);

  const [open, setOpen] = createSignal(false);
  const [visible, setVisible] = createSignal(false);

  let wrapper: HTMLSpanElement | undefined;
  let bubble: HTMLDivElement | undefined;
  let timer: number | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };

  const show = (): void => {
    if (local.disabled || !local.content) return;
    clearTimer();
    // 延迟用留出「划过」的容错：用户快速掠过时不该留下任何痕迹。
    timer = window.setTimeout(() => {
      setOpen(true);
      // 等元素进入 DOM 拿到尺寸后再定位，否则首帧会闪到左上角。
      queueMicrotask(() => {
        if (!wrapper || !bubble) return;
        const position = computePosition(
          wrapper.getBoundingClientRect(),
          bubble.getBoundingClientRect(),
          local.placement ?? "top",
        );
        bubble.style.left = position.x + "px";
        bubble.style.top = position.y + "px";
        setVisible(true);
      });
    }, local.delay ?? 300);
  };

  const hide = (): void => {
    clearTimer();
    setVisible(false);
    setOpen(false);
  };

  // 组件卸载时清掉未触发的定时器，避免在已卸载的组件上 setState。
  onCleanup(() => {
    clearTimer();
    document.removeEventListener("scroll", hide, true);
  });

  // 打开期间才挂滚动监听：气泡用 fixed 定位，页面一滚就会与触发元素错位，
  // 与其做实时跟随（会造成每帧布局读取），不如直接收起。
  createEffect(() => {
    if (open()) {
      document.addEventListener("scroll", hide, true);
    } else {
      document.removeEventListener("scroll", hide, true);
    }
  });

  // 降级环境下不做位移，只保留透明度变化（5.6）。
  const transitionStyle = (): JSX.CSSProperties => {
    const policy = motionPolicy({ duration: 120 });
    return {
      "transition-duration": policy.duration + "ms",
      transform: policy.allowTransform
        ? visible()
          ? "translateY(0)"
          : local.placement === "bottom"
            ? "translateY(-2px)"
            : "translateY(2px)"
        : "none",
    };
  };

  const describedBy = (): string | undefined => {
    if (local.disabled || !local.content) return undefined;
    return open() ? "yh-tooltip-popup" : undefined;
  };

  return (
    <span
      {...rest}
      ref={wrapper}
      class={cx("yh-tooltip-anchor", local.class)}
      style={{ display: "inline-flex" }}
      aria-describedby={describedBy()}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocusIn={show}
      onFocusOut={hide}
      onKeyDown={(event) => {
        // Esc 收起提示：与系统的「关闭浮层」习惯一致，
        // 也避免读屏用户被一段不请自来的描述困住。
        if (event.key === "Escape") hide();
      }}
    >
      {local.children}
      <Show when={open() && local.content}>
        <div
          ref={bubble}
          id="yh-tooltip-popup"
          role="tooltip"
          class="yh-layer yh-tooltip"
          data-state={visible() ? "open" : "closed"}
          data-placement={local.placement ?? "top"}
          style={{ position: "fixed", ...transitionStyle() }}
        >
          {local.content}
        </div>
      </Show>
    </span>
  );
};
