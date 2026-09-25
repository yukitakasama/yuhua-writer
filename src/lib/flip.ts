/**
 * FLIP 让位动效。
 *
 * ## FLIP 是什么、为什么用它
 *
 * FLIP = First（记录旧位置）→ Last（改完 DOM 读新位置）
 * → Invert（用 transform 把元素"瞬移"回旧位置，此时不动画）
 * → Play（把 transform 归零，浏览器自己做补间）。
 *
 * 直接动画 `top` / `margin` 会每帧触发重排（layout），
 * 列表越长越卡。FLIP 把整个过程压成一次 `transform` 过渡，
 * 完全满足计划书 5.4 节「只动画 transform 与 opacity」的铁律。
 *
 * ## 关键实现细节
 *
 * - **必须读取两次布局**（改前一次、改后一次）。浏览器会把两次读数
 *   之间的写操作合并刷新，因此不会产生"布局抖动"。
 * - **动画结束必须移除 `will-change`**：计划书 5.4 节明确要求。
 *   长期挂着 will-change 会让浏览器一直保留合成层，白占显存。
 * - **尊重 reduced-motion**：系统开了减弱动效就直接跳过，
 *   连 transform 都不设，避免闪一下。
 */

import { PANEL_TRANSITION_MS } from "@/app/layout-store";

/** 一次快照：元素 ID 到其视口矩形上边缘的映射。 */
export type PositionSnapshot = Map<string, DOMRect>;

/** FLIP 让位使用的时长。与前文「落位 spring-snappy」对应。 */
export const FLIP_DURATION_MS = 180;

/** 采集当前所有带 `data-flip-id` 元素的位置。 */
export function capturePositions(root: ParentNode = document): PositionSnapshot {
  const map: PositionSnapshot = new Map();
  root.querySelectorAll<HTMLElement>("[data-flip-id]").forEach((el) => {
    const id = el.dataset["flipId"];
    if (id) map.set(id, el.getBoundingClientRect());
  });
  return map;
}

/**
 * 播放让位动效。
 *
 * `before` 是结构变化**之前**采集的位置。函数会对比当前实际位置，
 * 把发生位移的元素先瞬移回旧位置，再放手让它们滑到新位置。
 *
 * 返回实际开始动画的元素数量：调用方据此判断是否需要等待，
 * 也为性能监控（计划书 5.4 节"同时动画元素不超过 30"）提供数据。
 */
export function playFlip(before: PositionSnapshot, root: ParentNode = document, durationMs = FLIP_DURATION_MS): number {
  if (prefersReducedMotion()) return 0;

  let animated = 0;
  root.querySelectorAll<HTMLElement>("[data-flip-id]").forEach((el) => {
    const id = el.dataset["flipId"];
    if (!id) return;
    const prev = before.get(id);
    if (!prev) return;

    const now = el.getBoundingClientRect();
    const dy = prev.top - now.top;
    const dx = prev.left - now.left;

    // 位移不足 1px 的不处理：亚像素抖动做动画只会让文字发虚
    if (Math.abs(dy) < 1 && Math.abs(dx) < 1) return;

    el.style.willChange = "transform";
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;

    // 强制一次样式计算，让"瞬移回旧位置"这一帧落地。
    // 不读这行的话浏览器会把设置与清除合并，动画就不会发生。
    void el.offsetHeight;

    el.style.transition = `transform ${durationMs}ms cubic-bezier(0.2, 0, 0, 1)`;
    el.style.transform = "";

    animated += 1;
    const cleanup = (): void => {
      el.style.willChange = "";
      el.style.transition = "";
      el.removeEventListener("transitionend", cleanup);
    };
    el.addEventListener("transitionend", cleanup);
    // 兜底：transitionend 在某些情况下（元素被移除、标签页失焦）不触发
    window.setTimeout(cleanup, durationMs + PANEL_TRANSITION_MS);
  });

  return animated;
}

/** 系统是否要求减弱动效。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 在 DOM 变化前后跑一段逻辑并自动播放 FLIP。
 *
 * 把「采样 → 改结构 → 播放」三步包成一个函数，是为了防止
 * 某个调用点忘了采样，或者采样与改动之间插入了别的 DOM 操作
 * 导致快照过期。
 */
export function withFlip(mutate: () => void, root: ParentNode = document): number {
  const before = capturePositions(root);
  mutate();
  return playFlip(before, root);
}
