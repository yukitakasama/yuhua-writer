/**
 * IPC 绑定层测试。
 *
 * 重点验证**边界处的转换与降级**，而不是重复测 mock 的业务逻辑
 * （那是 mock-backend.test.ts 的职责）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetMockBackend, adaptSearchResults, byteRangesToCharRanges, isTauri, utf8Length } from "./index";
import { IpcFailure, isIpcError, normalizeError, toFailure } from "./errors";

beforeEach(() => {
  __resetMockBackend();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isTauri", () => {
  it("jsdom 里默认不是 Tauri 环境", () => {
    expect(isTauri()).toBe(false);
  });

  it("注入 __TAURI_INTERNALS__ 后判定为 Tauri", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    expect(isTauri()).toBe(true);
  });

  it("旧版本的 __TAURI__ 也能识别", () => {
    vi.stubGlobal("__TAURI__", {});
    expect(isTauri()).toBe(true);
  });
});

describe("错误归一化", () => {
  it("已经是标准形状的对象原样通过", () => {
    const error = { code: "IO_ERROR", message: "失败了", recoverable: true, detail: "底层原因" };
    expect(normalizeError(error)).toEqual(error);
  });

  it("Error 实例转成 INTERNAL", () => {
    const result = normalizeError(new Error("炸了"));
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("炸了");
    expect(result.recoverable).toBe(false);
  });

  it("字符串（Tauri 参数反序列化失败的情形）转成 INTERNAL", () => {
    const result = normalizeError("invalid args");
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toBe("invalid args");
  });

  it("缺字段的对象补上默认值", () => {
    const result = normalizeError({ code: "NOT_FOUND" });
    expect(result.code).toBe("NOT_FOUND");
    expect(result.message).toBe("未知错误");
    expect(result.recoverable).toBe(false);
  });

  it("null / undefined / 数字都能处理，不抛异常", () => {
    for (const value of [null, undefined, 42, true]) {
      const result = normalizeError(value);
      expect(result.code).toBe("INTERNAL");
      expect(typeof result.message).toBe("string");
    }
  });

  it("isIpcError 正确区分", () => {
    expect(isIpcError({ code: "A", message: "b", recoverable: true })).toBe(true);
    expect(isIpcError({ code: "A", message: "b" })).toBe(false);
    expect(isIpcError(null)).toBe(false);
    expect(isIpcError("字符串")).toBe(false);
  });

  it("toFailure 保留已有的 IpcFailure 实例", () => {
    const original = new IpcFailure({ code: "X", message: "y", recoverable: true, detail: null });
    expect(toFailure(original)).toBe(original);
  });

  it("toFailure 包装普通错误，且 code / recoverable 可读", () => {
    const failure = toFailure({ code: "IO_ERROR", message: "读文件失败", recoverable: true, detail: null });
    expect(failure).toBeInstanceOf(IpcFailure);
    expect(failure.code).toBe("IO_ERROR");
    expect(failure.recoverable).toBe(true);
    expect(failure.message).toBe("读文件失败");
  });
});

describe("utf8Length", () => {
  it("ASCII 是 1 字节", () => {
    expect(utf8Length("a")).toBe(1);
    expect(utf8Length("1")).toBe(1);
  });

  it("汉字是 3 字节", () => {
    expect(utf8Length("羽")).toBe(3);
    expect(utf8Length("写")).toBe(3);
  });

  it("拉丁扩展是 2 字节", () => {
    expect(utf8Length("é")).toBe(2);
  });

  it("emoji 是 4 字节（代理对）", () => {
    // 用码点构造而不是字面量：源码里出现 emoji 会违反全仓零 emoji 约定
    expect(utf8Length(String.fromCodePoint(0x1f600))).toBe(4);
  });
});

describe("byteRangesToCharRanges", () => {
  it("纯 ASCII 时字节与字符一致", () => {
    expect(byteRangesToCharRanges("hello world", [[0, 5]])).toEqual([[0, 5]]);
  });

  it("中文按字节区间正确转成字符区间", () => {
    // "羽化写作" 每个字 3 字节：羽=0-3, 化=3-6, 写=6-9, 作=9-12
    expect(byteRangesToCharRanges("羽化写作", [[3, 6]])).toEqual([[1, 2]]);
  });

  it("整段区间的转换", () => {
    expect(byteRangesToCharRanges("羽化写作", [[0, 12]])).toEqual([[0, 4]]);
  });

  it("空区间数组返回空结果", () => {
    expect(byteRangesToCharRanges("任意内容", [])).toEqual([]);
  });

  it("多个区间分别转换", () => {
    expect(byteRangesToCharRanges("羽化写作", [[0, 3], [9, 12]])).toEqual([[0, 1], [3, 4]]);
  });

  it("越界区间被夹紧，不产生负数或越界下标", () => {
    const result = byteRangesToCharRanges("羽化", [[100, 200]]);
    expect(result[0]?.[0]).toBeGreaterThanOrEqual(0);
    expect(result[0]?.[1]).toBeLessThanOrEqual(2);
  });

  it("中英混排时的转换", () => {
    // "羽a" -> 羽(0-3) a(3-4)
    expect(byteRangesToCharRanges("羽a化", [[3, 4]])).toEqual([[1, 2]]);
  });
});

describe("adaptSearchResults", () => {
  it("把字节区间换成字符区间", () => {
    const input = {
      hits: [
        {
          chapterId: "ch_1",
          title: "第一章",
          path: "a.md",
          volumeId: "vol_1",
          score: 1,
          snippets: [{ text: "羽化写作", ranges: [[3, 6]] as Array<[number, number]> }],
        },
      ],
      total: 1,
      limit: 30,
      offset: 0,
      tokens: ["羽"],
    };
    const out = adaptSearchResults(input);
    expect(out.hits[0]?.snippets[0]?.ranges).toEqual([[1, 2]]);
  });

  it("没有片段的命中不会被破坏", () => {
    const input = {
      hits: [{ chapterId: "c", title: "t", path: "p", volumeId: "v", score: 0, snippets: [] }],
      total: 1,
      limit: 30,
      offset: 0,
      tokens: [],
    };
    expect(adaptSearchResults(input).hits[0]?.snippets).toEqual([]);
  });

  it("保留其它字段不变", () => {
    const input = { hits: [], total: 7, limit: 10, offset: 3, tokens: ["a", "b"] };
    expect(adaptSearchResults(input)).toEqual(input);
  });
});

describe("降级到 mock 后端", () => {
  it("非 Tauri 环境下 listRecentWorkspaces 返回示例数据", async () => {
    const ipc = await import("./index");
    const recents = await ipc.listRecentWorkspaces();
    expect(recents.length).toBeGreaterThan(0);
    expect(recents[0]).toHaveProperty("root");
  });

  it("非 Tauri 环境下 openWorkspace 返回完整文档结构", async () => {
    const ipc = await import("./index");
    const result = await ipc.openWorkspace("C:/示例");
    expect(result.document.volumes.length).toBeGreaterThan(0);
    expect(result.document.book.title).toBeTruthy();
  });

  it("mock 的错误被包装成 IpcFailure", async () => {
    const ipc = await import("./index");
    await expect(ipc.renameVolume("vol_不存在", "x")).rejects.toBeInstanceOf(IpcFailure);
  });

  it("被包装的错误带有可分支的 code", async () => {
    const ipc = await import("./index");
    try {
      await ipc.renameChapter("ch_不存在", "x");
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(IpcFailure);
      expect((err as IpcFailure).code).toBe("NOT_FOUND");
    }
  });

  it("search 返回的区间是合法的字符区间且能切出关键词", async () => {
    const ipc = await import("./index");
    const result = await ipc.search({ keyword: "雨" });
    let checked = 0;
    for (const hit of result.hits) {
      for (const snippet of hit.snippets) {
        for (const [start, end] of snippet.ranges) {
          // 区间必须落在片段范围内，且起点不能超过终点
          expect(start).toBeGreaterThanOrEqual(0);
          expect(start).toBeLessThan(end);
          expect(end).toBeLessThanOrEqual(snippet.text.length);
          // 区间切出来的必须真的是关键词 —— 这是高亮的正确性底线
          expect(snippet.text.slice(start, end)).toBe("雨");
          checked++;
        }
      }
    }
    // 防止「循环一次都没进」让整个测试变成空跑
    expect(checked).toBeGreaterThan(0);
  });

  it("createWorkspace 走通并返回可用的文档", async () => {
    const ipc = await import("./index");
    const result = await ipc.createWorkspace("C:/新书", "测试新书");
    expect(result.document.book.title).toBe("测试新书");
    expect(result.document.volumes.length).toBe(1);
  });
});
