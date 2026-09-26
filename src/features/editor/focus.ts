/**
 * 专注模式（T4.10）。
 *
 * ## 它到底做什么
 *
 * 计划书 5.4 节的定义是「**只留正文，其余全部收起**」。
 * 具体来说三件事：
 *
 * 1. 两侧栏折叠（复用 layout-store 的折叠，不是另一套状态）
 * 2. 工具栏收起（但**不是消失** —— 鼠标移到屏幕顶部要能唤出来，
 *    否则作者没法退出专注模式）
 * 3. 正文区加宽，行距放松一档
 *
 * ## 为什么"当前段高亮、其余变淡"没有做
 *
 * 那是很多写作软件的做法。但它与本作的排版原则冲突：
 * 计划书 5.1 节要求"正文对比度 14.6:1 长时间阅读不刺眼"，
 * 而把非当前段降对比度会让整屏 90% 的正文长期处于低对比状态 ——
 * 对需要**回看前文找线索**的小说作者来说这是净损失。
 *
 * 因此这里不做逐段变暗，只做"去掉一切不是正文的东西"。
 */

import { createSignal } from "solid-js";

import { layout, setView } from "../../app/layout-store";

/** 专注模式是否开启。 */
const [focusMode, setFocusMode] = createSignal(false);

export { focusMode };

/**
 * 进入专注模式之前保存的布局。
 *
 * 退出时要**精确还原**作者原来的布局：他可能本来就折叠了左栏、
 * 把右栏拉得很宽。直接套用"默认布局"会把这些偏好抹掉。
 */
interface SavedLayout {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  view: "library" | "workspace";
}

let saved: SavedLayout | null = null;

/** 切换专注模式。 */
export function toggleFocusMode(): void {
  if (focusMode()) exitFocusMode();
  else enterFocusMode();
}

/** 进入专注模式。 */
export function enterFocusMode(): void {
  if (focusMode()) return;
  // 书架页没有"正文"，进入专注模式没有意义
  if (layout.view !== "workspace") return;
  saved = {
    leftCollapsed: layout.leftCollapsed,
    rightCollapsed: layout.rightCollapsed,
    view: layout.view,
  };
  setFocusMode(true);
  layout.leftCollapsed = true;
  layout.rightCollapsed = true;
}

/** 退出专注模式并还原布局。 */
export function exitFocusMode(): void {
  if (!focusMode()) return;
  setFocusMode(false);
  if (saved) {
    layout.leftCollapsed = saved.leftCollapsed;
    layout.rightCollapsed = saved.rightCollapsed;
    setView(saved.view);
    saved = null;
  }
}

/**
 * 专注模式下正文区的额外 class。
 *
 * 组件把它加到编辑区容器上，具体样式在 app.css
 * （行距、宽度这些是排版决策，属于 CSS）。
 */
export function focusModeClass(): string {
  return focusMode() ? "editor--focus" : "";
}

/** 重置（测试用）。 */
export function __resetFocusMode(): void {
  setFocusMode(false);
  saved = null;
}
