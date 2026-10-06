/**
 * 数据安全分区与回收站的交互测试。
 *
 * ## 这一层要守住什么
 *
 * 后端四个回收站命令与 `rebuild_index` 早就有测试，但那证明的是
 * 「函数正确」，不是「用户点得到、点了不会丢稿」。本文件覆盖的正是这段
 * 之前完全空白的距离 —— `pnpm check:ipc` 的界面入口反查只能说明
 * 「有源文件引用了这个绑定」，说明不了交互是对的。
 *
 * ## 为什么打桩 `@/lib/ipc`
 *
 * 回收站的夹具要能指定列表内容与失败路径。mock 后端是共享单例、
 * 且 `listTrash()` 初始为空，用它就只能测「空态」这一种情况；
 * 错误呈现、二次确认这些恰恰是本页最重要的行为。
 *
 * ## 三条被反复强调的约束
 *
 * 1. **绝不调用 `getRecoveryReport`** —— 它的实现是重新 `openWorkspace`，
 *    在设置页里点一下「检查」就把未保存的稿子丢了。所以有一条测试专门钉它。
 * 2. **破坏性动作必须二次确认**，且确认之前不能已经发出请求。
 * 3. **读列表失败不能长得像「回收站是空的」** —— 那会让人以为
 *    备份全没了，从而去做真正毁数据的操作。
 */

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrashEntry } from "@/lib/ipc";

const {
  listTrashMock,
  restoreMock,
  purgeMock,
  emptyMock,
  rebuildMock,
  recoveryMock,
  reloadDocMock,
} = vi.hoisted(() => ({
  listTrashMock: vi.fn(),
  restoreMock: vi.fn(),
  purgeMock: vi.fn(),
  emptyMock: vi.fn(),
  rebuildMock: vi.fn(),
  recoveryMock: vi.fn(),
  reloadDocMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  listTrash: () => listTrashMock(),
  restoreFromTrash: (name: string) => restoreMock(name),
  purgeFromTrash: (name: string) => purgeMock(name),
  emptyTrash: () => emptyMock(),
  rebuildIndex: () => rebuildMock(),
  // 留着这个 spy 只为证明本页**不**调它：它的实现是 openWorkspace()，
  // 在设置页里点一下「检查」就会把未保存的稿子一起丢掉。
  getRecoveryReport: (root: string) => recoveryMock(root),
}));

vi.mock("@/app/workspace-store", () => ({
  workspaceState: {
    root: "D:/书/羽化录",
    document: {
      book: {
        id: "bk_1",
        title: "羽化录",
        author: "",
        description: "",
        created: "2026-01-01T00:00:00+08:00",
        updated: "2026-01-01T00:00:00+08:00",
      },
      volumes: [],
      chapters: [],
      recovery: {
        sweptTempFiles: 3,
        interruptedOperations: ["删除章节 第三章"],
        pendingPaths: ["chapters/第三章.md"],
        purgedTrashItems: 1,
        conflicts: [
          {
            relativePath: "chapters/第一章 副本.md",
            fileName: "第一章 副本.md",
            originalFileName: "第一章.md",
            patternLabel: "网盘「副本」命名",
          },
        ],
      },
    },
  },
  /**
   * 恢复成功的代价是「卷章树里多回一个节点」，所以 TrashSection 会重读文档。
   * 这里给个可控的替身：断言它被调用，而不是让它去碰没打桩的 `openWorkspace`。
   */
  reloadDocument: reloadDocMock,
}));

import { DataSafetyPanel } from "./DataSafetyPanel";
import { TrashSection } from "./TrashSection";

/** 一条真实的回收站条目形状（字段名与 Rust `TrashEntry` 对齐）。 */
function entry(overrides: Partial<TrashEntry> = {}): TrashEntry {
  return {
    originalId: "ch_1",
    originalTitle: "第三章 落羽",
    originalPath: "chapters/第三章.md",
    trashDirName: "ch_1-20260920",
    deletedAt: "2026-09-20T10:00:00+08:00",
    kind: "chapter",
    ...overrides,
  };
}

/** 等一轮微任务：组件里的动作都是 async。 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * 按文本找按钮，每次调用都重新查 DOM。
 *
 * 不能把结果缓存成变量：Solid 的 `Show` 换分支时会**重建**节点，
 * 手里那份引用会脱离文档，在它上面 fireEvent 什么都不发生。
 */
function buttonsByText(container: Element, text: string): HTMLElement[] {
  return [...container.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === text,
  ) as HTMLElement[];
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  listTrashMock.mockResolvedValue([]);
  restoreMock.mockResolvedValue(undefined);
  purgeMock.mockResolvedValue(undefined);
  emptyMock.mockResolvedValue(0);
  rebuildMock.mockResolvedValue(undefined);
  reloadDocMock.mockResolvedValue(undefined);
  recoveryMock.mockRejectedValue(new Error("不该被调用"));
});

describe("回收站列表", () => {
  it("进入分区就读取列表，并显示标题与路径", async () => {
    listTrashMock.mockResolvedValue([entry()]);
    const view = render(() => <TrashSection />);
    await settle();

    const item = view.container.querySelector(".trash-section__item");
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain("第三章 落羽");
    expect(item?.textContent).toContain("chapters/第三章.md");
    expect(listTrashMock).toHaveBeenCalledTimes(1);
  });

  it("没有条目时明确说「回收站是空的」", async () => {
    render(() => <TrashSection />);
    await settle();
    expect(screen.queryByText("回收站是空的。")).not.toBeNull();
  });

  it("读取失败时显示错误，而不是伪装成空列表", async () => {
    // 这条区分的是「没东西可恢复」与「我没读到」——
    // 前者是事实，后者被显示成前者会让人以为备份全没了
    listTrashMock.mockRejectedValue(new Error("磁盘忙"));
    render(() => <TrashSection />);
    await settle();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("磁盘忙");
    expect(screen.queryByText("回收站是空的。")).toBeNull();
  });
});

describe("回收站动作", () => {
  it("恢复直接执行，并重读列表与文稿", async () => {
    listTrashMock.mockResolvedValueOnce([entry()]).mockResolvedValueOnce([]);
    const view = render(() => <TrashSection />);
    await settle();

    fireEvent.click(buttonsByText(view.container, "恢复")[0] as HTMLElement);
    // 恢复现在多了一步「重读文稿」，动作到列表刷新之间隔的微任务变多了，
    // 一次 settle 只等到中间态
    for (let i = 0; i < 4; i += 1) await settle();

    expect(restoreMock).toHaveBeenCalledWith("ch_1-20260920");
    expect(listTrashMock).toHaveBeenCalledTimes(2);
    // 恢复的就是卷章树里的节点：不重读文稿，那章在界面上仍然不存在，
    // 用户会以为恢复失败，于是再恢复一次或在原地新建同名章。
    expect(reloadDocMock).toHaveBeenCalledTimes(1);
    // 恢复成功后列表由后端重新决定：这里应回到空态，而不是本地偷偷删一行
    expect(view.container.querySelector(".trash-section__item")).toBeNull();
    expect(screen.queryByText("回收站是空的。")).not.toBeNull();
  });

  it("彻底删除要先二次确认，确认之前不发请求", async () => {
    listTrashMock.mockResolvedValue([entry()]);
    const view = render(() => <TrashSection />);
    await settle();

    fireEvent.click(
      buttonsByText(view.container, "彻底删除")[0] as HTMLElement,
    );
    await settle();

    // 只是进入确认态
    expect(purgeMock).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("「第三章 落羽」将无法找回。");

    fireEvent.click(
      buttonsByText(view.container, "彻底删除")[0] as HTMLElement,
    );
    await settle();

    expect(purgeMock).toHaveBeenCalledWith("ch_1-20260920");
    // 彻底删除只是清掉备份：卷章树里没有它，重读文稿属于多余动作
    expect(reloadDocMock).not.toHaveBeenCalled();
  });

  it("确认态可以取消，取消后不产生任何删除", async () => {
    listTrashMock.mockResolvedValue([entry()]);
    const view = render(() => <TrashSection />);
    await settle();

    fireEvent.click(
      buttonsByText(view.container, "彻底删除")[0] as HTMLElement,
    );
    await settle();
    fireEvent.click(buttonsByText(view.container, "取消")[0] as HTMLElement);
    await settle();

    expect(purgeMock).not.toHaveBeenCalled();
    expect(listTrashMock).toHaveBeenCalledTimes(1);
  });

  it("清空回收站同样需要确认，且确认文案带上条目数", async () => {
    listTrashMock.mockResolvedValue([
      entry(),
      entry({ originalId: "ch_2", originalTitle: "第四章" }),
    ]);
    const view = render(() => <TrashSection />);
    await settle();

    fireEvent.click(
      buttonsByText(view.container, "清空回收站")[0] as HTMLElement,
    );
    await settle();
    expect(emptyMock).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("回收站里的 2 项将无法找回。");

    fireEvent.click(
      buttonsByText(view.container, "清空回收站")[0] as HTMLElement,
    );
    await settle();
    expect(emptyMock).toHaveBeenCalledTimes(1);
  });

  it("一行进入确认态时，另一行的确认态会被收起", async () => {
    listTrashMock.mockResolvedValue([
      entry(),
      entry({
        originalId: "ch_2",
        originalTitle: "第四章",
        trashDirName: "ch_2-20260921",
      }),
    ]);
    const view = render(() => <TrashSection />);
    await settle();

    // 两行都还没进入确认态时，各有一个「彻底删除」按钮
    expect(buttonsByText(view.container, "彻底删除")).toHaveLength(2);
    fireEvent.click(
      buttonsByText(view.container, "彻底删除")[0] as HTMLElement,
    );
    await settle();
    expect(
      view.container.querySelectorAll(".trash-section__confirm-text"),
    ).toHaveLength(1);

    // 现在剩下的两个「彻底删除」是：第一行的确认按钮 + 第二行的入口按钮
    fireEvent.click(
      buttonsByText(view.container, "彻底删除")[1] as HTMLElement,
    );
    await settle();

    // 屏幕上只应剩下刚点的那一行的确认文案
    expect(
      view.container.querySelectorAll(".trash-section__confirm-text"),
    ).toHaveLength(1);
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it("动作失败时把错误显示出来，且不重刷列表制造「已经成功」的假象", async () => {
    listTrashMock.mockResolvedValue([entry()]);
    restoreMock.mockRejectedValue(new Error("目标路径已存在"));
    const view = render(() => <TrashSection />);
    await settle();
    const before = listTrashMock.mock.calls.length;

    fireEvent.click(buttonsByText(view.container, "恢复")[0] as HTMLElement);
    await settle();

    expect(
      view.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("目标路径已存在");
    expect(listTrashMock.mock.calls.length).toBe(before);
  });
});

describe("数据安全分区", () => {
  it("恢复报告读 store 里那份，绝不重新打开工作区", async () => {
    // ipc.getRecoveryReport 的实现是 openWorkspace()，
    // 恢复报告读的是 store 里那份：`ipc.getRecoveryReport` 的实现是
    // openWorkspace()，在设置页里触发它会把未保存的稿子一起丢掉。
    // 夹具把它设成 reject，所以真被调用时页面会冒出 alert ——
    // 但更直接的断言是 spy 从未被调用。
    render(() => <DataSafetyPanel />);
    await settle();

    expect(recoveryMock).not.toHaveBeenCalled();
    expect(screen.queryByText("崩溃恢复")).not.toBeNull();
    expect(screen.queryByText("删除章节 第三章")).not.toBeNull();
    expect(screen.queryByText("chapters/第三章.md")).not.toBeNull();
  });

  it("冲突副本只报告，界面上不给任何删除入口", async () => {
    const view = render(() => <DataSafetyPanel />);
    await settle();

    expect(view.container.textContent).toContain("第一章 副本.md");
    expect(view.container.textContent).toContain("网盘「副本」命名");
    expect(view.container.textContent).toContain(
      "羽化写作只报告，绝不自动删除或覆盖",
    );
    for (const button of view.container.querySelectorAll("button")) {
      expect(button.textContent).not.toMatch(/删除|清空/);
    }
  });

  it("重建索引调用命令并给出完成反馈", async () => {
    const view = render(() => <DataSafetyPanel />);
    await settle();

    fireEvent.click(
      buttonsByText(view.container, "重建索引")[0] as HTMLElement,
    );
    await settle();

    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain("索引已重建。");
  });

  it("重建失败时显示错误，并且按钮可以再点一次", async () => {
    rebuildMock.mockRejectedValue(new Error("索引库被占用"));
    const view = render(() => <DataSafetyPanel />);
    await settle();

    const button = buttonsByText(view.container, "重建索引")[0] as HTMLElement;
    fireEvent.click(button);
    await settle();

    expect(
      view.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("索引库被占用");
    // 失败后必须还能重试：把按钮永久禁掉等于要求用户重启应用
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("页面里嵌着回收站", async () => {
    listTrashMock.mockResolvedValue([entry()]);
    const view = render(() => <DataSafetyPanel />);
    await settle();

    expect(view.container.querySelector(".trash-section")).not.toBeNull();
    expect(view.container.textContent).toContain("第三章 落羽");
  });
});
