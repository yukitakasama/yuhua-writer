import { describe, expect, it } from "vitest";

import {
  CURSOR_STORE_LIMIT,
  captureCursor,
  isCursorResolvable,
  recallCursor,
  rememberCursor,
  resolveCursor,
  type ChapterCursor,
  type CursorStore,
} from "./cursor-memory";

/** 造一条记录。 */
function cursor(anchor: number, text: string, line = 1): ChapterCursor {
  return captureCursor(text, anchor, anchor, line);
}

describe("光标记忆：捕获", () => {
  it("锚点取光标之后的若干字符", () => {
    const text = "他只是走过去，什么也没说。后面还有很多字。";
    const c = captureCursor(text, 5, 5, 1);
    expect(text.slice(5, 5 + c.textAnchor.length)).toBe(c.textAnchor);
    expect(c.textAnchor.length).toBeGreaterThan(0);
  });

  it("锚点长度有上限", () => {
    const text = "甲".repeat(500);
    const c = captureCursor(text, 0, 0, 1);
    expect(c.textAnchor.length).toBe(32);
  });

  it("光标在文末时锚点为空", () => {
    const text = "短文本";
    const c = captureCursor(text, text.length, text.length, 1);
    expect(c.textAnchor).toBe("");
  });

  it("光标越界会被夹紧而不是抛错", () => {
    const text = "短";
    expect(() => captureCursor(text, 9999, 9999, 1)).not.toThrow();
    const c = captureCursor(text, 9999, 9999, 1);
    expect(c.textAnchor).toBe("");
  });

  it("选区（anchor ≠ head）被完整保留", () => {
    const text = "一二三四五六七八九十";
    const c = captureCursor(text, 2, 6, 1);
    expect(c.anchor).toBe(2);
    expect(c.head).toBe(6);
  });
});

describe("光标记忆：解析", () => {
  const text = "第一章的正文内容，后面还有更多。";

  it("锚点仍然存在时精确恢复", () => {
    const c = cursor(0, text);
    expect(resolveCursor(text, c)).toBe(0);
  });

  it("前面插入文字后跟着内容走", () => {
    const original = "他只是走过去。";
    const c = captureCursor(original, 3, 3, 1);
    // 作者回头在最前面补了一段
    const modified = "补充的一段。" + original;
    const resolved = resolveCursor(modified, c);
    // 应当落在"走过去"的"走"上，也就是原偏移 3 加上插入长度
    expect(resolved).toBe(3 + "补充的一段。".length);
    expect(modified.slice(resolved, resolved + c.textAnchor.length)).toBe(c.textAnchor);
  });

  it("前面删除文字后跟着内容走", () => {
    const original = "甲乙丙丁戊己庚辛";
    const c = captureCursor(original, 4, 4, 1);
    const modified = original.slice(2);
    const resolved = resolveCursor(modified, c);
    expect(modified.slice(resolved, resolved + c.textAnchor.length)).toBe(c.textAnchor);
  });

  it("锚点丢失时退回偏移并夹紧", () => {
    const c = captureCursor("原始文本内容", 4, 4, 1);
    const totallyDifferent = "完全不同的另一段";
    const resolved = resolveCursor(totallyDifferent, c);
    expect(resolved).toBeGreaterThanOrEqual(0);
    expect(resolved).toBeLessThanOrEqual(totallyDifferent.length);
  });

  it("偏移越界时夹到文末而不是报错", () => {
    const c: ChapterCursor = { anchor: 99999, head: 99999, textAnchor: "不存在的锚", line: 1 };
    expect(resolveCursor("短", c)).toBe(1);
  });

  it("空文档恢复为 0", () => {
    const c = captureCursor("", 0, 0, 1);
    expect(resolveCursor("", c)).toBe(0);
  });

  it("锚点文本在文中出现多次时取第一个（保守选择）", () => {
    // 重复的锚点无法区分，取第一个至少不会跳到文档之外
    const c = captureCursor("重复内容甲重复内容乙", 5, 5, 1);
    const resolved = resolveCursor("重复内容甲重复内容乙", c);
    expect(resolved).toBeGreaterThanOrEqual(0);
  });
});

describe("光标记忆：可用性判定", () => {
  it("锚点为空且文档为空 => 可用", () => {
    const c = captureCursor("", 0, 0, 1);
    expect(isCursorResolvable("", c)).toBe(true);
  });

  it("锚点为空但文档非空 => 不可用", () => {
    const c = captureCursor("原文", 2, 2, 1);
    const empty: ChapterCursor = { anchor: 0, head: 0, textAnchor: "", line: 1 };
    void c;
    expect(isCursorResolvable("有内容", empty)).toBe(false);
  });

  it("锚点还在 => 可用", () => {
    const c = cursor(0, "完整的一句话");
    expect(isCursorResolvable("完整的一句话", c)).toBe(true);
  });

  it("文档被完全改写 => 不可用", () => {
    const c = cursor(0, "原标题内容");
    expect(isCursorResolvable("全然不同", c)).toBe(false);
  });
});

describe("光标记忆：存储与淘汰", () => {
  it("能按章 ID 取回", () => {
    const store: CursorStore = new Map();
    rememberCursor(store, "ch_1", cursor(3, "第一章正文", 2));
    expect(recallCursor(store, "ch_1")?.anchor).toBe(3);
  });

  it("没存过的章返回 null", () => {
    const store: CursorStore = new Map();
    expect(recallCursor(store, "ch_missing")).toBeNull();
  });

  it("重复存同一章只保留最新", () => {
    const store: CursorStore = new Map();
    rememberCursor(store, "ch_1", cursor(1, "正文"));
    rememberCursor(store, "ch_1", cursor(2, "正文"));
    expect(store.size).toBe(1);
    expect(recallCursor(store, "ch_1")?.anchor).toBe(2);
  });

  it("超过上限时淘汰最旧的一条", () => {
    const store: CursorStore = new Map();
    for (let i = 0; i < CURSOR_STORE_LIMIT + 10; i += 1) {
      rememberCursor(store, `ch_${i}`, cursor(0, "正文"));
    }
    expect(store.size).toBe(CURSOR_STORE_LIMIT);
    // 最早的那几条应当被淘汰
    expect(recallCursor(store, "ch_0")).toBeNull();
    expect(recallCursor(store, `ch_${CURSOR_STORE_LIMIT + 9}`)).not.toBeNull();
  });

  it("重新访问会把记录移到最新（不被淘汰）", () => {
    const store: CursorStore = new Map();
    for (let i = 0; i < CURSOR_STORE_LIMIT; i += 1) {
      rememberCursor(store, `ch_${i}`, cursor(0, "正文"));
    }
    // 重新访问最早的那一条
    rememberCursor(store, "ch_0", cursor(9, "正文"));
    // 再塞一条，此时该被淘汰的应该是 ch_1 而不是 ch_0
    rememberCursor(store, "ch_new", cursor(0, "正文"));
    expect(recallCursor(store, "ch_0")).not.toBeNull();
    expect(recallCursor(store, "ch_1")).toBeNull();
  });

  it("上限是 500（够一本 300 章的书全量切换）", () => {
    expect(CURSOR_STORE_LIMIT).toBe(500);
  });
});
