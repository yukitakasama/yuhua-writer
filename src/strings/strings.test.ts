/**
 * 文案完整性测试（T0.13 的验收条件）。
 *
 * ## 测什么、为什么
 *
 * 文案集中化的价值有一半来自"它可被遍历"。这些用例检查的是
 * **只有集中管理才能发现的问题**：
 *
 * - 有没有空字符串（界面上会出现一个没有文字的按钮）
 * - 有没有键漏配（t() 会返回键名本身，用户看到 "chapters.emptyTitle"）
 * - 占位符是否两边一致（`{count}` 与调用点传的参数名对不上）
 * - 是否有 emoji（全仓硬约定禁止）
 *
 * 最后一条特别值得单独测：emoji 很容易在复制粘贴文案时混进来，
 * 而代码审查常常看漏。
 */

import { describe, expect, it } from "vitest";

import zhCN from "./zh-CN";
import { DEFAULT_LOCALE, dictionary, interpolate, lookup, t } from "./index";

/** 把嵌套字典摊平成 "a.b.c" -> 值 的映射。 */
function flatten(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof obj !== "object" || obj === null) return out;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const ALL_STRINGS = flatten(zhCN);

describe("文案字典结构", () => {
  it("至少要有一百条文案（覆盖应用的主要界面）", () => {
    // 下限而不是精确值：加文案不应该让测试失败，但删到不足说明有遗漏
    expect(ALL_STRINGS.size).toBeGreaterThan(100);
  });

  it("没有任何空字符串值", () => {
    const empty = [...ALL_STRINGS.entries()].filter(([, v]) => v.trim().length === 0);
    expect(empty.map(([k]) => k)).toEqual([]);
  });

  it("值首尾没有多余空白", () => {
    const padded = [...ALL_STRINGS.entries()].filter(([, v]) => v !== v.trim());
    expect(padded.map(([k]) => k)).toEqual([]);
  });

  it("不含任何 emoji（全仓硬约定）", () => {
    // 覆盖面比 \u{1F600}-\u{1F64F} 宽：包含杂项符号、交通、旗帜、
    // 变体选择符等所有 Emoji 区段
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F2FF}]/u;
    const found = [...ALL_STRINGS.entries()].filter(([, v]) => emoji.test(v));
    expect(found.map(([k, v]) => `${k}: ${v}`)).toEqual([]);
  });

  it("不含 emoji 的肤色修饰符与零宽连接符", () => {
    const modifiers = /[\u{1F3FB}-\u{1F3FF}\u{200D}]/u;
    const found = [...ALL_STRINGS.entries()].filter(([, v]) => modifiers.test(v));
    expect(found.map(([k]) => k)).toEqual([]);
  });
});

describe("必需覆盖的文案类别", () => {
  /** 计划书与任务书明确要求至少覆盖的项。 */
  const required = [
    "app.name",
    "action.create",
    "action.rename",
    "action.remove",
    "action.cancel",
    "action.confirm",
    "toolbar.newVolume",
    "toolbar.newChapter",
    "toolbar.search",
    "toolbar.settings",
    "chapters.emptyTitle",
    "chapters.emptyBody",
    "chapters.addChapter",
    "chapters.addVolume",
    "library.emptyTitle",
    "library.newWorkspace",
    "library.recent",
    "status.draft",
    "status.done",
    "status.revising",
    "wordCount.thisChapter",
    "wordCount.thisVolume",
    "wordCount.thisBook",
    "error.noWorkspace",
    "error.notFound",
    "error.generic",
  ];

  it.each(required)("存在非空文案：%s", (key) => {
    const value = lookup(key);
    expect(value, `缺少文案键 ${key}`).toBeTypeOf("string");
    expect(value?.trim().length).toBeGreaterThan(0);
  });

  it("三个写作状态都有中文名，且互不相同", () => {
    const values = [t("status.draft"), t("status.done"), t("status.revising")];
    expect(values).toEqual(["草稿", "已完成", "修订中"]);
    expect(new Set(values).size).toBe(3);
  });

  it("三套字数口径都有标签", () => {
    expect(t("wordCount.withPunctuation")).toBe("含标点");
    expect(t("wordCount.withoutPunctuation")).toBe("不含标点");
    expect(t("wordCount.wordsForEnglish")).toBe("英文按词");
  });
});

describe("查找与插值", () => {
  it("lookup 按键路径取到值", () => {
    expect(lookup("app.name")).toBe("羽化写作");
  });

  it("lookup 对不存在的键返回 undefined 而不是抛异常", () => {
    expect(lookup("不存在.的键")).toBeUndefined();
    expect(lookup("")).toBeUndefined();
    expect(lookup("app")).toBeUndefined(); // 中间节点不是字符串
  });

  it("t() 对不存在的键回退为键名本身，便于定位漏配", () => {
    // 用 as 绕过编译期检查：这里刻意测试运行时的兜底路径
    const value = t("不存在的键" as never);
    expect(value).toBe("不存在的键");
  });

  it("t() 做 {name} 插值", () => {
    expect(t("library.chapterCount", { count: 12 })).toBe("12 章");
  });

  it("interpolate 保留未知占位符，方便发现漏传的参数", () => {
    expect(interpolate("找到 {count} 条，共 {total} 页", { count: 3 })).toBe("找到 3 条，共 {total} 页");
  });

  it("interpolate 支持数字与字符串", () => {
    expect(interpolate("{a}-{b}", { a: 1, b: "x" })).toBe("1-x");
  });

  it("interpolate 对空参数对象返回原文", () => {
    expect(interpolate("没有占位符", {})).toBe("没有占位符");
  });

  it("中文插值结果不含转义残留", () => {
    const value = t("chapters.defaultVolumeName", { index: "三" });
    expect(value).toBe("第三卷");
    expect(value).not.toContain("{");
  });
});

describe("多语言结构", () => {
  it("默认语言是简体中文", () => {
    expect(DEFAULT_LOCALE).toBe("zh-CN");
  });

  it("字典可取，且与 zh-CN 是同一份", () => {
    expect(dictionary()).toBe(zhCN);
    expect(dictionary("zh-CN")).toBe(zhCN);
  });

  it("所有带占位符的文案，占位符写法合法（只有字母数字下划线）", () => {
    const bad: string[] = [];
    for (const [key, value] of ALL_STRINGS) {
      const matches = value.matchAll(/\{([^}]*)\}/g);
      for (const m of matches) {
        const name = m[1] ?? "";
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) bad.push(`${key}: {${name}}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("没有未闭合的花括号（会让插值正则静默失效）", () => {
    const bad: string[] = [];
    for (const [key, value] of ALL_STRINGS) {
      const opens = (value.match(/\{/g) ?? []).length;
      const closes = (value.match(/\}/g) ?? []).length;
      if (opens !== closes) bad.push(key);
    }
    expect(bad).toEqual([]);
  });
});
