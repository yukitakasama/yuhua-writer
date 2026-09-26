/**
 * 命中片段的高亮切分（T6.1）。
 *
 * ## 为什么需要切分函数而不是直接 `replace`
 *
 * 用 `dangerouslySetInnerHTML` 拼 `<mark>` 是检索结果列表里最经典的
 * XSS 入口：片段来自用户的正文，正文里完全可以写出 `<script>`。
 * Solid 的 JSX 默认转义，所以正确做法是把片段切成
 * 「普通段 / 命中段」的数组交给 JSX 渲染，全程不碰 innerHTML。
 *
 * ## 区间是**字符**区间
 *
 * `HighlightSnippet.ranges` 在 IPC 层已经从 Rust 的字节区间转成了
 * 字符区间（见 lib/ipc/types.ts 的 `byteRangesToCharRanges`）。
 * 这里直接用 `String.prototype.slice` 即可 —— 中文字符在 JS 里是
 * 单个 UTF-16 码元，slice 不会切碎它。
 *
 * ## 重叠与乱序区间要归一
 *
 * 关键词在片段里重叠出现（「哈哈哈」找「哈哈」）或后端给了乱序区间时，
 * 直接按序遍历会切出负长度的片段。因此先排序、再合并重叠区间。
 */

/** 高亮片段的一段。 */
export interface Segment {
  /** 文本。 */
  text: string;
  /** 是否是命中部分。 */
  hit: boolean;
}

/** 一个字符区间（闭开，单位是 JS 字符串下标）。 */
export type Range = readonly [number, number];

/**
 * 把重叠或相邻的区间合并成不重叠的有序区间。
 *
 * 相邻也算合并（`[0,2]` 与 `[2,4]` 合成 `[0,4]`）：它们渲染出来
 * 是同一段高亮，分成两个 `<mark>` 会在视觉上出现一条缝隙。
 */
export function mergeRanges(ranges: readonly Range[], length: number): Array<[number, number]> {
  const valid = ranges
    .map(([start, end]) => [
      Math.max(0, Math.min(start, length)),
      Math.max(0, Math.min(end, length)),
    ] as [number, number])
    // 空区间（start >= end）直接丢弃，它们画不出任何东西
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: Array<[number, number]> = [];
  for (const [start, end] of valid) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * 把一段文本按命中区间切成若干段。
 *
 * 没有任何区间时返回单个「非命中」段，调用方不必分支处理 ——
 * 返回空数组会让渲染处出现一整块空白，那是比不高亮更糟的结果。
 */
export function splitHighlight(text: string, ranges: readonly Range[]): Segment[] {
  const merged = mergeRanges(ranges, text.length);
  if (merged.length === 0) return [{ text, hit: false }];

  const segments: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

/**
 * 在正文里定位第一次命中的字符偏移。
 *
 * ## 为什么要定位
 *
 * T6.2 要求「点结果 → 编辑器滚动到并闪烁高亮该位置」。检索结果只给了
 * **片段**（前后各 24 字的窗口），没给片段在正文里的绝对偏移，
 * 因此必须自己找回来。
 *
 * 策略分两级：
 * 1. 先用片段里的命中文字在正文中 `indexOf`。片段含换行压平，
 *    因此先试原文、再试把空白折叠后的形式。
 * 2. 都找不到时退回到 **0**，让编辑器至少停在章节开头而不是不跳。
 *
 * 这里刻意不做模糊匹配：跳错位置比跳到开头更让人困惑。
 */
export function findHitOffset(body: string, snippet: string, keyword: string): number {
  const needle = keyword.trim();
  if (needle.length === 0) return 0;

  const fromSnippet = locate(body, snippet, needle);
  if (fromSnippet >= 0) return fromSnippet;

  // 片段找不到（正文在这次检索之后被改过）：直接找关键词
  const direct = body.indexOf(needle);
  if (direct >= 0) return direct;

  // 关键词跨换行的情况：「HA\nHA」应当能匹配「HA HA」里的连续两个字
  const loose = body.replace(/\s+/g, "");
  const looseIndex = loose.indexOf(needle);
  if (looseIndex < 0) return 0;

  // 把「去掉空白后的下标」映射回原文下标
  let seen = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (/\s/.test(body[i] ?? "")) continue;
    if (seen === looseIndex) return i;
    seen += 1;
  }
  return 0;
}

/** 在一段片段里定位关键词，返回它在 body 中的绝对偏移；找不到返回 -1。 */
function locate(body: string, snippet: string, needle: string): number {
  const cleaned = snippet.replace(/[\s]+/g, " ").trim();
  if (cleaned.length === 0) return -1;

  // 用片段的前 12 个字当锚点：太短容易撞车，太长则正文稍有改动就找不到
  const anchor = cleaned.slice(0, Math.min(12, cleaned.length));
  const at = body.indexOf(anchor);
  if (at < 0) return -1;

  const inSnippet = cleaned.indexOf(needle);
  if (inSnippet < 0) return at;
  return at + inSnippet;
}
