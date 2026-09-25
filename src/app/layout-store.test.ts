/**
 * 窗口状态记忆测试（T5.1 的验收点）。
 *
 * 重点是**脏数据不能把界面搞坏**：localStorage 里可能存着上一版本的
 * 结构、越界的宽度、甚至是手改坏的 JSON。这些都必须安全回退。
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LAYOUT,
  LEFT_MAX,
  LEFT_MIN,
  RIGHT_MAX,
  RIGHT_MIN,
  effectiveLeftWidth,
  effectiveRightWidth,
  loadLayout,
  normalizeLayout,
  resetLayout,
  setLeftWidth,
  setRightWidth,
  toggleLeft,
  toggleRight,
  layout,
} from "./layout-store";
import { isFiniteNumber, isPlainObject, readJson, removeKey, writeJson } from "./persistent";

beforeEach(() => {
  window.localStorage.clear();
  resetLayout();
  window.localStorage.clear();
});

describe("normalizeLayout", () => {
  it("空输入返回默认布局", () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout({})).toEqual(DEFAULT_LAYOUT);
  });

  it("正常值被保留", () => {
    const result = normalizeLayout({ leftWidth: 320, rightWidth: 260, leftCollapsed: true, rightCollapsed: false, view: "workspace" });
    expect(result.leftWidth).toBe(320);
    expect(result.rightWidth).toBe(260);
    expect(result.leftCollapsed).toBe(true);
    expect(result.view).toBe("workspace");
  });

  it("过宽的左栏被夹到上限（换到小屏幕不会挤没编辑区）", () => {
    expect(normalizeLayout({ leftWidth: 9999 }).leftWidth).toBe(LEFT_MAX);
  });

  it("过窄的左栏被夹到下限", () => {
    expect(normalizeLayout({ leftWidth: 10 }).leftWidth).toBe(LEFT_MIN);
  });

  it("过宽的右栏被夹到上限", () => {
    expect(normalizeLayout({ rightWidth: 9999 }).rightWidth).toBe(RIGHT_MAX);
  });

  it("过窄的右栏被夹到下限", () => {
    expect(normalizeLayout({ rightWidth: 1 }).rightWidth).toBe(RIGHT_MIN);
  });

  it("NaN / Infinity 回退到默认值而不是产生 NaN 宽度", () => {
    expect(normalizeLayout({ leftWidth: Number.NaN }).leftWidth).toBe(DEFAULT_LAYOUT.leftWidth);
    expect(normalizeLayout({ leftWidth: Number.POSITIVE_INFINITY }).leftWidth).toBe(DEFAULT_LAYOUT.leftWidth);
  });

  it("字符串宽度被忽略（localStorage 里的值可能被手改）", () => {
    // 用 as never 绕过类型检查：这里刻意测试运行时对脏数据的容错
    expect(normalizeLayout({ leftWidth: "很宽" as never }).leftWidth).toBe(DEFAULT_LAYOUT.leftWidth);
  });

  it("非法 view 值回退到 library", () => {
    expect(normalizeLayout({ view: "乱写的" as never }).view).toBe("library");
  });

  it("非布尔值的折叠标记被忽略", () => {
    expect(normalizeLayout({ leftCollapsed: "yes" as never }).leftCollapsed).toBe(DEFAULT_LAYOUT.leftCollapsed);
  });

  it("宽度被取整（避免出现半像素导致模糊）", () => {
    expect(normalizeLayout({ leftWidth: 300.6 }).leftWidth).toBe(301);
  });
});

describe("setLeftWidth / setRightWidth", () => {
  it("设置左栏宽度", () => {
    setLeftWidth(320);
    expect(layout.leftWidth).toBe(320);
  });

  it("设置左栏宽度时自动夹紧", () => {
    setLeftWidth(9999);
    expect(layout.leftWidth).toBe(LEFT_MAX);
    setLeftWidth(-100);
    expect(layout.leftWidth).toBe(LEFT_MIN);
  });

  it("设置右栏宽度时自动夹紧", () => {
    setRightWidth(9999);
    expect(layout.rightWidth).toBe(RIGHT_MAX);
    setRightWidth(0);
    expect(layout.rightWidth).toBe(RIGHT_MIN);
  });

  it("宽度被持久化到 localStorage", () => {
    setLeftWidth(360);
    expect(loadLayout().leftWidth).toBe(360);
  });
});

describe("折叠", () => {
  it("切换左栏折叠状态", () => {
    const before = layout.leftCollapsed;
    toggleLeft();
    expect(layout.leftCollapsed).toBe(!before);
    toggleLeft();
    expect(layout.leftCollapsed).toBe(before);
  });

  it("切换右栏折叠状态", () => {
    const before = layout.rightCollapsed;
    toggleRight();
    expect(layout.rightCollapsed).toBe(!before);
  });

  it("折叠状态被持久化", () => {
    toggleLeft();
    const persisted = loadLayout();
    expect(persisted.leftCollapsed).toBe(layout.leftCollapsed);
  });

  it("折叠时有效宽度为 0", () => {
    resetLayout();
    setLeftWidth(300);
    expect(effectiveLeftWidth()).toBe(300);
    toggleLeft();
    expect(effectiveLeftWidth()).toBe(0);
  });

  it("右栏折叠时有效宽度为 0", () => {
    resetLayout();
    expect(effectiveRightWidth()).toBe(layout.rightWidth);
    toggleRight();
    expect(effectiveRightWidth()).toBe(0);
  });
});

describe("持久化往返", () => {
  it("resetLayout 恢复默认值", () => {
    setLeftWidth(400);
    toggleLeft();
    resetLayout();
    expect(layout.leftWidth).toBe(DEFAULT_LAYOUT.leftWidth);
    expect(layout.leftCollapsed).toBe(DEFAULT_LAYOUT.leftCollapsed);
  });

  it("localStorage 里是坏 JSON 时回退到默认而不抛异常", () => {
    window.localStorage.setItem("yuhua.layout.v1", "{ 不是 JSON");
    expect(() => loadLayout()).not.toThrow();
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("localStorage 里是数组时回退到默认", () => {
    window.localStorage.setItem("yuhua.layout.v1", "[1,2,3]");
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

describe("persistent 工具", () => {
  it("读写往返", () => {
    writeJson("test.key", { a: 1, b: "中文" });
    expect(readJson("test.key", null)).toEqual({ a: 1, b: "中文" });
  });

  it("键不存在时返回 fallback", () => {
    expect(readJson("不存在", "默认值")).toBe("默认值");
  });

  it("内容损坏时返回 fallback", () => {
    window.localStorage.setItem("yuhua.bad", "{{{{");
    expect(readJson("bad", "兜底")).toBe("兜底");
  });

  it("校验函数拒绝时返回 fallback", () => {
    writeJson("num", "字符串");
    expect(readJson("num", 0, isFiniteNumber)).toBe(0);
  });

  it("校验函数通过时返回真实值", () => {
    writeJson("num2", 42);
    expect(readJson("num2", 0, isFiniteNumber)).toBe(42);
  });

  it("removeKey 删除键", () => {
    writeJson("temp", 1);
    removeKey("temp");
    expect(readJson("temp", null)).toBeNull();
  });

  it("isPlainObject 排除数组与 null", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });

  it("isFiniteNumber 排除 NaN 与 Infinity", () => {
    expect(isFiniteNumber(1)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber("1")).toBe(false);
  });
});
