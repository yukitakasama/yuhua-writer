/**
 * 图标库测试。
 *
 * 校验的是「规范被真正遵守」，而不是渲染结果长什么样：
 * 画布尺寸、线宽、端点、颜色继承、无障碍属性、以及零 emoji。
 * 这些一旦破防很难靠肉眼发现，但会直接违反计划书第 7 章。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { render } from "solid-js/web";
import {
  ALL_ICONS,
  ICON_COUNT,
  ICON_STROKE_WIDTH,
  ICON_VIEW_BOX,
  BrandIcon,
  FeatherIcon,
} from "./index";

const here = dirname(fileURLToPath(import.meta.url));

/** 图标组件的实际形状：接受属性、返回 JSX 元素。 */
type IconComponent = (props: Record<string, unknown>) => unknown;

/** 把组件渲染到游离容器里并返回 svg 元素。 */
function renderIcon(
  Component: IconComponent,
  props: Record<string, unknown> = {},
): SVGElement {
  const host = document.createElement("div");
  const dispose = render(() => Component(props) as unknown as Element, host);
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("图标未渲染出 svg 元素");
  // 保留 DOM 供断言，dispose 在测试结束后由 GC 处理
  void dispose;
  return svg as SVGElement;
}

describe("图标数量与清单", () => {
  it("至少 46 枚（计划书 7.3 要求约 46）", () => {
    expect(ICON_COUNT).toBeGreaterThanOrEqual(46);
  });

  it("清单中每项都是函数组件", () => {
    for (const [name, Component] of Object.entries(ALL_ICONS)) {
      expect(typeof Component, name).toBe("function");
    }
  });

  it("图标名称为 kebab-case", () => {
    for (const name of Object.keys(ALL_ICONS)) {
      expect(name, name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  it("覆盖了计划书 7.3 的关键图标", () => {
    const required = [
      "file",
      "folder",
      "book",
      "volume",
      "chapter",
      "plus",
      "minus",
      "close",
      "check",
      "arrow-up",
      "arrow-down",
      "arrow-left",
      "arrow-right",
      "collapse",
      "expand",
      "search",
      "replace",
      "undo",
      "redo",
      "bold",
      "italic",
      "heading",
      "quote",
      "list",
      "list-ordered",
      "divider",
      "code",
      "link",
      "image",
      "save",
      "settings",
      "moon",
      "sun",
      "fullscreen",
      "focus",
      "export",
      "trash",
      "more",
      "drag-handle",
      "word-count",
      "calendar",
      "character",
      "world",
      "panel-left",
      "panel-right",
      "feather",
      "flame",
      "goal",
      "clock",
      "format-docx",
      "format-pdf",
      "format-epub",
    ];
    for (const name of required) {
      expect(Object.keys(ALL_ICONS), name).toContain(name);
    }
  });

  it("品牌标记可经别名访问", () => {
    expect(BrandIcon).toBe(FeatherIcon);
  });
});

describe("图标规范（计划书 7.2）", () => {
  const names = Object.keys(ALL_ICONS);

  it.each(names)("%s 使用 24x24 viewBox", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never);
    expect(svg.getAttribute("viewBox")).toBe(ICON_VIEW_BOX);
  });

  it.each(names)("%s 线宽为 1.5 且端点圆角", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never);
    expect(svg.getAttribute("stroke-width")).toBe(String(ICON_STROKE_WIDTH));
    expect(svg.getAttribute("stroke-linecap")).toBe("round");
    expect(svg.getAttribute("stroke-linejoin")).toBe("round");
  });

  it.each(names)("%s 默认无填充且颜色继承 currentColor", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never);
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });

  it.each(names)("%s 纯装饰时标记 aria-hidden", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("aria-label")).toBeNull();
  });

  it.each(names)("%s 提供 aria-label 时转为语义图标", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never, {
      "aria-label": "测试标签",
    });
    expect(svg.getAttribute("aria-label")).toBe("测试标签");
    expect(svg.getAttribute("role")).toBe("img");
    // 语义图标不应再被 aria-hidden 屏蔽
    expect(svg.getAttribute("aria-hidden")).toBeNull();
  });

  it.each(names)("%s 默认尺寸为 24", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never);
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
  });

  it.each(names)("%s 支持自定义尺寸", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never, {
      size: 32,
    });
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
  });

  it.each(names)("%s 支持附加类名", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never, {
      class: "yh-icon-test",
    });
    expect(svg.getAttribute("class")).toContain("yh-icon-test");
  });

  it.each(names)("%s 含有可见的绘制内容", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never);
    // 空图标或只有一个占位矩形都是不合格的
    expect(svg.children.length).toBeGreaterThan(0);
  });

  it.each(names)("%s 没有用占位矩形敷衍", (name) => {
    const svg = renderIcon(ALL_ICONS[name as keyof typeof ALL_ICONS] as never);
    const rects = Array.from(svg.querySelectorAll("rect"));
    // 最多只允许一个背景矩形，且必须带圆角
    expect(rects.length).toBeLessThanOrEqual(1);
    for (const rect of rects) {
      expect(rect.getAttribute("rx"), name).not.toBeNull();
    }
  });

  it("仅粗体图标使用实心填充，且是自觉的例外", () => {
    // 计划书 7.2 规定「默认无填充；实心场景另出 -filled 变体」。
    // 粗体是唯一的例外：它的语义恰恰来自笔画粗细对比，
    // 用单一线宽的描边无论怎么画都只像字母 B，读不出「加粗」。
    // 这条测试把这个例外钉死，避免后来者顺手给别的图标也加 fill。
    const filled = names.filter((name) => {
      const svg = renderIcon(
        ALL_ICONS[name as keyof typeof ALL_ICONS] as never,
      );
      return svg.querySelector('[fill="currentColor"]') !== null;
    });
    expect(filled).toEqual(["bold"]);
  });
});

describe("图标源码零违规", () => {
  // 只扫图标组件文件：base.tsx 是公共基础，测试文件自己不算图标
  const files = readdirSync(here).filter(
    (f) => f.endsWith(".tsx") && f !== "base.tsx" && !f.endsWith(".test.tsx"),
  );

  it("一图一文件，数量与清单一致", () => {
    expect(files.length).toBe(ICON_COUNT);
  });

  it("每个图标文件都对应清单里的一项", () => {
    const expected = Object.keys(ALL_ICONS).map((n) => `${n}.tsx`);
    expect([...files].sort()).toEqual(expected.sort());
  });

  it.each(files)("%s 不含 emoji", (file) => {
    const source = readFileSync(resolve(here, file), "utf8");
    // 覆盖常见 emoji 区段：杂项符号、装饰符号、交通、表情、补充符号
    const emoji =
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/u;
    expect(emoji.test(source), `${file} 含 emoji 或箭头符号`).toBe(false);
  });

  it.each(files)("%s 不含外链资源", (file) => {
    const source = readFileSync(resolve(here, file), "utf8");
    expect(source).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(source).not.toContain("<image");
    expect(source).not.toContain("@font-face");
  });

  it("全部图标都引用了统一的描边基础", () => {
    for (const file of files) {
      const source = readFileSync(resolve(here, file), "utf8");
      expect(source, file).toContain("iconProps");
    }
  });

  it("index.ts 不含 emoji", () => {
    const source = readFileSync(resolve(here, "index.ts"), "utf8");
    const emoji =
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
    expect(emoji.test(source)).toBe(false);
  });
});
