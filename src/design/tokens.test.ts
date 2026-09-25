/**
 * 设计令牌一致性测试。
 *
 * 这里校验的是「CSS 与 TS 两份令牌没有漂移」。
 * 这是最容易出错也最难被发现的一类问题：两边各自看都合理，
 * 只有并排比较才会发现 WAAPI 动画比 CSS 过渡慢了 60ms。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  DURATION,
  EASING,
  EASING_POINTS,
  MAX_CONCURRENT_ANIMATIONS,
  REDUCED_MOTION_QUERY,
  SPRING_SNAPPY,
  SPRING_SOFT,
  prefersReducedMotion,
  resolveDuration,
} from "./motion/tokens";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "tokens.css"), "utf8");

/**
 * 从 CSS 文本里取自定义属性的值。
 *
 * @param name 变量名，不含前缀 --
 * @param scope 作用域选择器，默认 :root
 * @returns 变量值（已去空白），找不到时返回 undefined
 */
function cssVar(name: string, scope = ":root"): string | undefined {
  const scopeStart = css.indexOf(scope);
  if (scopeStart === -1) return undefined;
  const blockStart = css.indexOf("{", scopeStart);
  const blockEnd = css.indexOf("\n}", blockStart);
  const block = css.slice(blockStart, blockEnd === -1 ? undefined : blockEnd);
  const match = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim();
}

/** 把 "180ms" 解析为数字 180。 */
function msToNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.match(/^(-?\d+(?:\.\d+)?)ms$/);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

describe("动效令牌与 CSS 一致", () => {
  const pairs: [keyof typeof DURATION, string][] = [
    ["instant", "d-instant"],
    ["fast", "d-fast"],
    ["base", "d-base"],
    ["slow", "d-slow"],
    ["page", "d-page"],
  ];

  it.each(pairs)("%s 与 --%s 数值相同", (token, cssName) => {
    expect(msToNumber(cssVar(cssName))).toBe(DURATION[token]);
  });

  it("缓动曲线两侧完全一致", () => {
    expect(cssVar("e-standard")).toBe(EASING.standard);
    expect(cssVar("e-decelerate")).toBe(EASING.decelerate);
    expect(cssVar("e-accelerate")).toBe(EASING.accelerate);
  });

  it("cubic-bezier 四参数与控制点字符串同源", () => {
    const standard = EASING_POINTS.standard;
    expect(EASING.standard).toBe(
      `cubic-bezier(${standard[0]}, ${standard[1]}, ${standard[2]}, ${standard[3]})`,
    );
  });

  it("缓动曲线参数的四个分量都在合法区间", () => {
    for (const points of Object.values(EASING_POINTS)) {
      // cubic-bezier 的 x 必须落在 0..1，否则浏览器会拒绝整条曲线
      expect(points[0]).toBeGreaterThanOrEqual(0);
      expect(points[0]).toBeLessThanOrEqual(1);
      expect(points[2]).toBeGreaterThanOrEqual(0);
      expect(points[2]).toBeLessThanOrEqual(1);
    }
  });
});

describe("设计令牌完整性", () => {
  const required = [
    "c-bg", "c-bg-subtle", "c-surface", "c-border", "c-text", "c-text-muted",
    "c-accent", "c-danger",
    "sp-1", "sp-2", "sp-3", "sp-4", "sp-5", "sp-6", "sp-7", "sp-8",
    "fs-xs", "fs-sm", "fs-base", "fs-lg", "fs-xl", "fs-2xl",
    "r-sm", "r-md", "r-lg", "r-full",
    "font-body", "font-heading", "font-ui",
    "shadow-sm", "shadow-md", "shadow-lg",
    "z-base", "z-dropdown", "z-overlay", "z-dialog", "z-toast", "z-tooltip",
    "c-heat-0", "c-heat-1", "c-heat-2", "c-heat-3", "c-heat-4",
  ];

  it.each(required)("亮色主题定义了 --%s", (name) => {
    expect(cssVar(name)).toBeTruthy();
  });

  it("间距符合 4px 基准栅格", () => {
    const expected: Record<string, number> = {
      "sp-1": 4, "sp-2": 8, "sp-3": 12, "sp-4": 16,
      "sp-5": 20, "sp-6": 24, "sp-7": 28, "sp-8": 32,
    };
    for (const [name, px] of Object.entries(expected)) {
      expect(cssVar(name)).toBe(`${px}px`);
    }
  });

  it("间距梯度严格递增且均为 4 的倍数", () => {
    const values = ["sp-1", "sp-2", "sp-3", "sp-4", "sp-5", "sp-6", "sp-7", "sp-8"].map(
      (n) => Number.parseInt(cssVar(n) ?? "0", 10),
    );
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
      expect(values[i]! % 4).toBe(0);
    }
  });

  it("字阶严格递增", () => {
    const values = ["fs-xs", "fs-sm", "fs-base", "fs-lg", "fs-xl", "fs-2xl"].map((n) =>
      Number.parseInt(cssVar(n) ?? "0", 10),
    );
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
    expect(values[0]).toBe(12);
    expect(values[5]).toBe(26);
  });

  it("字体族三个作用域各自独立且都带回退链", () => {
    for (const scope of ["font-body", "font-heading", "font-ui"]) {
      const value = cssVar(scope) ?? "";
      expect(value.length).toBeGreaterThan(0);
      // 回退链至少两项，否则子集化的缺字会变成豆腐块
      expect(value.split(",").length).toBeGreaterThanOrEqual(2);
    }
    expect(cssVar("font-body")).not.toBe(cssVar("font-heading"));
    expect(cssVar("font-heading")).not.toBe(cssVar("font-ui"));
  });
});

describe("亮暗双主题", () => {
  const vars = ["c-bg", "c-surface", "c-text", "c-accent", "c-heat-0", "c-heat-4"];

  it.each(vars)("暗色主题覆盖了 --%s", (name) => {
    const dark = cssVar(name, '[data-theme="dark"]');
    expect(dark).toBeTruthy();
    expect(dark).not.toBe(cssVar(name));
  });

  it("跟随系统的媒体查询存在且排除显式亮色", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it("文字与背景在亮色主题下不是同一色值", () => {
    expect(cssVar("c-text")).not.toBe(cssVar("c-bg"));
    expect(cssVar("c-text")).not.toBe(cssVar("c-surface"));
  });
});

describe("无障碍降级", () => {
  it("存在 prefers-reduced-motion 媒体查询", () => {
    expect(css).toContain(REDUCED_MOTION_QUERY);
  });

  it("查询内把全部时长压到 100ms 以内", () => {
    const start = css.indexOf(REDUCED_MOTION_QUERY);
    const block = css.slice(start, css.indexOf("/* =", start + 1));
    for (const name of ["d-instant", "d-fast", "d-base", "d-slow", "d-page"]) {
      const match = block.match(new RegExp(`--${name}\\s*:\\s*(\\d+)ms`));
      expect(match?.[1], name).toBeDefined();
      expect(Number(match![1])).toBeLessThanOrEqual(100);
    }
  });

  it("查询内标记动效关闭开关", () => {
    const start = css.indexOf(REDUCED_MOTION_QUERY);
    const block = css.slice(start, css.indexOf("】", start) === -1 ? start + 900 : start + 900);
    expect(block).toContain("--motion-enabled: 0");
  });
});

describe("resolveDuration", () => {
  it("正常时原样返回时长", () => {
    expect(resolveDuration(320, false)).toBe(320);
    expect(resolveDuration(0, false)).toBe(0);
  });

  it("减弱动效时封顶 100ms", () => {
    expect(resolveDuration(320, true)).toBe(100);
    expect(resolveDuration(180, true)).toBe(100);
  });

  it("减弱动效时不会把已很短的时长拉长", () => {
    expect(resolveDuration(80, true)).toBe(80);
    expect(resolveDuration(60, true)).toBe(60);
  });

  it("边界：0 与负数不会变成负时长", () => {
    expect(resolveDuration(0, true)).toBe(0);
    expect(resolveDuration(-5, true)).toBe(-5);
  });
});

describe("prefersReducedMotion 探测", () => {
  /** 造一个只实现 matchMedia 的最小窗口替身。 */
  function fakeWindow(matches: boolean, throwOnMatch = false) {
    return {
      matchMedia: (query: string) => {
        if (throwOnMatch) throw new Error("受限环境");
        return { matches: query === REDUCED_MOTION_QUERY ? matches : !matches };
      },
    } as unknown as Window;
  }

  it("查询命中时返回 true", () => {
    expect(prefersReducedMotion(fakeWindow(true))).toBe(true);
  });

  it("查询未命中时返回 false", () => {
    expect(prefersReducedMotion(fakeWindow(false))).toBe(false);
  });

  it("缺乏 window 时返回 false（不静默关掉全部动效）", () => {
    expect(prefersReducedMotion(null)).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
  });

  it("matchMedia 抛错时按不减弱处理", () => {
    expect(prefersReducedMotion(fakeWindow(false, true))).toBe(false);
  });

  it("matchMedia 不是函数时不崩溃", () => {
    const broken = { matchMedia: 42 } as unknown as Window;
    expect(prefersReducedMotion(broken)).toBe(false);
  });
});

describe("弹簧参数", () => {
  it("与计划书 5.3 的数值一致", () => {
    expect(SPRING_SOFT).toMatchObject({ stiffness: 300, damping: 30 });
    expect(SPRING_SNAPPY).toMatchObject({ stiffness: 500, damping: 35 });
  });

  it("脆弹簧比软弹簧更快到达目标", () => {
    expect(SPRING_SNAPPY.stiffness).toBeGreaterThan(SPRING_SOFT.stiffness);
    expect(SPRING_SNAPPY.damping).toBeGreaterThan(SPRING_SOFT.damping);
  });

  it("并发上限为 30", () => {
    expect(MAX_CONCURRENT_ANIMATIONS).toBe(30);
  });
});

describe("性能铁律写进了注释", () => {
  it("CSS 中明示只动画 transform 与 opacity", () => {
    expect(css).toContain("只动画 transform 与 opacity");
    // 明确列出被禁止的属性，避免后来者「顺手」加上过渡
    for (const banned of ["width", "height", "top", "left", "margin", "box-shadow", "filter"]) {
      expect(css).toContain(banned);
    }
  });

  it("CSS 中明示 will-change 必须移除", () => {
    expect(css).toContain("will-change");
  });
});
