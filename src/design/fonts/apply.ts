/**
 * 把生效设置写进 CSS 变量（T9.3 / T9.5 / T1.12）。
 *
 * ## 为什么只写 CSS 变量，不写内联样式
 *
 * 计划书 5.4 的硬约束：**字体切换不得触发整页重排动画**。
 * 如果给每个文本节点写 `style.fontFamily`，一次切换会命中成百上千个节点，
 * 触发大面积样式重算，而组件上的 transition（按钮的背景色、折叠的列宽等）
 * 会跟着重播一遍 —— 看起来就是「整页抖了一下」。
 *
 * 改成只改 `:root` 上的几个自定义属性：样式重算是**一次**的，
 * 而且自定义属性不是可过渡属性，不会触发任何 transition。
 * 组件层照常读 `var(--font-body)` / `var(--fs-body)`，零改动。
 *
 * ## 与 tokens.css 的对应关系
 *
 * | 设置项 | CSS 变量 | tokens.css 是否有默认值 |
 * | --- | --- | --- |
 * | 正文/标题/界面字体族 | `--font-body` / `--font-heading` / `--font-ui` | 有 |
 * | 正文/标题/界面字号 | `--fs-body` / `--fs-heading` / `--fs-ui` | **无**（新增） |
 * | 行距 | `--lh-body` / `--lh-heading` / `--lh-ui` | 部分（`--lh-read` 等） |
 * | 段距 | `--gap-paragraph` | **无** |
 * | 正文宽度 | `--measure-body` | 有（720px） |
 *
 * 新增变量在 {@link APPEARANCE_CSS} 里给了出厂默认值，因此即使
 * tokens.css 将来删掉某个变量，界面也不会突然失去排版。
 */

import { fontFamilyById } from "./catalog";
import type { TypographySettings } from "@/app/appearance-store";

/**
 * 新增 CSS 变量的出厂默认值。
 *
 * 只在**变量未被设置过**时生效，所以它等价于一份「令牌兜底」，
 * 与 app.css 里 `@layer fallback` 的思路一致：真正的值由 JS 写入，
 * 这里保证首帧（JS 还没跑）也是可读的排版。
 */
export const APPEARANCE_CSS = `/* 外观设置写入的 CSS 变量。首帧兜底值，随后由 JS 覆盖。 */
:root {
  --fs-body: 17px;
  --fs-heading: 22px;
  --fs-ui: 15px;
  --lh-body: 1.9;
  --lh-heading: 1.4;
  --lh-ui: 1.6;
  --gap-paragraph: 1em;
}

/* 段距：正文段落之间。用 margin 而不是 padding，
   避免相邻段落的间距叠成两倍（相邻 margin 会合并，padding 不会）。 */
.yh-body p + p,
.yh-body .yh-paragraph + .yh-paragraph {
  margin-top: var(--gap-paragraph);
}

/* 先按变量换字体，再让浏览器自己去加载缺字。 */
.yh-body { font-family: var(--font-body); }
.yh-heading { font-family: var(--font-heading); }
`;

/** 一次性注入样式标签，返回标签元素。重复调用只注入一次。 */
function ensureStyle(): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById("yh-appearance-style");
  if (existing instanceof HTMLStyleElement) return existing;
  const style = document.createElement("style");
  style.id = "yh-appearance-style";
  style.textContent = APPEARANCE_CSS;
  document.head.appendChild(style);
  return style;
}

/** 把排版设置折算成 CSS 自定义属性表。纯函数，便于单测。 */
export function typographyVariables(typo: TypographySettings): Record<string, string> {
  return {
    "--font-body": fontFamilyById(typo.body.family).stack,
    "--font-heading": fontFamilyById(typo.heading.family).stack,
    "--font-ui": fontFamilyById(typo.ui.family).stack,

    "--fs-body": `${typo.body.size}px`,
    "--fs-heading": `${typo.heading.size}px`,
    "--fs-ui": `${typo.ui.size}px`,

    "--lh-body": String(typo.body.lineHeight),
    "--lh-heading": String(typo.heading.lineHeight),
    "--lh-ui": String(typo.ui.lineHeight),

    // 段距用 em：它跟着字号缩放，用户把正文调到 20px 时段距自动变大，
    // 不需要再单独调一次段距。
    "--gap-paragraph": `${typo.paragraphGap}em`,

    "--measure-body": `${typo.measure}px`,

    // 与 tokens.css 的 --lh-read 保持同步：正文阅读区读的是它
    "--lh-read": String(typo.body.lineHeight),
  };
}

/**
 * 把变量写到目标元素的 style 上。
 *
 * @param typo 生效排版
 * @param target 写入目标，默认 :root
 * @returns 实际写入的变量表（供测试断言）
 */
export function applyTypography(
  typo: TypographySettings,
  target: HTMLElement = document.documentElement,
): Record<string, string> {
  ensureStyle();
  const vars = typographyVariables(typo);
  for (const [name, value] of Object.entries(vars)) {
    target.style.setProperty(name, value);
  }
  return vars;
}

/**
 * 把主题写到 `html[data-theme]`。
 *
 * 与 tokens.css 的约定一致：
 * - `light` / `dark` 写入显式属性，覆盖 `prefers-color-scheme` 媒体查询；
 * - `system` **删除**属性，让媒体查询重新生效。
 *
 * 删除而不是写 `data-theme="system"`：tokens.css 里的选择器是
 * `:root:not([data-theme="light"])`，如果写上 `"system"`，
 * 它仍然满足 `not([data-theme="light"])`，看似也能工作 ——
 * 但一旦将来有人加一条 `[data-theme]` 的通用规则，就会踩雷。
 * 语义上「跟随系统」就是「没有显式选择」，删掉属性是最诚实的表达。
 *
 * @param theme 主题选择
 * @param target 目标元素，默认 html
 */
export function applyTheme(
  theme: "light" | "dark" | "system",
  target: HTMLElement = document.documentElement,
): void {
  if (theme === "system") target.removeAttribute("data-theme");
  else target.setAttribute("data-theme", theme);
}

/** 读出当前实际生效的主题（把 system 解析成真实的亮/暗）。 */
export function resolveTheme(theme: "light" | "dark" | "system"): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}
