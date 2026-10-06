/**
 * 分隔条的全局监听生命周期测试。
 *
 * 只钉一件事：**拖到一半组件被卸载时，不能把监听器和 `is-resizing`
 * 留在外面**。切到书架、关闭工作区都会让分隔条在拖拽中途消失，
 * 从前这条路径没人清理 —— 监听器继续响应指针，而 body 上的
 * `is-resizing` 会把全局文本选择永久禁掉。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { Resizer } from "./Resizer";

const LEFT_VAR = "--left-w";

let host: HTMLElement | null = null;
let dispose: (() => void) | null = null;

/**
 * 造一个指针事件。
 *
 * jsdom 不提供 `PointerEvent` 构造函数，而组件的处理器只读 `clientX`
 * 与 `button`、不校验事件类型，因此用 `MouseEvent` 挂上 pointer 的
 * 事件名就够了（`onPointerDown` 在 Solid 里绑定的正是 `pointerdown`）。
 */
function pointer(type: string, clientX: number, button = 0): MouseEvent {
  return new MouseEvent(type, {
    clientX,
    button,
    bubbles: true,
    cancelable: true,
  });
}

function mount(setWidth: (width: number) => void): HTMLElement {
  const node = document.createElement("div");
  document.body.appendChild(node);
  host = node;
  dispose = render(
    () => (
      <Resizer
        side="left"
        getWidth={() => 200}
        setWidth={setWidth}
        min={120}
        max={480}
      />
    ),
    node,
  );
  const handle = node.querySelector<HTMLElement>(".resizer");
  if (handle === null) throw new Error("分隔条没渲染出来");
  return handle;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.classList.remove("is-resizing");
  document.documentElement.style.removeProperty(LEFT_VAR);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  host?.remove();
  host = null;
  document.body.classList.remove("is-resizing");
  document.documentElement.style.removeProperty(LEFT_VAR);
});

describe("分隔条：拖拽中的卸载", () => {
  it("拖到一半被卸载后，is-resizing 不残留", () => {
    const handle = mount(vi.fn());
    handle.dispatchEvent(pointer("pointerdown", 200));
    expect(document.body.classList.contains("is-resizing")).toBe(true);

    dispose?.();
    dispose = null;

    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });

  it("拖到一半被卸载后，指针移动不再改宽度", () => {
    const handle = mount(vi.fn());
    handle.dispatchEvent(pointer("pointerdown", 200));
    window.dispatchEvent(pointer("pointermove", 260));
    expect(document.documentElement.style.getPropertyValue(LEFT_VAR)).toBe(
      "260px",
    );

    dispose?.();
    dispose = null;
    document.documentElement.style.removeProperty(LEFT_VAR);

    // 监听器若还挂着，这一次移动会把变量重新写回来
    window.dispatchEvent(pointer("pointermove", 400));
    expect(document.documentElement.style.getPropertyValue(LEFT_VAR)).toBe("");
  });

  it("没有拖拽时卸载不会误伤别的分隔条", () => {
    // 左右两条分隔条同时存在；卸载其中一条不该动全局状态
    const setWidth = vi.fn();
    const handle = mount(setWidth);
    document.body.classList.add("is-resizing");

    // 不 pointerdown，直接卸载
    handle.remove();
    dispose?.();
    dispose = null;

    expect(document.body.classList.contains("is-resizing")).toBe(true);
  });
});

describe("分隔条：正常拖拽", () => {
  it("松手时把最终宽度提交进 store", () => {
    const setWidth = vi.fn();
    const handle = mount(setWidth);

    handle.dispatchEvent(pointer("pointerdown", 200));
    window.dispatchEvent(pointer("pointermove", 260));
    window.dispatchEvent(pointer("pointerup", 260));

    expect(setWidth).toHaveBeenCalledWith(260);
    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });

  it("宽度被夹在 min/max 之间", () => {
    const setWidth = vi.fn();
    const handle = mount(setWidth);

    handle.dispatchEvent(pointer("pointerdown", 200));
    // 向左拖 500px：起始 200 - 500 = -300，应被夹到 min=120
    window.dispatchEvent(pointer("pointermove", -300));
    window.dispatchEvent(pointer("pointerup", -300));

    expect(setWidth).toHaveBeenCalledWith(120);
  });

  it("非左键按下不进入拖拽", () => {
    const setWidth = vi.fn();
    const handle = mount(setWidth);

    handle.dispatchEvent(pointer("pointerdown", 200, 2));
    expect(document.body.classList.contains("is-resizing")).toBe(false);

    window.dispatchEvent(pointer("pointermove", 300));
    expect(document.documentElement.style.getPropertyValue(LEFT_VAR)).toBe("");
    expect(setWidth).not.toHaveBeenCalled();
  });
});
