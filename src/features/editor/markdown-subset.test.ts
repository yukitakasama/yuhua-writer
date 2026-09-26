import { describe, expect, it } from "vitest";

import {
  MARKDOWN_SUBSET,
  FIRST_CLASS_SYNTAXES,
  DEGRADED_SYNTAXES,
  MARKDOWN_MARKERS,
  isMarkdownMarker,
} from "./markdown-subset";

/**
 * 冻结子集表的测试（T4.15，防 R17）。
 *
 * ## 为什么这张"纯数据表"也要测试
 *
 * 因为它是**三处共用的唯一真相来源**：编辑器的高亮、导出器的
 * 解析选项、以及 Rust 侧的 `subset_consistency.rs` 都锚定它。
 * 表本身写错了（少一种语法、把降级的标成支持），三处会一起错，
 * 而且错得很安静 —— 直到作者的稿子在导出时丢了格式。
 *
 * 这里的断言与 Rust 侧的 `subset_consistency.rs` **成对**：
 * 那边断言"Rust 解析器对这 18 种语法的行为"，
 * 这边断言"表本身符合计划书 9.3 节"。
 */

describe("冻结子集：表的结构", () => {
  it("恰好 16 种语法（计划书 9.3 节的 12 种 + 4 种需降级的扩展）", () => {
    expect(MARKDOWN_SUBSET.length).toBe(16);
  });

  it("12 种一等公民 + 4 种会降级", () => {
    expect(FIRST_CLASS_SYNTAXES.length).toBe(12);
    expect(DEGRADED_SYNTAXES.length).toBe(4);
  });

  it("语法名唯一", () => {
    const names = MARKDOWN_SUBSET.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("每条规则都有名字与写法示例", () => {
    for (const rule of MARKDOWN_SUBSET) {
      expect(rule.name.length).toBeGreaterThan(0);
      expect(rule.syntax.length).toBeGreaterThan(0);
    }
  });

  it("会降级的语法必须写明降级行为（否则作者不知道会丢什么）", () => {
    for (const rule of MARKDOWN_SUBSET.filter((r) => !r.firstClass)) {
      expect(rule.degradation).toBeTruthy();
      expect(rule.degradation?.length).toBeGreaterThan(0);
    }
  });

  it("一等公民语法不需要降级说明", () => {
    for (const rule of MARKDOWN_SUBSET.filter((r) => r.firstClass)) {
      expect(rule.degradation).toBeUndefined();
    }
  });
});

describe("冻结子集：内容覆盖", () => {
  it("覆盖计划书 9.3 节列出的全部语法", () => {
    const names = MARKDOWN_SUBSET.map((r) => r.name);
    const required = [
      "标题",
      "段落",
      "粗体",
      "斜体",
      "引用",
      "无序列表",
      "有序列表",
      "分隔线",
      "链接",
      "图片",
      "行内代码",
      "代码块",
    ];
    for (const name of required) {
      expect(names).toContain(name);
    }
  });

  it("把删除线、任务列表、表格、脚注归为降级（不是一等公民）", () => {
    // 这四种正是 R17 的高风险项：编辑器能打出来、但导出会降级。
    // 若有人把它们标成 firstClass，导出侧就会出现"说了支持却没支持"
    for (const name of ["删除线", "任务列表", "表格", "脚注"]) {
      expect(DEGRADED_SYNTAXES).toContain(name);
    }
  });

  it("一等公民与降级集合无交集", () => {
    for (const name of FIRST_CLASS_SYNTAXES) {
      expect(DEGRADED_SYNTAXES).not.toContain(name);
    }
  });
});

describe("标记字符", () => {
  it("包含全部 Markdown 标记", () => {
    for (const ch of ["#", "*", "_", ">", "-", "+", "~", "`", "[", "]", "(", ")", "!", "|"]) {
      expect(MARKDOWN_MARKERS).toContain(ch);
    }
  });

  it("isMarkdownMarker 能识别标记", () => {
    expect(isMarkdownMarker("#")).toBe(true);
    expect(isMarkdownMarker("*")).toBe(true);
    expect(isMarkdownMarker("~")).toBe(true);
  });

  it("isMarkdownMarker 拒绝普通文字", () => {
    expect(isMarkdownMarker("甲")).toBe(false);
    expect(isMarkdownMarker("a")).toBe(false);
    expect(isMarkdownMarker("，")).toBe(false);
    expect(isMarkdownMarker(" ")).toBe(false);
  });

  it("标记字符本身不是多字符字符串", () => {
    // 若有人不小心写成 "**" 这样的两字符项，includes 判断会给出错误结果
    for (const marker of MARKDOWN_MARKERS) {
      expect([...marker].length).toBe(1);
    }
  });
});
