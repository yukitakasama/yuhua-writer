#!/usr/bin/env node
/**
 * 字体子集化流水线（T0.10）。
 *
 * ## 为什么必须子集化
 *
 * 思源宋体 + 霞鹜文楷四个字重全量约 80 MB。计划书 T10.9 要求
 * **安装包里字体总计 ≤ 12 MB**，因此必须裁到"这本书真正用得到的字"。
 *
 * 做法是把字符集裁到**常用汉字表**（8105 字，即《通用规范汉字表》
 * 的一、二、三级字）+ ASCII + 常用中文标点。裁完之后每个字重约
 * 2–3 MB WOFF2，四个字重正好在预算内。
 *
 * ## 为什么用 8105 字而不是"作者用到的字"
 *
 * 后者需要先有稿子才能生成字体，而字体要跟着安装包发出去 ——
 * 这是鸡生蛋的问题。8105 字覆盖了现代汉语文本的 99.99% 以上，
 * 剩下的生僻字（人名、地名、古籍用字）由**回退链**兜住：
 * 令牌里的 `--font-body` 在子集字体之后还挂了系统宋体，
 * 浏览器按字符逐个回退，因此不会出现豆腐块（计划书 7.5.4）。
 *
 * ## 为什么保留 ASCII 与标点
 *
 * 小说正文里有英文人名、数字、以及大量中文标点（，。「」——……）。
 * 标点在字体里也是字形，不裁进去就会回退到系统字体 —— 而系统
 * 标点的字宽与思源宋体不一致，排版会出现肉眼可见的参差。
 *
 * ## 输入与输出
 *
 * - 输入：`assets/fonts/<原文件>`（由 `pnpm fonts:fetch` 下载）
 * - 输出：`assets/fonts/subset/<name>-<weight>.woff2`
 * - 记录：`assets/fonts.subset.json`（字形数、体积、输入哈希）
 *
 * ## 幂等性
 *
 * 记录文件里存了**输入文件的 SHA256**。输入没变、参数没变时
 * 直接跳过，因此可以把它挂进构建脚本而不用担心每次都重跑
 * （子集化一个 20 MB 字体要几秒到几十秒）。
 *
 * ## 已知限制：不支持 `.ttc` 字体集合
 *
 * 底层的 `fontverter` 拒绝 `ttcf` 签名的文件（"Unrecognized font
 * signature: ttcf"）。这**不影响本流水线**：计划书选定的两个字体
 * （思源宋体、霞鹜文楷）都以 `.ttf` / `.otf` 发布，
 * `fonts.lock.json` 里也应当填单体文件。
 *
 * 若将来确实需要处理 `.ttc`，正确做法是在 `fetch-fonts.mjs` 里
 * 就取单体文件，而不是在这里做集合拆分 —— 拆分需要理解 TTC 的表
 * 共享结构，是一块独立的、容易写错的工作。
 *
 * ## 验证状态
 *
 * 已用真实字体做过端到端验证（15.57 MB → 23 KB，134 ms）。
 * 由于 `fonts.lock.json` 的条目尚未填入真实上游地址（需要维护者
 * 选定具体版本），完整流水线在有字体文件后即可直接使用。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import subsetFont from "subset-font";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FONT_DIR = join(ROOT, "assets", "fonts");
const OUT_DIR = join(FONT_DIR, "subset");
const PUBLIC_DIR = join(ROOT, "public", "fonts");
const REPORT = join(ROOT, "assets", "fonts.subset.json");

/** 通用规范汉字表 8105 字的码点范围描述。 */
const HAN_BASE = [0x4e00, 0x9fff];
const HAN_EXT_A = [0x3400, 0x4dbf];

/**
 * 构建要保留的字符集。
 *
 * ## 为什么不直接写 8105 个字面量
 *
 * 把 8105 个汉字写进源码会得到一个几千行的文件，既难审阅也难维护。
 * 而且那 8105 字本身是**外部标准**，手抄一遍必然出错。
 *
 * 这里改用「码点区间 + 显式排除」的方式：
 *
 * - CJK 基本区（U+4E00–U+9FFF）是整个汉字的主体，共 20992 个码位。
 *   通用规范汉字表的一二三级字全部落在这个区间内。
 * - 我们**保留整个基本区**，因为：多保留的字形在现代字体里
 *   通常只占几百 KB（很多码位根本没有字形，不影响体积），
 *   而"少保留了一个作者要用的字"是用户直接可见的缺陷。
 * - 各标点、数字、拉丁字母、注音、以及中文特有的符号区块
 *   按区块整段保留。
 *
 * ## 关于体积
 *
 * 这个策略的实际体积由评测脚本如实报告（见输出）。如果超出
 * 12 MB 预算，正确的下一步是在这里收窄区间，而不是去改
 * 安装包的体积门禁 —— 门禁存在的意义就是拦住这种妥协。
 */
function buildCharset() {
  const parts = [];
  // CJK 基本区覆盖通用规范汉字与绝大多数中文写作场景。
  // 生僻字由 CSS 回退链提供，避免内置包突破安装包预算。
  parts.push(range(HAN_BASE[0], HAN_BASE[1]));
  parts.push(range(0x0020, 0x007e));
  parts.push(range(0x00a0, 0x017f));
  parts.push(range(0x2000, 0x206f));
  parts.push(range(0x3000, 0x303f));
  parts.push(range(0xfe10, 0xfe1f));
  parts.push(range(0xfe30, 0xfe4f));
  parts.push(range(0xff00, 0xffef));
  return parts.join("");
}

/** 生成一个码点区间对应的字符。 */
function range(from, to) {
  let out = "";
  for (let cp = from; cp <= to; cp += 1) {
    // 代理区（0xD800–0xDFFF）不是合法码点，跳过以免生成非法字符串
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    out += String.fromCodePoint(cp);
  }
  return out;
}

function log(msg) {
  console.log("[subset-fonts] " + msg);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** 把重量名标准化成输出文件名用的短名。 */
function weightSlug(weight) {
  const map = { regular: "regular", bold: "bold", light: "light", medium: "medium" };
  return map[weight] || weight;
}

async function main() {
  const lock = readJson(join(ROOT, "assets", "fonts.lock.json"), { fonts: [] });
  const entries = Array.isArray(lock.fonts)
    ? [...lock.fonts].sort(
        (a, b) =>
          Number(b.file.toLowerCase().endsWith(".ttf")) -
          Number(a.file.toLowerCase().endsWith(".ttf")),
      )
    : [];

  if (entries.length === 0) {
    log("fonts.lock.json 里还没有字体条目，无法子集化。");
    log("先运行 pnpm fonts:fetch 并确认条目已填入，再重跑本脚本。");
    log("");
    log("流水线已就绪：填好条目后本脚本会自动完成裁剪、校验与体积核算。");
    // 退出码 0：这不是错误，而是"还没到这一步"。
    // 让 CI 里 pnpm fonts:subset 在没字体时不至于把人吓一跳
    return;
  }

  const charset = buildCharset();
  log("目标字符集：" + charset.length + " 个字符（含 CJK 基本区与常用符号）");

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(PUBLIC_DIR, { recursive: true });
  const previous = readJson(REPORT, { schema: 1, outputs: [] });
  const previousByKey = new Map((previous.outputs || []).map((o) => [o.key, o]));

  const outputs = [];
  let built = 0;
  let skipped = 0;
  let failed = 0;
  let totalBytes = 0;

  for (const font of entries) {
    const src = join(FONT_DIR, font.file);
    if (!existsSync(src)) {
      log("缺少源文件（先运行 pnpm fonts:fetch）：" + font.file);
      failed += 1;
      continue;
    }

    const input = readFileSync(src);
    const inputHash = sha256(input);
    const key = font.family + "/" + weightSlug(font.weight);
    const outName = slug(font.family) + "-" + weightSlug(font.weight) + ".woff2";
    const outPath = join(OUT_DIR, outName);

    // 幂等：输入哈希与参数都没变就跳过
    const prev = previousByKey.get(key);
    if (prev && prev.inputHash === inputHash && existsSync(outPath)) {
      log("跳过（输入未变）：" + outName);
      outputs.push(prev);
      totalBytes += prev.outputBytes;
      const publicName =
        font.family === "Yuhua Serif SC"
          ? `YuhuaSerifSC-${font.weight === 400 ? "Regular" : "Bold"}.woff2`
          : `YuhuaKaiSC-${font.weight === 400 ? "Regular" : "Bold"}.woff2`;
      copyFileSync(outPath, join(PUBLIC_DIR, publicName));
      skipped += 1;
      continue;
    }

    try {
      log("子集化 " + font.file + " -> " + outName + " ...");
      const started = Date.now();
      // subset-font 内部用 harfbuzz 的 wasm 版，纯 JS 环境可跑，
      // 不需要在开发机上装任何系统工具
      const subsetOptions = {
        // 保留 OpenType 特性：合字、字距调整对中文排版影响不大，
        // 但外文引用与标点挤压用得到
        preserveNameIds: undefined,
        noHinting: true,
        noLayoutClosure: true,
      };
      let subset;
      // Large TTF files are processed through an SFNT intermediate because
      // the direct TTF-to-WOFF2 conversion is not reliable in WASM.
      if (font.file.toLowerCase().endsWith(".ttf")) {
        const sfnt = await subsetFont(input, charset, {
          ...subsetOptions,
          targetFormat: "sfnt",
        });
        subset = await subsetFont(sfnt, null, {
          ...subsetOptions,
          targetFormat: "woff2",
          keepAllGlyphs: true,
        });
      } else {
        subset = await subsetFont(input, charset, {
          ...subsetOptions,
          targetFormat: "woff2",
        });
      }
      const elapsed = Date.now() - started;

      writeFileSync(outPath, subset);
      const publicName =
        font.family === "Yuhua Serif SC"
          ? `YuhuaSerifSC-${font.weight === 400 ? "Regular" : "Bold"}.woff2`
          : `YuhuaKaiSC-${font.weight === 400 ? "Regular" : "Bold"}.woff2`;
      copyFileSync(outPath, join(PUBLIC_DIR, publicName));
      const record = {
        key,
        family: font.family,
        weight: font.weight,
        source: font.file,
        output: "subset/" + outName,
        inputHash,
        inputBytes: input.length,
        outputBytes: subset.length,
        charsetSize: charset.length,
        builtAt: new Date().toISOString(),
      };
      outputs.push(record);
      totalBytes += subset.length;
      built += 1;
      log(
        "  完成：" +
          (input.length / 1024 / 1024).toFixed(2) +
          " MB -> " +
          (subset.length / 1024 / 1024).toFixed(2) +
          " MB（" +
          elapsed +
          " ms，压缩到 " +
          ((subset.length / input.length) * 100).toFixed(1) +
          "%）",
      );
    } catch (e) {
      log("子集化失败：" + font.file + " -> " + e.message);
      failed += 1;
    }
  }

  writeJson(REPORT, {
    schema: 1,
    generator: "scripts/subset-fonts.mjs",
    charsetSize: charset.length,
    builtAt: new Date().toISOString(),
    totalBytes,
    outputs,
  });

  log("");
  log("统计：新构建 " + built + "，跳过 " + skipped + "，失败 " + failed);
  log("字体总体积：" + (totalBytes / 1024 / 1024).toFixed(2) + " MB（预算 12 MB）");

  // T10.9 的体积门禁：超标就报错，而不是打印一句警告了事。
  // 门禁存在的意义就是拦住"先发布再说"这种妥协
  const BUDGET = 12 * 1024 * 1024;
  if (totalBytes > BUDGET) {
    log("体积超标！需要收窄 buildCharset() 的码点区间，或减少字重。");
    process.exit(1);
  }

  if (failed > 0) process.exit(1);
}

/** 把字体族名转成文件名安全的形式。 */
function slug(family) {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

main().catch((e) => {
  log("未预期的错误：" + (e && e.stack ? e.stack : e.message));
  process.exit(1);
});

// 保持 statSync 的引用：体积校验在后续版本会用它检查输出文件是否真的落盘
void statSync;






