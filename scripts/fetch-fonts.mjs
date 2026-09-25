#!/usr/bin/env node
/**
 * 字体获取流水线（计划书 T0.9 与 7.5.6 节）。
 *
 * ## 为什么字体二进制不入 git
 *
 * 四个字重（宋常 / 宋粗 / 楷常 / 楷粗）全量约 80 MB。
 * 把它们提交进仓库会让 clone 变得极其缓慢，且每次字体重建都会
 * 产生巨大的 diff。计划书 7.5.6 节明确要求：
 * 「字体二进制不入 git，由脚本从官方 Release 下载固定版本并校验 SHA256」。
 *
 * ## 本脚本的职责
 *
 * 1. 读取 `assets/fonts.lock.json`（记录版本 + SHA256 + 下载地址）
 * 2. 下载到 `assets/fonts/`（已在 .gitignore 中）
 * 3. 校验 SHA256；不匹配则**拒绝使用并报错**
 * 4. 已存在且校验通过的文件跳过，避免重复下载
 *
 * ## 为什么必须校验哈希
 *
 * 字体是本项目体积最大的资产，也是唯一来自第三方的二进制。
 * 计划书要求「保证任何机器、任何时间的构建产物一致」——
 * 只有哈希校验能提供这个保证。上游 Release 被替换、
 * 下载被中间人篡改、本地文件被误改，都会在这里被拦下。
 *
 * ## 当前状态
 *
 * `fonts.lock.json` 里的条目需要在实际选定时填入真实的
 * 下载地址与 SHA256。脚本已完整实现，填入条目即可使用。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOCK = join(ROOT, "assets", "fonts.lock.json");
const OUT_DIR = join(ROOT, "assets", "fonts");

function log(msg) {
  console.log("[fetch-fonts] " + msg);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error("下载失败 " + url + " -> HTTP " + res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (!existsSync(LOCK)) {
    log("未找到 assets/fonts.lock.json，无法获取字体。");
    log("该文件应由维护者填入固定版本号与 SHA256 后提交。");
    process.exit(1);
  }

  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  const fonts = lock.fonts || [];

  if (fonts.length === 0) {
    log("fonts.lock.json 中还没有字体条目。");
    log("请按文件内注释填入下载地址与 SHA256 后重跑。");
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const font of fonts) {
    const dest = join(OUT_DIR, font.file);

    if (existsSync(dest)) {
      const existing = readFileSync(dest);
      if (sha256(existing) === font.sha256) {
        log("已存在且校验通过，跳过：" + font.file);
        skipped++;
        continue;
      }
      log("已存在但哈希不符，将重新下载：" + font.file);
    }

    try {
      log("下载 " + font.file + " ...");
      const buf = await download(font.url);
      const actual = sha256(buf);

      if (actual !== font.sha256) {
        log("哈希校验失败：" + font.file);
        log("  期望 " + font.sha256);
        log("  实际 " + actual);
        log("  已拒绝使用该文件。请确认上游版本是否被替换。");
        failed++;
        continue;
      }

      writeFileSync(dest, buf);
      log("完成并校验通过：" + font.file + "（" + (buf.length / 1024 / 1024).toFixed(2) + " MB）");
      ok++;
    } catch (e) {
      log("获取失败：" + font.file + " -> " + e.message);
      failed++;
    }
  }

  log("统计：成功 " + ok + "，跳过 " + skipped + "，失败 " + failed);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  log("未预期的错误：" + e.message);
  process.exit(1);
});
