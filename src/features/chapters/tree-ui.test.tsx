/**
 * 卷章树的界面态：作者的选择必须活过「重读文稿」。
 *
 * ## 为什么这条值得单开一个文件
 *
 * `reloadDocument()` 在每次增删卷章后都会用后端返回的大纲**整体替换**
 * document，`<For>` 按引用比对项，于是每个 `VolumeGroup` 都被销毁重建。
 * 展开态当时是组件本地的 `createSignal(true)`，一重建就全部回到展开 ——
 * 作者刚加完一章，卷全收起来，得逐个再点。
 *
 * 这类缺陷组件单测照不出来：单独挂一个 `VolumeGroup`，展开收起都是好的，
 * 只有「父级数据被整体替换」时才会露出来。所以这里走真实的
 * `openWorkspace` + `reloadDocument`，用界面上看得见的 `aria-expanded` 断言。
 */

import { cleanup, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it } from "vitest";

import { __resetMockBackend } from "@/lib/ipc";
import {
  __resetWorkspaceState,
  openWorkspace,
  reloadDocument,
} from "@/app/workspace-store";
import { ChapterTree } from "./ChapterTree";
import { __resetTreeUi } from "./tree-ui-store";

/** 把微任务链跑完：`reloadDocument` 里是两次 IPC。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

/** 第 N 个卷头的展开按钮。 */
function toggleAt(index: number): HTMLElement {
  const toggles = [...document.querySelectorAll(".tree-group__toggle")];
  const found = toggles[index];
  if (!found) throw new Error("卷章树里没有这个卷");
  return found as HTMLElement;
}

beforeEach(async () => {
  cleanup();
  __resetMockBackend();
  __resetWorkspaceState();
  __resetTreeUi();
  expect(await openWorkspace("D:/书/羽化录")).toBe(true);
  await flush();
});

describe("卷的展开选择", () => {
  it("没被点过的卷默认展开", () => {
    render(() => <ChapterTree />);
    expect(toggleAt(0).getAttribute("aria-expanded")).toBe("true");
  });

  it("重读文稿之后，作者折叠起来的卷仍然是折叠的", async () => {
    render(() => <ChapterTree />);

    toggleAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggleAt(0).getAttribute("aria-expanded")).toBe("false");

    await reloadDocument();
    await flush();

    // 视图整个重建了，但选择还在
    expect(toggleAt(0).getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll(".tree-group").length).toBeGreaterThan(0);
  });

  it("展开回去也 survives 重读，两个方向都不该被重置", async () => {
    render(() => <ChapterTree />);

    toggleAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    toggleAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggleAt(0).getAttribute("aria-expanded")).toBe("true");

    await reloadDocument();
    await flush();
    expect(toggleAt(0).getAttribute("aria-expanded")).toBe("true");
  });

  it("换一本工作区就忘掉上一本的选择（卷 ID 是每本书专属的）", async () => {
    render(() => <ChapterTree />);
    toggleAt(0).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggleAt(0).getAttribute("aria-expanded")).toBe("false");

    expect(await openWorkspace("D:/书/另一本")).toBe(true);
    await flush();
    render(() => <ChapterTree />);

    expect(toggleAt(0).getAttribute("aria-expanded")).toBe("true");
  });
});
