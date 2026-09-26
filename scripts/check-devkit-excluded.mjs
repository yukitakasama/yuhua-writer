#!/usr/bin/env node
/**
 * 校验组件预览页没有进生产产物（T1.9 的收尾）。
 *
 * ## 为什么需要一个脚本，而不是"看一眼 dist 目录"
 *
 * 因为这是个**会静默退化**的性质。任何人只要把 DevKit 的
 * 动态 import 改回静态 import（一个很自然的"优化"动作），
 * 预览页就会重新进主包 —— 而构建照样成功、测试照样全绿、
 * 界面照样正常。没有任何反馈会告诉作者"你刚刚让正式包
 * 多发了 20 KB 的内部工具"。
 *
 * 因此把它变成一条可以跑的断言。挂进 CI 的 build 之后即可。
 *
 * ## 检查三条
 *
 * 1. `index.html` 引用的 chunk 里没有 DevKit
 * 2. 主 chunk 里搜不到预览页独有的 class 名与文案
 * 3. `devkit.css` 也没有被主样式引用
 *
 * 三条都必要：第 1 条单独会被"DevKit 被内联进主 chunk"绕过，
 * 第 2 条单独会被"样式泄漏"绕过。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

/**
 * 只属于组件预览页的**代码标记**。
 *
 * ## 为什么不用 `zh-CN.ts` 里的文案当标记
 *
 * 文案字典是**无条件打包**的（整个应用都要用），所以
 * `"组件预览"` 这个字符串必然在主包里 —— 用它当判据永远会误报。
 *
 * 要判定的是"DevKit 这个**组件**有没有被发出"，因此标记必须是
 * 只出现在 DevKit.tsx 与 devkit.css 里的东西：它的 class 名与
 * 它独有的文案。
 *
 * 第一版把 `组件预览` 放进标记表，脚本立刻误报 —— 这恰好说明
 * 判据选错了。判据错了的检查比没有检查更糟：它会训练人忽略它。
 */
const DEVKIT_MARKERS = [
  // DevKit.tsx 独有的 class
  "kit-section",
  "kit-motion-box",
  "kit-heat__cell",
  "kit-scroll__inner",
  // DevKit.tsx 独有的文案（注意：不能用 zh-CN.ts 里的键对应的值，
  // 那些是无条件打包的）
  "重放动效",
  "编辑器内核的组件级测试",
];

/** 主 chunk 的判定：index.html 里不带 DevKit 名字的那些。 */
function mainEntryNames() {
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  const names = [];
  for (const m of html.matchAll(/assets\/([^"'\s>]+)/g)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

function fail(message) {
  console.error("[check-devkit] ✗ " + message);
  process.exitCode = 1;
}

function log(message) {
  console.log("[check-devkit] " + message);
}

function main() {
  if (!existsSync(DIST)) {
    log("dist 目录不存在，请先运行 pnpm build。");
    process.exitCode = 1;
    return;
  }

  const entries = mainEntryNames();
  if (entries.length === 0) {
    log("index.html 里没有解析到任何 chunk 引用，构建产物可能不完整。");
    process.exitCode = 1;
    return;
  }
  log("主产物引用：" + entries.join(", "));

  // ---- 检查 1：不得直接引用 DevKit chunk ----
  for (const name of entries) {
    if (/devkit/i.test(name)) {
      fail(`index.html 直接引用了 DevKit 的 chunk：${name}`);
    }
  }

  // ---- 检查 2：主 chunk 里不得含预览页标记 ----
  const assetsDir = join(DIST, "assets");
  const files = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  for (const name of entries) {
    const path = join(assetsDir, name);
    if (!existsSync(path)) continue;
    // 只看 JS 与 CSS：图片等二进制不需要扫
    if (!/\.(js|css)$/.test(name)) continue;
    const text = readFileSync(path, "utf8");
    for (const marker of DEVKIT_MARKERS) {
      if (text.includes(marker)) {
        fail(`主产物 ${name} 里出现了预览页标记 "${marker}"`);
      }
    }
  }

  // ---- 检查 3：DevKit 的样式不得被主样式引用 ----
  for (const name of entries) {
    if (!name.endsWith(".css")) continue;
    const text = readFileSync(join(assetsDir, name), "utf8");
    // 预览页样式里独有的类名
    if (text.includes("kit-motion-box") || text.includes("kit-heat__cell")) {
      fail(`主样式 ${name} 里包含了预览页的样式`);
    }
  }

  if (process.exitCode === 1) {
    console.error("");
    console.error("[check-devkit] 预览页泄漏进了生产产物。");
    console.error("[check-devkit] 修复方式：确认 main.tsx 里 DevKit 与 devkit.css 都是**动态** import。");
    return;
  }

  log("通过：组件预览页未进入生产产物。");
  void files;
}

main();
