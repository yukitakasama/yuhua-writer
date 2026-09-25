#!/usr/bin/env node
/**
 * 基准采集脚本（计划书 T0.7 与 6.3 节）。
 *
 * ## 设计目标：可重复
 *
 * 计划书要求「基准的持续化」：内存类指标依赖真实窗口环境，
 * 采用「本地手动跑 + 发布前必须跑」的方式，结果记录在 docs/benchmarks.md。
 * 因此本脚本的职责是**产出一份可粘贴进文档、可跨版本对比的记录**，
 * 而不是自动判定通过 / 失败（阈值判定由人来做，因为环境差异大）。
 *
 * ## 采集哪些指标
 *
 * | 指标 | 来源 | 说明 |
 * | --- | --- | --- |
 * | 环境信息 | 本机 | 操作系统、CPU、内存、Node / Rust 版本 —— **没有这些数字没有可比性** |
 * | 前端产物体积 | dist/ | 影响启动与内存 |
 * | Rust 测试耗时 | cargo test | 回归信号 |
 * | 索引 / 检索耗时 | cargo test（集成测试输出） | P5 相关 |
 *
 * ## 为什么不在这里测真实内存
 *
 * 真实内存占用需要启动窗口并读取进程 RSS 与 WebView2 子进程之和。
 * 这要求应用已构建且能运行，不适合放进常规脚本。本脚本提供
 * 一个「手动采集指引」段落，说明该用什么工具测哪些数字。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, totalmem, platform, release, arch } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

function log(msg) {
  console.log("[bench] " + msg);
}

/** 安全执行命令，失败返回 null 而不是抛出。 */
function tryExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim();
  } catch {
    return null;
  }
}

/** 递归统计目录体积。 */
function dirSize(dir) {
  let total = 0;
  let files = 0;
  if (!existsSync(dir)) return { total, files };

  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile()) {
        total += statSync(p).size;
        files++;
      }
    }
  };
  walk(dir);
  return { total, files };
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function main() {
  const lines = [];

  lines.push("# 基准采集记录");
  lines.push("");
  lines.push("由 `scripts/bench/collect.mjs` 自动生成。");
  lines.push("");
  lines.push("## 环境");
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("| --- | --- |");
  lines.push("| 采集时间 | " + new Date().toISOString() + " |");
  lines.push("| 平台 | " + platform() + " " + release() + " (" + arch() + ") |");
  lines.push("| CPU | " + (cpus()[0]?.model ?? "未知") + " |");
  lines.push("| CPU 核心数 | " + cpus().length + " |");
  lines.push("| 内存总量 | " + fmtMB(totalmem()) + " |");
  lines.push("| Node | " + (process.version) + " |");
  lines.push("| pnpm | " + (tryExec("pnpm", ["--version"]) ?? "未安装") + " |");
  lines.push("| Rust | " + (tryExec("cargo", ["--version"]) ?? "未安装") + " |");
  lines.push("");

  // ---- 前端产物 ----
  lines.push("## 前端产物");
  lines.push("");
  const dist = join(ROOT, "dist");
  if (existsSync(dist)) {
    const { total, files } = dirSize(dist);
    lines.push("| 项 | 值 |");
    lines.push("| --- | --- |");
    lines.push("| dist 总体积 | " + fmtMB(total) + " |");
    lines.push("| dist 文件数 | " + files + " |");
    lines.push("");
    lines.push("各 chunk：");
    lines.push("");
    const assets = join(dist, "assets");
    if (existsSync(assets)) {
      lines.push("| 文件 | 体积 |");
      lines.push("| --- | --- |");
      for (const f of readdirSync(assets).sort()) {
        const p = join(assets, f);
        if (statSync(p).isFile()) {
          lines.push("| " + f + " | " + fmtMB(statSync(p).size) + " |");
        }
      }
    }
  } else {
    lines.push("尚未构建（`pnpm build`），跳过。");
  }
  lines.push("");

  // ---- 字体资产 ----
  lines.push("## 字体资产");
  lines.push("");
  const fonts = join(ROOT, "assets", "fonts");
  if (existsSync(fonts)) {
    const { total, files } = dirSize(fonts);
    lines.push("字体源文件：" + files + " 个，合计 " + fmtMB(total) + "。");
    lines.push("");
    lines.push("注意：安装包预算 P6 要求内置 WOFF2 子集 ≤ 12 MB。");
    lines.push("子集产物在 `src/fonts/`（不入 git），请单独核验其体积。");
  } else {
    lines.push("尚无字体源文件（运行 `pnpm fonts:fetch` 获取）。");
  }
  lines.push("");

  // ---- Rust 测试 ----
  lines.push("## Rust 测试");
  lines.push("");
  const testOut = tryExec("cargo", ["test", "--workspace", "--", "--list"], { cwd: ROOT });
  if (testOut) {
    const count = testOut.split("\n").filter((l) => l.endsWith(": test")).length;
    lines.push("待运行测试数：" + count);
  } else {
    lines.push("无法列出测试（cargo 不可用）。");
  }
  lines.push("");

  // ---- 需要手动采集的指标 ----
  lines.push("## 需要手动采集的指标");
  lines.push("");
  lines.push("以下指标依赖真实窗口环境，必须人工测量并填入本文件：");
  lines.push("");
  lines.push("| 编号 | 指标 | 目标 | 测量方法 |");
  lines.push("| --- | --- | --- | --- |");
  lines.push("| M1 | 冷启动应用组总内存 | ≤ 150 MB | 任务管理器 → 应用分组（含 WebView2 子进程） |");
  lines.push("| M1b | Rust 主进程 RSS | ≤ 30 MB | 任务管理器 → 详细信息 → yuhua-writer.exe |");
  lines.push("| M2 | 打开 100 万字工作区并编辑的增幅 | ≤ 50 MB | 打开前后各记一次 M1 |");
  lines.push("| M3 | 连续输入 30 分钟内存漂移 | ≤ 10 MB 且无单调增长 | 第 5 分钟与第 30 分钟各记一次 |");
  lines.push("| M4 | 空闲 5 分钟 CPU | ≤ 1% | 任务管理器 → 性能 |");
  lines.push("| M5 | 内置字体常驻内存（≤ 2 字族） | ≤ 24 MB | DevTools 内存快照对比 |");
  lines.push("| M6 | 切换字族 60 秒后可回收 | 回落，残留 ≤ 4 MB | 切换后等 60 秒再快照 |");
  lines.push("| M7 | 导出 100 万字 / 300 章内存峰值 | ≤ 120 MB，不随书量增长 | 导出全程监控峰值 |");
  lines.push("| M8 | 打开统计页后内存增幅 | ≤ 8 MB | 进入统计页前后对比 |");
  lines.push("| P1 | 按键到字形上屏延迟 | P95 ≤ 16 ms | DevTools Performance 录制 |");
  lines.push("| P2 | 动效帧率 | 每秒掉帧 ≤ 2 | DevTools Performance |");
  lines.push("| P3 | 冷启动到可输入 | ≤ 1.5 s | 秒表 / 日志时间戳 |");
  lines.push("| P4 | 打开 1 万字章节 | ≤ 150 ms | 应用内埋点 |");
  lines.push("| P5 | 100 万字全文检索 | ≤ 300 ms | cargo test 集成测试输出 |");
  lines.push("| P6 | Windows 安装包体积 | ≤ 25 MB | 构建产物文件属性 |");
  lines.push("| P7 | 首屏字体加载到可读 | ≤ 120 ms | DevTools Network |");
  lines.push("| P8 | 导出 30 万字 / 100 章 DOCX | ≤ 5 s | 应用内计时 |");
  lines.push("| P9 | 导出 30 万字 / 100 章 EPUB 过 epubcheck | ≤ 6 s，零 error | 应用内计时 + epubcheck |");
  lines.push("| P10 | PDF 中文嵌入、可搜索可复制 | 必须满足 | 打开导出的 PDF 尝试选中文字 |");
  lines.push("| P11 | 统计页（年热力图）首次渲染 | ≤ 200 ms | DevTools Performance |");
  lines.push("");

  const outPath = join(ROOT, "docs", "benchmarks-generated.md");
  writeFileSync(outPath, lines.join("\n"), "utf8");
  log("已写出 " + outPath.replace(ROOT, "."));

  // 同时打印到控制台，方便直接粘贴
  console.log("\n" + lines.join("\n"));
}

main();
