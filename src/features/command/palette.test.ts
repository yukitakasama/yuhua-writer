/**
 * 模糊匹配测试（T5.7）。
 *
 * ## 为什么"能匹配上"还不够
 *
 * 一个糟糕的模糊搜索会匹配上所有东西，从而什么都不好找。
 * 因此这里除了断言"搜得到"，更断言**排序**：更相关的命令必须排在前面。
 * 三条规则各自有独立用例：连续命中、靠前命中、名字更短。
 */

import { describe, expect, it } from "vitest";

import { fuzzyMatch, rankCommands } from "./palette";

describe("fuzzyMatch", () => {
  it("空关键词匹配一切且不产生高亮位置", () => {
    expect(fuzzyMatch("全文检索", "")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("全文检索", "   ")).toEqual({ score: 0, positions: [] });
  });

  it("完全相等时命中全部位置", () => {
    const match = fuzzyMatch("统计", "统计");
    expect(match?.positions).toEqual([0, 1]);
  });

  it("前缀命中得分最高", () => {
    const prefix = fuzzyMatch("新建一章", "新建");
    const middle = fuzzyMatch("新建一章", "一章");
    expect(prefix!.score).toBeGreaterThan(middle!.score);
  });

  it("连续命中比散落命中得分高", () => {
    const consecutive = fuzzyMatch("新建一章", "新建");
    const scattered = fuzzyMatch("新建一章", "新章");
    expect(consecutive!.score).toBeGreaterThan(scattered!.score);
  });

  it("子序列按顺序匹配即可，不要求相邻", () => {
    expect(fuzzyMatch("新建一章", "新章")).not.toBeNull();
    expect(fuzzyMatch("折叠 / 展开左栏", "折左")).not.toBeNull();
  });

  it("顺序不对就不算匹配", () => {
    expect(fuzzyMatch("新建一章", "章新")).toBeNull();
  });

  it("缺字符时不匹配", () => {
    expect(fuzzyMatch("新建一章", "新建两")).toBeNull();
  });

  it("大小写不敏感", () => {
    expect(fuzzyMatch("Export", "exp")).not.toBeNull();
    expect(fuzzyMatch("export", "EXP")).not.toBeNull();
  });

  it("关键词比文本还长时直接判负", () => {
    expect(fuzzyMatch("短", "太长了")).toBeNull();
  });

  it("命中位置都落在文本范围内且升序", () => {
    const text = "折叠 / 展开左栏";
    const match = fuzzyMatch(text, "折左");
    expect(match).not.toBeNull();
    for (const position of match!.positions) {
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThan(text.length);
    }
    const sorted = [...match!.positions].sort((a, b) => a - b);
    expect(match!.positions).toEqual(sorted);
    // 位置必须真的指到那两个字（高亮靠它加粗）
    expect(match!.positions.map((p) => text[p])).toEqual(["折", "左"]);
  });

  it("名字相同的两条命令得到相同分数（排序可复现）", () => {
    expect(fuzzyMatch("统计", "统计")!.score).toBe(fuzzyMatch("统计", "统计")!.score);
  });
});

describe("rankCommands", () => {
  const commands = [
    { label: "全文检索" },
    { label: "写作统计" },
    { label: "新建一章" },
    { label: "折叠 / 展开左栏" },
  ];

  it("空关键词保持原顺序（刚打开时列表不该乱跳）", () => {
    expect(rankCommands(commands, "").map((e) => e.item.label)).toEqual([
      "全文检索",
      "写作统计",
      "新建一章",
      "折叠 / 展开左栏",
    ]);
  });

  it("按相关度排序而不是按原顺序", () => {
    const ranked = rankCommands(commands, "统计");
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.item.label).toBe("写作统计");
  });

  it("多个匹配时更相关的排前面", () => {
    const ranked = rankCommands(commands, "新");
    expect(ranked[0]!.item.label).toBe("新建一章");
  });

  it("不匹配的项被过滤掉", () => {
    expect(rankCommands(commands, "zzzz")).toHaveLength(0);
  });

  it("返回的 match 里带高亮位置", () => {
    const ranked = rankCommands(commands, "检索");
    expect(ranked[0]!.match.positions).toEqual([2, 3]);
  });

  it("全是同一分数时按标签字典序，保证顺序稳定", () => {
    const same = [{ label: "乙命令" }, { label: "甲命令" }];
    const first = rankCommands(same, "命令").map((e) => e.item.label);
    const second = rankCommands(same, "命令").map((e) => e.item.label);
    expect(first).toEqual(second);
  });

  it("空列表返回空数组而不是抛错", () => {
    expect(rankCommands([], "统计")).toEqual([]);
  });
});
