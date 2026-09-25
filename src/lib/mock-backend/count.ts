/**
 * mock 后端的字数统计。
 *
 * ## 为什么要照抄 Rust 的规则
 *
 * 如果 mock 用 `str.length` 糊弄过去，浏览器预览下的字数会和
 * Tauri 里跑出来的不一样，这会让「字数对不对」这种问题变得无法判断
 * —— 到底是 UI 显示错了，还是 mock 不准？
 *
 * 因此这里实现与 `yuhua-core/count.rs` **同一套规则**：
 * 汉字逐字、标点按口径取舍、连续英文算一个词。
 * 它不是一份独立实现，而是一份刻意保持同步的镜像。
 */

import type { CountMode, WordCount } from "../ipc/types";

/** 判断是否为逐字计数的 CJK 字符（覆盖汉字、假名、韩文）。 */
export function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // 平假名 / 片假名
    (cp >= 0x31f0 && cp <= 0x31ff) || // 片假名语音扩展
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0xff66 && cp <= 0xff9f) || // 半角片假名
    (cp >= 0xac00 && cp <= 0xd7af) || // 韩文音节
    (cp >= 0x1100 && cp <= 0x11ff) || // 韩文字母
    (cp >= 0x20000 && cp <= 0x2fa1f) || // CJK 扩展 B-F
    (cp >= 0x30000 && cp <= 0x3134f) // CJK 扩展 G
  );
}

/** 判断是否为字母或数字（非 CJK）。 */
function isWordChar(cp: number): boolean {
  if (isCjk(cp)) return false;
  const ch = String.fromCodePoint(cp);
  return /[\p{L}\p{N}]/u.test(ch);
}

/** 判断是否为标点（非空白、非字母数字、非 CJK）。 */
function isPunctuation(cp: number, ch: string): boolean {
  if (/\s/.test(ch)) return false;
  if (isCjk(cp)) return false;
  return !isWordChar(cp);
}

/**
 * 统计一段文本的字数，一次产出三套口径。
 *
 * 单次遍历，与 Rust 侧 `count_words` 的实现逐条对应，
 * 包括「空行不产生段落」「结尾换行不额外加段落」这些细节。
 */
export function countWords(text: string): WordCount {
  const out: WordCount = {
    withPunctuation: 0,
    withoutPunctuation: 0,
    wordsForEnglish: 0,
    hanChars: 0,
    paragraphs: 0,
  };

  let inLatinWord = false;
  let hasContentInParagraph = false;

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;

    if (ch === "\n") {
      if (hasContentInParagraph) {
        out.paragraphs += 1;
        hasContentInParagraph = false;
      }
      inLatinWord = false;
      continue;
    }

    if (!/\s/.test(ch)) hasContentInParagraph = true;

    if (isCjk(cp)) {
      out.hanChars += 1;
      out.withPunctuation += 1;
      out.withoutPunctuation += 1;
      out.wordsForEnglish += 1;
      inLatinWord = false;
    } else if (isWordChar(cp)) {
      out.withPunctuation += 1;
      out.withoutPunctuation += 1;
      if (!inLatinWord) {
        out.wordsForEnglish += 1;
        inLatinWord = true;
      }
    } else if (isPunctuation(cp, ch)) {
      out.withPunctuation += 1;
      inLatinWord = false;
    } else {
      inLatinWord = false;
    }
  }

  if (hasContentInParagraph) out.paragraphs += 1;
  return out;
}

/** 按口径取字数。 */
export function countByMode(text: string, mode: CountMode): number {
  const c = countWords(text);
  switch (mode) {
    case "withPunctuation":
      return c.withPunctuation;
    case "withoutPunctuation":
      return c.withoutPunctuation;
    case "wordsForEnglish":
      return c.wordsForEnglish;
  }
}
