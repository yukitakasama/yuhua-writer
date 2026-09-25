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
  createVolume(input: CreateVolumeInput): Volume;
  renameVolume(volumeId: string, title: string): void;
  deleteVolume(volumeId: string): void;
  moveVolume(volumeId: string, toIndex: number): void;
  createChapter(input: CreateChapterInput): ChapterSummary;
  listChapters(): ChapterSummary[];
  readChapter(chapterId: string): ChapterContent;
  saveChapter(chapterId: string, body: string, expectedHash?: string): ChapterContent;
  updateChapterMeta(input: UpdateChapterMetaInput): void;
  renameChapter(chapterId: string, title: string): void;
  setChapterStatus(chapterId: string, status: ChapterStatus): void;
  deleteChapter(chapterId: string): void;
  moveChapter(chapterId: string, toVolumeId: string, toIndex: number): void;
  getOutline(): OutlineNode[];
  getWordStats(chapterId?: string): WordStats;
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
      return { ...volume };
    },

    renameVolume(volumeId, title) {
      const volume = requireVolume(volumeId);
      const name = requireTitle(title, "卷名");
      volume.title = name;
      // 卷改名后章节的相对路径要跟着变，否则路径与磁盘结构对不上
      chaptersOf(volumeId).forEach((c) => {
        c.path = chapterPath(volume, c.sort, c.title);
      });
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
    },

    moveVolume(volumeId, toIndex) {
      const from = volumes.findIndex((v) => v.id === volumeId);
      if (from < 0) throw new MockError("NOT_FOUND", `找不到卷：${volumeId}`, true);
      const [moved] = volumes.splice(from, 1);
      if (!moved) return;
      const clamped = Math.max(0, Math.min(toIndex, volumes.length));
      volumes.splice(clamped, 0, moved);
      volumes.forEach((v, i) => {
        v.sort = i;
      });
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
      return { ...summary };
    },

    listChapters() {
      return chapters.map((c) => ({ ...c }));
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
    },

    moveChapter(chapterId, toVolumeId, toIndex) {
      const found = requireChapter(chapterId);
      requireVolume(toVolumeId);
      const fromVolume = found.volumeId;

      // 先摘出来，避免它算进目标卷的位置计算里
      const targetList = chaptersOf(toVolumeId).filter((c) => c.id !== chapterId);
      const clamped = Math.max(0, Math.min(toIndex, targetList.length));
      found.volumeId = toVolumeId;
      // 用一个「排序权重」把新位置钉住，随后统一 renumber
      const anchor = targetList[clamped];
      const previous = clamped > 0 ? targetList[clamped - 1] : undefined;
      if (anchor) {
        found.sort = anchor.sort - 0.5;
      } else if (previous) {
        found.sort = previous.sort + 0.5;
      } else {
        found.sort = 0;
      }
      renumber(fromVolume);
      if (fromVolume !== toVolumeId) renumber(toVolumeId);
      else found.sort = clamped;

      const volume = requireVolume(toVolumeId);
      found.path = chapterPath(volume, found.sort, found.title);
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

/** 围绕命中位置截取上下文片段。 */
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

    const slice = body.slice(start, end).replace(/\n+/g, " ");
    // 重新定位关键词在片段中的位置：换行被压成空格后偏移会变
    const rel = slice.indexOf(keyword);
    snippets.push({
      text: slice,
      ranges: rel >= 0 ? [[rel, rel + keyword.length]] : [],
    });
  }

  if (snippets.length === 0 && occurrences.length === 0 && body.includes(keyword)) {
    snippets.push({ text: body.slice(0, 60), ranges: [[0, keyword.length]] });
  }
  return snippets;
}
