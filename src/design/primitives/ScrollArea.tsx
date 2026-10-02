/**
 * 滚动区域。
 *
 * 为什么不直接用 overflow:auto：
 * 1. 需要一个稳定的「视口」hook，供虚拟滚动、自动滚到当前章节、
 *    以及「长列表滚动时暂停非可视区入场动效」（5.4 补充规则）使用。
 * 2. WebView2 默认滚动条无法跟随设计令牌，需要在同一处统一覆写样式，
 *    避免每个用到滚动的地方各写一遍。
 *
 * 刻意不自己实现滚动条滑块：自绘滑块需要在滚动时读取 scrollHeight 并写入 transform，
 * 在长章节列表上是每帧一次的布局读取，远不如原生合成层滚动流畅（性能铁律第二条）。
 */

import { createSignal, splitProps, type Component, type JSX } from "solid-js";
import { cx, usePrimitivesStyle } from "./styles";

/** 滚动方向。 */
export type ScrollOrientation = "vertical" | "horizontal" | "both";

/** 滚动事件携带的信息。 */
export interface ScrollInfo {
  /** 当前滚动位置。 */
  scrollTop: number;
  scrollLeft: number;
  /** 内容总高度 / 宽度。 */
  scrollHeight: number;
  scrollWidth: number;
  /** 视口尺寸。 */
  clientHeight: number;
  clientWidth: number;
  /** 是否已经滚到底部（用于「加载更多」与「回到最新」按钮的显隐）。 */
  atBottom: boolean;
}

/** {@link ScrollArea} 的 props。 */
export interface ScrollAreaProps {
  /** 滚动方向，默认 vertical。 */
  orientation?: ScrollOrientation;
  /** 滚动回调。 */
  onScroll?: (info: ScrollInfo) => void;
  /** 视口元素挂载后的回调，调用方可以借此拿到 DOM 做测量。 */
  viewportRef?: (element: HTMLDivElement) => void;
  /** 调用方自定义类名，透传到根元素。 */
  class?: string;
  /** 视口元素的额外类名。 */
  viewportClass?: string;
  /** 内容。 */
  children?: JSX.Element;
}

/**
 * 滚动容器。
 *
 * @example
 * <ScrollArea onScroll={(info) => loadMore(info.atBottom)}>{chapters()}</ScrollArea>
 */
export const ScrollArea: Component<ScrollAreaProps> = (props) => {
  usePrimitivesStyle();

  const [local] = splitProps(props, [
    "orientation",
    "onScroll",
    "viewportRef",
    "class",
    "viewportClass",
    "children",
  ]);

  const [info, setInfo] = createSignal<ScrollInfo | null>(null);

  const handleScroll = (event: Event): void => {
    const element = event.currentTarget as HTMLDivElement;
    const next: ScrollInfo = {
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      // 留 1px 容差：高分辨率屏上 scrollTop 常是小数，严格相等会永远判不到底。
      atBottom:
        element.scrollHeight - element.scrollTop - element.clientHeight <= 1,
    };
    setInfo(next);
    local.onScroll?.(next);
  };

  return (
    <div class={cx("yh-scroll-area", local.class)}>
      <div
        ref={(element) => {
          local.viewportRef?.(element);
        }}
        class={cx("yh-scroll-area__viewport", local.viewportClass)}
        data-orientation={local.orientation ?? "vertical"}
        // tabindex=0 让键盘用户可以聚焦滚动区并用上下键滚动。
        // 不加的话，内容比视口高时键盘用户完全无法滚动它（屏幕阅读器用户尤其受影响）。
        tabindex={0}
        role="region"
        aria-label="可滚动区域"
        onScroll={handleScroll}
      >
        {local.children}
      </div>
      {/* 供调用方与测试读取最近一次的滚动状态；不渲染任何可见内容。 */}
      <span
        class="yh-visually-hidden"
        data-scroll-state={info()?.atBottom ? "bottom" : "not-bottom"}
      />
    </div>
  );
};

/** 把滚动容器滚到底部。供「跳到最新」使用。 */
export function scrollToBottom(element: HTMLElement): void {
  element.scrollTop = element.scrollHeight;
}
