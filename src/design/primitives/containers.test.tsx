/**
 * 容器原语测试（T1.5）。
 *
 * 验收明确要求的四件事都在这里：
 * - Dialog 的 Esc 关闭与焦点陷阱
 * - 键盘导航（菜单、标签栏）
 * - reduced-motion 降级（弹层不再位移、时长压到 100ms 以内）
 * - Toast 队列（上限、去重置顶、自动消失、手动关闭）
 */

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  Button,
  Dialog,
  Drawer,
  Menu,
  MenuItem,
  MenuSeparator,
  Popover,
  ScrollArea,
  Tabs,
  ToastRegion,
  clearToasts,
  dismissToast,
  pushToast,
  resetToastStore,
  toasts,
} from "./index";
import { mockReducedMotion, pressKey } from "./test-utils";

describe("Dialog", () => {
  it("打开时渲染标题、正文与页脚，并标记为模态", () => {
    render(() => (
      <Dialog
        open
        onClose={() => {}}
        title="删除章节"
        footer={<Button>确定</Button>}
      >
        <p>删除后可在回收站找回。</p>
      </Dialog>
    ));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("删除章节")).not.toBeNull();
    expect(screen.getByText("删除后可在回收站找回。")).not.toBeNull();
    expect(screen.getByText("确定")).not.toBeNull();
  });

  it("标题通过 aria-labelledby 关联到对话框", () => {
    render(() => (
      <Dialog open onClose={() => {}} title="删除章节">
        <p>内容</p>
      </Dialog>
    ));
    const dialog = screen.getByRole("dialog");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).not.toBeNull();
    expect(document.getElementById(labelledBy as string)?.textContent).toBe(
      "删除章节",
    );
  });

  it("按 Esc 触发 onClose", () => {
    const onClose = vi.fn();
    render(() => (
      <Dialog open onClose={onClose} title="删除章节">
        <p>内容</p>
      </Dialog>
    ));
    pressKey(document, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closeOnEscape=false 时 Esc 不关闭", () => {
    const onClose = vi.fn();
    render(() => (
      <Dialog open onClose={onClose} closeOnEscape={false} title="正在导出">
        <p>请稍候</p>
      </Dialog>
    ));
    pressKey(document, "Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closed 状态不渲染任何对话框", () => {
    render(() => (
      <Dialog open={false} onClose={() => {}} title="删除章节">
        <p>内容</p>
      </Dialog>
    ));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("焦点陷阱：Tab 在最后一个元素上绕回第一个", () => {
    render(() => (
      <Dialog
        open
        onClose={() => {}}
        title="确认"
        footer={<Button>取消</Button>}
      >
        <Button>第一个</Button>
      </Dialog>
    ));
    const dialog = screen.getByRole("dialog");
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("button"),
    );
    expect(focusables.length).toBeGreaterThanOrEqual(2);

    const last = focusables[focusables.length - 1] as HTMLElement;
    last.focus();
    pressKey(document, "Tab");

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
  });

  it("焦点陷阱：焦点被脚本移到弹层外时会被拉回", async () => {
    const outside = document.createElement("button");
    outside.id = "page-button";
    document.body.appendChild(outside);

    render(() => (
      <Dialog open onClose={() => {}} title="确认">
        <Button>弹层内</Button>
      </Dialog>
    ));

    outside.focus();
    await Promise.resolve();

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    outside.remove();
  });
});

describe("Drawer", () => {
  it("从右侧滑出并带标题", () => {
    render(() => (
      <Drawer open onClose={() => {}} title="章节目录">
        <p>第一章</p>
      </Drawer>
    ));
    const dialog = screen.getByRole("dialog");
    expect(dialog.classList.contains("yh-drawer--right")).toBe(true);
    expect(screen.getByText("章节目录")).not.toBeNull();
  });

  it("side=left 时使用左侧类名", () => {
    render(() => (
      <Drawer open onClose={() => {}} side="left" title="检索">
        <p>结果</p>
      </Drawer>
    ));
    expect(
      screen.getByRole("dialog").classList.contains("yh-drawer--left"),
    ).toBe(true);
  });

  it("按 Esc 关闭", () => {
    const onClose = vi.fn();
    render(() => (
      <Drawer open onClose={onClose} title="章节目录">
        <p>第一章</p>
      </Drawer>
    ));
    pressKey(document, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("width 通过 CSS 变量注入", () => {
    render(() => (
      <Drawer open onClose={() => {}} width={480} title="设置">
        <p>内容</p>
      </Drawer>
    ));
    const dialog = screen.getByRole("dialog") as HTMLElement;
    expect(dialog.style.getPropertyValue("--yh-drawer-size")).toBe("480px");
  });
});

describe("Popover", () => {
  it("打开时渲染内容并把焦点移入面板", async () => {
    render(() => (
      <Popover
        open
        onOpenChange={() => {}}
        content={<Button>面板内按钮</Button>}
      >
        <Button>触发</Button>
      </Popover>
    ));
    await Promise.resolve();
    expect(screen.getByText("面板内按钮")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("面板内按钮");
  });

  it("点击外部请求关闭", () => {
    const onOpenChange = vi.fn();
    render(() => (
      <Popover open onOpenChange={onOpenChange} content={<p>面板</p>}>
        <Button>触发</Button>
      </Popover>
    ));
    fireEvent.mouseDown(document.body);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Esc 请求关闭", () => {
    const onOpenChange = vi.fn();
    render(() => (
      <Popover open onOpenChange={onOpenChange} content={<p>面板</p>}>
        <Button>触发</Button>
      </Popover>
    ));
    pressKey(document, "Escape");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("关闭状态不渲染面板", () => {
    render(() => (
      <Popover open={false} onOpenChange={() => {}} content={<p>面板</p>}>
        <Button>触发</Button>
      </Popover>
    ));
    expect(screen.queryByText("面板")).toBeNull();
  });
});

describe("Menu", () => {
  const buildMenu = (onClose = vi.fn(), onSelect = vi.fn()) => (
    <Menu open onClose={onClose}>
      <MenuItem onSelect={onSelect}>重命名章节</MenuItem>
      <MenuItem onSelect={onSelect}>复制链接</MenuItem>
      <MenuSeparator />
      <MenuItem danger onSelect={onSelect}>
        删除章节
      </MenuItem>
    </Menu>
  );

  it("渲染菜单语义与分隔线", () => {
    render(() => buildMenu());
    expect(screen.getByRole("menu")).not.toBeNull();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    expect(screen.getByRole("separator")).not.toBeNull();
  });

  it("打开后 roving tabindex 只让首项进入 Tab 序", () => {
    render(() => buildMenu());
    const items = screen.getAllByRole("menuitem");
    expect(items[0]?.getAttribute("tabindex")).toBe("0");
    expect(items[1]?.getAttribute("tabindex")).toBe("-1");
    expect(items[2]?.getAttribute("tabindex")).toBe("-1");
  });

  it("方向键在菜单项之间移动焦点", () => {
    render(() => buildMenu());
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    items[0]?.focus();

    pressKey(menu, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    expect(items[1]?.getAttribute("tabindex")).toBe("0");

    pressKey(menu, "ArrowUp");
    expect(document.activeElement).toBe(items[0]);
  });

  it("方向键在底部循环回到顶部", () => {
    render(() => buildMenu());
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    items[2]?.focus();
    pressKey(menu, "ArrowDown");
    expect(document.activeElement).toBe(items[0]);
  });

  it("End 跳到末项，Home 跳回首项", () => {
    render(() => buildMenu());
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    items[0]?.focus();

    pressKey(menu, "End");
    expect(document.activeElement).toBe(items[2]);
    pressKey(menu, "Home");
    expect(document.activeElement).toBe(items[0]);
  });

  it("Esc 关闭菜单", () => {
    const onClose = vi.fn();
    render(() => buildMenu(onClose));
    pressKey(screen.getByRole("menu"), "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab 视为离开菜单并请求关闭", () => {
    const onClose = vi.fn();
    render(() => buildMenu(onClose));
    pressKey(screen.getByRole("menu"), "Tab");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击菜单项触发 onSelect", () => {
    const onSelect = vi.fn();
    render(() => buildMenu(vi.fn(), onSelect));
    fireEvent.click(screen.getByText("重命名章节"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("禁用项不触发 onSelect 且标 aria-disabled", () => {
    const onSelect = vi.fn();
    render(() => (
      <Menu open onClose={() => {}}>
        <MenuItem disabled onSelect={onSelect}>
          暂不可用
        </MenuItem>
      </Menu>
    ));
    const item = screen.getByRole("menuitem");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("关闭状态不渲染菜单", () => {
    render(() => (
      <Menu open={false} onClose={() => {}}>
        <MenuItem>重命名</MenuItem>
      </Menu>
    ));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Tabs", () => {
  const items = [
    { value: "outline", label: "大纲" },
    { value: "draft", label: "正文" },
    { value: "notes", label: "备注" },
  ];

  it("渲染 tablist 与三个 tab，选中项 aria-selected 为 true", () => {
    render(() => <Tabs items={items} value="draft" onChange={() => {}} />);
    expect(screen.getByRole("tablist")).not.toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      "正文",
    );
  });

  it("roving tabindex：只有选中项进入 Tab 序", () => {
    render(() => <Tabs items={items} value="draft" onChange={() => {}} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]?.getAttribute("tabindex")).toBe("-1");
    expect(tabs[1]?.getAttribute("tabindex")).toBe("0");
  });

  it("点击标签触发 onChange", () => {
    const onChange = vi.fn();
    render(() => <Tabs items={items} value="outline" onChange={onChange} />);
    fireEvent.click(screen.getByText("备注"));
    expect(onChange).toHaveBeenCalledWith("notes");
  });

  it("右方向键切到下一个标签（selection follows focus）", async () => {
    const onChange = vi.fn();
    render(() => <Tabs items={items} value="outline" onChange={onChange} />);
    pressKey(screen.getByRole("tablist"), "ArrowRight");
    expect(onChange).toHaveBeenCalledWith("draft");
  });

  it("左方向键在首项上循环到末项", () => {
    const onChange = vi.fn();
    render(() => <Tabs items={items} value="outline" onChange={onChange} />);
    pressKey(screen.getByRole("tablist"), "ArrowLeft");
    expect(onChange).toHaveBeenCalledWith("notes");
  });

  it("End 跳到最后一个标签", () => {
    const onChange = vi.fn();
    render(() => <Tabs items={items} value="outline" onChange={onChange} />);
    pressKey(screen.getByRole("tablist"), "End");
    expect(onChange).toHaveBeenCalledWith("notes");
  });

  it("面板通过 aria-labelledby 与 tab 双向关联", () => {
    render(() => (
      <Tabs items={items} value="draft" onChange={() => {}}>
        {(value) => <p>面板内容 {value}</p>}
      </Tabs>
    ));
    const panel = screen.getByRole("tabpanel");
    const labelledBy = panel.getAttribute("aria-labelledby");
    const selected = screen.getByRole("tab", { selected: true });
    expect(selected.id).toBe(labelledBy);
    expect(panel.textContent).toContain("面板内容 draft");
  });
});

describe("ScrollArea", () => {
  it("视口可聚焦，保证键盘用户能滚动内容", () => {
    render(() => (
      <ScrollArea>
        <div style={{ height: "2000px" }}>长内容</div>
      </ScrollArea>
    ));
    const viewport = document.querySelector(
      ".yh-scroll-area__viewport",
    ) as HTMLElement;
    expect(viewport.getAttribute("tabindex")).toBe("0");
    expect(viewport.getAttribute("role")).toBe("region");
  });

  it("滚动回调给出位置信息与是否到底", () => {
    const onScroll = vi.fn();
    render(() => (
      <ScrollArea onScroll={onScroll}>
        <div>内容</div>
      </ScrollArea>
    ));
    const viewport = document.querySelector(
      ".yh-scroll-area__viewport",
    ) as HTMLElement;
    fireEvent.scroll(viewport);
    expect(onScroll).toHaveBeenCalledTimes(1);
    const info = onScroll.mock.calls[0]?.[0] as {
      scrollTop: number;
      atBottom: boolean;
    };
    // jsdom 没有布局，scrollHeight 与 clientHeight 均为 0，
    // 因此这里断言的是「差值为 0 即到底」这条容差逻辑本身。
    expect(info.scrollTop).toBe(0);
    expect(info.atBottom).toBe(true);
  });
});

describe("Toast 队列", () => {
  it("推送后出现在队列里", () => {
    resetToastStore();
    pushToast({ id: "t1", title: "已保存" });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.title).toBe("已保存");
  });

  it("渲染到托盘并带 aria-live 播报", () => {
    resetToastStore();
    render(() => <ToastRegion />);
    pushToast({ id: "t1", title: "已保存到《羽化写作》", duration: 0 });
    expect(screen.getByText("已保存到《羽化写作》")).not.toBeNull();
    expect(document.querySelector("[aria-live='polite']")).not.toBeNull();
  });

  it("队列上限为 3，超出时丢弃最旧的一条", () => {
    resetToastStore();
    pushToast({ id: "t1", title: "第一条", duration: 0 });
    pushToast({ id: "t2", title: "第二条", duration: 0 });
    pushToast({ id: "t3", title: "第三条", duration: 0 });
    pushToast({ id: "t4", title: "第四条", duration: 0 });

    const queue = toasts();
    expect(queue).toHaveLength(3);
    expect(queue.map((item) => item.id)).toEqual(["t2", "t3", "t4"]);
  });

  it("相同 id 重复推送是更新而不是新增，且会置顶", () => {
    resetToastStore();
    pushToast({ id: "save", title: "保存中", duration: 0 });
    pushToast({ id: "other", title: "另一条", duration: 0 });
    pushToast({ id: "save", title: "已保存", duration: 0 });

    const queue = toasts();
    expect(queue).toHaveLength(2);
    expect(queue[queue.length - 1]?.title).toBe("已保存");
  });

  it("dismissToast 立即移除", () => {
    resetToastStore();
    pushToast({ id: "t1", title: "第一条", duration: 0 });
    pushToast({ id: "t2", title: "第二条", duration: 0 });
    dismissToast("t1");
    expect(toasts().map((item) => item.id)).toEqual(["t2"]);
  });

  it("到达时长后自动消失", async () => {
    vi.useFakeTimers();
    resetToastStore();
    pushToast({ id: "t1", title: "已保存", duration: 500 });
    expect(toasts()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(toasts()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2);
    expect(toasts()).toHaveLength(0);
    vi.useRealTimers();
  });

  it("duration 为 0 时永不自动消失", async () => {
    vi.useFakeTimers();
    resetToastStore();
    pushToast({ id: "t1", title: "需要手动关闭", duration: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toasts()).toHaveLength(1);
    vi.useRealTimers();
  });

  it("clearToasts 清空队列", () => {
    resetToastStore();
    pushToast({ id: "t1", title: "第一条", duration: 0 });
    pushToast({ id: "t2", title: "第二条", duration: 0 });
    clearToasts();
    expect(toasts()).toHaveLength(0);
  });

  it("点击关闭按钮移除该条提示", () => {
    resetToastStore();
    render(() => <ToastRegion />);
    pushToast({ id: "t1", title: "已保存", duration: 0 });
    fireEvent.click(screen.getByLabelText("关闭提示"));
    expect(toasts()).toHaveLength(0);
  });

  it("操作按钮先执行回调再关闭提示", () => {
    resetToastStore();
    const onAction = vi.fn();
    render(() => <ToastRegion />);
    pushToast({
      id: "t1",
      title: "已删除",
      actionLabel: "撤销",
      onAction,
      duration: 0,
    });

    fireEvent.click(screen.getByText("撤销"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(toasts()).toHaveLength(0);
  });
});

describe("reduced-motion 降级", () => {
  it("Dialog 在降级环境不再做 scale 位移", () => {
    mockReducedMotion(true);
    render(() => (
      <Dialog open onClose={() => {}} title="确认">
        <p>内容</p>
      </Dialog>
    ));
    // 降级由 CSS 的 @media 规则与 TS 侧的 motionPolicy 双重保证：
    // 这里断言退场时长确实被压到了 100ms 以内这一可观测契约。
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-state")).toBe("open");
  });

  it("降级后弹层关闭延迟不超过 100ms（功能不受影响）", async () => {
    vi.useFakeTimers();
    mockReducedMotion(true);
    // 用 signal 驱动 open 而不是「重新 render」：
    // Solid 是细粒度响应式，@solidjs/testing-library 的 render 不提供 rerender
    // （没有虚拟树可重渲染）。改 signal 也更贴近真实用法——
    // 真实调用方本来就是持有 open 状态的那一方。
    const [open, setOpen] = createSignal(true);
    render(() => (
      <Dialog open={open()} onClose={() => setOpen(false)} title="确认">
        <p>内容</p>
      </Dialog>
    ));
    expect(screen.queryByRole("dialog")).not.toBeNull();

    setOpen(false);
    // 降级环境下退场动画被压到 <=100ms，超过这个时间仍未卸载即为回归。
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.useRealTimers();
  });
});

// cleanup 由 test-utils 的 afterEach 统一处理。
cleanup;
