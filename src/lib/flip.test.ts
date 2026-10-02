/**
 * FLIP 动效测试。
 *
 * ## jsdom 的限制与应对
 *
 * jsdom **不做布局**：所有 `getBoundingClientRect()` 都返回全 0。
 * 因此不能真的测"元素移动了多少像素"，但可以测**更重要的东西**：
 *
 * - 位移小于 1px 的元素是否被跳过（避免无意义的动画）
 * - `will-change` 是否在结束后被清理（计划书 5.4 的硬要求）
 * - `prefers-reduced-motion` 时是否完全不动画
 *
 * 这些正是"用一次就忘了清理"最容易出问题的地方。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  capturePositions,
  playFlip,
  prefersReducedMotion,
  withFlip,
} from "./flip";

/** 造一个带 flip id 的元素，并伪造它的位置。 */
function makeRow(
  id: string,
  top: number,
  left = 0,
  height = 28,
  width = 200,
): HTMLElement {
  const el = document.createElement("div");
  el.dataset["flipId"] = id;
  el.getBoundingClientRect = () =>
    ({
      top,
      left,
      height,
      width,
      bottom: top + height,
      right: left + width,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("capturePositions", () => {
  it("采集所有带 data-flip-id 的元素", () => {
    makeRow("a", 0);
    makeRow("b", 40);
    const snapshot = capturePositions();
    expect(snapshot.size).toBe(2);
    expect(snapshot.get("a")?.top).toBe(0);
    expect(snapshot.get("b")?.top).toBe(40);
  });

  it("没有 flip id 的元素被忽略", () => {
    const plain = document.createElement("div");
    document.body.appendChild(plain);
    expect(capturePositions().size).toBe(0);
  });

  it("空文档返回空快照", () => {
    expect(capturePositions().size).toBe(0);
  });

  it("忽略没有 id 的 data 属性", () => {
    const el = document.createElement("div");
    el.setAttribute("data-flip-id", "");
    document.body.appendChild(el);
    // 空字符串是 falsy，应当被跳过
    expect(capturePositions().size).toBe(0);
  });
});

describe("playFlip", () => {
  it("位移明显的元素会被设置 transform", () => {
    const el = makeRow("a", 0);
    const before = capturePositions();
    // 元素"移动"到新位置
    el.getBoundingClientRect = () =>
      ({
        top: 60,
        left: 0,
        height: 28,
        width: 200,
        bottom: 88,
        right: 200,
        x: 0,
        y: 60,
        toJSON: () => ({}),
      }) as DOMRect;

    const animated = playFlip(before);
    expect(animated).toBe(1);
    // 初始被瞬移回旧位置，然后清空以触发过渡
    expect(el.style.transform).toBe("");
    expect(el.style.transition).toContain("transform");
  });

  it("位移不足 1px 的元素被跳过（亚像素抖动不做动画）", () => {
    const el = makeRow("a", 0);
    const before = capturePositions();
    el.getBoundingClientRect = () =>
      ({
        top: 0.4,
        left: 0,
        height: 28,
        width: 200,
        bottom: 28.4,
        right: 200,
        x: 0,
        y: 0.4,
        toJSON: () => ({}),
      }) as DOMRect;

    expect(playFlip(before)).toBe(0);
    expect(el.style.transform).toBe("");
  });

  it("位置完全没变的不动画", () => {
    makeRow("a", 0);
    const before = capturePositions();
    expect(playFlip(before)).toBe(0);
  });

  it("不在快照里的新元素不参与动画（它们是入场而不是让位）", () => {
    const before = capturePositions();
    makeRow("new", 100);
    expect(playFlip(before)).toBe(0);
  });

  it("动画完成后 will-change 被移除（不长期占用合成层）", () => {
    const el = makeRow("a", 0);
    const before = capturePositions();
    el.getBoundingClientRect = () =>
      ({
        top: 60,
        left: 0,
        height: 28,
        width: 200,
        bottom: 88,
        right: 200,
        x: 0,
        y: 60,
        toJSON: () => ({}),
      }) as DOMRect;

    playFlip(before, document, 16);
    // 手动触发 transitionend 模拟动画结束
    el.dispatchEvent(new Event("transitionend"));
    expect(el.style.willChange).toBe("");
    expect(el.style.transition).toBe("");
  });

  it("transitionend 不触发时由超时兜底清理", () => {
    vi.useFakeTimers();
    const el = makeRow("a", 0);
    const before = capturePositions();
    el.getBoundingClientRect = () =>
      ({
        top: 60,
        left: 0,
        height: 28,
        width: 200,
        bottom: 88,
        right: 200,
        x: 0,
        y: 60,
        toJSON: () => ({}),
      }) as DOMRect;

    playFlip(before, document, 16);
    expect(el.style.willChange).toBe("transform");
    vi.advanceTimersByTime(16 + 240 + 10);
    expect(el.style.willChange).toBe("");
    vi.useRealTimers();
  });

  it("减少动效时完全不动画", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    );
    const el = makeRow("a", 0);
    const before = capturePositions();
    el.getBoundingClientRect = () =>
      ({
        top: 60,
        left: 0,
        height: 28,
        width: 200,
        bottom: 88,
        right: 200,
        x: 0,
        y: 60,
        toJSON: () => ({}),
      }) as DOMRect;

    expect(playFlip(before)).toBe(0);
  });

  it("多个元素同时动画（返回动画个数）", () => {
    const a = makeRow("a", 0);
    const b = makeRow("b", 40);
    const before = capturePositions();
    a.getBoundingClientRect = () =>
      ({
        top: 80,
        left: 0,
        height: 28,
        width: 200,
        bottom: 108,
        right: 200,
        x: 0,
        y: 80,
        toJSON: () => ({}),
      }) as DOMRect;
    b.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        height: 28,
        width: 200,
        bottom: 28,
        right: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    expect(playFlip(before)).toBe(2);
  });

  it("可以限定作用域，不采集范围外的元素", () => {
    makeRow("inside", 0);
    const outside = makeRow("outside", 100);
    const scope = document.createElement("div");
    document.body.appendChild(scope);
    scope.appendChild(
      document.querySelector("[data-flip-id='inside']") as Node,
    );

    const before = capturePositions(scope);
    expect(before.size).toBe(1);
    expect(before.has("inside")).toBe(true);
    expect(before.has("outside")).toBe(false);
    void outside;
  });
});

describe("prefersReducedMotion", () => {
  it("matchMedia 返回 true 时为 true", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(prefersReducedMotion()).toBe(true);
  });

  it("matchMedia 返回 false 时为 false", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
  });

  it("环境没有 matchMedia 时安全返回 false", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("withFlip", () => {
  it("先采样再执行改动，然后播放", () => {
    const el = makeRow("a", 0);
    const calls: string[] = [];

    const animated = withFlip(() => {
      calls.push("mutate");
      // 改动中元素移动到新位置
      el.getBoundingClientRect = () =>
        ({
          top: 60,
          left: 0,
          height: 28,
          width: 200,
          bottom: 88,
          right: 200,
          x: 0,
          y: 60,
          toJSON: () => ({}),
        }) as DOMRect;
    });

    expect(calls).toEqual(["mutate"]);
    expect(animated).toBe(1);
  });

  it("改动中不移动元素时返回 0", () => {
    makeRow("a", 0);
    expect(withFlip(() => undefined)).toBe(0);
  });
});
