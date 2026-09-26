/**
 * 命令面板测试（T5.7）。
 *
 * ## 要测的是"键盘到底能不能用"
 *
 * 命令面板的全部价值在于**不碰鼠标就能执行任何功能**
 * （计划书 A9 验收项：「不碰鼠标即可完成：打开书、切章、写作、检索、导出」）。
 * 因此这里逐条验证键盘路径：打开即聚焦、↑↓ 移动、
 * 回车执行、禁用项不可执行、Tab 序只占一格。
 *
 * 与之配套的是 palette.test.ts 里对匹配质量的断言 ——
 * 那边保证"搜得到"，这里保证"选得中"。
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { CommandPalette, type CommandItem } from "./CommandPalette";

/**
 * 把组件渲染到临时节点里，并返回**一个能查到内容的根**。
 *
 * ## 为什么查询根必须是 document.body
 *
 * CommandPalette 用 <Dialog> 渲染，而 Dialog 的底座 Modal 会把内容
 * <Portal mount={document.body}> 到 body 上。这是模态**必需**的做法
 * （否则侧栏的 overflow: hidden 与编辑器的层叠上下文会把弹层裁掉）。
 *
 * 代价是挂载点里什么都没有。第一版直接用挂载点当根，结果
 * querySelectorAll("button.cmd__item") 永远返回空数组 —— 表现为
 * "组件没渲染"，但实际上是"查错了地方"。
 *
 * ## dispose 只删本次新增的节点
 *
 * Portal 插到 body 上的 DOM 不一定随 dispose() 一起消失（Dialog 有
 * 退场动画）。用例之间不清理会让后面的断言读到前面留下的内容 ——
 * 那种串味极难定位。
 */
function mount(component: () => unknown): { root: HTMLElement; dispose: () => void } {
  const before = new Set(document.body.children);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(component as never, host);
  return {
    root: document.body as HTMLElement,
    dispose: () => {
      dispose();
      for (const child of Array.from(document.body.children)) {
        if (!before.has(child)) child.remove();
      }
    },
  };
}

/** 造一组命令。 */
function makeCommands(overrides: Partial<CommandItem> = {}): CommandItem[] {
  const base = (id: string, label: string, group: string): CommandItem => ({
    id,
    label,
    group,
    run: () => undefined,
    ...overrides,
  });
  return [
    base("search", "全文检索", "导航"),
    base("stats", "写作统计", "导航"),
    base("newChapter", "新建一章", "写作"),
    base("toggleLeft", "折叠 / 展开左栏", "视图"),
  ];
}

/** 取列表项。 */
function items(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>("button.cmd__item")];
}

describe("命令面板基础", () => {
  it("打开时渲染输入框与全部命令", () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    expect(root.querySelector("input.cmd__input")).not.toBeNull();
    expect(items(root)).toHaveLength(4);
    dispose();
  });

  it("关闭时不渲染任何内容", () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={false} onClose={() => undefined} commands={makeCommands()} />
    ));
    expect(root.querySelector("input.cmd__input")).toBeNull();
    dispose();
  });

  it("每项显示分组与名字", () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    expect(root.textContent).toContain("全文检索");
    expect(root.textContent).toContain("导航");
    dispose();
  });

  it("列表带 listbox 语义与可读标签", () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    const list = root.querySelector("[role='listbox']");
    expect(list?.getAttribute("aria-label")).toBe("可用命令");
    expect(root.querySelectorAll("[role='option']")).toHaveLength(4);
    dispose();
  });
});

describe("模糊搜索", () => {
  it("输入后只留下匹配项", async () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    const input = root.querySelector("input.cmd__input") as HTMLInputElement;
    input.value = "统计";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await Promise.resolve();
    expect(items(root)).toHaveLength(1);
    expect(root.textContent).toContain("写作统计");
    dispose();
  });

  it("子序列也能匹配（新章 → 新建一章）", async () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    const input = root.querySelector("input.cmd__input") as HTMLInputElement;
    input.value = "新章";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await Promise.resolve();
    expect(items(root)).toHaveLength(1);
    dispose();
  });

  it("没有匹配时给出说明而不是空白", async () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    const input = root.querySelector("input.cmd__input") as HTMLInputElement;
    input.value = "zzzzz";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await Promise.resolve();
    expect(root.textContent).toContain("没有匹配的命令");
    dispose();
  });

  it("清空关键词后恢复全部命令", async () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    const input = root.querySelector("input.cmd__input") as HTMLInputElement;
    input.value = "统计";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await Promise.resolve();
    input.value = "";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await Promise.resolve();
    expect(items(root)).toHaveLength(4);
    dispose();
  });
});

describe("键盘可达（A9）", () => {
  it("第一项在 Tab 序里（roving tabindex）", () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    const all = items(root);
    expect(all[0]?.getAttribute("tabindex")).toBe("0");
    expect(all[1]?.getAttribute("tabindex")).toBe("-1");
    dispose();
  });

  it("↓ 在列表里下移，↑ 上移", async () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    const list = root.querySelector(".cmd__list") as HTMLElement;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await Promise.resolve();
    expect(items(root)[1]?.getAttribute("tabindex")).toBe("0");

    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await Promise.resolve();
    expect(items(root)[0]?.getAttribute("tabindex")).toBe("0");
    dispose();
  });

  it("↑ 在首项处停住（不循环，避免误操作）", async () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    const list = root.querySelector(".cmd__list") as HTMLElement;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await Promise.resolve();
    expect(items(root)[0]?.getAttribute("tabindex")).toBe("0");
    dispose();
  });

  it("End 跳到末项，Home 回到首项", async () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    const list = root.querySelector(".cmd__list") as HTMLElement;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await Promise.resolve();
    const all = items(root);
    expect(all[all.length - 1]?.getAttribute("tabindex")).toBe("0");

    list.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await Promise.resolve();
    expect(items(root)[0]?.getAttribute("tabindex")).toBe("0");
    dispose();
  });

  it("回车执行当前项并关闭面板", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const commands: CommandItem[] = [{ id: "x", label: "做点什么", group: "视图", run }];
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={onClose} commands={commands} />
    ));
    const list = root.querySelector(".cmd__list") as HTMLElement;
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("点击同样执行并关闭", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const commands: CommandItem[] = [{ id: "x", label: "做点什么", group: "视图", run }];
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={onClose} commands={commands} />
    ));
    items(root)[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("禁用项被点击时不执行", () => {
    const run = vi.fn();
    const commands: CommandItem[] = [
      { id: "x", label: "暂时不可用", group: "视图", run, enabled: () => false },
    ];
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={commands} />
    ));
    const item = items(root)[0];
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(run).not.toHaveBeenCalled();
    // 禁用项仍然渲染：它是"为什么不能用"的解释载体
    expect(item?.getAttribute("aria-disabled")).toBe("true");
    dispose();
  });

  it("禁用项仍然可以被搜到（否则用户以为功能不存在）", async () => {
    const commands: CommandItem[] = [
      { id: "x", label: "写作统计", group: "导航", run: () => undefined, enabled: () => false },
    ];
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={commands} />
    ));
    const input = root.querySelector("input.cmd__input") as HTMLInputElement;
    input.value = "统计";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await Promise.resolve();
    expect(items(root)).toHaveLength(1);
    dispose();
  });

  it("↓ 把焦点从输入框送进列表", async () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    // Dialog 的 initialFocus 与 mount 都是**异步**排的（它要等
    // Portal 把节点插进 body 才能聚焦）。因此这里必须先等一拍 ——
    // 不然输入框还没拿到焦点，keydown 的事件目标就不对
    await Promise.resolve();
    const input = root.querySelector("input.cmd__input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    // 焦点转移是同步的（focusActiveItem 直接调 .focus()），
    // 但 Solid 的渲染是批处理的，因此再让一拍微任务落地
    await Promise.resolve();
    expect(document.activeElement?.classList.contains("cmd__item")).toBe(true);
    dispose();
  });

  it("↓ 把高亮与焦点一起前移（不会固定在「第一项」）", async () => {
    // 这条抓的是一类真实缺陷：早先的实现里，输入框的 ↓ 只做
    // 「把焦点交给第一项」（它写的是 document.querySelector(".cmd__item")，
    // 拿到的是全局第一个），而**高亮**根本不动。作者以为自己在
    // 往下选，实际每次都被拽回第一项，回车执行的是错的那条命令。
    //
    // 正确的语义是：↓ 同时前移高亮与焦点，两者永远指向同一项。
    // 这条测试直接断言"高亮项 == 聚焦项"，不关心它具体是哪一条 ——
    // 命令列表按匹配度排序，写死"第 N 项是哪个命令"会让测试
    // 与排序算法耦合，那种测试改一次排序就得改一遍。
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    await Promise.resolve();
    const input = root.querySelector("input.cmd__input") as HTMLInputElement;

    // 按两次 ↓：每次都应前移一项，且焦点始终跟着高亮
    for (let step = 0; step < 2; step += 1) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await Promise.resolve();
      const focused = document.activeElement as HTMLElement | null;
      const highlighted = root.querySelector<HTMLElement>('[aria-selected="true"]');
      expect(highlighted).not.toBeNull();
      // 核心断言：焦点落在**当前高亮项**上
      expect(focused).toBe(highlighted);
    }

    // 而且确实前移了：不在第一项上
    expect(document.activeElement).not.toBe(items(root)[0]);
    dispose();
  });

  it("↑ 在列表首项上不会越界（两端不循环）", async () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    await Promise.resolve();
    const input = root.querySelector("input.cmd__input") as HTMLInputElement;

    // 连按更多次 ↑ 也不应把高亮推到负数或把它弄丢
    for (let i = 0; i < 5; i += 1) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await Promise.resolve();
    }
    expect(document.activeElement).toBe(items(root)[0]);
    dispose();
  });

  it("显示键盘提示", () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={makeCommands()} />
    ));
    expect(root.textContent).toContain("回车执行");
    dispose();
  });

  it("空命令表也不会崩", () => {
    const { root, dispose } = mount(() => (
      <CommandPalette open={true} onClose={() => undefined} commands={[]} />
    ));
    expect(root.textContent).toContain("没有匹配的命令");
    dispose();
  });
});
