/**
 * 冒烟测试：把整个应用真的挂载起来。
 *
 * ## 为什么需要这一层
 *
 * 组件测试覆盖了单个组件，但覆盖不到**组装**：
 * App 的导入图里少一个 export、store 的初始化顺序不对、
 * 某个 effect 在真实挂载时抛异常 —— 这些在单元测试里都看不到，
 * 却会让用户面对一个白屏。
 *
 * 这个文件只做一件事：把 App 渲染出来，然后断言关键区域都在。
 * 它不测业务逻辑（那是别处的职责），只回答"应用能不能启动"。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";

import { App } from "@/App";
import { __resetMockBackend } from "@/lib/ipc";
import { __resetWorkspaceState, refreshRecents } from "@/app/workspace-store";
import { resetLayout } from "@/app/layout-store";

let root: HTMLElement | null = null;
let dispose: (() => void) | null = null;

/** 挂载应用并等待异步数据到位。 */
async function mountApp(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <App />, host);
  root = host;
  // 最近列表是 onMount 之后异步拉的，给它一个微任务周期的机会
  await refreshRecents();
  await Promise.resolve();
  return host;
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  __resetMockBackend();
  __resetWorkspaceState();
  resetLayout();
});

afterEach(() => {
  dispose?.();
  root?.remove();
  dispose = null;
  root = null;
});

describe("应用启动", () => {
  it("能挂载且不抛异常", async () => {
    await expect(mountApp()).resolves.toBeDefined();
  });

  it("初始进入书架视图", async () => {
    const host = await mountApp();
    expect(host.querySelector(".library")).not.toBeNull();
  });

  it("书架显示工具栏的品牌名", async () => {
    const host = await mountApp();
    expect(host.textContent).toContain("羽化写作");
  });

  it("书架显示最近打开区块", async () => {
    const host = await mountApp();
    expect(host.textContent).toContain("最近打开");
  });

  it("书架按示例数据渲染出书籍卡片", async () => {
    const host = await mountApp();
    const cards = host.querySelectorAll(".shelf__card");
    expect(cards.length).toBeGreaterThan(0);
  });

  it("每本书的封面是内联 SVG，且没有外链图片", async () => {
    const host = await mountApp();
    expect(host.querySelectorAll("svg.cover").length).toBeGreaterThan(0);
    expect(host.querySelectorAll("img").length).toBe(0);
  });

  it("失效的工作区被标记且不可点击", async () => {
    const host = await mountApp();
    // 示例数据里有一条 available=false 的记录
    const disabled = [...host.querySelectorAll("button")].filter((b) => (b as HTMLButtonElement).disabled);
    expect(disabled.length).toBeGreaterThan(0);
  });

  it("浏览器模式提示可见（非 Tauri 环境）", async () => {
    const host = await mountApp();
    expect(host.textContent).toContain("浏览器预览模式");
  });

  it("提供新建工作区入口", async () => {
    const host = await mountApp();
    expect(host.textContent).toContain("新建工作区");
  });
});

describe("进入写作台", () => {
  it("点击书籍卡片后切到三栏布局", async () => {
    const host = await mountApp();
    const card = host.querySelector(".shelf__card-btn") as HTMLButtonElement | null;
    card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // 打开工作区是异步的，多等几拍
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(host.querySelector(".shell")).not.toBeNull();
  });

  it("写作台渲染出卷章树、编辑区与右侧面板", async () => {
    const host = await mountApp();
    (host.querySelector(".shelf__card-btn") as HTMLButtonElement | null)?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(host.querySelector(".tree")).not.toBeNull();
    expect(host.querySelector(".editor")).not.toBeNull();
    expect(host.querySelector(".meta")).not.toBeNull();
  });

  it("卷章树里出现示例卷名", async () => {
    const host = await mountApp();
    (host.querySelector(".shelf__card-btn") as HTMLButtonElement | null)?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(host.textContent).toContain("第一卷 落羽");
  });

  it("卷章树是可访问的 tree 角色", async () => {
    const host = await mountApp();
    (host.querySelector(".shelf__card-btn") as HTMLButtonElement | null)?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(host.querySelector("[role='tree']")).not.toBeNull();
  });

  it("工具栏有新建卷与新建章入口", async () => {
    const host = await mountApp();
    (host.querySelector(".shelf__card-btn") as HTMLButtonElement | null)?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(host.textContent).toContain("新建卷");
    expect(host.textContent).toContain("新建章");
  });
});

describe("没有 emoji 泄漏到渲染结果", () => {
  it("书架页面的文本节点不含 emoji", async () => {
    const host = await mountApp();
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F2FF}]/u;
    expect(emoji.test(host.textContent ?? "")).toBe(false);
  });
});
