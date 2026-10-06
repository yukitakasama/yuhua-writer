/**
 * 数据安全分区的**集成**测试：不打桩 `@/lib/ipc`。
 *
 * ## 为什么在同目录已有 data-safety.test.tsx 的情况下还要这一份
 *
 * 那份把 IPC 整层换成了手写桩，好处是能精确驱动失败路径，
 * 代价是它**没有经过真实的 `call()` 分发** —— 也就是没有验证
 * 「绑定层的命令名、参数与 mock 后端的实现真的对得上」。
 * 本项目已经因为这类断层吃过一次严重教训：`open_workspace` 的参数名
 * 前后端不一致，浏览器测试全绿、真机一跑就崩（见 CHANGELOG 的 P0 修复轮）。
 *
 * 所以这份走真实 ipc + mock 后端，只回答三个问题：
 * 1. 深链 `initialTab="data"` 能不能把用户带到数据安全分区；
 * 2. 那三个回收站命令与 `rebuildIndex` 在真实调用路径上能不能跑通；
 * 3. 没有工作区时这一页会不会崩。
 */

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetMockBackend } from "@/lib/ipc";
import {
  __resetWorkspaceState,
  chaptersIn,
  openWorkspace,
  removeChapter,
  workspaceState,
} from "@/app/workspace-store";

import { SettingsPanel } from "./SettingsPanel";

beforeEach(() => {
  cleanup();
  __resetMockBackend();
  __resetWorkspaceState();
});

/** 等真实 IPC 的微任务链跑完（call() 里是 async + mock 的 Promise.resolve）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("设置面板深链到数据安全分区", () => {
  it("initialTab=data 时打开就停在数据安全页，并渲染回收站", async () => {
    render(() => (
      <SettingsPanel open onClose={() => undefined} initialTab="data" />
    ));
    await flush();

    expect(screen.queryByText("崩溃恢复")).not.toBeNull();
    expect(screen.queryByText("云盘冲突副本")).not.toBeNull();
    expect(screen.queryByText("全文索引")).not.toBeNull();
    expect(screen.queryByText("回收站")).not.toBeNull();

    const tab = screen.getByRole("tab", { selected: true });
    expect(tab.textContent).toBe("数据安全");
  });

  it("不传 initialTab 时仍停在默认的「外观」", () => {
    render(() => <SettingsPanel open onClose={() => undefined} />);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      "外观",
    );
  });

  it("真实调用路径下「重建索引」能跑通并给出反馈", async () => {
    const errorSpy = vi.spyOn(console, "error");
    render(() => (
      <SettingsPanel open onClose={() => undefined} initialTab="data" />
    ));
    await flush();

    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "重建索引",
    ) as HTMLElement;
    fireEvent.click(button);
    await flush();

    expect(document.body.textContent).toContain("索引已重建。");
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("空回收站在真实后端下显示为空态而不是报错", async () => {
    render(() => (
      <SettingsPanel open onClose={() => undefined} initialTab="data" />
    ));
    await flush();

    expect(screen.queryByText("回收站是空的。")).not.toBeNull();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("删除一章后，回收站里能看到它并可以恢复", async () => {
    expect(await openWorkspace("D:/书/羽化录")).toBe(true);
    await flush();

    // 从 mock 的示例数据里取一章删掉，让回收站真的有内容
    const first = chaptersIn(workspaceState.document?.volumes[0]?.id ?? "")[0];
    expect(first).toBeDefined();
    expect(await removeChapter((first as { id: string }).id)).toBe(true);
    await flush();

    render(() => (
      <SettingsPanel open onClose={() => undefined} initialTab="data" />
    ));
    await flush();

    const item = document.querySelector(".trash-section__item");
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain((first as { title: string }).title);

    const restore = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "恢复",
    ) as HTMLElement;
    fireEvent.click(restore);
    await flush();

    expect(document.querySelector(".trash-section__item")).toBeNull();
  });
});
