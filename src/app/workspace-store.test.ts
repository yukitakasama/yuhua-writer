/**
 * workspace-store 的保存路径测试。
 *
 * 重点钉住一件事：**保存请求必须带上它所属那一章的基线哈希**。
 *
 * 这条不变量是「绝不静默覆盖」在前端的一半 —— 后端
 * `check_no_external_conflict` 只在 `expected` 非空时才做冲突比对，
 * 传 `undefined` 等于声明「我不做并发控制」，后端会无条件放行。
 * 因此前端一旦因为状态读取时机不对而漏传哈希，那次写入就会绕过
 * 全部防护直接落盘。
 *
 * 最容易漏传的场景正是自动保存的主路径：作者在第三章打字，
 * 直接点第七章 —— 切章流程会 flush 第三章，而此刻 `editing()`
 * 已经指向第七章了。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChapterContent, WorkspaceDocument } from "@/lib/ipc/types";

/**
 * IPC 打桩。用 `vi.hoisted` 是因为 `vi.mock` 的工厂会提升到 import
 * 之前执行；也**不能**用 `importOriginal` —— `@/lib/ipc` 的模块图里
 * 含 `@/app/workspace-store`，后者又回头 import `@/lib/ipc`，
 * vitest 在这种环上会一直挂着不返回（详见 SearchPanel.test.tsx 的同款说明）。
 */
const { readChapterMock, saveChapterMock } = vi.hoisted(() => ({
  readChapterMock: vi.fn(),
  saveChapterMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  readChapter: (chapterId: string) => readChapterMock(chapterId),
  saveChapter: (chapterId: string, body: string, expectedHash?: string) =>
    saveChapterMock(chapterId, body, expectedHash),
  toFailure: (err: unknown) => ({
    error: { kind: "unknown", message: String(err) },
  }),
}));

import {
  __resetWorkspaceState,
  editingChapter,
  loadChapterBody,
  saveChapterBody,
  setWorkspaceState,
} from "./workspace-store";

function content(id: string, body: string, hash: string): ChapterContent {
  return {
    id,
    title: `第${id}章`,
    body,
    words: {
      withPunctuation: body.length,
      withoutPunctuation: body.length,
      wordsForEnglish: body.length,
      hanChars: body.length,
      paragraphs: 1,
    },
    mtime: 1_700_000_000_000,
    contentHash: hash,
  };
}

/**
 * 塞一份最小的大纲进 store。
 *
 * `saveChapterBody` 成功后要回写该章的字数（`setState("document",
 * "chapters", …)`），而 `document` 为 `null` 时那条路径会抛错并被
 * catch 成「保存失败」。真实运行时 document 由「打开工作区」填好，
 * 测试里得自己垫上。book / volumes / recovery 与本组测试无关，
 * 因此整体断言成 `WorkspaceDocument`，只保证 `chapters` 是真的。
 */
function seedDocument(chapterIds: string[]): void {
  setWorkspaceState("document", {
    chapters: chapterIds.map((id, i) => ({
      id,
      volumeId: "vol_1",
      title: id,
      status: "draft",
      sort: i,
      path: `manuscript/${id}.md`,
      wordCount: 0,
      wordGoal: 0,
      summary: "",
      updated: "",
    })),
  } as unknown as WorkspaceDocument);
}

describe("保存的乐观并发基线", () => {
  beforeEach(() => {
    readChapterMock.mockReset();
    saveChapterMock.mockReset();
    __resetWorkspaceState();
    seedDocument(["ch_a", "ch_b", "ch_new"]);
  });

  it("切到别的章之后保存上一章，仍带上上一章的哈希", async () => {
    // 这是丢稿路径的复现：editing() 已指向 ch_b，
    // 而这次保存属于 ch_a。旧实现从 editing() 取哈希，
    // ID 不匹配就传 undefined，后端于是无条件放行覆盖。
    readChapterMock.mockImplementation(async (id: string) =>
      content(id, `正文-${id}`, `hash-${id}`),
    );
    saveChapterMock.mockResolvedValue(content("ch_a", "改了", "hash-a2"));

    await loadChapterBody("ch_a");
    await loadChapterBody("ch_b");
    const ok = await saveChapterBody("ch_a", "改了");

    expect(ok).toBe(true);
    expect(saveChapterMock).toHaveBeenCalledWith("ch_a", "改了", "hash-ch_a");
  });

  it("同一章连续保存，第二次的基线是第一次返回的新哈希", async () => {
    readChapterMock.mockResolvedValue(content("ch_a", "原稿", "hash-1"));
    saveChapterMock
      .mockResolvedValueOnce(content("ch_a", "第一稿", "hash-2"))
      .mockResolvedValueOnce(content("ch_a", "第二稿", "hash-3"));

    await loadChapterBody("ch_a");
    await saveChapterBody("ch_a", "第一稿");
    await saveChapterBody("ch_a", "第二稿");

    expect(saveChapterMock).toHaveBeenNthCalledWith(
      1,
      "ch_a",
      "第一稿",
      "hash-1",
    );
    expect(saveChapterMock).toHaveBeenNthCalledWith(
      2,
      "ch_a",
      "第二稿",
      "hash-2",
    );
  });

  it("没读回过的章（如刚新建）传 undefined，交给后端按既有语义放行", async () => {
    saveChapterMock.mockResolvedValue(content("ch_new", "新章", "hash-n"));

    const ok = await saveChapterBody("ch_new", "新章");

    expect(ok).toBe(true);
    expect(saveChapterMock).toHaveBeenCalledWith("ch_new", "新章", undefined);
  });

  it("读章失败时不记基线，避免拿一个不存在的哈希去比对", async () => {
    readChapterMock.mockRejectedValue(new Error("文件被占用"));
    saveChapterMock.mockResolvedValue(content("ch_a", "正文", "hash-x"));

    await loadChapterBody("ch_a");
    await saveChapterBody("ch_a", "正文");

    expect(saveChapterMock).toHaveBeenCalledWith("ch_a", "正文", undefined);
  });

  it("保存失败时不更新基线，重试仍拿旧哈希比对", async () => {
    readChapterMock.mockResolvedValue(content("ch_a", "原稿", "hash-1"));
    saveChapterMock
      .mockRejectedValueOnce(new Error("云盘占用"))
      .mockResolvedValueOnce(content("ch_a", "重试稿", "hash-2"));

    await loadChapterBody("ch_a");
    expect(await saveChapterBody("ch_a", "第一次")).toBe(false);
    expect(await saveChapterBody("ch_a", "重试稿")).toBe(true);

    // 两次都该用 hash-1：第一次没成功，磁盘上的基线没有变
    expect(saveChapterMock).toHaveBeenNthCalledWith(
      1,
      "ch_a",
      "第一次",
      "hash-1",
    );
    expect(saveChapterMock).toHaveBeenNthCalledWith(
      2,
      "ch_a",
      "重试稿",
      "hash-1",
    );
  });
});

/**
 * 连点两章时，两个读章请求会同时在途，而**返回顺序没有保证** ——
 * 快慢由文件大小与磁盘状态决定。若照单全收，后到的旧结果会把上一章的
 * 正文写成「当前正在编辑的正文」，界面就对着第 7 章显示第 6 章的内容。
 */
describe("读章响应的顺序", () => {
  beforeEach(() => {
    readChapterMock.mockReset();
    saveChapterMock.mockReset();
    __resetWorkspaceState();
    seedDocument(["ch_a", "ch_b"]);
  });

  it("上一章的请求后返回时，不会覆盖最新一次选中", async () => {
    /** 手动了结的 A 请求：`settle` 由 Promise 执行器填上。 */
    const pendingA: { settle?: (value: ChapterContent) => void } = {};
    readChapterMock.mockImplementationOnce(
      () =>
        new Promise<ChapterContent>((resolve) => {
          pendingA.settle = resolve;
        }),
    );
    readChapterMock.mockImplementationOnce(() =>
      Promise.resolve(content("ch_b", "乙章", "hash-b")),
    );

    void loadChapterBody("ch_a");
    await loadChapterBody("ch_b");
    expect(editingChapter()?.body).toBe("乙章");

    pendingA.settle?.(content("ch_a", "甲章", "hash-a"));
    await Promise.resolve();
    await Promise.resolve();

    expect(editingChapter()?.body).toBe("乙章");
  });
});
