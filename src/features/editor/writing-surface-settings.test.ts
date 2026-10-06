/**
 * 护栏：设置里的排版与专注模式，必须真的落到**写作台**上。
 *
 * ## 为什么需要这条测试
 *
 * 起因是审查时发现两件「看着能用、其实没接上」的事：
 *
 * 1. 「正文宽度」滑块改的是 `--measure-body`，而这个令牌**只有设置页的
 *    预览块**在用；写作台自己钉死 `max-width: 720px`。段间距同理，
 *    编辑器的段落间距写死在主题里。于是滑块拖动时预览变宽变扁，
 *    真正写字的那一栏一动不动 —— 「即时生效」是假的。
 * 2. 专注模式往 DOM 写了一个 `data-focus-mode`，四个样式文件里
 *    **没有任何规则读它**，计划书 5.4 的「工具栏收起」只存在于注释里。
 *
 * 这两类的共同点是：写的一方和读的一方分属两个文件，类型检查、lint、
 * 组件测试各自都看不出问题 —— 令牌有值、属性有写、渲染也不报错，
 * 只有人眼盯着真机才会发现「改了没用」。所以把它变成可执行的规则：
 * **写作台必须能在样式里被追溯到消费了这些设置**。
 *
 * ## 为什么扫源码而不是量计算样式
 *
 * jsdom 不做 CSS 级联与布局计算，`getComputedStyle` 在这类规则上不可信
 * （它会给回初始值，无论样式表里写了什么）。测渲染结果只会得到一个恒真
 * 或恒假的读数，而真正要钉的是「样式表里存在这条规则」这件事本身。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  layout,
  resetLayout,
  setLeftCollapsed,
  setRightCollapsed,
  setView,
} from "@/app/layout-store";
import {
  enterFocusMode,
  exitFocusMode,
  focusMode,
  toggleFocusMode,
  __resetFocusMode,
} from "./focus";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");

const appCss = readFileSync(resolve(root, "src/styles/app.css"), "utf8");
const editorTheme = readFileSync(
  resolve(root, "src/features/editor/theme.ts"),
  "utf8",
);

/** 去掉空白差异，免得断言被换行与缩进带偏。 */
function flatten(source: string): string {
  return source.replace(/\s+/g, " ");
}

/** 取某个选择器块的正文（简单的一对大括号，够用）。 */
function blockOf(source: string, selector: string): string {
  const flat = flatten(source);
  const at = flat.indexOf(selector);
  if (at < 0) return "";
  // CSS 是 `选择器 {`，TS 对象是 `"选择器": {` —— 跳过冒号再取左括号
  const start = flat.indexOf("{", at + selector.length);
  const end = flat.indexOf("}", start);
  return start < 0 || end < 0 ? "" : flat.slice(start + 1, end);
}

beforeEach(() => {
  __resetFocusMode();
  resetLayout();
  setView("workspace");
  setLeftCollapsed(false);
  setRightCollapsed(false);
});

describe("排版设置要落到写作台", () => {
  it("写作台的栏宽跟着 --measure-body，不再钉死像素", () => {
    const page = blockOf(appCss, ".editor__page");
    expect(page).toContain("max-width: var(--measure-body)");
    expect(page).not.toMatch(/max-width: \d+px/);
  });

  it("专注模式加宽正文时，不压低用户选的更宽栏宽", () => {
    const focusPage = blockOf(appCss, ".editor--focus .editor__page");
    expect(focusPage).toContain("max(860px, var(--measure-body))");
  });

  it("段落间距跟着 --gap-paragraph", () => {
    const paragraph = blockOf(editorTheme, '".cm-paragraph"');
    expect(paragraph).toContain('marginBottom: "var(--gap-paragraph)"');
  });

  it("专注模式的行距是「不低于 2」，不是盖掉用户行距", () => {
    const focusContent = blockOf(appCss, ".editor--focus .cm-content");
    expect(focusContent).toContain("max(2, var(--lh-read))");
  });
});

describe("专注模式的标记要有人读", () => {
  it("样式里确实存在消费 [data-focus-mode] 的规则，而且收起的是工具栏", () => {
    const flat = flatten(appCss);
    expect(flat).toMatch(/html\[data-focus-mode="on"\] \.toolbar/);
  });

  it("进入与退出只切换 <html> 上的标记", () => {
    expect(document.documentElement.hasAttribute("data-focus-mode")).toBe(
      false,
    );

    console.log("PROBE view=", layout.view, "left=", layout.leftCollapsed);
    enterFocusMode();
    console.log(
      "PROBE2 focusMode=",
      focusMode(),
      "attr=",
      document.documentElement.getAttribute("data-focus-mode"),
      "left=",
      layout.leftCollapsed,
    );
    expect(focusMode()).toBe(true);
    expect(document.documentElement.getAttribute("data-focus-mode")).toBe("on");
    // 两侧栏折叠（复用 layout-store，不是另一套状态）
    expect(layout.leftCollapsed).toBe(true);
    expect(layout.rightCollapsed).toBe(true);

    exitFocusMode();
    expect(focusMode()).toBe(false);
    expect(document.documentElement.hasAttribute("data-focus-mode")).toBe(
      false,
    );
  });

  it("退出后精确还原进入前的布局", () => {
    // 作者本来只折叠了左栏：进入时不能被「切换」反着展开，退出时要回到原样
    setLeftCollapsed(true);
    setRightCollapsed(false);

    toggleFocusMode();
    expect(layout.rightCollapsed).toBe(true);

    toggleFocusMode();
    expect(layout.leftCollapsed).toBe(true);
    expect(layout.rightCollapsed).toBe(false);
  });

  it("书架页没有正文，进不去专注模式，也不许留下标记", () => {
    setView("library");
    enterFocusMode();
    expect(focusMode()).toBe(false);
    expect(document.documentElement.hasAttribute("data-focus-mode")).toBe(
      false,
    );
  });
});
