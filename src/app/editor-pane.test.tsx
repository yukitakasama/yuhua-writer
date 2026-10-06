/**
 * EditorPane 的装配级测试。
 *
 * ## 为什么单开一个文件
 *
 * `app-smoke.test.tsx` 证明的是「应用挂得起来、切章会去读正文」；
 * 这里钉的是**读不到之后**的行为。这两种情形的验证手段不一样：
 * 读失败要控制 `readChapter` 的成败，而冒烟测试走的是完整的 mock 后端。
 *
 * ## 为什么值得用真实的 CodeMirror
 *
 * 这三条性质全都落在视图上，用假句柄测就等于测我自己写的桩：
 *
 * | 性质 | 为什么假句柄测不出来 |
 * | --- | --- |
 * | 正文没到位时打不进字 | 「只读」是 `EditorState.readOnly` 决定的，真实视图才会拦下用户输入 |
 * | 换章后撤销历史归零 | 历史是 CodeMirror 自己的状态 |
 * | 切章会把上一章的改动存盘 | 要有一条真的用户事务才能把改动标成 dirty |
 *
 * jsdom 里跑真实视图是可行的（`MarkdownEditor.test.tsx` 已经这么做），
 * 取到视图实例用的是公开 API `EditorView.findFromDOM`。
 */

import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import type { ChapterContent, WorkspaceDocument } from "@/lib/ipc/types";

const { readChapterMock, saveChapterMock } = vi.hoisted(() => ({
  readChapterMock: vi.fn(),
  saveChapterMock: vi.fn(),
}));

/**
 * 只打桩 `workspace-store` 用到的那几个命令。
 *
 * 不能用 `importOriginal`：`@/lib/ipc` 的模块图里含 `@/app/workspace-store`，
 * 后者又回头 import `@/lib/ipc`，vitest 在这种环上会一直挂着不返回
 * （同款说明见 `workspace-store.test.ts`）。
 */
vi.mock("@/lib/ipc", () => ({
  readChapter: (chapterId: string) => readChapterMock(chapterId),
  saveChapter: (chapterId: string, body: string, expectedHash?: string) =>
    saveChapterMock(chapterId, body, expectedHash),
  toFailure: (err: unknown) => ({
    error: { kind: "unknown", message: String(err) },
  }),
}));

import { EditorPane } from "./EditorPane";
import {
  __resetWorkspaceState,
  saveChapterBody,
  selectChapter,
  setWorkspaceState,
} from "./workspace-store";

let dispose: (() => void) | null = null;
let host: HTMLElement;

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

/** 两章大纲。正文走 `readChapterMock`，这里只放列表需要的元数据。 */
function seedWorkspace(): void {
  setWorkspaceState("document", {
    chapters: ["ch_a", "ch_b"].map((id, index) => ({
      id,
      volumeId: "vol_1",
      title: id,
      status: "draft",
      sort: index,
      path: `manuscript/${id}.md`,
      wordCount: 0,
      updated: "2026-01-01T00:00:00+08:00",
      created: "2026-01-01T00:00:00+08:00",
    })),
    volumes: [],
    book: { id: "bk_1", title: "羽化录" },
    recovery: {
      sweptTempFiles: 0,
      interruptedOperations: [],
      pendingPaths: [],
      purgedTrashItems: 0,
      conflicts: [],
    },
  } as unknown as WorkspaceDocument);
}

/** 让微任务链跑完：读章 + 灌正文 + 自动保存的链路比想象中长。 */
async function settle(ticks = 12): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

/** 取编辑器视图（公开 API，不依赖 CodeMirror 的内部结构）。 */
function view(): EditorView {
  const dom = host.querySelector<HTMLElement>(".cm-editor");
  const found = dom === null ? null : EditorView.findFromDOM(dom);
  if (found === null) throw new Error("测试里没能取到编辑器视图");
  return found;
}

/**
 * 模拟「作者打字」。
 *
 * 必须带 `userEvent: "input"`：编辑器区分用户输入与程序替换，
 * 只有前者会被标成 dirty 并排自动保存。
 */
function type(text: string): void {
  // 换章后视图实例会被换掉（见「换章要重建视图」的说明），每次都重新取
  const v = view();
  v.dispatch({
    changes: { from: v.state.doc.length, insert: text },
    userEvent: "input",
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  readChapterMock.mockReset();
  saveChapterMock.mockReset();
  __resetWorkspaceState();
  seedWorkspace();
  saveChapterMock.mockResolvedValue(content("ch_a", "正文", "hash-new"));
  dispose = render(() => <EditorPane />, host);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
});

describe("正文没读回来时的编辑区", () => {
  it("读失败的章是只读的，并给出重新读取的入口", async () => {
    readChapterMock.mockResolvedValue(content("ch_a", "甲章的正文", "hash-a"));
    selectChapter("ch_a");
    await settle();
    expect(view().state.doc.toString()).toContain("甲章的正文");

    readChapterMock.mockRejectedValue(new Error("文件被云盘锁住"));
    selectChapter("ch_b");
    await settle();

    // 只读：正文不在，打字没有归宿
    expect(view().state.readOnly).toBe(true);
    // 失败要说出来，而且要有一条不用先切走再切回来的路
    expect(host.textContent).toContain("这一章的正文没能打开");
    expect(host.textContent).toContain("重新读取");
  });

  it("重新读取成功后可以接着写", async () => {
    readChapterMock.mockRejectedValue(new Error("读不动"));
    selectChapter("ch_a");
    await settle();
    expect(host.textContent).toContain("重新读取");

    readChapterMock.mockResolvedValue(content("ch_a", "甲章的正文", "hash-a"));
    const retry = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "重新读取",
    ) as HTMLElement;
    retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(view().state.doc.toString()).toContain("甲章的正文");
    expect(view().state.readOnly).toBe(false);
  });

  /**
   * 这条是丢稿路径的复现。
   *
   * 曾经的行为：读失败后 `mountedChapterId` 还留着**上一章**的 ID，
   * 而标题已经换成新章 —— 作者在新章标题下打的字会存进上一章的文件，
   * 一次读失败换掉一整章稿子。
   *
   * 触发保存用的是「失焦落盘」这条真实路径（`handleBlur` → `flushNow`），
   * 不是等自动保存的 1500 ms 防抖 —— 干等的话这条事务永远不会走到保存，
   * 测试就成了恒绿的空断言（本文件第一版就是这样，别再造第二次）。
   */
  it("读失败后打字不会落到上一章的文件里", async () => {
    readChapterMock.mockResolvedValue(content("ch_a", "甲章的正文", "hash-a"));
    selectChapter("ch_a");
    await settle();

    readChapterMock.mockRejectedValue(new Error("读不动"));
    selectChapter("ch_b");
    await settle();
    saveChapterMock.mockClear();

    // 程序发起的事务不受只读保护，正好用来检验第二道防线
    type("不该被存进任何文件的字");
    window.dispatchEvent(new Event("blur"));
    await settle();

    // 只读挡住的是**真实输入**（contenteditable 的 beforeinput / 粘贴），
    // 程序 dispatch 绕得过去 —— 所以这里同时钉第二道防线：
    // 就算文档被改脏了，落盘的章 ID 也不能是上一章。
    expect(view().state.readOnly).toBe(true);
    expect(saveChapterMock).not.toHaveBeenCalled();
  });
});

describe("换章", () => {
  it("上一章的未保存改动会被写回它自己的文件", async () => {
    readChapterMock
      .mockResolvedValueOnce(content("ch_a", "甲章的正文", "hash-a"))
      .mockResolvedValueOnce(content("ch_b", "乙章的正文", "hash-b"));
    saveChapterMock.mockResolvedValue(content("ch_a", "甲章补充", "hash-a2"));

    selectChapter("ch_a");
    await settle();
    type("｜甲章补充");
    await settle();

    selectChapter("ch_b");
    await settle();

    // 章 ID 必须是上一章的：把甲章的字写进乙章同样是丢稿
    expect(saveChapterMock).toHaveBeenCalledWith(
      "ch_a",
      expect.stringContaining("甲章补充"),
      "hash-a",
    );
    expect(view().state.doc.toString()).toContain("乙章的正文");
  });

  /**
   * 撤销历史必须跟着章一起换掉。
   *
   * 留着旧历史时，作者切到乙章后按一次 Ctrl+Z，甲章的正文就灌进乙章，
   * 紧接着自动保存把它写进乙章的文件 —— 两章都坏。
   * 这就是换章走「重建状态」而不是「替换整篇」的原因。
   */
  it("换章后撤销不会把上一章的正文带过来", async () => {
    readChapterMock
      .mockResolvedValueOnce(content("ch_a", "甲章的正文", "hash-a"))
      .mockResolvedValueOnce(content("ch_b", "乙章的正文", "hash-b"));

    selectChapter("ch_a");
    await settle();
    type("｜这一段只属于甲章");

    selectChapter("ch_b");
    await settle();

    const v = view();
    const before = v.state.doc.toString();
    // 与作者按下 Ctrl+Z 完全同一条路径
    expect(undo(v)).toBe(false);
    expect(v.state.doc.toString()).toBe(before);
    expect(v.state.doc.toString()).toContain("乙章的正文");
  });

  it("正文还在读的时候编辑器是只读的", async () => {
    /** 手动了结的读请求：`settle` 由 Promise 执行器填上。 */
    const pendingRead: { settle?: (value: ChapterContent) => void } = {};
    readChapterMock.mockImplementation(
      () =>
        new Promise<ChapterContent>((resolve) => {
          pendingRead.settle = resolve;
        }),
    );

    selectChapter("ch_a");
    await settle();

    expect(view().state.readOnly).toBe(true);
    expect(host.textContent).toContain("正在打开这一章");

    pendingRead.settle?.(content("ch_a", "甲章的正文", "hash-a"));
    await settle();
    expect(view().state.doc.toString()).toContain("甲章的正文");
  });
});

/**
 * 保存链路本身（乐观并发基线在 `workspace-store.test.ts` 里钉）。
 * 这里只确认编辑区把「保存」这件事接到了正确的章上。
 */
describe("保存入口", () => {
  it("手动保存写的是当前章", async () => {
    readChapterMock.mockResolvedValue(content("ch_b", "乙章的正文", "hash-b"));
    selectChapter("ch_b");
    await settle();

    const ok = await saveChapterBody("ch_b", "乙章改过");
    expect(ok).toBe(true);
    expect(saveChapterMock).toHaveBeenCalledWith("ch_b", "乙章改过", "hash-b");
  });
});
