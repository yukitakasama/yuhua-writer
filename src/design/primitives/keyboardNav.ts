/**
 * 键盘导航辅助。
 *
 * 为什么不用 roving tabindex 的完整实现：羽毛写作的列表（章节树、检索结果、菜单）
 * 规模都在千级以内，且大部分是虚拟滚动之外的固定项。这里采用「按 DOM 顺序取可聚焦项」
 * 的轻量方案，配合 \`tabindex\` 管理，行为可预测、代码量小，也不用维护额外索引状态。
 *
 * 所有函数都是纯函数，方便单独测试；组件负责把返回值接到 DOM 上。
 */

import { getFocusableElements } from "./focusTrap";

/** 方向键构成的线性导航轴。 */
export type NavigationAxis = "vertical" | "horizontal" | "both";

/** 列表导航的选项。 */
export interface ListNavigationOptions {
  /** 导航轴。垂直列表用 vertical，水平标签栏用 horizontal。 */
  axis?: NavigationAxis;
  /** 是否在首尾之间循环。菜单与 Tab 列表通常为 true，树形列表为 false。 */
  loop?: boolean;
  /** 导航发生后是否把焦点移过去。默认 true；预览高亮式导航可设为 false。 */
  moveFocus?: boolean;
}

/**
 * 判断某个按键是否属于给定轴上的「下一个」。返回 1 / -1 / 0。
 *
 * Home / End 单独用 {@link isEdgeKey} 判断，因为它们的目标是列表两端而非相对移动。
 */
export function axisDelta(key: string, axis: NavigationAxis = "vertical"): -1 | 0 | 1 {
  const vertical = axis === "vertical" || axis === "both";
  const horizontal = axis === "horizontal" || axis === "both";
  if (key === "ArrowDown" && vertical) return 1;
  if (key === "ArrowUp" && vertical) return -1;
  if (key === "ArrowRight" && horizontal) return 1;
  if (key === "ArrowLeft" && horizontal) return -1;
  return 0;
}

/** Home / End 判断。它们只在线性列表中有意义。 */
export function isEdgeKey(key: string): key is "Home" | "End" {
  return key === "Home" || key === "End";
}

/**
 * 计算下一个应当获得焦点的元素。
 *
 * @param items 当前可导航的元素序列（通常来自 {@link getFocusableElements}）。
 * @param current 当前拥有焦点的元素。
 * @param key 按下的按键。
 * @param options 导航选项。
 * @returns 下一个元素；按键与轴不匹配、或已在边界且不允许循环时返回 null。
 */
export function nextIndexFor(
  items: readonly HTMLElement[],
  current: HTMLElement | null,
  key: string,
  options: ListNavigationOptions = {},
): number | null {
  const { axis = "vertical", loop = false } = options;
  if (items.length === 0) return null;

  if (isEdgeKey(key)) {
    return key === "Home" ? 0 : items.length - 1;
  }

  const delta = axisDelta(key, axis);
  if (delta === 0) return null;

  const currentIndex = current ? items.indexOf(current) : -1;
  // 当前焦点不在列表内（例如列表刚渲染、或焦点在搜索框上）：
  // 让「下一个」按键从列表外侧进入列表，而不是原地不动，否则键盘用户会被卡住。
  if (currentIndex < 0) return delta > 0 ? 0 : items.length - 1;

  const candidate = currentIndex + delta;
  if (candidate < 0 || candidate >= items.length) {
    return loop ? (candidate + items.length) % items.length : null;
  }
  return candidate;
}

/**
 * 处理一次列表导航按键。
 *
 * @returns 若按键被消费（应当阻止默认滚动行为）返回 true。
 */
export function handleListNavigation(
  event: KeyboardEvent,
  items: readonly HTMLElement[],
  options: ListNavigationOptions = {},
): boolean {
  const { moveFocus = true } = options;
  const index = nextIndexFor(items, document.activeElement as HTMLElement | null, event.key, options);
  if (index === null) return false;
  if (moveFocus) items[index]?.focus();
  return true;
}

/**
 * 为容器内的元素排布 roving tabindex。
 *
 * 键盘可用性里最容易踩的坑：列表里每个可点击项都保留在 Tab 序里，
 * 于是「越过一个 20 项的章节列表」要按 21 次 Tab。roving tabindex 只让
 * 当前项进入 Tab 序，整张列表在 Tab 序里只占一格，再配合方向键内部移动。
 *
 * @param container 列表容器。
 * @param active 当前应保留在 Tab 序中的元素；不在容器内时退化为第一个元素。
 */
export function applyRovingTabindex(container: HTMLElement, active: HTMLElement | null): HTMLElement[] {
  const items = getFocusableElements(container);
  if (items.length === 0) return items;
  const target = active && items.includes(active) ? active : (items[0] as HTMLElement);
  for (const item of items) {
    item.setAttribute("tabindex", item === target ? "0" : "-1");
  }
  return items;
}
