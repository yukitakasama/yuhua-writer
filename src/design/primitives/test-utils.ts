/**
 * 原语测试共享工具。
 *
 * 为什么不用 @testing-library/jest-dom：
 * 它会给 expect 挂一堆自定义匹配器，而这些断言在 vitest 里用原生 API 同样简洁。
 * 少一个依赖、少一层全局副作用，测试报错信息也更直白（看到的是 DOM 真实状态，
 * 而不是匹配器内部的判断逻辑）。
 */

import { cleanup } from "@solidjs/testing-library";
import { afterEach, beforeEach, vi } from "vitest";

/** 记录原始的 matchMedia，测试结束后还原，避免用例之间互相污染。 */
const originalMatchMedia = window.matchMedia;

/**
 * 把 \`prefers-reduced-motion\` 打桩成指定值。
 *
 * jsdom 不实现 matchMedia，所以真实浏览器里的降级路径在测试中必须打桩才能覆盖。
 * 计划书验收项 A10 要求「开启系统减少动态效果后功能不受影响」，
 * 对应的测试就是从这里把 matches 设成 true。
 */
export function mockReducedMotion(reduced: boolean): void {
  const matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reduced : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: matchMedia,
  });
}

/** 移除 matchMedia，用于测试「宿主环境没有 matchMedia」的兜底路径。 */
export function removeMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: undefined,
  });
}

/** 恢复 host 提供的 matchMedia。 */
function restoreMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: originalMatchMedia,
  });
}

beforeEach(() => {
  // 默认按「未开启减少动效」起步，需要降级的用例自己调 mockReducedMotion(true)。
  mockReducedMotion(false);
});

afterEach(() => {
  cleanup();
  restoreMatchMedia();
  // Modal 会在 body 上残留 overflow 锁，清理掉避免影响后续用例的滚动断言。
  document.body.style.overflow = "";
});

/** 断言元素拥有某个 class。 */
export function hasClass(
  element: Element | null | undefined,
  className: string,
): boolean {
  return element instanceof Element && element.classList.contains(className);
}

/**
 * 派发一次原生键盘事件。
 *
 * 用真实 KeyboardEvent 而不是测试库的合成事件：焦点陷阱与键盘导航
 * 都挂在 document 的捕获阶段，只有真实的事件对象才会走完整条冒泡链路。
 */
export function pressKey(
  target: EventTarget,
  key: string,
  options: KeyboardEventInit = {},
): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    }),
  );
}
