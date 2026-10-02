/**
 * 检索面板组件测试（T6.1 / T6.2 / T6.3）。
 *
 * ## 这一层要测什么
 *
 * search.test.ts 锁的是高亮切分与偏移定位这两块纯逻辑；
 * 这里锁的是**交互接线**，也就是那种"逻辑全对但按钮没绑事件"的问题：
 *
 * - 输入关键词后到底有没有真的发起检索
 * - 点一条结果有没有（1）选中该章（2）请求跳转（3）关闭面板
 * - 大纲标签页有没有真的调用 getOutline
 *
 * ## 为什么可以打桩 IPC
 *
 * 面板只通过 `@/lib/ipc` 访问后端，因此打桩那一层既能隔离
 * 也能顺便断言"到底选了哪一章、跳到了哪个偏移"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 注：这里曾有一行 `eslint-disable no-restricted-syntax`。它是在
// 仓库还没有 eslint 配置时写的（当时的 lint 根本跑不起来，属于预防性注释）。
// 补上 eslint.config.js 之后，本项目的规则集是**白名单式**的
// （只启用能抓到真实缺陷的少数几条），并不包含 no-restricted-syntax，
// 因此该指令成了"指向一条不存在的规则"的死注释 —— ESLint 会把它
// 报成 Unused eslint-disable directive 警告，在 --max-warnings 0 下直接失败。
// 删掉它，需要等待真实延时的地方照旧用真实定时器（理由见下方 settle 的说明）。
import { render } from "solid-js/web";

import type { OutlineNode, SearchResults } from "@/lib/ipc";
import {
  __resetWorkspaceState,
  selectedChapterId,
} from "@/app/workspace-store";
import { SearchPanel } from "./SearchPanel";
import { clearJump, pendingJump } from "./search-store";

/**
 * IPC 打桩。
 *
 * ## 为什么用 `vi.hoisted`` 而不是模块级 `const`
 *
 * `vi.mock` 的工厂会被**提升到 import 之前**执行，此时模块级变量
 * 还没初始化 —— 直接引用会抛 "Cannot access before initialization"，
 * 或者在某些解析顺序下让整个测试文件挂住不返回。
 * `vi.hoisted` 保证这几个桩在任何模块求值之前就已就位。
 *
 * ## 为什么不打桩 workspace-store
 *
 * `selectChapter` 只是往一个 signal 里写值，没有任何副作用。
 * 用真实的实现反而更好：既能断言"选了哪一章"，又不需要
 * `importOriginal` 绕一圈（那条路会因为 workspace-store 自己也 import
 * lib/ipc 而形成模块循环，测试会卡死）。
 */
const { searchMock, outlineMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  outlineMock: vi.fn(),
}));

/**
 * 只桩掉检索需要的两个函数，**不调用 `importOriginal`**。
 *
 * ## 为什么不能带 importOriginal
 *
 * `importOriginal` 会让 mock 工厂去**真实加载**整个 `@/lib/ipc` 模块图，
 * 而那张图里包含 `@/app/workspace-store`，后者又回头 import `@/lib/ipc`。
 * vitest 在这种「mock 工厂等真实模块、真实模块等 mock」的环上会
 * **一直挂着不返回**（不是报错，是死等 —— 这类问题极难定位，
 * 所以这里显式写下原因，避免后来者又加回去）。
 *
 * 代价是 mock 必须列出被测组件用到的每一个导出。面板只用到
 * `search` 与 `getOutline`，加上类型导出即可 —— 类型在运行期不存在，
 * 因此不需要在 mock 里出现。
 */
vi.mock("@/lib/ipc", () => ({
  search: (query: unknown) => searchMock(query),
  getOutline: () => outlineMock(),
}));

/**
 * 把组件渲染到临时节点里，并返回**一个能查到内容的根**。
 *
 * ## 为什么不能直接用挂载点当查询根
 *
 * `SearchPanel` 内部用的是 `<Dialog>`，而 Dialog 的底座 `Modal`
 * 会把内容 `<Portal mount={document.body}>` 到 `document.body` ——
 * 这是模态**必需**的做法（否则侧栏的 `overflow: hidden` 和
 * 编辑器的层叠上下文会把弹层裁掉）。
 *
 * 代价是：挂载点 `root` 里**什么都没有**，所有断言都会
 * "查不到元素"。第一版就踩了这个坑，而且表现很有迷惑性 ——
 * 不是报错，而是 `root.querySelector(...)` 返回 null、
 * `root.textContent` 返回空串，看起来像"组件没渲染"。
 *
 * 因此这里把 `document.body` 当作查询根。这样能查到 Portal
 * 出来的内容，也能查到普通渲染的内容（挂载点本身就在 body 里）。
 *
 * ## dispose 必须清掉 Portal 留下的节点
 *
 * `dispose()` 只卸载 Solid 的根，Portal 插到 body 上的 DOM
 * **不会**被一并移除（它由 Solid 管理，但 Dialog 有退场动画，
 * 卸载后节点可能还留着）。用例之间不清理会让
 * `document.body.textContent` 之类的断言读到别人留下的内容。
 * 因此这里收窄到"这个用例期间新增的 body 子节点"再删。
 */
function mount(component: () => unknown): {
  root: HTMLElement;
  dispose: () => void;
} {
  // 记下挂载前的既有节点，dispose 时只删新增的
  const before = new Set(document.body.children);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(component as never, host);
  return {
    // 查询根是 body：Portal 把内容放在那里
    root: document.body as HTMLElement,
    dispose: () => {
      dispose();
      for (const child of Array.from(document.body.children)) {
        if (!before.has(child)) child.remove();
      }
    },
  };
}

/** 造一份检索结果。 */
function results(
  hits: SearchResults["hits"],
  total = hits.length,
): SearchResults {
  return { hits, total, limit: 50, offset: 0, tokens: ["测试"] };
}

/** 一条命中。 */
function hit(
  chapterId: string,
  title: string,
  snippet: string,
  range: [number, number],
) {
  return {
    chapterId,
    title,
    path: `manuscript/001/${chapterId}.md`,
    volumeId: "v1",
    score: 1,
    snippets: [{ text: snippet, ranges: [range] }],
  };
}

/**
 * 等防抖与异步检索落地。
 *
 * ## 为什么用真实的短延时而不是假定时器
 *
 * `vi.useFakeTimers()` 会接管 `setTimeout`，但 Solid 的响应式更新
 * 与 Dialog 的退场动画各自还有自己的微任务队列。两者混在一起时，
 * 假定时器不会自动推进，测试会**卡死在 await 上**而不是失败 ——
 * 一个卡住的测试比一个失败的测试糟糕得多，因为它会拖住整个 CI。
 *
 * 因此这里用真实的 220ms（略大于防抖的 180ms）。代价是每个
 * 检索用例多花 0.2 秒，换来的是"永远不会挂住"。
 */
const DEBOUNCE_WAIT = 220;

/** 等状态稳定：跑一轮定时器 + 若干拍微任务。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT));
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  searchMock.mockReset().mockResolvedValue(results([]));
  outlineMock.mockReset().mockResolvedValue([]);
  clearJump();
  __resetWorkspaceState();
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("检索面板基础", () => {
  it("打开时渲染输入框与两个标签页", () => {
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    expect(root.querySelector("#search-panel-input")).not.toBeNull();
    expect(root.querySelectorAll("[role='tab']")).toHaveLength(2);
    dispose();
  });

  it("关闭时不渲染任何内容", () => {
    const { root, dispose } = mount(() => (
      <SearchPanel open={false} onClose={() => undefined} />
    ));
    expect(root.querySelector("#search-panel-input")).toBeNull();
    dispose();
  });

  it("刚打开时给的是引导文案而不是「没有找到」", () => {
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    expect(root.textContent).toContain("输入关键词开始检索");
    expect(root.textContent).not.toContain("没有找到");
    dispose();
  });
});

describe("检索（T6.1）", () => {
  it("输入后经过防抖才发起检索", async () => {
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "雨夜";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));

    // 防抖窗口内不应该发请求：输入法中间态会产生十几次 input
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(searchMock).not.toHaveBeenCalled();
    await settle();
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0]?.[0]).toMatchObject({
      keyword: "雨夜",
      titleOnly: false,
    });
    dispose();
  });

  it("连续输入只发一次请求（防抖生效）", async () => {
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    // 三拍输入全部落在同一个防抖窗口内（每拍只等 30ms，远小于 180ms）
    for (const value of ["雨", "雨夜", "雨夜里"]) {
      input.value = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await settle();
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0]?.[0]).toMatchObject({ keyword: "雨夜里" });
    dispose();
  });

  it("渲染结果条数与路径", async () => {
    searchMock.mockResolvedValue(
      results([hit("c1", "第一章 落羽", "雨下了整整一夜", [0, 1])], 1),
    );
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "雨";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    expect(root.textContent).toContain("第一章 落羽");
    expect(root.textContent).toContain("manuscript/001/c1.md");
    dispose();
  });

  it("命中部分用 mark 高亮（而不是拼 innerHTML）", async () => {
    searchMock.mockResolvedValue(
      results([hit("c1", "第一章", "雨下了整整一夜", [0, 1])], 1),
    );
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "雨";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    const mark = root.querySelector("mark.hit__mark");
    expect(mark?.textContent).toBe("雨");
    // 高亮之外的文本必须原样保留
    expect(root.querySelector(".hit__snippet")?.textContent).toBe(
      "雨下了整整一夜",
    );
    dispose();
  });

  it("正文里的尖括号被转义，不会变成元素", async () => {
    searchMock.mockResolvedValue(
      results([hit("c1", "第一章", "<script>alert(1)</script>", [0, 1])], 1),
    );
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "<";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector(".hit__snippet")?.textContent).toContain(
      "<script>",
    );
    dispose();
  });

  it("搜完之后没有结果才显示「没有找到」", async () => {
    searchMock.mockResolvedValue(results([], 0));
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "不存在的词";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    expect(root.textContent).toContain("没有找到");
    dispose();
  });

  it("「只搜标题」立刻重查并带 titleOnly", async () => {
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "落羽";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();

    const toggle = [...root.querySelectorAll("button")].find(
      (b) => b.textContent === "只搜标题",
    );
    toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(searchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ titleOnly: true }),
    );
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    dispose();
  });

  it("清空关键词后回到引导态", async () => {
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "雨";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();

    input.value = "";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    expect(root.textContent).toContain("输入关键词开始检索");
    dispose();
  });
});

describe("结果跳转（T6.2）", () => {
  it("点结果：选中该章 + 发布跳转 + 关闭面板", async () => {
    searchMock.mockResolvedValue(
      results([hit("c1", "第一章", "雨下了整整一夜", [0, 1])], 1),
    );
    const onClose = vi.fn();
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={onClose} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "雨";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();

    (root.querySelector("button.hit") as HTMLButtonElement).click();
    expect(selectedChapterId()).toBe("c1");
    expect(pendingJump()?.chapterId).toBe("c1");
    expect(onClose).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("跳转偏移取的是片段内的高亮起点", async () => {
    // 片段"他说道：关键词在后面"，高亮区间是 [5, 8]
    searchMock.mockResolvedValue(
      results([hit("c1", "第一章", "他说道：关键词在后面", [5, 8])], 1),
    );
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "关键词";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();

    (root.querySelector("button.hit") as HTMLButtonElement).click();
    expect(pendingJump()?.offset).toBe(5);
    dispose();
  });

  it("跳转带自增 token（同一位置连跳两次也要能识别）", async () => {
    searchMock.mockResolvedValue(
      results([hit("c1", "第一章", "雨夜", [0, 1])], 1),
    );
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "雨";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();

    (root.querySelector("button.hit") as HTMLButtonElement).click();
    const first = pendingJump()?.token ?? 0;
    (root.querySelector("button.hit") as HTMLButtonElement).click();
    expect(pendingJump()?.token).toBeGreaterThan(first);
    dispose();
  });

  it("键盘：↓ 从输入框进入列表，回车跳转", async () => {
    searchMock.mockResolvedValue(
      results([hit("c1", "第一章", "雨夜", [0, 1])], 1),
    );
    const onClose = vi.fn();
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={onClose} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "雨";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();

    const item = root.querySelector("button.hit") as HTMLButtonElement;
    item.focus();
    item.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(selectedChapterId()).toBe("c1");
    expect(onClose).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("↑↓ 在结果之间移动并保持 roving tabindex", async () => {
    searchMock.mockResolvedValue(
      results(
        [
          hit("c1", "第一章", "雨夜", [0, 1]),
          hit("c2", "第二章", "夜雨", [0, 1]),
        ],
        2,
      ),
    );
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "雨";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();

    const list = root.querySelector(".hits") as HTMLElement;
    const items = [...root.querySelectorAll<HTMLButtonElement>("button.hit")];
    expect(items[0]?.getAttribute("tabindex")).toBe("0");
    expect(items[1]?.getAttribute("tabindex")).toBe("-1");

    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await settle();
    const after = [...root.querySelectorAll<HTMLButtonElement>("button.hit")];
    expect(after[1]?.getAttribute("tabindex")).toBe("0");
    dispose();
  });

  it("Enter 在空结果时不会抛异常", async () => {
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const input = root.querySelector("#search-panel-input") as HTMLInputElement;
    input.value = "没有";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    expect(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    ).not.toThrow();
    dispose();
  });
});

describe("大纲视图（T6.3）", () => {
  const outline: OutlineNode[] = [
    {
      volumeId: "v1",
      title: "第一卷 落羽",
      sort: 0,
      wordCount: 12_000,
      chapterCount: 3,
      chapters: [
        {
          id: "c1",
          volumeId: "v1",
          title: "第一章 落羽",
          status: "done",
          sort: 0,
          path: "manuscript/001/001.md",
          wordCount: 5000,
          wordGoal: 3000,
          summary: "",
          updated: "2026-01-01T09:00:00+08:00",
        },
      ],
    },
  ];

  it("切到大纲标签页会载入并渲染卷章", async () => {
    outlineMock.mockResolvedValue(outline);
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const tab = [...root.querySelectorAll("[role='tab']")].find((t) =>
      t.textContent?.includes("大纲"),
    );
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(outlineMock).toHaveBeenCalled();
    expect(root.textContent).toContain("第一卷 落羽");
    expect(root.textContent).toContain("第一章 落羽");
    dispose();
  });

  it("大纲里显示卷的字数与章数", async () => {
    outlineMock.mockResolvedValue(outline);
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const tab = [...root.querySelectorAll("[role='tab']")].find((t) =>
      t.textContent?.includes("大纲"),
    );
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(root.textContent).toContain("12,000");
    dispose();
  });

  it("点大纲里的章会跳转并关闭", async () => {
    outlineMock.mockResolvedValue(outline);
    const onClose = vi.fn();
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={onClose} />
    ));
    const tab = [...root.querySelectorAll("[role='tab']")].find((t) =>
      t.textContent?.includes("大纲"),
    );
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    (
      root.querySelector("button.outline__chapter") as HTMLButtonElement
    ).click();
    expect(selectedChapterId()).toBe("c1");
    expect(pendingJump()?.chapterId).toBe("c1");
    expect(onClose).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("大纲为空时给出空状态而不是白屏", async () => {
    outlineMock.mockResolvedValue([]);
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const tab = [...root.querySelectorAll("[role='tab']")].find((t) =>
      t.textContent?.includes("大纲"),
    );
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(root.textContent).toContain("还没有可展示的大纲");
    dispose();
  });

  it("大纲载入失败时退化为空状态而不是抛异常", async () => {
    outlineMock.mockRejectedValue(new Error("boom"));
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} />
    ));
    const tab = [...root.querySelectorAll("[role='tab']")].find((t) =>
      t.textContent?.includes("大纲"),
    );
    tab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(root.textContent).toContain("还没有可展示的大纲");
    dispose();
  });

  it("initialTab 可以直接落在大纲上", async () => {
    outlineMock.mockResolvedValue(outline);
    const { root, dispose } = mount(() => (
      <SearchPanel open={true} onClose={() => undefined} initialTab="outline" />
    ));
    await settle();
    expect(root.textContent).toContain("第一卷 落羽");
    dispose();
  });
});
