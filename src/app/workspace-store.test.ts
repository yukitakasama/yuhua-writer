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
const { readChapterMock, saveChapterMock, updateBookMetaMock } = vi.hoisted(
  () => ({
    readChapterMock: vi.fn(),
    saveChapterMock: vi.fn(),
    updateBookMetaMock: vi.fn(),
  }),
);

vi.mock("@/lib/ipc", () => ({
  readChapter: (chapterId: string) => readChapterMock(chapterId),
  saveChapter: (
    chapterId: string,
    body: string,
    expectedHash?: string,
    force?: boolean,
  ) => saveChapterMock(chapterId, body, expectedHash, force),
  updateBookMeta: (author: string, description: string) =>
    updateBookMetaMock(author, description),
  // 冲突的出路全靠按错误码分支，打桩不能把 code 抹掉
  ERROR_CODES: { conflict: "CONFLICT" },
  toFailure: (err: unknown) => ({
    error:
      err !== null && typeof err === "object" && "code" in err
        ? (err as {
            code: string;
            message: string;
            recoverable: boolean;
            detail: string | null;
          })
        : {
            code: "INTERNAL",
            message: String(err),
            recoverable: false,
            detail: null,
          },
  }),
}));

import {
  __resetWorkspaceState,
  conflictedChapterId,
  currentBook,
  editingChapter,
  loadChapterBody,
  saveBookMeta,
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
 * 测试里得自己垫上。`book` 是书级元数据那组要读的（见下面「书级元数据」），
 * volumes / recovery 与本组测试无关，因此整体断言成 `WorkspaceDocument`，
 * 只保证 `chapters` 与 `book` 是真的。
 */
function seedDocument(chapterIds: string[]): void {
  setWorkspaceState("document", {
    book: {
      id: "bk_1",
      title: "测试书",
      author: "",
      description: "",
      created: "",
      updated: "",
    },
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
    expect(saveChapterMock).toHaveBeenCalledWith(
      "ch_a",
      "改了",
      "hash-ch_a",
      undefined,
    );
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
      undefined,
    );
    expect(saveChapterMock).toHaveBeenNthCalledWith(
      2,
      "ch_a",
      "第二稿",
      "hash-2",
      undefined,
    );
  });

  it("没读回过的章（如刚新建）传 undefined，交给后端按既有语义放行", async () => {
    saveChapterMock.mockResolvedValue(content("ch_new", "新章", "hash-n"));

    const ok = await saveChapterBody("ch_new", "新章");

    expect(ok).toBe(true);
    expect(saveChapterMock).toHaveBeenCalledWith(
      "ch_new",
      "新章",
      undefined,
      undefined,
    );
  });

  it("读章失败时不记基线，避免拿一个不存在的哈希去比对", async () => {
    readChapterMock.mockRejectedValue(new Error("文件被占用"));
    saveChapterMock.mockResolvedValue(content("ch_a", "正文", "hash-x"));

    await loadChapterBody("ch_a");
    await saveChapterBody("ch_a", "正文");

    expect(saveChapterMock).toHaveBeenCalledWith(
      "ch_a",
      "正文",
      undefined,
      undefined,
    );
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
      undefined,
    );
    expect(saveChapterMock).toHaveBeenNthCalledWith(
      2,
      "ch_a",
      "重试稿",
      "hash-1",
      undefined,
    );
  });

  /**
   * 冲突的出路要钉在**哪一章**上，而不是钉在「最后一次错误」上。
   *
   * 顶部的错误横幅是全局唯一的一份：作者在冲突之后点个新建卷，它就被换掉了，
   * 而这一章依然存不下去。编辑区那两个按钮（以我的稿子为准 / 改用磁盘版本）
   * 读的就是这里记下的章 ID。
   */
  it("保存被判为外部修改冲突时记下那一章，重新读取后清掉", async () => {
    readChapterMock.mockResolvedValue(content("ch_a", "原稿", "hash-1"));
    saveChapterMock.mockRejectedValue({
      code: "CONFLICT",
      message: "这一章在磁盘上被外部改过了",
      recoverable: true,
      detail: null,
    });

    await loadChapterBody("ch_a");
    expect(conflictedChapterId()).toBeNull();

    expect(await saveChapterBody("ch_a", "改过的稿子")).toBe(false);
    expect(conflictedChapterId()).toBe("ch_a");

    // 改用磁盘版本要先重读一次：基线已随这次读取重建，冲突不该还挂着
    await loadChapterBody("ch_a");
    expect(conflictedChapterId()).toBeNull();
  });

  /**
   * 旧章保存在途落地时不许顶掉新章的编辑态。
   *
   * 切章会 flush 上一章，而那次保存是异步的：等它回来时作者已经在看下一章。
   * 照旧实现 `setEditing({id: 上一章})`，界面就会对着一个刚打开、
   * 正文明明就在眼前的章说「这一章的正文没能打开」，还把编辑器置成只读。
   */
  it("上一章的保存落地时不会把编辑态从新章顶掉", async () => {
    readChapterMock.mockImplementation(async (id: string) =>
      id === "ch_a"
        ? content("ch_a", "甲章的正文", "hash-a")
        : content("ch_b", "乙章的正文", "hash-b"),
    );
    saveChapterMock.mockResolvedValue(content("ch_a", "甲章改了", "hash-a2"));

    await loadChapterBody("ch_a");
    await loadChapterBody("ch_b");
    expect(await saveChapterBody("ch_a", "甲章改了")).toBe(true);

    expect(editingChapter()?.id).toBe("ch_b");
    expect(editingChapter()?.body).toBe("乙章的正文");
  });
});

/**
 * 书级元数据（作者 / 简介）。
 *
 * 钉的是「填了要记住」这条承诺的前端一半：作者署名必须真的走到后端，
 * 并且写回后要立刻反映在内存文稿上 —— 否则导出面板预填的还是旧名字，
 * 界面与文件各说各话。
 */
describe("书级元数据", () => {
  beforeEach(() => {
    readChapterMock.mockReset();
    saveChapterMock.mockReset();
    updateBookMetaMock.mockReset();
    __resetWorkspaceState();
    seedDocument(["ch_a"]);
  });

  it("把作者与简介发给后端，并用后端存下的值刷新内存文稿", async () => {
    updateBookMetaMock.mockResolvedValue({
      root: "D:/ws",
      workspaceId: "bk_1",
      title: "测试书",
      author: "四月",
      description: "一个关于记忆与羽毛的长篇故事。",
      created: "",
      lastOpened: null,
      available: true,
    });

    const ok = await saveBookMeta("四月", "一个关于记忆与羽毛的长篇故事。");

    expect(updateBookMetaMock).toHaveBeenCalledWith(
      "四月",
      "一个关于记忆与羽毛的长篇故事。",
    );
    expect(ok).toBe(true);
    expect(currentBook()?.author).toBe("四月");
    expect(currentBook()?.description).toBe("一个关于记忆与羽毛的长篇故事。");
  });

  /**
   * 后端没写成功时内存不许先变。
   *
   * 顺序反了就会出现「界面显示新作者、workspace.json 里还是旧的」：
   * 下一次重开工作区署名又变回去，而作者以为自己填好了。
   */
  it("后端写失败时返回 false，内存文稿保持原样", async () => {
    updateBookMetaMock.mockRejectedValue(new Error("磁盘只读"));

    expect(await saveBookMeta("四月", "新简介")).toBe(false);
    expect(currentBook()?.author).toBe("");
    expect(currentBook()?.description).toBe("");
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
