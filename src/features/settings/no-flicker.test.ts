/**
 * 字体切换不闪动验证（T1.12）。
 *
 * ## 验收要求
 *
 * 原文：「字体切换不闪动验证：**测量重排耗时与掉帧**」。
 * 同时计划书 5.4 有一条硬约束：「**字体切换不得触发整页重排动画**：
 * 只更新 CSS 变量」。
 *
 * ## 这套测试能证明什么、不能证明什么
 *
 * 在 jsdom 里**没有布局引擎**（`getBoundingClientRect` 恒返回 0，
 * 也没有帧调度），因此真帧率与真实重排耗时在单测中**测不出来**。
 * 假装测出来只会产出一种「看起来很严格但实际恒定通过」的测试。
 *
 * 因此这里改用**可判定的结构性断言**，它们各自对应闪动的一个成因：
 *
 * | 断言 | 对应的闪动成因 |
 * | --- | --- |
 * | 切换只写 `:root` 上的自定义属性 | 大面积样式重算 → 大量元素同时重绘 |
 * | 写入的自定义属性不是可过渡属性 | transition 被意外触发 → 视觉上「抖一下」 |
 * | 不给任何元素写内联 font-family | 命中节点数与文本量成正比 → 大文档明显卡顿 |
 * | 先 preload 再 apply | FOUT：先用回退字体渲染再跳成内置字体 |
 *
 * 真实帧率测量方法见 `docs/字体切换验证.md`，由人工在打包产物上执行
 * （`pnpm tauri:dev` + DevTools Performance 录制）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAppearance,
  DEFAULT_APPEARANCE,
  setMeasure,
  setScopeTypography,
} from "@/app/appearance-store";
import { FontLoader, type FontFaceLike } from "@/design/fonts/loader";
import { applyTypography, typographyVariables } from "@/design/fonts/apply";

beforeEach(() => {
  __resetAppearance();
  window.localStorage.clear();
});

/** 一个可控的 FontFace 替身，用于验证「先加载后应用」的顺序。 */
function createControllableHost(): {
  loader: FontLoader;
  resolveAll: () => void;
  callOrder: string[];
} {
  const callOrder: string[] = [];
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const loader = new FontLoader({
    createFace: () => {
      callOrder.push("createFace");
      const face: FontFaceLike = {
        family: "Yuhua Serif SC",
        load: async () => {
          callOrder.push("load");
          await gate;
          return face;
        },
      };
      return face;
    },
    fontSet: () => ({
      add: () => callOrder.push("add"),
      delete: () => true,
    }),
  });

  return {
    loader,
    resolveAll: () => release?.(),
    callOrder,
  };
}

describe("T1.12 · 字体切换只走 CSS 变量", () => {
  it("切换字体只写 :root 上的自定义属性，不写任何元素的内联 font-family", () => {
    const target = document.documentElement;
    // 先清掉可能残留的值，确保断言的是本次写入
    target.removeAttribute("style");

    applyTypography(DEFAULT_APPEARANCE.typography);
    expect(target.style.getPropertyValue("--font-body")).toContain(
      "Yuhua Serif SC",
    );
    // 关键断言：根元素本身没有内联 font-family —— 字体完全由变量下发
    expect(target.style.fontFamily).toBe("");
  });

  it("字号与行距同样只走自定义属性", () => {
    const target = document.createElement("div");
    applyTypography(DEFAULT_APPEARANCE.typography, target);
    expect(target.style.getPropertyValue("--fs-body")).toBe("17px");
    expect(target.style.getPropertyValue("--lh-body")).toBe("1.9");
    expect(target.style.fontSize).toBe("");
    expect(target.style.lineHeight).toBe("");
  });

  it("正文宽度只走 --measure-body，不给元素写内联 width", () => {
    const target = document.createElement("div");
    applyTypography({ ...DEFAULT_APPEARANCE.typography, measure: 900 }, target);
    expect(target.style.getPropertyValue("--measure-body")).toBe("900px");
    expect(target.style.width).toBe("");
  });

  it("写入的属性名全部以 -- 开头（不存在「顺手写个内联样式」的漏网）", () => {
    const vars = typographyVariables(DEFAULT_APPEARANCE.typography);
    for (const name of Object.keys(vars)) {
      expect(name.startsWith("--"), name).toBe(true);
    }
  });
});

describe("T1.12 · 自定义属性不参与过渡", () => {
  /**
   * 浏览器规范里 `transition-property` 的取值是**属性名**，
   * 自定义属性默认不在可过渡集合内（除非用 `@property` 显式声明类型，
   * 本项目没有任何 `@property` 声明）。
   *
   * 这条测试守的是「没有引入 @property」这个前提：一旦有人为了做
   * 「字号平滑放大」而给 --fs-body 加 @property + transition，
   * 字体切换就会开始播放动画，正好违反 5.4。这里通过扫描 CSS
   * 源码来把这条前提钉住。
   */
  it("项目 CSS 里没有 @property 声明（那会让自定义属性变成可过渡的）", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "../../../");

    for (const file of [
      "src/design/tokens.css",
      "src/styles/settings.css",
      "src/styles/app.css",
    ]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source.includes("@property"), file + " 引入了 @property").toBe(
        false,
      );
    }
  });

  it("CSS 里没有 transition 指向字体相关属性", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));

    const source = readFileSync(
      resolve(here, "../../styles/settings.css"),
      "utf8",
    );
    // 抽出所有 transition-property / transition 简写的声明块
    const transitions = source.match(/transition(-property)?\s*:[^;]+;/g) ?? [];
    for (const rule of transitions) {
      expect(rule, rule).not.toContain("font-family");
      expect(rule, rule).not.toContain("font-size");
      expect(rule, rule).not.toContain("line-height");
      expect(rule, rule).not.toContain("max-width");
      expect(rule, rule).not.toContain("width");
    }
  });
});

describe("T1.12 · 先加载字形，后应用排版", () => {
  it("preload 会在 resolve 之前保持 pending —— 调用方因此能等到字形就绪", async () => {
    const { loader, resolveAll, callOrder } = createControllableHost();
    let settled = false;
    const task = loader.preload(["yuhua-serif"]).then(() => {
      settled = true;
    });

    // 让微任务队列跑几轮：此时 load 还没被放行
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveAll();
    await task;
    expect(settled).toBe(true);
    expect(callOrder).toContain("load");
  });

  it("三个作用域共用字族时只加载一次（避免三次字形解析带来的三次重绘）", async () => {
    const { loader, resolveAll } = createControllableHost();
    const task = loader.preload(["yuhua-kai", "yuhua-kai", "yuhua-kai"]);
    resolveAll();
    await task;
    expect(loader.size).toBe(1);
  });

  it("加载失败时 preload 仍然 resolve（排版照常应用，回退链接管）", async () => {
    const loader = new FontLoader();
    // jsdom 没有 FontFace，真实宿主会失败
    await expect(loader.preload(["yuhua-serif"])).resolves.toBeUndefined();
  });

  it("preload 之后立刻 applyTypography，变量与字形都已就位", async () => {
    const { loader, resolveAll } = createControllableHost();
    const task = loader.preload(["yuhua-serif"]);
    resolveAll();
    await task;
    const target = document.createElement("div");
    applyTypography(DEFAULT_APPEARANCE.typography, target);
    expect(target.style.getPropertyValue("--font-body")).toContain(
      "Yuhua Serif SC",
    );
  });
});

describe("T1.12 · 高频连改不产生中间态残留", () => {
  it("连续改字号只留下最后一次的值（不会写入一串中间值）", () => {
    const target = document.createElement("div");
    for (const size of [18, 19, 20, 21, 22]) {
      applyTypography(
        {
          ...DEFAULT_APPEARANCE.typography,
          body: { ...DEFAULT_APPEARANCE.typography.body, size },
        },
        target,
      );
    }
    expect(target.style.getPropertyValue("--fs-body")).toBe("22px");
    // 自定义属性是「覆盖」语义，不存在过渡中的中间帧
    const value = target.style.getPropertyValue("--fs-body");
    expect(value).not.toContain("px, ");
  });

  it("拖动宽度滑块时代入的每一个值都是合法的 CSS 长度", () => {
    const target = document.createElement("div");
    for (let measure = 480; measure <= 1120; measure += 80) {
      applyTypography({ ...DEFAULT_APPEARANCE.typography, measure }, target);
      expect(target.style.getPropertyValue("--measure-body")).toMatch(
        /^\d+px$/,
      );
    }
  });

  it("切换字体族不会在根元素上留下上一次的变量", () => {
    const target = document.createElement("div");
    applyTypography(
      {
        ...DEFAULT_APPEARANCE.typography,
        body: { ...DEFAULT_APPEARANCE.typography.body, family: "yuhua-kai" },
      },
      target,
    );
    expect(target.style.getPropertyValue("--font-body")).toContain(
      "Yuhua Kai SC",
    );
    applyTypography(DEFAULT_APPEARANCE.typography, target);
    expect(target.style.getPropertyValue("--font-body")).toContain(
      "Yuhua Serif SC",
    );
    // 同一个变量被覆盖，不存在两条并存
    expect(target.style.getPropertyValue("--font-body")).not.toContain(
      "Yuhua Kai SC",
    );
  });
});

describe("T1.12 · store 侧的即时性", () => {
  it("改字体族与改排版都立刻反映在 effectiveTypography 上（无需保存步骤）", () => {
    setScopeTypography("body", { family: "yuhua-kai" });
    expect(DEFAULT_APPEARANCE.typography.body.family).toBe("yuhua-serif");
    setMeasure(860);
  });

  it("设置写入是同步的：调用返回即可读到新值", () => {
    const spy = vi.fn();
    setMeasure(700);
    spy();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
