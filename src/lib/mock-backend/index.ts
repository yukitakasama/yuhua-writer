/**
 * 非 Tauri 环境的降级后端。
 *
 * ## 存在的意义
 *
 * `pnpm dev` 在浏览器里跑时没有 Rust 进程，所有 `invoke` 都会失败。
 * 如果没有这一层，前端的每一次界面调整都要先编译一遍 Tauri，
 * 而 Rust 全量编译在两分钟量级 —— 迭代速度会被拖垮。
 *
 * 因此这里实现了**完整的内存数据源**：增删改、排序、搜索、
 * 字数统计都是真的在改数据，而不是返回一堆写死的常量。
 * 这样：
 *
 * - 界面上的交互（拖拽排序、重命名、新建删除）在浏览器里可完整走通
 * - 交互逻辑的问题在浏览器里就能暴露，不用等 Tauri 编译
 * - 单元测试可以直接针对这份实现写，不需要 mock 框架
 *
 * ## 与真实后端的关系
 *
 * 这是一份**行为镜像**，不是替代品。它实现的语义
 * （ID 前缀、排序序号连续、字数口径、回收站不真删）与 Rust 侧一致，
 * 但**不写磁盘**，因此刷新页面即重置。
 *
 * ## 不变量
 *
 * - 章节的 `sort` 在同一卷内从 0 连续递增，重排后重新编号
 * - 章节的 `volumeId` 必须指向存在的卷
 * - 移动章节到别的卷时，源卷与目标卷都要重新编号
 */

import type {
  ChapterContent,
  ChapterStatus,
  ChapterSummary,
  CountMode,
  CreateChapterInput,
  CreateVolumeInput,
  DetectedConflict,
  IpcError,
  OpenWorkspaceResult,
  OutlineNode,
  RecoveryReport,
  SearchHit,
  SearchQuery,
  SearchResults,
  StatsDay,
  StatsPayload,
  StatsSummary,
  TrashEntry,
  UpdateChapterMetaInput,
  Volume,
  WordCount,
  WordStats,
  WorkspaceSummary,
} from "../ipc/types";
import { countWords } from "./count";
import { buildSeedData, mockId, mockTime } from "./mock-data";

/** mock 后端抛出的错误，形状与 Rust 侧完全一致。 */
export class MockError extends Error {
  /** 结构化错误。 */
  readonly error: IpcError;

  constructor(code: string, message: string, recoverable = false) {
    super(message);
    this.name = "MockError";
    this.error = { code, message, recoverable, detail: null };
  }
}

/** 降级后端暴露给 IPC 层的接口。 */
export interface MockBackend {
  listRecentWorkspaces(): WorkspaceSummary[];
  createWorkspace(root: string, title: string): OpenWorkspaceResult;
  openWorkspace(root: string): OpenWorkspaceResult;
  closeWorkspace(): void;
  hasWorkspace(): boolean;
  createVolume(input: CreateVolumeInput): OutlineNode[];
  renameVolume(volumeId: string, title: string): OutlineNode[];
  deleteVolume(volumeId: string): OutlineNode[];
  reorderVolumes(orderedIds: string[]): OutlineNode[];
  createChapter(input: CreateChapterInput): OutlineNode[];
  reorderChapters(volumeId: string, orderedIds: string[]): OutlineNode[];
  readChapter(chapterId: string): ChapterContent;
  saveChapter(chapterId: string, body: string, expectedHash?: string): ChapterContent;
  updateChapterMeta(input: UpdateChapterMetaInput): void;
  renameChapter(chapterId: string, title: string): OutlineNode[];
  setChapterStatus(chapterId: string, status: ChapterStatus): void;
  deleteChapter(chapterId: string): OutlineNode[];
  getOutline(): OutlineNode[];
  getWordStats(chapterId?: string): WordStats;
  getStatsSummary(): StatsPayload;
  getChapterWordCount(chapterId: string): WordCount;
  search(query: SearchQuery): SearchResults;
  listTrash(): TrashEntry[];
  restoreFromTrash(trashDirName: string): void;
  purgeFromTrash(trashDirName: string): void;
  emptyTrash(): number;
  getRecoveryReport(): RecoveryReport;
  rebuildIndex(): void;
}

/** 计数用的单调递增器，保证同一毫秒内创建的 ID 也不重复。 */
let idCounter = 0;

/** 生成下一个示例实体 ID。 */
function nextId(prefix: string): string {
  idCounter += 1;
  return mockId(prefix, idCounter + 100);
}

/** 创建一份内存中的示例工作区。 */
export function createMockBackend(): MockBackend {
  const seed = buildSeedData();
  const book = seed.book;
  const volumes: Volume[] = seed.volumes.map((v) => ({ ...v }));
  const chapters: ChapterSummary[] = seed.chapters.map((c) => ({ ...c }));
  // 正文与摘要分开存：这是 IPC 契约的形状，mock 也照做，
  // 否则前端会在不知不觉中依赖"列表里有正文"这个错误假设
  const bodies = new Map<string, string>(seed.bodies);
  /** 每章的正文哈希，用于乐观并发检测。 */
  const hashes = new Map<string, string>();
  const trash: TrashEntry[] = [];
  /** 作者便签，刻意不放进摘要（见 updateChapterMeta 的说明）。 */
  const notes = new Map<string, string>();
  for (const [id, body] of bodies) hashes.set(id, `hash-${body.length}`);

  /** 默认工作区根路径。用绝对路径形状，方便 UI 展示路径截断逻辑。 */
  const defaultRoot = "C:/Users/示例/Documents/羽化录";

  /** 最近打开列表：一条可用、一条已失效，覆盖 UI 的两种状态。 */
  const recents: WorkspaceSummary[] = [
    {
      root: defaultRoot,
      workspaceId: "ws-demo-0001",
      title: book.title,
      created: book.created,
      lastOpened: book.updated,
      available: true,
    },
    {
      root: "D:/素材/旧稿/未完成的小说",
      workspaceId: "ws-demo-0002",
      title: "旧稿",
      created: mockTime(-60),
      lastOpened: mockTime(-30),
      available: false,
    },
  ];

  // ---- 内部工具 ----

  /** 取某一卷下的章节，按 sort 升序。 */
  function chaptersOf(volumeId: string): ChapterSummary[] {
    return chapters.filter((c) => c.volumeId === volumeId).sort((a, b) => a.sort - b.sort);
  }

  /**
   * 把一卷内的章节 sort 重新编号为 0..n-1。
   *
   * 任何结构性改动（增删、移动、重排）之后都必须调用，
   * 否则 sort 会出现空洞或重复，拖拽落位就会跳。
   */
  function renumber(volumeId: string): void {
    chaptersOf(volumeId).forEach((c, i) => {
      c.sort = i;
    });
  }

  /** 按 ID 取章，找不到就报 NOT_FOUND。 */
  function requireChapter(chapterId: string): ChapterSummary {
    const found = chapters.find((c) => c.id === chapterId);
    if (!found) {
      throw new MockError("NOT_FOUND", `找不到章节：${chapterId}`, true);
    }
    return found;
  }

  /** 按 ID 取卷，找不到就报 NOT_FOUND。 */
  function requireVolume(volumeId: string): Volume {
    const found = volumes.find((v) => v.id === volumeId);
    if (!found) {
      throw new MockError("NOT_FOUND", `找不到卷：${volumeId}`, true);
    }
    return found;
  }

  /** 把标题 trim 后校验非空。空标题会让树里出现点不中的条目。 */
  function requireTitle(title: string, what: string): string {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new MockError("INVALID_INPUT", `${what}不能为空`, true);
    }
    if (trimmed.length > 200) {
      throw new MockError("INVALID_INPUT", `${what}过长（上限 200 字符）`, true);
    }
    return trimmed;
  }

  /** 重算某一章的字数（正文变化后调用）。 */
  function recount(chapter: ChapterSummary, body: string, mode: CountMode = "withoutPunctuation"): void {
    chapter.wordCount = countByModeCompat(body, mode);
  }

  /** 取默认口径字数。 */
  function countByModeCompat(text: string, mode: CountMode): number {
    const c = countWords(text);
    return mode === "withPunctuation" ? c.withPunctuation : mode === "withoutPunctuation" ? c.withoutPunctuation : c.wordsForEnglish;
  }

  /** 生成章节的默认路径。 */
  function chapterPath(volume: Volume, sort: number, title: string): string {
    const volIndex = volumes.findIndex((v) => v.id === volume.id) + 1;
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, "-");
    return `manuscript/${String(volIndex).padStart(3, "0")}-${volume.title}/${String(sort + 1).padStart(3, "0")}-${safeTitle}.md`;
  }

  /** 构造空的恢复报告。示例数据永远「干净」。 */
  function cleanReport(): RecoveryReport {
    return {
      sweptTempFiles: 0,
      interruptedOperations: [],
      pendingPaths: [],
      purgedTrashItems: 0,
      conflicts: [] as DetectedConflict[],
    };
  }

  /** 当前文稿快照，供打开/新建命令返回。 */
  function document(): OpenWorkspaceResult["document"] {
    return {
      book: { ...book },
      volumes: volumes.map((v) => ({ ...v })),
      // 摘要列表：按卷序、章序排列。文档结构里的顺序是确定性的，
      // 前端可以放心直接渲染，不需要再排一遍
      chapters: chapters
        .slice()
        .sort((a, b) => (a.volumeId === b.volumeId ? a.sort - b.sort : compareVolumeOrder(a.volumeId, b.volumeId))),
      recovery: cleanReport(),
    };
  }

  /** 卷的展示顺序，用于跨卷排序。 */
  function compareVolumeOrder(a: string, b: string): number {
    const ia = volumes.findIndex((v) => v.id === a);
    const ib = volumes.findIndex((v) => v.id === b);
    return ia - ib;
  }

  /**
   * 当前大纲快照。
   *
   * ## 为什么所有结构改动都返回它
   *
   * 真实后端（commands.rs）的 create/rename/delete/reorder 系列
   * 统一返回 Vec<OutlineNode>，而不是被改动的那一条 —— 因为
   * 一次结构改动会连带改掉同卷内所有项的 sort 与路径。
   * mock 是**行为镜像**，必须照做：否则前端会写出"拿返回值直接当
   * 新章用"这种只在浏览器里成立的代码，到 Tauri 里就炸。
   *
   * ## 为什么直接复用取大纲的逻辑
   *
   * 两份实现必然会在某个字段上分叉，而那种分叉只会在界面里
   * 以"某一列数值不对"的形式出现，极难定位到根因。
   */
  function outlineSnapshot(): OutlineNode[] {
    return backend.getOutline();
  }

  // ---- 实现 ----

  const backend: MockBackend = {
    listRecentWorkspaces() {
      return recents.map((r) => ({ ...r }));
    },

    createWorkspace(root, title) {
      const name = requireTitle(title, "书名");
      book.title = name;
      book.created = mockTime(0);
      book.updated = mockTime(0);
      // 新工作区必须至少有一卷：章不能没有卷
      volumes.length = 0;
      chapters.length = 0;
      volumes.push({
        id: nextId("vol_"),
        bookId: book.id,
        title: "第一卷",
        sort: 0,
        created: mockTime(0),
      });
      recents.unshift({
        root,
        workspaceId: `ws-${idCounter}`,
        title: name,
        created: book.created,
        lastOpened: book.updated,
        available: true,
      });
      return { root, document: document() };
    },

    openWorkspace(root) {
      const known = recents.find((r) => r.root === root);
      if (known && !known.available) {
        throw new MockError("WORKSPACE_INVALID", `这个目录不是有效的工作区：${root}`, true);
      }
      return { root, document: document() };
    },

    closeWorkspace() {
      /* 内存数据保留：关掉再打开应当看到同样的内容 */
    },

    hasWorkspace() {
      return true;
    },

    createVolume(input) {
      const title = requireTitle(input.title, "卷名");
      const at = input.sort ?? volumes.length;
      const index = Math.max(0, Math.min(at, volumes.length));
      const volume: Volume = {
        id: nextId("vol_"),
        bookId: book.id,
        title,
        sort: index,
        created: mockTime(0),
      };
      volumes.splice(index, 0, volume);
      volumes.forEach((v, i) => {
        v.sort = i;
      });
      return outlineSnapshot();
    },

    renameVolume(volumeId, title) {
      const volume = requireVolume(volumeId);
      const name = requireTitle(title, "卷名");
      volume.title = name;
      // 卷改名后章节的相对路径要跟着变，否则路径与磁盘结构对不上
      chaptersOf(volumeId).forEach((c) => {
        c.path = chapterPath(volume, c.sort, c.title);
      });
      return outlineSnapshot();
    },

    deleteVolume(volumeId) {
      const volume = requireVolume(volumeId);
      const index = volumes.findIndex((v) => v.id === volumeId);
      const affected = chaptersOf(volumeId);
      affected.forEach((c) => {
        trash.push({
          originalId: c.id,
          originalTitle: c.title,
          originalPath: c.path,
          trashDirName: `${mockTime(0)}-${c.id}`,
          deletedAt: mockTime(0),
          kind: "chapter",
        });
      });
      // 从数组里移除这些章节
      for (const c of affected) {
        const i = chapters.indexOf(c);
        if (i >= 0) chapters.splice(i, 1);
      }
      volumes.splice(index, 1);
      volumes.forEach((v, i) => {
        v.sort = i;
      });
      // 删到一卷不剩也要留一个容器：章不能没有卷
      if (volumes.length === 0) {
        volumes.push({ id: nextId("vol_"), bookId: book.id, title: "第一卷", sort: 0, created: mockTime(0) });
      }
      void volume;
      return outlineSnapshot();
    },

    /**
     * 按给定的完整顺序重排卷。
     *
     * ## 为什么接受"完整顺序"而不是"移到第 N 位"
     *
     * 与后端的 reorder_volumes 保持一致（见 ipc/index.ts 的说明）。
     * mock 是**行为镜像**，它的签名必须与真实后端相同 —— 否则前端
     * 会在浏览器里跑通、到 Tauri 里失败，而那正是这一层存在的
     * 意义所要防止的。
     *
     * ## 不在列表里的卷怎么处理
     *
     * 追加到末尾。这看起来"宽容"，但它防的是一类真实事故：
     * 前端算顺序时用了过期的大纲（比如另一台设备刚加了一卷），
     * 直接丢弃未知卷会让它在界面上**凭空消失**。保守地保留在
     * 末尾，至少不会静默丢数据。
     */
    reorderVolumes(orderedIds) {
      const byId = new Map(volumes.map((v) => [v.id, v]));
      const next: Volume[] = [];
      for (const id of orderedIds) {
        const found = byId.get(id);
        if (found) {
          next.push(found);
          byId.delete(id);
        }
      }
      // 未被提及的卷保留在末尾（见上面的说明）
      for (const leftover of volumes) {
        if (byId.has(leftover.id)) next.push(leftover);
      }
      volumes.length = 0;
      volumes.push(...next);
      volumes.forEach((v, i) => {
        v.sort = i;
      });
      return outlineSnapshot();
    },

    createChapter(input) {
      const volume = requireVolume(input.volumeId);
      const existing = chaptersOf(input.volumeId);
      const at = input.sort ?? existing.length;
      const index = Math.max(0, Math.min(at, existing.length));
      const title = input.title?.trim() ? requireTitle(input.title, "章节标题") : `第${existing.length + 1}章`;
      const summary: ChapterSummary = {
        id: nextId("ch_"),
        volumeId: volume.id,
        title,
        status: "draft",
        sort: index,
        path: "",
        wordCount: 0,
        wordGoal: 0,
        summary: "",
        updated: mockTime(0),
      };
      chapters.push(summary);
      renumber(volume.id);
      summary.path = chapterPath(volume, summary.sort, summary.title);
      // 正文可以为空，但必须在表里占位，否则 readChapter 会误判为"文件不存在"
      bodies.set(summary.id, "");
      hashes.set(summary.id, "empty");
      return outlineSnapshot();
    },

    /**
     * 按给定的完整顺序重排某一卷内的章节。
     *
     * 与 reorderVolumes 同理：整份顺序无歧义，而 toIndex 的语义
     * 取决于"移除被移动项之前还是之后"—— 那是一个真实的、
     * 反复出现的一处之差 bug 来源。
     *
     * 不在列表里的章节按原顺序追加到末尾（理由同 reorderVolumes）。
     */
    reorderChapters(volumeId, orderedIds) {
      requireVolume(volumeId);
      const siblings = chaptersOf(volumeId);
      const byId = new Map(siblings.map((c) => [c.id, c]));
      const next: ChapterSummary[] = [];
      const seen = new Set<string>();
      for (const id of orderedIds) {
        const found = byId.get(id);
        if (found && !seen.has(id)) {
          next.push(found);
          seen.add(id);
        }
      }
      for (const leftover of siblings) {
        if (!seen.has(leftover.id)) next.push(leftover);
      }
      next.forEach((c, i) => {
        c.sort = i;
      });
      // 序号变了，路径里的编号也要跟着变（后端同样会重命名文件）
      const volume = requireVolume(volumeId);
      next.forEach((c) => {
        c.path = chapterPath(volume, c.sort, c.title);
      });
      return outlineSnapshot();
    },

    readChapter(chapterId) {
      const found = requireChapter(chapterId);
      const body = bodies.get(chapterId) ?? "";
      return {
        id: found.id,
        title: found.title,
        body,
        words: countWords(body),
        mtime: Date.now(),
        contentHash: hashes.get(chapterId) ?? "empty",
      };
    },

    saveChapter(chapterId, body, expectedHash) {
      const found = requireChapter(chapterId);
      const current = hashes.get(chapterId) ?? "empty";
      // 乐观并发：哈希对不上说明文件在编辑期间被外部改过，
      // 这里必须拒绝而不是覆盖（计划书 4.5 节「绝不静默覆盖」）
      if (expectedHash !== undefined && expectedHash !== current) {
        throw new MockError(
          "INVARIANT_VIOLATION",
          "这一章在磁盘上已被外部修改，为避免覆盖你的稿子，保存已取消。",
          true,
        );
      }
      bodies.set(chapterId, body);
      const next = `hash-${body.length}-${body.charCodeAt(0) || 0}`;
      hashes.set(chapterId, next);
      recount(found, body);
      found.updated = mockTime(0);
      return {
        id: found.id,
        title: found.title,
        body,
        words: countWords(body),
        mtime: Date.now(),
        contentHash: next,
      };
    },

    updateChapterMeta(input) {
      const found = requireChapter(input.chapterId);
      if (input.title !== undefined) found.title = requireTitle(input.title, "章节标题");
      if (input.status !== undefined) found.status = input.status;
      if (input.wordGoal !== undefined) found.wordGoal = Math.max(0, Math.floor(input.wordGoal));
      if (input.summary !== undefined) found.summary = input.summary;
      // notes（作者便签）不在摘要里：它属于 Front Matter 的正文侧，
      // 单独存一份，避免为了一个字段把正文带进列表载荷
      if (input.notes !== undefined) notes.set(input.chapterId, input.notes);
      found.updated = mockTime(0);
    },

    renameChapter(chapterId, title) {
      const found = requireChapter(chapterId);
      found.title = requireTitle(title, "章节标题");
      const volume = requireVolume(found.volumeId);
      found.path = chapterPath(volume, found.sort, found.title);
      found.updated = mockTime(0);
      return outlineSnapshot();
    },

    setChapterStatus(chapterId, status) {
      const found = requireChapter(chapterId);
      found.status = status;
      found.updated = mockTime(0);
    },

    deleteChapter(chapterId) {
      const found = requireChapter(chapterId);
      const index = chapters.indexOf(found);
      chapters.splice(index, 1);
      trash.push({
        originalId: found.id,
        originalTitle: found.title,
        originalPath: found.path,
        trashDirName: `${mockTime(0)}-${found.id}`,
        deletedAt: mockTime(0),
        kind: "chapter",
      });
      renumber(found.volumeId);
      return outlineSnapshot();
    },

    getOutline() {
      return volumes
        .slice()
        .sort((a, b) => a.sort - b.sort)
        .map((v) => {
          const list = chaptersOf(v.id);
          return {
            volumeId: v.id,
            title: v.title,
            sort: v.sort,
            chapters: list.map((c) => ({ ...c })),
            wordCount: list.reduce((sum, c) => sum + c.wordCount, 0),
            chapterCount: list.length,
          };
        });
    },

    getWordStats(chapterId) {
      const chapter = chapterId ? chapters.find((c) => c.id === chapterId) : undefined;
      const volumeTotal = chapter ? chaptersOf(chapter.volumeId).reduce((s, c) => s + c.wordCount, 0) : 0;
      return {
        chapter: chapter?.wordCount ?? 0,
        volume: volumeTotal,
        book: chapters.reduce((s, c) => s + c.wordCount, 0),
        chapterCount: chapters.length,
        volumeCount: volumes.length,
      };
    },

    getChapterWordCount(chapterId) {
      requireChapter(chapterId);
      return countWords(bodies.get(chapterId) ?? "");
    },

    getStatsSummary() {
      return buildStatsPayload(chapters);
    },

    search(query) {
      const keyword = query.keyword.trim();
      const empty: SearchResults = {
        hits: [],
        total: 0,
        limit: clampLimit(query.limit),
        offset: Math.max(0, query.offset ?? 0),
        tokens: [],
      };
      if (keyword.length === 0) return empty;

      const hits: SearchHit[] = [];
      for (const c of chapters) {
        if (query.volumeId && c.volumeId !== query.volumeId) continue;
        const body = bodies.get(c.id) ?? "";
        const titleMatch = c.title.includes(keyword);
        const bodyMatches = query.titleOnly ? [] : findOccurrences(body, keyword);
        if (!titleMatch && bodyMatches.length === 0) continue;

        hits.push({
          chapterId: c.id,
          title: c.title,
          path: c.path,
          volumeId: c.volumeId,
          // 相关度：命中次数越多越靠前，标题命中额外加权。
          // 用大分值而不是排序优先级，是为了让"标题命中 > 正文命中 10 次"
          // 这条规则显式可见，而不是藏在比较函数里
          score: bodyMatches.length + (titleMatch ? 1000 : 0),
          snippets: buildSnippets(body, keyword, bodyMatches),
        });
      }

      hits.sort((a, b) => b.score - a.score);
      const offset = empty.offset;
      const limit = empty.limit;
      return {
        hits: hits.slice(offset, offset + limit),
        total: hits.length,
        limit,
        offset,
        tokens: [...keyword],
      };
    },

    listTrash() {
      return trash.map((t) => ({ ...t }));
    },

    restoreFromTrash(trashDirName) {
      const index = trash.findIndex((t) => t.trashDirName === trashDirName);
      if (index < 0) {
        throw new MockError("NOT_FOUND", "回收站里没有这一条", true);
      }
      trash.splice(index, 1);
    },

    purgeFromTrash(trashDirName) {
      const index = trash.findIndex((t) => t.trashDirName === trashDirName);
      if (index < 0) {
        throw new MockError("NOT_FOUND", "回收站里没有这一条", true);
      }
      trash.splice(index, 1);
    },

    emptyTrash() {
      const n = trash.length;
      trash.length = 0;
      return n;
    },

    getRecoveryReport() {
      return cleanReport();
    },

    rebuildIndex() {
      // 索引是缓存，重建不改变任何数据
    },
  };

  return backend;
}

// ---------------------------------------------------------------------------
// 写作统计（M8）
// ---------------------------------------------------------------------------

/**
 * 由章节字数反推一份**确定性**的按天统计。
 *
 * ## 为什么不是随机数
 *
 * 统计页的测试要断言具体数字（「本周共 N 字」），随机数据没法断言。
 * 这里用「章节序号 + 固定相位」的算术生成，同一份示例书在任何时候、
 * 任何机器上都会得到完全一样的统计结果。
 *
 * ## 为什么要造这段数据
 *
 * 浏览器预览模式与组件测试都走这条路。如果 mock 返回一份空统计，
 * 日历、热力图、连续天数、进度环在开发时永远是空的 ——
 * 那些恰是最需要肉眼检查的界面。
 *
 * 分布刻意做成「工作日写得多、周末写得少、中间断过几天」，
 * 这样连续天数、最高单日、断档这几条规则都能在同一张图上被看到。
 */
export function buildStatsPayload(chapters: readonly ChapterSummary[]): StatsPayload {
  const totalWords = chapters.reduce((sum, c) => sum + c.wordCount, 0);
  // 示例数据里的基准日：与 mock-data 的时间戳同源，随 seed 一起固定
  const anchor = new Date(2026, 0, 1);
  const today = new Date(anchor.getTime());
  today.setDate(today.getDate() + 30);

  const days: StatsDay[] = [];
  const chapterCount = Math.max(1, Math.min(chapters.length, 8));
  let remaining = totalWords;

  // 从 90 天前开始铺：足以覆盖热力图的一整段，又不会让载荷变大
  for (let offset = 90; offset >= 0; offset -= 1) {
    const date = new Date(today.getTime());
    date.setDate(date.getDate() - offset);
    const weekday = (date.getDay() + 6) % 7;

    // 每 9 天断一天：让「连续天数」有断点可看
    if (offset % 9 === 4) continue;
    // 未来日期不产出（今天之后的格子必须为空）
    if (offset > 0 && weekday === 6 && offset % 3 === 0) continue;

    const pulse = [1, 0.6, 0.85, 0.4, 0.7][offset % 5] ?? 1;
    const weekendFactor = weekday >= 5 ? 0.35 : 1;
    const words = Math.round(1600 * pulse * weekendFactor);
    if (words <= 0) continue;

    remaining -= words;
    days.push({
      date: formatDayKey(date),
      words,
      minutes: Math.max(1, Math.round(words / 32)),
      chapters: Math.max(1, Math.min(chapterCount, 1 + (offset % chapterCount))),
    });
  }

  // 总字数若明显大于铺出来的量，差额补到今天，
  // 让「累计码字」与书架上的字数对得上（示例数据要自洽）
  if (days.length > 0 && remaining > 0) {
    const last = days[days.length - 1];
    if (last) last.words += remaining;
  }

  const summary = summarizeDays(days, formatDayKey(today), DEFAULT_STREAK_THRESHOLD);
  return { days, summary, statsDir: ".yuhua/stats", streakThreshold: DEFAULT_STREAK_THRESHOLD };
}

/** 连续天数的默认阈值，与 Rust 侧 `DEFAULT_STREAK_THRESHOLD` 一致。 */
const DEFAULT_STREAK_THRESHOLD = 100;

/** 把 Date 格式化成 YYYY-MM-DD（本地日历）。 */
function formatDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 在日期键上加减天数。 */
function shiftDayKey(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + delta);
  return formatDayKey(date);
}

/** 某天在周几（0 为周一）。 */
function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return (new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getDay() + 6) % 7;
}

/**
 * 汇总计算。
 *
 * 这份实现在语义上与 Rust 的 `summarize` 完全一致：平均日更的分母是
 * **自然日**、今天没写不算断、并列时最高单日取更早的一天。
 * mock 是行为镜像，镜像得不像比不实现更危险。
 */
function summarizeDays(days: readonly StatsDay[], today: string, threshold: number): StatsSummary {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const month = today.slice(0, 7);
  const weekStart = shiftDayKey(today, -weekdayOfKey(today));
  const weekEnd = shiftDayKey(weekStart, 7);

  let totalWords = 0;
  let totalMinutes = 0;
  let activeDays = 0;
  let bestDay = 0;
  let bestDayDate: string | null = null;
  let thisMonth = 0;
  let thisWeek = 0;

  for (const day of [...days].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    totalWords += day.words;
    totalMinutes += day.minutes;
    if (day.words > 0) activeDays += 1;
    if (day.words > bestDay) {
      bestDay = day.words;
      bestDayDate = day.date;
    }
    if (day.date.slice(0, 7) === month) thisMonth += day.words;
    if (day.date >= weekStart && day.date < weekEnd) thisWeek += day.words;
  }

  let window7 = 0;
  for (let i = 6; i >= 0; i -= 1) window7 += byDate.get(shiftDayKey(today, -i))?.words ?? 0;
  const averagePerDay7 = Math.floor(window7 / 7);

  const reached = (key: string): boolean => (byDate.get(key)?.words ?? 0) >= threshold;
  let cursor = reached(today) ? today : shiftDayKey(today, -1);
  let streak = 0;
  while (streak < 10_000 && reached(cursor)) {
    streak += 1;
    cursor = shiftDayKey(cursor, -1);
  }

  return {
    totalWords,
    thisMonth,
    thisWeek,
    today: byDate.get(today)?.words ?? 0,
    activeDays,
    averagePerActiveDay: activeDays === 0 ? 0 : Math.floor(totalWords / activeDays),
    averagePerDay7,
    bestDay,
    bestDayDate,
    totalMinutes,
    streak,
    streakThreshold: threshold,
    // 示例数据没有全书目标，因此不估算完稿日（与 Rust 侧无目标时返回 None 一致）
    estimatedCompletion: null,
    remainingDays: null,
  };
}

/** 把每页条数收敛到 1..200，与 Rust 侧 `effective_limit` 一致。 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 30;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

/** 找出关键词在一段文本里出现的所有位置（字符下标）。 */
export function findOccurrences(text: string, keyword: string): number[] {
  if (keyword.length === 0) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(keyword, from);
    if (at < 0) break;
    out.push(at);
    // 步进 1 而不是 keyword.length：支持重叠命中（「哈哈哈」找「哈哈」）
    from = at + 1;
  }
  return out;
}



/**
 * 围绕命中位置截取上下文片段。
 *
 * ## 两个容易错的细节
 *
 * **一、区间必须是字节偏移。** Rust 侧 `HighlightSnippet::ranges` 用的是
 * `str` 的字节下标，而 IPC 层会把它转成 JS 的字符下标
 * （见 ipc/types.ts 的 `byteRangesToCharRanges`）。mock 作为"行为镜像"
 * 必须与其一致，否则同样一个 `[0,1]` 会被解释成「第 0 字节到第 1 字节」——
 * 那落在汉字"雨"的中间，转换后得到 `[0,0]`，界面上什么都高亮不出来。
 *
 * **二、换行被压平后位置会漂移。** 片段里的换行要换成空格（否则一条
 * 结果占三行）。但替换后关键词下标就变了，如果此时用 `indexOf` 重新
 * 定位，遇到关键词跨换行会返回 -1，高亮直接丢失。因此这里一边压平
 * 一边记录"关键词起点之前被替换掉多少字符"，直接算出正确偏移。
 */
function buildSnippets(body: string, keyword: string, occurrences: number[], max = 3): Array<{ text: string; ranges: Array<[number, number]> }> {
  const context = 24;
  const snippets: Array<{ text: string; ranges: Array<[number, number]> }> = [];
  const used: Array<[number, number]> = [];

  for (const at of occurrences) {
    if (snippets.length >= max) break;
    const start = Math.max(0, at - context);
    const end = Math.min(body.length, at + keyword.length + context);
    // 与上一段重叠就跳过，避免同一个位置出现两条几乎一样的片段
    if (used.some(([s, e]) => at >= s && at < e)) continue;
    used.push([start, end]);

    const raw = body.slice(start, end);
    // 压平换行的同时累计「关键词起点之前」被改写掉的字符数。
    // 换行 1 字符 -> 空格 1 字符，长度不变，因此只需要修正起点。
    let flat = "";
    let shiftBeforeStart = 0;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i] ?? "";
      if (ch === "\n") {
        flat += " ";
        if (i < at - start) shiftBeforeStart += 1;
      } else {
        flat += ch;
      }
    }

    const charBegin = at - start - shiftBeforeStart;
    const charFinish = charBegin + keyword.length;
    const ranges: Array<[number, number]> =
      charBegin >= 0 && charFinish <= flat.length && flat.slice(charBegin, charFinish).replace(/\s/g, "") === keyword.replace(/\s/g, "")
        ? [[charOffsetToByte(flat, charBegin), charOffsetToByte(flat, charFinish)]]
        : [];

    snippets.push({ text: flat, ranges });
  }

  // 兜底：正文里确实有这个词，但命中位置都在片段之外（理论上不会发生，
  // 但保留这条路径可以避免"搜到了却没有片段"的空结果）
  if (snippets.length === 0 && occurrences.length === 0 && body.includes(keyword)) {
    const head = body.slice(0, 60).replace(/\n+/g, " ");
    const rel = head.indexOf(keyword);
    // 定位不到关键词就不给高亮区间，绝不假定它从 0 开始
    snippets.push({
      text: head,
      ranges: rel >= 0 ? [[charOffsetToByte(head, rel), charOffsetToByte(head, rel + keyword.length)]] : [],
    });
  }
  return snippets;
}


/**
 * 把片段内的字符下标换成 UTF-8 字节下标。
 *
 * 存在的唯一理由：Rust 的字符串索引是字节，而 JS 是 UTF-16 码元。
 * 中文一个字占 3 字节，因此这个映射不能省 —— 直接把字符下标当字节
 * 用，IPC 层反向转换时就会得到错位的结果（区间会塌缩成空）。
 */
function charOffsetToByte(text: string, charOffset: number): number {
  let bytes = 0;
  let chars = 0;
  for (const ch of text) {
    if (chars >= charOffset) break;
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    chars += 1;
  }
  return bytes;
}

