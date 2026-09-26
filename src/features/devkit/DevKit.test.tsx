import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { DevKit } from "./DevKit";

/**
 * 组件预览页的测试（T1.9）。
 *
 * ## 这一页为什么也需要测试
 *
 * 预览页最容易出的问题是**"某个区块整个崩掉"** ——
 * 而它恰恰是最不容易被发现的地方（没有人会天天打开它）。
 * 一个抛错的预览页比没有预览页更糟：G1 评审时会直接卡住。
 *
 * 因此这里测的不是"按钮长什么样"（那是视觉评审的事），
 * 而是**每一类原语都能被渲染出来且可交互**。
 */

afterEach(() => cleanup());

describe("组件预览页：整体渲染", () => {
  it("能渲染出标题", () => {
    render(() => <DevKit />);
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("渲染出计划书要求的主要分区", () => {
    render(() => <DevKit />);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
    // 至少要有按钮、输入、容器、动效、图表这几个分区
    expect(headings.length).toBeGreaterThanOrEqual(5);
    expect(headings.some((h) => h.includes("按钮"))).toBe(true);
    expect(headings.some((h) => h.includes("动效"))).toBe(true);
    expect(headings.some((h) => h.includes("图表"))).toBe(true);
  });

  it("列出动效令牌表", () => {
    render(() => <DevKit />);
    // 计划书 5.5 节要求逐条核对，因此表里必须有具体的毫秒数
    const table = document.querySelector(".kit-table");
    expect(table).toBeTruthy();
    expect(table?.textContent).toContain("ms");
  });
});

describe("组件预览页：原语可交互", () => {
  it("对话框能打开", async () => {
    render(() => <DevKit />);
    const button = screen.getByRole("button", { name: "对话框" });
    await fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("抽屉能打开", async () => {
    render(() => <DevKit />);
    const button = screen.getByRole("button", { name: "抽屉" });
    await fireEvent.click(button);
    // 抽屉也是 role=dialog
    expect(screen.getAllByRole("dialog").length).toBeGreaterThan(0);
  });

  it("开关能切换", async () => {
    render(() => <DevKit />);
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThan(0);
    const first = switches[0];
    if (!first) throw new Error("没有找到开关");
    const before = first.getAttribute("aria-checked");
    await fireEvent.click(first);
    expect(first.getAttribute("aria-checked")).not.toBe(before);
  });

  it("复选框能切换", async () => {
    render(() => <DevKit />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThan(0);
    const first = boxes[0];
    if (!first) throw new Error("没有找到复选框");
    const before = (first as HTMLInputElement).checked;
    await fireEvent.click(first);
    expect((first as HTMLInputElement).checked).not.toBe(before);
  });

  it("标签页能切换", async () => {
    render(() => <DevKit />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThanOrEqual(3);
    const second = tabs[1];
    if (!second) throw new Error("没有找到标签");
    await fireEvent.click(second);
    expect(second.getAttribute("aria-selected")).toBe("true");
  });

  it("输入框能输入", async () => {
    render(() => <DevKit />);
    const input = screen.getByPlaceholderText("单行输入") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "测试文本" } });
    expect(input.value).toBe("测试文本");
  });

  it("重放按钮可点击", async () => {
    render(() => <DevKit />);
    const button = screen.getByRole("button", { name: "重放动效" });
    await fireEvent.click(button);
    expect(screen.getByText(/已重放 1 次/)).toBeTruthy();
  });
});

describe("组件预览页：图表基座", () => {
  it("渲染出五档色阶", () => {
    render(() => <DevKit />);
    const cells = document.querySelectorAll(".kit-heat__cell");
    expect(cells.length).toBe(5);
  });

  it("色阶用的是设计令牌而不是硬编码色值", () => {
    render(() => <DevKit />);
    const cells = document.querySelectorAll<HTMLElement>(".kit-heat__cell");
    // heatColors("light") 返回的是具体色值（来自 tokens.css 的 --c-heat-*），
    // 因此这里断言的是"有色值且互不相同"，而不是断言某个具体颜色 ——
    // 断死具体颜色会让改色板时测试无意义地变红
    const colors = Array.from(cells).map((c) => c.style.background);
    expect(colors.every((c) => c.length > 0)).toBe(true);
    expect(new Set(colors).size).toBe(5);
  });

  it("渲染出四个进度环", () => {
    render(() => <DevKit />);
    const rings = document.querySelectorAll(".kit-ring svg");
    expect(rings.length).toBe(4);
  });

  it("进度环有无障碍标签", () => {
    render(() => <DevKit />);
    const rings = screen.getAllByRole("img");
    expect(rings.length).toBeGreaterThanOrEqual(4);
    expect(rings[0]?.getAttribute("aria-label")).toContain("/");
  });
});

describe("组件预览页：无障碍", () => {
  it("图标按钮都有无障碍名称（图标本身不提供上下文）", () => {
    render(() => <DevKit />);
    const buttons = screen.getAllByRole("button");
    const unnamed = buttons.filter((b) => {
      const text = (b.textContent ?? "").trim();
      const label = b.getAttribute("aria-label");
      // 既没有可见文字也没有 aria-label 的按钮是读屏无法使用的
      return text.length === 0 && (label === null || label.trim().length === 0);
    });
    expect(unnamed.length).toBe(0);
  });

  it("没有使用 emoji（全仓硬约定）", () => {
    const { container } = render(() => <DevKit />);
    // 覆盖常见 emoji 区段。全仓零 emoji 是计划书 A8 的要求
    const text = container.textContent ?? "";
    const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
    expect(emojiPattern.test(text)).toBe(false);
  });

  it("没有外链图片（全仓硬约定：图表亦为内联 SVG）", () => {
    const { container } = render(() => <DevKit />);
    expect(container.querySelectorAll("img").length).toBe(0);
  });
});
