/**
 * 无障碍基座测试（T1.8）。
 *
 * 覆盖三件事：reduced-motion 检测与降级、焦点陷阱、列表键盘导航。
 * 这三处是所有交互组件共享的地基，各写一遍很容易漏掉边界，
 * 集中测一次比在每个组件里重复测更彻底。
 */

import { describe, expect, it } from "vitest";
import {
  applyRovingTabindex,
  axisDelta,
  focusTrap,
  getFocusableElements,
  handleListNavigation,
  isEdgeKey,
  isFocusable,
  motionPolicy,
  nextIndexFor,
  prefersReducedMotion,
  reduceDuration,
} from "./index";
import { mockReducedMotion, pressKey, removeMatchMedia } from "./test-utils";

/** 造一个带若干可聚焦元素的容器。 */
function makeTrappableContainer(html: string): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

describe("reducedMotion", () => {
  it("系统开启减少动效时返回 true", () => {
    mockReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it("系统未开启减少动效时返回 false", () => {
    mockReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("宿主没有 matchMedia 时按不降级处理，不抛异常", () => {
    removeMatchMedia();
    expect(prefersReducedMotion()).toBe(false);
  });

  it("降级后不允许位移动画，时长被压到 100ms 以内", () => {
    mockReducedMotion(true);
    const policy = motionPolicy({ duration: 240, easing: "ease" });
    expect(policy.allowTransform).toBe(false);
    expect(policy.duration).toBeLessThanOrEqual(100);
    expect(policy.easing).toBe("linear");
  });

  it("未降级时保留原始时长与位移许可", () => {
    mockReducedMotion(false);
    const policy = motionPolicy({ duration: 240, easing: "ease-out" });
    expect(policy.allowTransform).toBe(true);
    expect(policy.duration).toBe(240);
    expect(policy.easing).toBe("ease-out");
  });

  it("reduceDuration 不放大本来就短的时长", () => {
    mockReducedMotion(true);
    expect(reduceDuration(40)).toBe(40);
    expect(reduceDuration(400)).toBeLessThanOrEqual(100);
  });
});

describe("isFocusable", () => {
  it("原生可聚焦元素可聚焦", () => {
    const container = makeTrappableContainer(
      "<button>确定</button><input /><a href='#x'>链接</a>",
    );
    expect(getFocusableElements(container)).toHaveLength(3);
    container.remove();
  });

  it("disabled 元素被排除", () => {
    const container = makeTrappableContainer(
      "<button disabled>禁用</button><button>可用</button>",
    );
    expect(getFocusableElements(container)).toHaveLength(1);
    expect(getFocusableElements(container)[0]?.textContent).toBe("可用");
    container.remove();
  });

  it("tabindex=-1 的元素被排除，tabindex=0 的普通 div 被纳入", () => {
    const container = makeTrappableContainer(
      "<div tabindex='-1'>跳过</div><div tabindex='0'>纳入</div>",
    );
    const focusable = getFocusableElements(container);
    expect(focusable).toHaveLength(1);
    expect(focusable[0]?.textContent).toBe("纳入");
    container.remove();
  });

  it("hidden 属性内的元素被排除", () => {
    const container = makeTrappableContainer(
      "<div hidden><button>藏起来</button></div>",
    );
    expect(getFocusableElements(container)).toHaveLength(0);
    container.remove();
  });

  it("null 与非 HTMLElement 输入返回 false", () => {
    expect(isFocusable(null)).toBe(false);
    expect(
      isFocusable(document.createTextNode("x") as unknown as Element),
    ).toBe(false);
  });
});

describe("focusTrap", () => {
  it("Tab 在末元素上会绕回首元素", () => {
    const container = makeTrappableContainer(
      "<button id='a'>一</button><button id='b'>二</button>",
    );
    const release = focusTrap(container);

    const last = container.querySelector<HTMLButtonElement>("#b");
    last?.focus();
    pressKey(document, "Tab");

    expect(document.activeElement?.id).toBe("a");
    release();
    container.remove();
  });

  it("Shift+Tab 在首元素上会绕回末元素", () => {
    const container = makeTrappableContainer(
      "<button id='a'>一</button><button id='b'>二</button>",
    );
    const release = focusTrap(container);

    container.querySelector<HTMLButtonElement>("#a")?.focus();
    pressKey(document, "Tab", { shiftKey: true });

    expect(document.activeElement?.id).toBe("b");
    release();
    container.remove();
  });

  it("开启时自动聚焦容器内第一个可聚焦元素", () => {
    const container = makeTrappableContainer(
      "<button id='first'>一</button><button id='second'>二</button>",
    );
    const release = focusTrap(container);
    expect(document.activeElement?.id).toBe("first");
    release();
    container.remove();
  });

  it("焦点被移到容器外时会被拉回来", async () => {
    const container = makeTrappableContainer("<button id='inside'>内</button>");
    const outside = document.createElement("button");
    outside.id = "outside";
    document.body.appendChild(outside);

    const release = focusTrap(container);
    outside.focus();
    // focusin 是异步派发的，等一个微任务。
    await Promise.resolve();

    expect(container.contains(document.activeElement)).toBe(true);
    release();
    container.remove();
    outside.remove();
  });

  it("容器内没有可聚焦元素时把焦点扣在容器上", () => {
    const container = makeTrappableContainer("<p>纯文本</p>");
    container.tabIndex = -1;
    const release = focusTrap(container);

    pressKey(document, "Tab");
    expect(document.activeElement).toBe(container);
    release();
    container.remove();
  });

  it("释放后把焦点归还给打开前的元素", () => {
    const trigger = document.createElement("button");
    trigger.id = "trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const container = makeTrappableContainer("<button id='inside'>内</button>");
    const release = focusTrap(container);
    expect(document.activeElement?.id).toBe("inside");

    release();
    expect(document.activeElement?.id).toBe("trigger");
    container.remove();
    trigger.remove();
  });

  it("restoreFocus=false 时不归还焦点", () => {
    const trigger = document.createElement("button");
    trigger.id = "trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const container = makeTrappableContainer("<button id='inside'>内</button>");
    const release = focusTrap(container, { restoreFocus: false });
    release();

    expect(document.activeElement?.id).not.toBe("trigger");
    container.remove();
    trigger.remove();
  });

  it("释放后不再拦截 Tab", () => {
    const container = makeTrappableContainer("<button id='a'>一</button>");
    const release = focusTrap(container);
    release();

    const outside = document.createElement("button");
    outside.id = "outside";
    document.body.appendChild(outside);
    outside.focus();
    pressKey(document, "Tab");

    expect(document.activeElement?.id).toBe("outside");
    container.remove();
    outside.remove();
  });
});

describe("键盘导航", () => {
  it("axisDelta 按轴过滤按键", () => {
    expect(axisDelta("ArrowDown", "vertical")).toBe(1);
    expect(axisDelta("ArrowUp", "vertical")).toBe(-1);
    expect(axisDelta("ArrowRight", "vertical")).toBe(0);
    expect(axisDelta("ArrowRight", "horizontal")).toBe(1);
    expect(axisDelta("ArrowDown", "both")).toBe(1);
  });

  it("isEdgeKey 只认 Home / End", () => {
    expect(isEdgeKey("Home")).toBe(true);
    expect(isEdgeKey("End")).toBe(true);
    expect(isEdgeKey("ArrowDown")).toBe(false);
  });

  it("nextIndexFor 在边界处不循环时返回 null", () => {
    const items = [
      document.createElement("button"),
      document.createElement("button"),
    ];
    expect(
      nextIndexFor(items, items[1] as HTMLElement, "ArrowDown", {
        loop: false,
      }),
    ).toBeNull();
  });

  it("nextIndexFor 循环时首尾相接", () => {
    const items = [
      document.createElement("button"),
      document.createElement("button"),
    ];
    expect(
      nextIndexFor(items, items[1] as HTMLElement, "ArrowDown", { loop: true }),
    ).toBe(0);
    expect(
      nextIndexFor(items, items[0] as HTMLElement, "ArrowUp", { loop: true }),
    ).toBe(1);
  });

  it("nextIndexFor 支持 Home / End", () => {
    const items = [
      document.createElement("button"),
      document.createElement("button"),
      document.createElement("button"),
    ];
    expect(nextIndexFor(items, items[1] as HTMLElement, "Home")).toBe(0);
    expect(nextIndexFor(items, items[1] as HTMLElement, "End")).toBe(2);
  });

  it("焦点不在列表内时方向键把焦点带入列表", () => {
    const items = [
      document.createElement("button"),
      document.createElement("button"),
    ];
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    expect(nextIndexFor(items, outside, "ArrowDown")).toBe(0);
    expect(nextIndexFor(items, outside, "ArrowUp")).toBe(1);
    outside.remove();
  });

  it("空列表返回 null，不抛异常", () => {
    expect(nextIndexFor([], null, "ArrowDown")).toBeNull();
  });

  it("handleListNavigation 移动焦点并消费按键", () => {
    const container = makeTrappableContainer(
      "<button id='a'>一</button><button id='b'>二</button>",
    );
    const items = getFocusableElements(container);
    items[0]?.focus();

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    const consumed = handleListNavigation(event, items, { axis: "vertical" });

    expect(consumed).toBe(true);
    expect(document.activeElement?.id).toBe("b");
    container.remove();
  });

  it("handleListNavigation 对无关按键返回 false", () => {
    const container = makeTrappableContainer("<button id='a'>一</button>");
    const items = getFocusableElements(container);
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    expect(handleListNavigation(event, items, { axis: "vertical" })).toBe(
      false,
    );
    container.remove();
  });

  it("applyRovingTabindex 只让当前项进入 Tab 序", () => {
    const container = makeTrappableContainer(
      "<button id='a'>一</button><button id='b'>二</button>",
    );
    const items = applyRovingTabindex(
      container,
      container.querySelector<HTMLElement>("#b"),
    );

    expect(items[0]?.getAttribute("tabindex")).toBe("-1");
    expect(items[1]?.getAttribute("tabindex")).toBe("0");
    container.remove();
  });

  it("applyRovingTabindex 对空容器安全", () => {
    const container = makeTrappableContainer("<p>空</p>");
    expect(applyRovingTabindex(container, null)).toHaveLength(0);
    container.remove();
  });
});
