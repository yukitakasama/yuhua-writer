#!/usr/bin/env node
/**
 * 应用图标派生脚本（计划书 T10.2 / 附录 C）。
 *
 * ## 设计原则
 *
 * `assets/icon.svg` 是**唯一源文件**。本脚本从它派生出全平台所需的各种尺寸。
 * 因此「换图标」= 替换那一个 SVG + 重跑本脚本，**不涉及任何代码改动**。
 *
 * ## 为什么不用带位图处理的依赖
 *
 * 计划书要求②「内存占用最低」与「前端零运行时依赖优先」的精神同样适用于
 * 构建期：引入 sharp / canvas 这类带原生二进制的包会显著拖慢 CI 并带来
 * 安装失败风险。这里只做两件事：
 *
 *   1. 生成 SVG 的尺寸变体（纯文本操作，零依赖）
 *   2. 调用系统 / 已有工具做 SVG → PNG 转换（有则用，无则明确提示）
 *
 * ## 支持的工具链（按优先级探测）
 *
 * - `resvg`（若已安装）—— 纯 Rust，跨平台最稳
 * - `rsvg-convert`（librsvg）—— Linux / macOS 常见
 * - `magick` / `convert`（ImageMagick）—— 通用
 *
 * 都不可用时脚本**不会失败**：它会生成 SVG 变体并给出清晰的安装指引。
 * 这样开发者在没有图像工具的机器上依然能跑完整套构建（Tauri 会跳过
 * 缺失的图标文件），而不是被一个图标脚本卡住。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ASSETS = join(ROOT, "assets");
const OUT = join(ROOT, "src-tauri", "icons");

/** Tauri 需要的图标尺寸（对应 tauri.conf.json 的 bundle.icon）。 */
const SIZES = [32, 128, 256, 512];

/** 生成 1024 主稿的尺寸变体时使用的最小尺寸。 */
const MARK_SIZES = [16, 24, 32];

function log(msg) {
  // 刻意不用 emoji（计划书要求③）
  console.log("[gen-icons] " + msg);
}

/** 读取源 SVG。 */
function readSource(name) {
  const p = join(ASSETS, name);
  if (!existsSync(p)) {
    throw new Error("缺少源文件：" + p);
  }
  return readFileSync(p, "utf8");
}

/**
 * 给 SVG 注入 width/height，生成指定像素尺寸的变体。
 *
 * 主稿是 1024x1024 的 viewBox，因此只需改 width/height 属性即可缩放；
 * 矢量内容本身不需要任何改动，这是 SVG 相对位图的核心优势。
 */
function withSize(svg, size) {
  let out = svg;

  // 替换或注入 width / height
  if (/\swidth="[^"]*"/.test(out)) {
    out = out.replace(/\swidth="[^"]*"/, ' width="' + size + '"');
  } else {
    out = out.replace("<svg", '<svg width="' + size + '"');
  }
  if (/\sheight="[^"]*"/.test(out)) {
    out = out.replace(/\sheight="[^"]*"/, ' height="' + size + '"');
  } else {
    out = out.replace("<svg", '<svg height="' + size + '"');
  }
  return out;
}

/** 探测可用的 SVG → PNG 转换工具。 */
function findConverter() {
  const candidates = [
    { cmd: "resvg", args: (src, out, size) => [src, out, "--width", String(size), "--height", String(size)] },
    { cmd: "rsvg-convert", args: (src, out, size) => ["-w", String(size), "-h", String(size), "-o", out, src] },
    { cmd: "magick", args: (src, out, size) => ["-background", "none", "-resize", size + "x" + size, src, out] },
    { cmd: "convert", args: (src, out, size) => ["-background", "none", "-resize", size + "x" + size, src, out] },
  ];

  for (const c of candidates) {
    try {
      execFileSync(c.cmd, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      // 该工具不可用，试下一个
    }
  }
  return null;
}

function main() {
  const icon = readSource("icon.svg");
  const mark = readSource("icon-mark.svg");

  mkdirSync(OUT, { recursive: true });

  // ---- 1. 生成 SVG 尺寸变体（纯文本操作，永远可用）----
  for (const size of SIZES) {
    const dest = join(OUT, "icon-" + size + ".svg");
    writeFileSync(dest, withSize(icon, size), "utf8");
  }
  for (const size of MARK_SIZES) {
    const dest = join(OUT, "mark-" + size + ".svg");
    writeFileSync(dest, withSize(mark, size), "utf8");
  }
  log("已生成 SVG 尺寸变体：" + SIZES.join(" / ") + " 与标记 " + MARK_SIZES.join(" / "));

  // ---- 2. 尝试派生出 PNG / ICO ----
  const converter = findConverter();
  if (!converter) {
    log("未找到 SVG 转 PNG 工具，已跳过位图派生。");
    log("如需生成 .ico / .icns / PNG，请安装以下任一工具后重跑：");
    log("  · cargo install resvg        （推荐，纯 Rust）");
    log("  · apt install librsvg2-bin   （Linux）");
    log("  · brew install librsvg       （macOS）");
    log("  · https://imagemagick.org    （通用）");
    log("提示：Tauri 构建会跳过缺失的位图图标，因此这不影响开发调试。");
    return;
  }

  log("使用转换工具：" + converter.cmd);

  const master = join(OUT, "icon-512.svg");
  for (const size of SIZES) {
    const out = join(OUT, size + "x" + size + ".png");
    try {
      execFileSync(converter.cmd, converter.args(master, out, size), { stdio: "ignore" });
      log("  -> " + out.replace(ROOT, "."));
    } catch (e) {
      log("  转换 " + size + "px 失败：" + e.message);
    }
  }

  // 128@2x 是 Tauri 的约定命名
  try {
    const src = join(OUT, "256x256.png");
    const dst = join(OUT, "128x128@2x.png");
    if (existsSync(src)) {
      writeFileSync(dst, readFileSync(src));
      log("  -> " + dst.replace(ROOT, "."));
    }
  } catch (e) {
    log("  生成 128x128@2x 失败：" + e.message);
  }

  log("图标派生完成。替换 assets/icon.svg 后重跑本脚本即可整体换肤。");
}

main();
