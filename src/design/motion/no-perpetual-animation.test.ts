/**
 * 护栏：不许存在「永久运行且改动几何」的 CSS 动画。
 *
 * ## 为什么需要这条测试
 *
 * 起因是一次实测：M4 要求「空闲 5 分钟 CPU ≤ 1%」，真机量出来是
 * **单个 CPU 核心的约 37%**，而且稳定期越久越高。归因采样显示全部开销都在
 * WebView2 的 gpu-process，主进程是 0.00s —— 也就是说不是 Rust 在空转，
 * 是页面在无限出帧。
 *
 * 元凶是空状态插画的 `animation: breathe 9s ... infinite`，关键帧里写的是
 * `transform: scale(1) → scale(1.02)`。**缩放会强制那张内联 SVG 每帧重新
 * 栅格化**：不是「重绘一次很贵」，而是「永远不进入空闲」。作者只是让软件
 * 开着去查资料，笔记本就在掉电。
 *
 * CSS 动画看起来人畜无害、也不会有任何报错，这类问题没有任何其它门禁能抓住
 * —— 因此把它变成一条可执行的规则。
 *
 * ## 两条规则
 *
 * 1. 无限循环的动画只允许出现在**临时状态指示器**上（白名单见下），
 *    它们只在加载/保存期间存在，本身就该一直动。
 * 2. 任何无限循环的关键帧不得改动几何属性（`scale` / 尺寸 / 位移），
 *    因为那会触发重新栅格化；`rotate` 与 `opacity` 属合成器友好，不在此列。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");

/** 被扫描的样式来源：CSS 文件 + 内联样式的 TS（组件原语走的是后者）。 */
const SOURCES = [
  "src/styles/app.css",
  "src/styles/devkit.css",
  "src/design/tokens.css",
  "src/design/primitives/styles.ts",
];

/**
 * 允许无限循环的动画。
 *
 * 判断标准只有一条：**这个元素是否会在用户闲置时仍然挂在页面上。**
 * 加载转圈与保存脉冲都只在对应状态期间存在，闲置时不在场，所以可以一直动。
 *
 * `geometryAllowed` 是对第二条规则的显式豁免，必须带理由：
 * `save-pulse` 的宿主是一个 6px 的圆点，`scale` 触发的重新栅格化只覆盖这
 * 几平方像素，而且仅存在于保存中的那几百毫秒 —— 与「148px 的内联 SVG
 * 永久重画」完全不是一个量级。豁免写成数据而不是把规则放松，
 * 是为了让下一次新增无限动画时必须回答同一个问题。
 */
const ALLOWED_INFINITE: Record<
  string,
  { reason: string; geometryAllowed?: string }
> = {
  "yh-spin": { reason: "加载转圈，仅在该元素处于加载状态时存在" },
  "save-pulse": {
    reason: "保存脉冲，仅正在保存时存在",
    geometryAllowed: "宿主是 6px 圆点，重栅格面积可忽略，且只在保存期间运行",
  },
};

/** 会触发重新栅格化的几何写法。 */
const GEOMETRY_PATTERNS: Array<[RegExp, string]> = [
  [/\bscale(?:3d|X|Y|3f)?\s*\(/, "scale()"],
  [
    /[\w-]*(?:width|height|margin|padding|inset|top|right|bottom|left)\s*:/,
    "尺寸或偏移",
  ],
];

/** 从样式文本里取出所有 `animation:` 声明。 */
function animationDeclarations(css: string): string[] {
  return [...css.matchAll(/animation:\s*([^;{}]+);/g)].map((m) => m[1]!);
}

/** 取出声明里被 `infinite` 修饰的动画名。 */
function infiniteNames(css: string): string[] {
  return animationDeclarations(css)
    .filter((decl) => decl.includes("infinite"))
    .map((decl) => decl.trim().split(/\s+/)[0]!);
}

/** 解析出所有 `@keyframes 名字 { ... }` 的正文（按大括号配对）。 */
function keyframeBodies(css: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const name = match[1]!;
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    out.push({ name, body: css.slice(start, i - 1) });
  }
  return out;
}

describe("闲置期不得存在无限运行的动画", () => {
  const texts = SOURCES.map((p) => ({
    path: p,
    css: readFileSync(resolve(root, p), "utf8"),
  }));

  it("样式源文件都能读到", () => {
    expect(texts.length).toBeGreaterThan(0);
  });

  it("无限循环的动画名全部在白名单内", () => {
    const offenders: string[] = [];
    for (const { path, css } of texts) {
      for (const name of infiniteNames(css)) {
        if (!(name in ALLOWED_INFINITE)) {
          offenders.push(`${path} → animation: ${name} … infinite`);
        }
      }
    }
    expect(
      offenders,
      `这些动画会永久运行。闲置时仍在页面上的元素不可以一直动：\n${offenders.join(
        "\n",
      )}\n白名单及理由：${JSON.stringify(ALLOWED_INFINITE, null, 2)}`,
    ).toEqual([]);
  });

  it("无限循环的动画不得用改动几何的关键帧（除非显式豁免）", () => {
    const offenders: string[] = [];
    for (const { path, css } of texts) {
      const forever = new Set(infiniteNames(css));
      for (const name of forever) {
        if (ALLOWED_INFINITE[name]?.geometryAllowed) continue;
        for (const { name: kf, body } of keyframeBodies(css)) {
          if (kf !== name) continue;
          for (const [pattern, label] of GEOMETRY_PATTERNS) {
            if (pattern.test(body)) {
              offenders.push(
                `${path} → @keyframes ${name} 改了${label}` +
                  `（不在白名单豁免里：${JSON.stringify(ALLOWED_INFINITE[name] ?? null)}）`,
              );
            }
          }
        }
      }
    }
    expect(
      offenders,
      `这些关键帧会强制重新栅格化（实测正是 M4 空闲 CPU 超标的根因）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("空状态插画的呼吸必须是有界次数（守住这次修复）", () => {
    const css = readFileSync(resolve(root, "src/styles/app.css"), "utf8");
    const art = /\.empty__art\s*\{([^}]*)\}/.exec(css);
    expect(art, "找不到 .empty__art 规则").not.toBeNull();
    const decl = /animation:\s*([^;]+);/.exec(art![1]!)?.[1] ?? "";
    expect(decl).toContain("breathe");
    expect(decl).not.toContain("infinite");
    // 末尾的次数必须是有限正整数（省略不写等价于 1，也算合格）
    const count = decl.trim().split(/\s+/).pop()!;
    expect(/^\d+$/.test(count) || count === "breathe").toBe(true);
  });

  it("呼吸关键帧本身不得再含 scale", () => {
    const css = readFileSync(resolve(root, "src/styles/app.css"), "utf8");
    const breathe = keyframeBodies(css).find((k) => k.name === "breathe");
    expect(
      breathe,
      "breathe 关键帧应当仍存在（空状态还需要它做入场引导）",
    ).not.toBeNull();
    expect(breathe!.body).not.toMatch(/scale\s*\(/);
  });
});
