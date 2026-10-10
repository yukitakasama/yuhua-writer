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

import { App, flushThenAck } from "@/App";
import { __resetMockBackend, saveChapter } from "@/lib/ipc";
import {
  __resetWorkspaceState,
  refreshRecents,
  selectChapter,
  workspaceState,
} from "@/app/workspace-store";
import { __resetPerfForTests, perfSnapshot } from "@/app/perf";
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
  // 埋点也是全局状态：不重置的话「首次就绪」会被前一个用例用掉
  __resetPerfForTests();
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
    const disabled = [...host.querySelectorAll("button")].filter(
      (b) => (b as HTMLButtonElement).disabled,
    );
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
    const card = host.querySelector(
      ".shelf__card-btn",
    ) as HTMLButtonElement | null;
    card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // 打开工作区是异步的，多等几拍
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(host.querySelector(".shell")).not.toBeNull();
  });

  it("写作台渲染出卷章树、编辑区与右侧面板", async () => {
    const host = await mountApp();
    (
      host.querySelector(".shelf__card-btn") as HTMLButtonElement | null
    )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(host.querySelector(".tree")).not.toBeNull();
    expect(host.querySelector(".editor")).not.toBeNull();
    expect(host.querySelector(".meta")).not.toBeNull();
  });

  /**
   * 切章的**组装**证明：点另一章，编辑器里得是那章的正文。
   *
   * ## 为什么这条必须存在
   *
   * 读章一度只在 EditorPane 的 `onMount` 里发起，而 EditorPane 不随换章
   * 重建 —— 于是「先开工作区、再点某一章」这条最主要的路径压根不会去读
   * 文件，编辑器停在上一章的内容上。作者以为在写第 7 章，敲的字却进了
   * 第 6 章的草稿。组件测试各守一隅（树只管选中、编辑器只管渲染），
   * 这种「谁都没接住」的缝隙只有把整棵树挂起来才照得出来。
   */
  it("切到另一章后，编辑器显示的是那章的正文", async () => {
    const host = await mountApp();
    (
      host.querySelector(".shelf__card-btn") as HTMLButtonElement | null
    )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    const [first, second] = workspaceState.document?.chapters ?? [];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // 示例工作区的正文都是空的，空章之间互相看不出来，先写两份可区分的内容
    await saveChapter(first!.id, "甲章的正文");
    await saveChapter(second!.id, "乙章的正文");

    const editorText = (): string =>
      host.querySelector(".cm-content")?.textContent ?? "";

    selectChapter(first!.id);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(editorText()).toContain("甲章的正文");

    selectChapter(second!.id);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const text = editorText();
    expect(text).toContain("乙章的正文");
    expect(text).not.toContain("甲章的正文");
  });

  /**
   * P3 / P4 埋点的**接线**证明。
   *
   * `perf.test.ts` 只证明这个模块自己的算术对 —— 它完全可以在一个
   * 从来没人调用的文件里全绿。本项目有过先例：`docs/benchmarks.md`
   * 曾声称 P5 有测试覆盖，而那个测试文件从未被写进仓库。
   * 所以这一条走完整挂载链路（App → EditorPane → MarkdownEditor → store 读章），
   * 断言两个数真的产生了。
   */
  it("进入写作台后，P3 与 P4 的埋点都产生了样本", async () => {
    expect(perfSnapshot().editorReadyMs).toBeNull();
    expect(perfSnapshot().lastChapterOpenMs).toBeNull();

    const host = await mountApp();
    (
      host.querySelector(".shelf__card-btn") as HTMLButtonElement | null
    )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    // 打开工作区不会自动选章（EditorPane 会停在「未选中章节」的空态，
    // 编辑器根本不挂载），所以这里显式选一章。
    // 走 store 而不是点树里的行：卷默认折叠时 DOM 里可能没有章行，
    // 而本条要验的是「三个埋点调用点连得通」，点行已由 chapters 的测试覆盖。
    const first = workspaceState.document?.chapters[0];
    expect(first).toBeDefined();
    selectChapter((first as { id: string }).id);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    const snap = perfSnapshot();
    // 起点在 workspace-store、终点在 EditorPane、就绪点在 MarkdownEditor：
    // 三个调用点分布在三个文件里，只有整棵树挂载起来才连得通
    expect(snap.editorReadyMs).not.toBeNull();
    expect(snap.lastChapterOpenMs).not.toBeNull();
    expect(snap.chapterOpens.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * 书级元数据「看得见」的那一半。
   *
   * 填的入口在导出面板，展示的地方在右侧「本书信息」。两边都得有人钉：
   * 「填了记不住」与「记住了看不见」是同一枚硬币的两面。这一条走的是
   * 真实装配链路（App → MetaPanel → store → `open_workspace` 交回的摘要），
   * 组件级测试照不出「摘要里的 author 根本没被任何人读」这种缝隙。
   */
  it("右侧面板显示这本书的作者与简介", async () => {
    const host = await mountApp();
    (
      host.querySelector(".shelf__card-btn") as HTMLButtonElement | null
    )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    const text = host.textContent ?? "";
    expect(text).toContain("本书信息");
    expect(text).toContain("无名");
    expect(text).toContain("一个关于记忆与羽毛的长篇故事。");
  });

  it("卷章树里出现示例卷名", async () => {
    const host = await mountApp();
    (
      host.querySelector(".shelf__card-btn") as HTMLButtonElement | null
    )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(host.textContent).toContain("第一卷 落羽");
  });

  it("卷章树是可访问的 tree 角色", async () => {
    const host = await mountApp();
    (
      host.querySelector(".shelf__card-btn") as HTMLButtonElement | null
    )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(host.querySelector("[role='tree']")).not.toBeNull();
  });

  it("工具栏有新建卷与新建章入口", async () => {
    const host = await mountApp();
    (
      host.querySelector(".shelf__card-btn") as HTMLButtonElement | null
    )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(host.textContent).toContain("新建卷");
    expect(host.textContent).toContain("新建章");
  });
});

describe("没有 emoji 泄漏到渲染结果", () => {
  it("书架页面的文本节点不含 emoji", async () => {
    const host = await mountApp();
    const emoji =
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F2FF}]/u;
    expect(emoji.test(host.textContent ?? "")).toBe(false);
  });
});

/**
 * 关闭屏障的编排（Rust 侧的状态机在 `src-tauri/src/closing.rs` 里有单测）。
 *
 * jsdom 里 `isTauri()` 恒为假，那条 `flush-and-close` 事件收不到，
 * 所以这里钉的是**收到之后**的两件事：顺序与兜底。
 * 接线本身（订阅、事件名两边对得上）只有真机能验。
 */
describe("关闭屏障的编排", () => {
  it("ack 排在刷盘真正落地之后", async () => {
    const order: string[] = [];
    await flushThenAck(
      async () => {
        // 用定时器而不是微任务：真实的 flush 要等 IO。
        // 只排微任务的话「先 await 再 ack」能被顺序蒙对，钉不住没等完的情形
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("flushed");
      },
      async () => {
        order.push("acked");
      },
    );
    expect(order).toEqual(["flushed", "acked"]);
  });

  it("刷盘失败仍然 ack，而且不把失败咽掉", async () => {
    // 不 ack 的话作者要等 3 秒超时才关得掉窗口，期间他以为程序卡死了；
    // 而失败必须继续往外抛，由调用方的错误提示报出去
    let acked = false;
    await expect(
      flushThenAck(
        async () => {
          throw new Error("磁盘被云盘占着");
        },
        async () => {
          acked = true;
        },
      ),
    ).rejects.toThrow("磁盘被云盘占着");
    expect(acked).toBe(true);
  });
});
