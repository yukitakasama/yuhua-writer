/**
 * 检索面板的纯逻辑测试（T6.1 / T6.2）。
 *
 * ## 为什么要单独测高亮切分
 *
 * 高亮是「用户正文 → JSX」这条路径上唯一的出口，出错的后果分两类：
 *
 * - **漏切**：关键词没高亮 —— 用户以为没搜到，其实只是没标记
 * - **切错**：区间重叠或字符下标算错 —— JSX 会渲染出重复或缺失的文本，
 *   用户看到的正文与真实内容不一致，这是更严重的问题
 *
 * 中文字符的区间尤其容易错：Rust 的字节下标与 JS 的字符下标差 3 倍。
 * 这里用中英混排的用例把这条边界钉死。
 */

import { describe, expect, it } from "vitest";

import { findHitOffset, mergeRanges, splitHighlight } from "./highlight";

describe("区间归一", () => {
  it("空区间被丢弃", () => {
    expect(
      mergeRanges(
        [
          [3, 3],
          [5, 2],
        ],
        10,
      ),
    ).toEqual([]);
  });

  it("乱序区间会被排序", () => {
    expect(
      mergeRanges(
        [
          [5, 7],
          [1, 3],
        ],
        10,
      ),
    ).toEqual([
      [1, 3],
      [5, 7],
    ]);
  });

  it("重叠区间合并成一个", () => {
    expect(
      mergeRanges(
        [
          [1, 5],
          [3, 8],
        ],
        10,
      ),
    ).toEqual([[1, 8]]);
  });

  it("相邻区间也合并（否则高亮会中间开裂）", () => {
    expect(
      mergeRanges(
        [
          [0, 2],
          [2, 4],
        ],
        10,
      ),
    ).toEqual([[0, 4]]);
  });

  it("超出文本长度的区间被夹紧", () => {
    expect(mergeRanges([[8, 99]], 10)).toEqual([[8, 10]]);
    expect(mergeRanges([[-5, 3]], 10)).toEqual([[0, 3]]);
  });

  it("结果按起点升序且互不重叠", () => {
    const merged = mergeRanges(
      [
        [0, 3],
        [1, 2],
        [5, 6],
        [4, 7],
      ],
      10,
    );
    for (let i = 1; i < merged.length; i += 1) {
      expect(merged[i]![0]).toBeGreaterThanOrEqual(merged[i - 1]![1]);
    }
  });
});

describe("高亮切分", () => {
  it("没有区间时返回单个非命中段", () => {
    expect(splitHighlight("一段文字", [])).toEqual([
      { text: "一段文字", hit: false },
    ]);
  });

  it("命中区间切成三段", () => {
    expect(splitHighlight("前后中间后", [[2, 4]])).toEqual([
      { text: "前后", hit: false },
      { text: "中间", hit: true },
      { text: "后", hit: false },
    ]);
  });

  it("命中在开头与结尾时不产生空段", () => {
    expect(splitHighlight("开始文字", [[0, 2]])).toEqual([
      { text: "开始", hit: true },
      { text: "文字", hit: false },
    ]);
    expect(splitHighlight("文字结尾", [[2, 4]])).toEqual([
      { text: "文字", hit: false },
      { text: "结尾", hit: true },
    ]);
  });

  it("多个命中各自成段", () => {
    const segments = splitHighlight("雨夜雨", [
      [0, 1],
      [2, 3],
    ]);
    expect(segments.filter((s) => s.hit)).toHaveLength(2);
  });

  it("重叠区间不会切出重复文本", () => {
    const segments = splitHighlight("哈哈哈", [
      [0, 2],
      [1, 3],
    ]);
    // 拼回去必须与原文完全一致：这是"没有丢字也没有重复"的唯一硬标准
    expect(segments.map((s) => s.text).join("")).toBe("哈哈哈");
  });

  it("切分结果拼回去永远等于原文", () => {
    const text = "他说：「雨停了。」然后转身。";
    for (const ranges of [
      [] as Array<[number, number]>,
      [[0, 2]] as Array<[number, number]>,
      [
        [2, 6],
        [8, 10],
      ] as Array<[number, number]>,
      [[0, text.length]] as Array<[number, number]>,
    ]) {
      expect(
        splitHighlight(text, ranges)
          .map((s) => s.text)
          .join(""),
      ).toBe(text);
    }
  });

  it("中文区间按字符而不是字节切", () => {
    // 后端给的是字符区间（IPC 层已从字节转过）。
    // 若这里误按字节处理，"雨夜"会切成半个汉字
    const segments = splitHighlight("雨夜之后", [[0, 2]]);
    expect(segments[0]).toEqual({ text: "雨夜", hit: true });
  });
});

describe("命中偏移定位（T6.2）", () => {
  it("关键词在正文里时返回它的位置", () => {
    const body = "雨下了整整一夜，屋檐下的水声始终没有停过。";
    expect(findHitOffset(body, "屋檐下的水声", "屋檐")).toBe(8);
  });

  it("片段中含换行（被压平成空格）时仍能找到", () => {
    // 正文第 3 个字符是换行，片段里被压成了空格 —— 位置映射不能因为
    // 这个替换而漂移，否则跳转会落到前一行的中间
    const body = "第一段\n第二段的关键词在这里";
    const snippet = "第一段 第二段的关键词在这里";
    expect(findHitOffset(body, snippet, "关键词")).toBe(8);
  });

  it("关键词跨换行时返回换行后的起始位置", () => {
    const body = "前面\n关键词后面";
    // 片段是压平后的形式，关键词在片段里是连续的
    expect(findHitOffset(body, "前面 关键词后面", "关键词")).toBe(3);
  });

  it("空关键词回到 0", () => {
    expect(findHitOffset("正文", "片段", "")).toBe(0);
    expect(findHitOffset("正文", "片段", "   ")).toBe(0);
  });

  it("找不到时回到 0 而不是跳到随机位置", () => {
    expect(findHitOffset("完全无关的正文", "另一个片段", "关键词")).toBe(0);
  });
});
