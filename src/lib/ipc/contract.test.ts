/**
 * IPC 契约测试 —— 走**真实 Tauri 分支**，不经过 mock。
 *
 * ## 为什么必须有这个文件
 *
 * `ipc.test.ts` 与 `mock-backend.test.ts` 加起来有几十个用例，但它们
 * **一个都没碰到真实路径**：jsdom 下 `isTauri()` 恒为 false
 * （`window.__TAURI_INTERNALS__` 不存在），`call()` 因此总是走
 * `mockFn(mock())` 那一支。
 *
 * 后果是四类漂移可以长期潜伏，全部测试仍是绿的：
 *
 * | 漂移 | 症状 |
 * | --- | --- |
 * | `open_workspace` 传 `{ root }` 而非 `{ path }` | 打开工作区直接报「缺少 path 参数」 |
 * | `create_workspace` 同上 | 新建工作区同上 |
 * | 前端期望 `{ root, document }` 而非 `{ workspace, outline, … }` | `state.document` 为 `undefined`，渲染卷章树抛错 |
 * | `get_word_stats` 只传 `chapterId` | 本卷字数恒为 0（**静默的错数**） |
 *
 * 本文件用 `vi.mock` 替换 `@tauri-apps/api/core` 的 `invoke`，
 * 再用 `vi.stubGlobal("__TAURI_INTERNALS__", {})` 把 `isTauri()` 骗成
 * true，从而**真的执行**那条平时从不执行的代码路径。
 *
 * ## 判据来自哪一侧
 *
 * 来自 **Rust**。下面 `RUST_OPEN_RESULT` 是照着
 * `src-tauri/src/commands.rs` 的 `OpenResult` 手写的 JSON，注释逐字段
 * 标了出处。用「后端的形状」而不是「mock 的形状」验证前端，
 * 正是当初漏掉的判据 —— 后者只能证明前端与自己一致。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenWorkspaceResult } from "./types";

/**
 * 记录所有 `invoke` 调用，并让调用方决定返回值。
 *
 * 用 `vi.hoisted` 是因为 `vi.mock` 的工厂会被提升到文件顶部，
 * 此时普通 `const` 还没初始化 —— 直接引用会得到 TDZ 报错。
 */
const transport = vi.hoisted(() => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let responder: (
    command: string,
    args: Record<string, unknown>,
  ) => unknown = () => {
    throw new Error("没有为这次 invoke 准备返回值");
  };
  return {
    calls,
    setResponder(
      fn: (command: string, args: Record<string, unknown>) => unknown,
    ) {
      responder = fn;
    },
    reset() {
      calls.length = 0;
      responder = () => {
        throw new Error("没有为这次 invoke 准备返回值");
      };
    },
    invoke(command: string, args: Record<string, unknown>) {
      calls.push({ command, args });
      // async 让 await 的行为与真实 invoke 一致（真实实现返回 Promise）
      return Promise.resolve(responder(command, args));
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));

/**
 * Rust `commands::OpenResult` 的真实形状（`commands.rs:79-90`）。
 *
 * 每个字段的出处都写在注释里，改动这里之前请先改 Rust ——
 * 这个常量就是本文件唯一的「真相来源」。
 *
 * ## 为什么显式标注类型
 *
 * 标了 `OpenWorkspaceResult` 之后，**这份"照 Rust 抄的" JSON 会被
 * 编译期检查**：Rust 加了字段而这里没加、或前端类型被改窄导致
 * 这份合法载荷不再合法，`pnpm typecheck` 就会报错。
 * 不标的话它只是一个结构字面量，`as const` 还会把 `status` 收窄成
 * `"draft"` 而不是 `ChapterStatus`，反而失去约束力。
 */
const RUST_OPEN_RESULT: OpenWorkspaceResult = {
  // workspace: WorkspaceSummary（yuhua-fs/src/workspace.rs:79-95）
  workspace: {
    root: "/x",
    workspaceId: "ws_1",
    title: "测试书",
    created: "2026-01-01T00:00:00+08:00",
    lastOpened: null,
    available: true,
  },
  // outline: Vec<OutlineNode>（yuhua-core/src/model.rs:234-247）
  outline: [
    {
      volumeId: "vol_1",
      title: "第一卷 风起",
      sort: 0,
      chapters: [
        {
          id: "ch_1",
          volumeId: "vol_1",
          title: "第一章 落羽",
          status: "draft",
          sort: 0,
          path: "manuscript/001-第一卷 风起/001-第一章 落羽.md",
          wordCount: 1200,
          wordGoal: 0,
          summary: "",
          updated: "2026-01-01T00:00:00+08:00",
        },
      ],
      wordCount: 1200,
      chapterCount: 1,
    },
  ],
  // words: WordStats（yuhua-store/src/stats.rs）
  words: {
    chapter: 0,
    volume: 0,
    book: 1200,
    chapterCount: 1,
    volumeCount: 1,
  },
  // recovery: RecoveryReportDto（commands.rs:93-106）
  recovery: {
    sweptTempFiles: 0,
    interruptedOperations: [],
    pendingPaths: [],
    purgedTrashItems: 0,
    conflicts: [],
  },
};

/** 每个用例都从「非 Tauri」以外的干净状态开始，避免调用记录互相污染。 */
beforeEach(() => {
  transport.reset();
  // 让 isTauri() 为 true —— 这是本文件与其它测试文件唯一的关键差别
  vi.stubGlobal("__TAURI_INTERNALS__", {});
});

describe("IPC 契约：前端发出的参数（对着 Rust 签名）", () => {
  it("openWorkspace 传的是 { path }，不是 { root }", async () => {
    const ipc = await import("./index");
    transport.setResponder(() => RUST_OPEN_RESULT);

    await ipc.openWorkspace("/x");

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.command).toBe("open_workspace");
    // 断言**恰好相等**而不是「含有 path」：后者会漏掉多余字段
    // （比如同时带着 root），而 Tauri 对多余参数是静默忽略的
    expect(transport.calls[0]?.args).toEqual({ path: "/x" });
  });

  it("createWorkspace 传的是 { path, title }，不是 { root, title }", async () => {
    const ipc = await import("./index");
    transport.setResponder(() => RUST_OPEN_RESULT);

    await ipc.createWorkspace("/x", "书");

    expect(transport.calls[0]?.command).toBe("create_workspace");
    expect(transport.calls[0]?.args).toEqual({ path: "/x", title: "书" });
  });

  it("getWordStats 同时传出 volumeId 与 chapterId", async () => {
    const ipc = await import("./index");
    transport.setResponder(() => RUST_OPEN_RESULT.words);

    await ipc.getWordStats("vol_1", "ch_1");

    expect(transport.calls[0]?.command).toBe("get_word_stats");
    // Rust 的签名是 (volume_id, chapter_id) —— 两个参数各管一个字段。
    // 只传 chapterId 时后端的 volume 恒为 0，界面上会显示「本卷 0 字」
    expect(transport.calls[0]?.args).toEqual({
      volumeId: "vol_1",
      chapterId: "ch_1",
    });
  });

  it("省略参数时显式传 null（Rust 侧是 Option<String>）", async () => {
    const ipc = await import("./index");
    transport.setResponder(() => RUST_OPEN_RESULT.words);

    await ipc.getWordStats();

    // undefined 会被 JSON 序列化时丢掉，导致 Tauri 报「缺少参数」；
    // null 才会被反序列化成 None
    expect(transport.calls[0]?.args).toEqual({
      volumeId: null,
      chapterId: null,
    });
  });
});

describe("IPC 契约：前端消费 Rust 的返回形状", () => {
  it("openWorkspace 的返回值就是 Rust OpenResult 的四个键", async () => {
    const ipc = await import("./index");
    transport.setResponder(() => RUST_OPEN_RESULT);

    const result = await ipc.openWorkspace("/x");

    expect(Object.keys(result).sort()).toEqual([
      "outline",
      "recovery",
      "words",
      "workspace",
    ]);
    // 曾经这里读 result.root / result.document —— 都是 undefined。
    // 前端**不能**再依赖这两个键，因此显式断言它们不存在
    expect(result).not.toHaveProperty("document");
    expect(result).not.toHaveProperty("root");
  });

  it("workspace-store 能把 OpenResult 装成文档，不抛错且 document 非 null", async () => {
    // 这是本次修复的**核心回归测试**：用「Rust 的形状」而不是
    // 「mock 的形状」验证前端。修复前，store 读的是 result.document，
    // 于是 document 为 undefined，渲染卷章树时直接抛错。
    transport.setResponder((command) => {
      if (command === "open_workspace") return RUST_OPEN_RESULT;
      throw new Error(`未预期的命令：${command}`);
    });

    const { openWorkspace, workspaceState, __resetWorkspaceState } =
      await import("@/app/workspace-store");
    __resetWorkspaceState();

    const ok = await openWorkspace("/x");

    expect(ok).toBe(true);
    expect(workspaceState.status).toBe("ready");
    expect(workspaceState.document).not.toBeNull();
    expect(workspaceState.document).toBeDefined();

    const doc = workspaceState.document;
    if (doc === null) throw new Error("document 为 null");

    // 卷从 outline 折算而来
    expect(doc.volumes).toHaveLength(1);
    expect(doc.volumes[0]?.id).toBe("vol_1");
    expect(doc.volumes[0]?.title).toBe("第一卷 风起");
    // 章从 outline 的 chapters 拉平
    expect(doc.chapters).toHaveLength(1);
    expect(doc.chapters[0]?.id).toBe("ch_1");
    // 恢复报告取自 recovery（不是 document.recovery）
    expect(doc.recovery.sweptTempFiles).toBe(0);
    // 书名取自 workspace.title
    expect(doc.book.title).toBe("测试书");
    expect(doc.book.id).toBe("ws_1");
  });

  it("reloadDocument 也走同一条折算路径", async () => {
    transport.setResponder(() => RUST_OPEN_RESULT);

    const {
      openWorkspace,
      reloadDocument,
      workspaceState,
      setWorkspaceState,
      __resetWorkspaceState,
    } = await import("@/app/workspace-store");
    __resetWorkspaceState();
    await openWorkspace("/x");

    // 模拟"结构改动后重读"：先清掉 document（用导出的 setter 而不是直接
    // 赋值 —— store 是只读代理，直接改会静默失败并打警告），再重读
    setWorkspaceState("document", null);
    expect(workspaceState.document).toBeNull();

    await reloadDocument();

    expect(workspaceState.document).not.toBeNull();
    expect(workspaceState.document?.volumes).toHaveLength(1);
  });

  it("book 元数据用最小占位而不是伪造", async () => {
    // 「book 在 open 路径上不可得」是一条**已知缺口**（见 types.ts 的
    // WorkspaceDocument 文档）。这条测试把它钉死：宁可空串，
    // 也不能编出一个作者名或简介。
    const { documentFromOpenResult } = await import("@/app/workspace-store");
    const doc = documentFromOpenResult(RUST_OPEN_RESULT);

    expect(doc.book.author).toBe("");
    expect(doc.book.description).toBe("");
    expect(doc.book.title).toBe("测试书");
  });
});
