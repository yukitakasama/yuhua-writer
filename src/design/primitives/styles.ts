/**
 * 原语共享样式。
 *
 * 为什么不用 CSS Modules / 运行时 CSS-in-JS：
 * 1. 计划书 5.4 要求「只动画 transform 与 opacity」，样式集中在一个模板字符串里，
 *    code review 时能一眼扫出有没有偷偷动画 width / box-shadow。
 * 2. 全部颜色、间距、时长都走 tokens.css 变量，主题切换只需换变量值，
 *    组件层零改动（5.5 节的「主题切换：全局颜色过渡」依赖这一点）。
 * 3. 零外链、零字体、零图片。
 *
 * 注意：组件不做样式隔离的 hash 处理，类名统一加 yh- 前缀避免与调用方冲突。
 */

import { onMount } from "solid-js";

/** 样式标签的 id。多份实例只注入一次，避免重复插入大量文本节点。 */
const STYLE_ID = "yh-primitives-style";

export const PRIMITIVES_CSS = String.raw`
/* ---- 基础字体继承（只作用于原语自身，不污染全局 body） ----
   正文用 --font-body（衬线），但界面控件必须用 --font-ui，
   否则按钮与输入框里的中文会变成正文衬线体，与周围 UI 割裂。 */
.yh-btn,
.yh-icon-btn,
.yh-input,
.yh-textarea,
.yh-select,
.yh-checkbox,
.yh-switch,
.yh-tab,
.yh-menu-item,
.yh-toast { font-family: var(--font-ui, system-ui, sans-serif); }

/* ---- 焦点环 ----
   计划书 5.6：焦点环必须可见且高对比。用 :focus-visible 而非 :focus，
   鼠标点击不产生焦点环，键盘用户始终能看到。
   outline 与 box-shadow 同时给：Windows 高对比度模式会丢弃 box-shadow，
   而部分浏览器在不透明背景上 outline 会被裁切，两者互为兜底。 */
:where(.yh-btn, .yh-icon-btn, .yh-input, .yh-textarea, .yh-select, .yh-checkbox, .yh-switch,
  .yh-tab, .yh-menu-item, .yh-toast__action):focus-visible {
  outline: 2px solid var(--c-accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-accent) 35%, transparent);
}

/* ---- 按下回弹 ----
   计划书 5.5：按钮按下 scale(0.97) 回弹 80ms。只动 transform，符合 5.4 铁律。 */
.yh-pressable {
  transition:
    transform var(--d-instant, 80ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1)),
    background-color var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1)),
    border-color var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1)),
    color var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1));
}
.yh-pressable:active:not([disabled]):not([aria-disabled="true"]) { transform: scale(0.97); }
/* 不可用时不回弹：给出「按钮响应了」的错误反馈比没有反馈更糟。 */
.yh-pressable[disabled],
.yh-pressable[aria-disabled="true"] { cursor: not-allowed; }

/* ---- 按钮 ---- */
.yh-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2, 8px);
  border: 1px solid transparent;
  border-radius: var(--r-md, 6px);
  font-size: var(--fs-sm, 13px);
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  background: transparent;
  color: var(--c-text);
}
.yh-btn[disabled],
.yh-btn[aria-disabled="true"] { opacity: 0.45; }
.yh-btn--block { width: 100%; }
.yh-btn--sm { height: 26px; padding: 0 var(--sp-2, 8px); font-size: var(--fs-xs, 12px); border-radius: var(--r-sm, 4px); }
.yh-btn--md { height: 32px; padding: 0 var(--sp-3, 12px); }
.yh-btn--lg { height: 40px; padding: 0 var(--sp-4, 16px); font-size: var(--fs-base, 15px); border-radius: var(--r-lg, 10px); }

.yh-btn--primary { background: var(--c-accent); color: var(--c-bg); border-color: var(--c-accent); }
.yh-btn--primary:hover:not([disabled]):not([aria-disabled="true"]) { filter: brightness(1.06); }
.yh-btn--secondary { background: var(--c-surface); color: var(--c-text); border-color: var(--c-border); }
.yh-btn--secondary:hover:not([disabled]):not([aria-disabled="true"]) { border-color: var(--c-text-muted); }
.yh-btn--ghost { background: transparent; color: var(--c-text); }
.yh-btn--ghost:hover:not([disabled]):not([aria-disabled="true"]) { background: color-mix(in srgb, var(--c-text) 8%, transparent); }
.yh-btn--danger { background: var(--c-danger); color: var(--c-bg); border-color: var(--c-danger); }
.yh-btn--danger:hover:not([disabled]):not([aria-disabled="true"]) { filter: brightness(1.06); }

/* 加载转圈：纯 CSS 绘制，零外链零图标字体。 */
.yh-spinner {
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  border-radius: var(--r-full, 999px);
  animation: yh-spin 640ms linear infinite;
}
@keyframes yh-spin { to { transform: rotate(360deg); } }

/* ---- 图标按钮 ---- */
.yh-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--r-md, 6px);
  background: transparent;
  color: var(--c-text);
  cursor: pointer;
  padding: 0;
}
.yh-icon-btn:hover:not([disabled]):not([aria-disabled="true"]) { background: color-mix(in srgb, var(--c-text) 8%, transparent); }
/* 选中态除了背景还给 1px 描边：颜色不是唯一通道。 */
.yh-icon-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--c-accent) 18%, transparent);
  border-color: var(--c-accent);
  color: var(--c-accent);
}
.yh-icon-btn--sm { width: 24px; height: 24px; }
.yh-icon-btn--md { width: 30px; height: 30px; }
.yh-icon-btn--lg { width: 38px; height: 38px; }

/* ---- 表单域 ---- */
.yh-field { display: flex; flex-direction: column; gap: var(--sp-1, 4px); }
.yh-field__label { font-size: var(--fs-xs, 12px); color: var(--c-text-muted); }
.yh-field__hint { font-size: var(--fs-xs, 12px); color: var(--c-text-muted); }
.yh-field__error { font-size: var(--fs-xs, 12px); color: var(--c-danger); }

.yh-input,
.yh-textarea,
.yh-select {
  width: 100%;
  box-sizing: border-box;
  background: var(--c-surface);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md, 6px);
  font-size: var(--fs-sm, 13px);
  padding: 0 var(--sp-3, 12px);
  transition: border-color var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1));
}
.yh-input { height: 32px; }
.yh-textarea { padding: var(--sp-2, 8px) var(--sp-3, 12px); line-height: 1.6; resize: vertical; }
.yh-select { height: 32px; appearance: none; padding-right: var(--sp-6, 24px); }
.yh-input::placeholder,
.yh-textarea::placeholder { color: var(--c-text-muted); }
.yh-input:disabled,
.yh-textarea:disabled,
.yh-select:disabled { opacity: 0.45; cursor: not-allowed; }
/* 错误态不能只靠颜色（色觉障碍），额外加一条左侧色条做第二通道。 */
.yh-input--invalid,
.yh-textarea--invalid,
.yh-select--invalid { border-color: var(--c-danger); }
.yh-input--invalid { box-shadow: inset 3px 0 0 var(--c-danger); }

/* 下拉箭头：纯 CSS 边框绘制，避免图标字体与外链 SVG。 */
.yh-select__wrap { position: relative; display: block; }
.yh-select__arrow {
  position: absolute;
  right: var(--sp-3, 12px);
  top: 50%;
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--c-text-muted);
  transform: translateY(-50%);
  pointer-events: none;
}

/* ---- 复选框 ---- */
.yh-checkbox { display: inline-flex; align-items: center; gap: var(--sp-2, 8px); cursor: pointer; font-size: var(--fs-sm, 13px); }
.yh-checkbox[data-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.yh-checkbox__box {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  box-sizing: border-box;
  border: 1px solid var(--c-border);
  border-radius: var(--r-sm, 4px);
  background: var(--c-surface);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background-color var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1)),
    border-color var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1));
}
.yh-checkbox[data-checked="true"] .yh-checkbox__box { background: var(--c-accent); border-color: var(--c-accent); }
/* 勾：两条边框旋转画出，不引入 SVG 也不引入图标字体。 */
.yh-checkbox__tick {
  width: 4px;
  height: 8px;
  border: solid var(--c-bg);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg) translateY(-1px);
}
/* 不确定态用一条横杠，与「已选」在形状上明确区分（不是第三种颜色）。 */
.yh-checkbox__dash { width: 8px; height: 2px; background: var(--c-bg); }
.yh-checkbox[data-checked="false"] .yh-checkbox__tick,
.yh-checkbox[data-checked="false"] .yh-checkbox__dash,
.yh-checkbox[data-indeterminate="true"] .yh-checkbox__tick { display: none; }
.yh-checkbox[data-indeterminate="false"] .yh-checkbox__dash { display: none; }
.yh-checkbox--invalid .yh-checkbox__box { border-color: var(--c-danger); }

/* ---- 开关 ---- */
.yh-switch { display: inline-flex; align-items: center; gap: var(--sp-2, 8px); cursor: pointer; font-size: var(--fs-sm, 13px); }
.yh-switch[data-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.yh-switch__track {
  width: 34px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: var(--r-full, 999px);
  background: var(--c-border);
  position: relative;
  transition: background-color var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1));
}
.yh-switch[data-checked="true"] .yh-switch__track { background: var(--c-accent); }
.yh-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: var(--r-full, 999px);
  background: var(--c-bg);
  /* 只动 transform：left 属于 5.4 铁律里的禁用属性。 */
  transition: transform var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1));
}
.yh-switch[data-checked="true"] .yh-switch__thumb { transform: translateX(14px); }

/* ---- 弹层通用（Tooltip / Popover / Menu 共用的定位容器） ---- */
.yh-layer {
  position: absolute;
  z-index: 60;
  background: var(--c-surface);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md, 6px);
  box-shadow: 0 6px 24px rgb(0 0 0 / 12%);
  opacity: 1;
  transition:
    opacity var(--d-fast, 120ms) var(--e-decelerate, cubic-bezier(0, 0, 0, 1)),
    transform var(--d-fast, 120ms) var(--e-decelerate, cubic-bezier(0, 0, 0, 1));
}
.yh-layer[data-state="closed"] { opacity: 0; pointer-events: none; }
.yh-tooltip { padding: var(--sp-1, 4px) var(--sp-2, 8px); font-size: var(--fs-xs, 12px); max-width: 280px; z-index: 80; }
.yh-tooltip[data-state="closed"] { transform: translateY(-2px); }
.yh-popover { padding: var(--sp-3, 12px); min-width: 160px; }
.yh-menu { padding: var(--sp-1, 4px); min-width: 180px; }
.yh-menu__separator { height: 1px; margin: var(--sp-1, 4px) 0; background: var(--c-border); }
.yh-menu-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2, 8px);
  width: 100%;
  box-sizing: border-box;
  padding: var(--sp-2, 8px);
  border: 0;
  border-radius: var(--r-sm, 4px);
  background: transparent;
  color: var(--c-text);
  font-size: var(--fs-sm, 13px);
  text-align: left;
  cursor: pointer;
}
.yh-menu-item:hover:not([aria-disabled="true"]),
.yh-menu-item[data-active="true"] { background: color-mix(in srgb, var(--c-text) 8%, transparent); }
.yh-menu-item[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.yh-menu-item--danger { color: var(--c-danger); }

/* ---- 模态（Dialog / Drawer 共用的遮罩） ---- */
.yh-overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
  display: flex;
  z-index: 100;
  opacity: 1;
  transition: opacity var(--d-base, 180ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1));
}
.yh-overlay[data-state="closed"] { opacity: 0; }
.yh-dialog {
  margin: auto;
  min-width: 280px;
  max-width: min(560px, calc(100vw - var(--sp-8, 32px)));
  max-height: calc(100vh - var(--sp-8, 32px));
  display: flex;
  flex-direction: column;
  background: var(--c-surface);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg, 10px);
  box-shadow: 0 12px 40px rgb(0 0 0 / 18%);
  /* 计划书 5.5：打开 scale(0.96→1) + opacity 180ms；关闭 120ms 反向。 */
  transform: scale(1);
  transition:
    transform var(--d-base, 180ms) var(--e-decelerate, cubic-bezier(0, 0, 0, 1)),
    opacity var(--d-base, 180ms) var(--e-decelerate, cubic-bezier(0, 0, 0, 1));
}
.yh-dialog[data-state="closed"] {
  transform: scale(0.96);
  opacity: 0;
  transition-duration: var(--d-fast, 120ms);
  transition-timing-function: var(--e-accelerate, cubic-bezier(0.3, 0, 1, 1));
}
.yh-dialog__header { padding: var(--sp-4, 16px) var(--sp-4, 16px) 0; }
.yh-dialog__title { margin: 0; font-size: var(--fs-lg, 17px); font-family: var(--font-heading, serif); }
.yh-dialog__desc { margin: var(--sp-1, 4px) 0 0; font-size: var(--fs-xs, 12px); color: var(--c-text-muted); }
.yh-dialog__body { padding: var(--sp-3, 12px) var(--sp-4, 16px); overflow: auto; font-size: var(--fs-sm, 13px); }
.yh-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2, 8px);
  padding: 0 var(--sp-4, 16px) var(--sp-4, 16px);
}

.yh-drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: var(--yh-drawer-size, 320px);
  max-width: 100vw;
  background: var(--c-surface);
  color: var(--c-text);
  box-shadow: 0 0 40px rgb(0 0 0 / 18%);
  transition:
    transform var(--d-slow, 240ms) var(--e-decelerate, cubic-bezier(0, 0, 0, 1)),
    opacity var(--d-slow, 240ms) var(--e-decelerate, cubic-bezier(0, 0, 0, 1));
}
.yh-drawer--right { right: 0; }
.yh-drawer--left { left: 0; }
.yh-drawer--right[data-state="closed"] { transform: translateX(100%); }
.yh-drawer--left[data-state="closed"] { transform: translateX(-100%); }
.yh-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2, 8px);
  padding: var(--sp-3, 12px) var(--sp-4, 16px);
  border-bottom: 1px solid var(--c-border);
}
.yh-drawer__title { margin: 0; font-size: var(--fs-base, 15px); font-family: var(--font-heading, serif); }
.yh-drawer__body { flex: 1 1 auto; overflow: auto; padding: var(--sp-4, 16px); }

/* ---- Toast ---- */
.yh-toast-region {
  position: fixed;
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2, 8px);
  pointer-events: none;
  max-width: min(360px, calc(100vw - var(--sp-8, 32px)));
}
.yh-toast-region--bottom-right { right: var(--sp-4, 16px); bottom: var(--sp-4, 16px); align-items: flex-end; }
.yh-toast-region--bottom-left { left: var(--sp-4, 16px); bottom: var(--sp-4, 16px); align-items: flex-start; }
.yh-toast-region--top-right { right: var(--sp-4, 16px); top: var(--sp-4, 16px); align-items: flex-end; }
.yh-toast-region--top-left { left: var(--sp-4, 16px); top: var(--sp-4, 16px); align-items: flex-start; }

.yh-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2, 8px);
  min-width: 200px;
  box-sizing: border-box;
  padding: var(--sp-2, 8px) var(--sp-3, 12px);
  background: var(--c-surface);
  color: var(--c-text);
  border: 1px solid var(--c-border);
  border-left: 3px solid var(--c-text-muted);
  border-radius: var(--r-md, 6px);
  box-shadow: 0 8px 28px rgb(0 0 0 / 16%);
  font-size: var(--fs-sm, 13px);
  /* 计划书 5.5：Toast 进出 translateY + opacity 180ms。
     用带轻微过冲的 cubic-bezier 近似「弹簧」，不引入 WAAPI 依赖，
     避免与 motion/ 代理的实现产生耦合。 */
  transform: translateY(0);
  opacity: 1;
  transition:
    transform var(--d-base, 180ms) cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity var(--d-base, 180ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1));
}
.yh-toast[data-state="closed"] { transform: translateY(8px); opacity: 0; }
.yh-toast--success { border-left-color: var(--c-accent); }
.yh-toast--error { border-left-color: var(--c-danger); }
.yh-toast--warning { border-left-color: var(--c-text); }
.yh-toast__body { flex: 1 1 auto; min-width: 0; }
.yh-toast__title { font-weight: 600; }
.yh-toast__desc { color: var(--c-text-muted); font-size: var(--fs-xs, 12px); }
.yh-toast__action {
  border: 0;
  background: transparent;
  color: var(--c-accent);
  font-size: var(--fs-xs, 12px);
  cursor: pointer;
  padding: 0 var(--sp-1, 4px);
  border-radius: var(--r-sm, 4px);
}

/* ---- Tabs ---- */
.yh-tabs { display: flex; flex-direction: column; gap: var(--sp-2, 8px); }
.yh-tabs__list { display: flex; gap: var(--sp-1, 4px); border-bottom: 1px solid var(--c-border); }
.yh-tab {
  position: relative;
  border: 0;
  background: transparent;
  color: var(--c-text-muted);
  font-size: var(--fs-sm, 13px);
  padding: var(--sp-2, 8px) var(--sp-3, 12px);
  cursor: pointer;
  border-radius: var(--r-sm, 4px) var(--r-sm, 4px) 0 0;
  transition:
    color var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1)),
    background-color var(--d-fast, 120ms) var(--e-standard, cubic-bezier(0.2, 0, 0, 1));
}
.yh-tab[aria-selected="true"] { color: var(--c-text); }
/* 选中态除颜色外加 2px 下划线：颜色不是唯一通道，且它不动画宽度（5.4 铁律）。 */
.yh-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--c-accent);
}
.yh-tab[disabled] { opacity: 0.45; cursor: not-allowed; }

/* ---- ScrollArea ---- */
.yh-scroll-area { position: relative; min-height: 0; }
.yh-scroll-area__viewport { overflow: auto; height: 100%; }
.yh-scroll-area__viewport[data-orientation="horizontal"] { overflow-y: hidden; overflow-x: auto; }
.yh-scroll-area__viewport[data-orientation="both"] { overflow: auto; }
/* 自绘滚动条：WebView2 默认滚动条无法跟随主题令牌，会破坏简洁观感。 */
.yh-scroll-area__viewport { scrollbar-width: thin; scrollbar-color: var(--c-border) transparent; }
.yh-scroll-area__viewport::-webkit-scrollbar { width: 10px; height: 10px; }
.yh-scroll-area__viewport::-webkit-scrollbar-thumb {
  background: var(--c-border);
  border-radius: var(--r-full, 999px);
  border: 3px solid transparent;
  background-clip: content-box;
}
.yh-scroll-area__viewport::-webkit-scrollbar-track { background: transparent; }

/* ---- 视觉隐藏（给屏幕阅读器保留文字，视觉上不可见但仍在可达性树里） ---- */
.yh-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ---- 减少动效降级（计划书 5.6） ----
   这是第二道保险：组件里读 prefersReducedMotion() 决定 JS 侧行为，
   CSS 侧再兜一次，因为部分宿主环境的媒体查询可能被自定义 CSS 覆盖。 */
@media (prefers-reduced-motion: reduce) {
  .yh-pressable:active:not([disabled]):not([aria-disabled="true"]) { transform: none; }
  .yh-switch__thumb { transition: transform 80ms linear; }
  .yh-dialog,
  .yh-dialog[data-state="closed"],
  .yh-drawer,
  .yh-overlay,
  .yh-toast,
  .yh-layer { transform: none; transition-duration: 80ms; transition-timing-function: linear; }
  .yh-toast[data-state="closed"] { transform: none; }
  .yh-spinner { animation-duration: 1600ms; }
}
`;

/** 样式标签的 id。幂等注入时用它做判重。 */
export { STYLE_ID };

/**
 * 注入原语样式（幂等）。
 *
 * 为什么不在模块顶层直接执行：模块顶层副作用在非浏览器环境（只用到 focusTrap
 * 这类纯函数的单元测试、未来的 SSR）会去碰 document。由组件显式调用更安全。
 */
export function ensurePrimitivesStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.setAttribute("data-yh-primitives", "");
  style.textContent = PRIMITIVES_CSS;
  document.head.appendChild(style);
}

/**
 * 在组件挂载时注入样式。
 *
 * 用 onMount 而不是 createEffect：注入是纯 DOM 副作用，只需要发生一次，
 * createEffect 会在依赖变化时反复跑，虽然 ensurePrimitivesStyle 是幂等的，
 * 但让每次渲染都过一遍 DOM 查询没有必要。
 */
export function usePrimitivesStyle(): void {
  onMount(() => {
    ensurePrimitivesStyle();
  });
}

/** 拼类名：过滤 falsy 并去重，保证测试断言时类名字符串稳定。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const token of part.split(/\s+/)) {
      if (!token || seen.has(token)) continue;
      seen.add(token);
      result.push(token);
    }
  }
  return result.join(" ");
}
