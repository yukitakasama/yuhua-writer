/**
 * 窗口与面板布局状态（T5.1 的「窗口状态记忆」）。
 *
 * ## 记住什么、为什么
 *
 * 长篇小说作者一天要在同一本书上工作几小时，而且**每个人对三栏宽度的
 * 偏好完全不同**：有人把左栏拉满当大纲用，有人把右栏关掉只求沉浸。
 * 每次启动都回到默认值是一种持续的骚扰。
 *
 * 因此持久化三件事：两侧栏宽度、折叠状态、字数口径。
 * 都是纯 UI 偏好，放 localStorage；不进工作区 —— 它们不该跟着
 * 云盘同步到另一台不同分辨率的机器上。
 *
 * ## 宽度为什么要夹紧
 *
 * 存进去的宽度可能是上一台 4K 显示器上的 900px，换到 1366 笔记本上
 * 会直接把中间编辑区挤没。所以读取时一律夹到合法区间。
 */

import { createStore } from "solid-js/store";

import { isFiniteNumber, isPlainObject, readJson, writeJson } from "./persistent";

/** 左栏宽度的合法区间。下限保证 240px 下标题还能显示两个汉字加省略号。 */
export const LEFT_MIN = 200;
export const LEFT_MAX = 480;
/** 右栏宽度的合法区间。 */
export const RIGHT_MIN = 220;
export const RIGHT_MAX = 420;

/** 面板宽度过渡时长，与计划书 5.5 节「侧栏折叠 240ms」一致。 */
export const PANEL_TRANSITION_MS = 240;

/** 布局状态形状。 */
export interface LayoutState {
  /** 左栏宽度（px）。 */
  leftWidth: number;
  /** 右栏宽度（px）。 */
  rightWidth: number;
  /** 左栏是否折叠。 */
  leftCollapsed: boolean;
  /** 右栏是否折叠。 */
  rightCollapsed: boolean;
  /** 主视图：书架还是写作台。 */
  view: "library" | "workspace";
}

/** 默认布局。 */
export const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: 280,
  rightWidth: 300,
  leftCollapsed: false,
  rightCollapsed: false,
  view: "library",
};

/** localStorage 键名。 */
const STORAGE_KEY = "layout.v1";

/** 校验读回来的布局对象，任何字段不合法都退回默认值。 */
function validateLayout(value: unknown): value is Partial<LayoutState> {
  return isPlainObject(value);
}

/** 把读回来的（可能缺字段、可能越界的）布局补全并夹紧。 */
export function normalizeLayout(raw: Partial<LayoutState> | null): LayoutState {
  const pickBool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  const pickWidth = (v: unknown, min: number, max: number, fallback: number): number =>
    isFiniteNumber(v) ? Math.round(Math.min(max, Math.max(min, v))) : fallback;

  return {
    leftWidth: pickWidth(raw?.leftWidth, LEFT_MIN, LEFT_MAX, DEFAULT_LAYOUT.leftWidth),
    rightWidth: pickWidth(raw?.rightWidth, RIGHT_MIN, RIGHT_MAX, DEFAULT_LAYOUT.rightWidth),
    leftCollapsed: pickBool(raw?.leftCollapsed, DEFAULT_LAYOUT.leftCollapsed),
    rightCollapsed: pickBool(raw?.rightCollapsed, DEFAULT_LAYOUT.rightCollapsed),
    view: raw?.view === "workspace" || raw?.view === "library" ? raw.view : DEFAULT_LAYOUT.view,
  };
}

/** 从 localStorage 读取布局，读不到或坏了就用默认值。 */
export function loadLayout(): LayoutState {
  return normalizeLayout(readJson<Partial<LayoutState>>(STORAGE_KEY, {}, validateLayout));
}

const [layout, setLayout] = createStore<LayoutState>(loadLayout());

export { layout };

/** 写回 localStorage。每次改动都写：布局变更是低频动作，不需要防抖。 */
function persist(): void {
  writeJson(STORAGE_KEY, layout);
}

/** 设置左栏宽度（自动夹紧）。 */
export function setLeftWidth(width: number): void {
  setLayout("leftWidth", Math.round(Math.min(LEFT_MAX, Math.max(LEFT_MIN, width))));
  persist();
}

/** 设置右栏宽度（自动夹紧）。 */
export function setRightWidth(width: number): void {
  setLayout("rightWidth", Math.round(Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, width))));
  persist();
}

/** 切换左栏折叠。 */
export function toggleLeft(): void {
  setLayout("leftCollapsed", (v) => !v);
  persist();
}

/** 切换右栏折叠。 */
export function toggleRight(): void {
  setLayout("rightCollapsed", (v) => !v);
  persist();
}

/** 切换主视图。 */
export function setView(view: LayoutState["view"]): void {
  setLayout("view", view);
  persist();
}

/** 重置布局（「恢复默认窗口布局」用，测试也会用）。 */
export function resetLayout(): void {
  setLayout({ ...DEFAULT_LAYOUT });
  persist();
}

/**
 * 折叠时实际的列宽。
 *
 * 折叠动画的做法是不改 grid 列宽，而是**把列宽过渡到 0**
 * （见 app.css 的 `.shell--left-collapsed`）。
 * 这里给出的是过渡终点值，供需要精确计算的场景使用。
 */
export function effectiveLeftWidth(): number {
  return layout.leftCollapsed ? 0 : layout.leftWidth;
}

/** 右栏折叠时的实际列宽。 */
export function effectiveRightWidth(): number {
  return layout.rightCollapsed ? 0 : layout.rightWidth;
}
