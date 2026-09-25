/**
 * IPC 数据契约 —— 与 Rust 侧一对一的 TypeScript 镜像。
 *
 * ## 为什么手写而不是用 tauri-specta 生成
 *
 * 计划书 T0.4 的目标是 tauri-specta 自动生成，但命令层此刻还不完整
 * （主代理正在写）。前端不能因为后端没写完就停工，因此这里先手写一份
 * **严格的镜像**：字段名、可选性、枚举取值都与 Rust 结构体的
 * `#[serde(rename_all = "camelCase")]` 对齐。
 *
 * 等命令层落地后，把本文件换成生成产物即可，调用方无需改动 ——
 * 这正是所有组件都只通过 `@/lib/ipc` 的函数访问后端的原因。
 *
 * ## 命名约定
 *
 * Rust 侧统一 `#[serde(rename_all = "camelCase")]`，因此
 * `volume_id` 到这里是 `volumeId`。**不要**在这里混用下划线命名。
 *
 * ## 时间与路径
 *
 * - 时间一律是 RFC 3339 字符串（chrono 的 `DateTime<FixedOffset>`），
 *   不在这里转成 Date —— 时区信息在字符串里，转 Date 会把本地时区的
 *   偏移量弄丢，导出统计会算错日期。
 * - 路径分两种：`path` 一律是**相对工作区根**的 POSIX 路径（用 `/`）；
 *   只有工作区自身的 `root` 是绝对路径。
 */

/** 章节写作状态，对应 Rust `ChapterStatus`。 */
export type ChapterStatus = "draft" | "done" | "revising";

/** 全部章节状态的有序列表，供渲染下拉框。 */
export const CHAPTER_STATUSES: readonly ChapterStatus[] = ["draft", "done", "revising"] as const;

/**
 * 字数统计口径，对应 Rust `CountMode`。
 *
 * 序列化用的是 camelCase 枚举名（Rust 侧是 `rename_all = "camelCase"`），
 * 但 Front Matter 里用的是小写（`ChapterStatus` 用 `rename_all = "lowercase"`）。
 * 两者不一致是有意的：前者走 IPC，后者进用户可读的文件。
 */
export type CountMode = "withPunctuation" | "withoutPunctuation" | "wordsForEnglish";

/** 默认口径：不含标点。与 Rust 侧 `CountMode::default()` 一致。 */
export const DEFAULT_COUNT_MODE: CountMode = "withoutPunctuation";

/** 字数统计的完整结果，对应 Rust `WordCount`。 */
export interface WordCount {
  /** 含标点字数。 */
  withPunctuation: number;
  /** 不含标点字数。 */
  withoutPunctuation: number;
  /** 中文逐字 + 英文按词。 */
  wordsForEnglish: number;
  /** 汉字个数。 */
  hanChars: number;
  /** 段落数。 */
  paragraphs: number;
}

/** 按口径从统计结果取数。 */
export function pickCount(count: WordCount, mode: CountMode): number {
  switch (mode) {
    case "withPunctuation":
      return count.withPunctuation;
    case "withoutPunctuation":
      return count.withoutPunctuation;
    case "wordsForEnglish":
      return count.wordsForEnglish;
  }
}

/** 一本书，对应 Rust `Book`。 */
export interface Book {
  /** 书 ID，形如 `bk_\u2026`。 */
  id: string;
  /** 书名。 */
  title: string;
  /** 作者名。 */
  author: string;
  /** 一句话简介。 */
  description: string;
  /** 创建时间（RFC 3339）。 */
  created: string;
  /** 最后修改时间（RFC 3339）。 */
  updated: string;
}

/** 一卷，对应 Rust `Volume`。 */
export interface Volume {
  /** 卷 ID，形如 `vol_\u2026`。 */
  id: string;
  /** 所属书 ID。 */
  bookId: string;
  /** 卷名。 */
  title: string;
  /** 卷内排序序号，从 0 开始。 */
  sort: number;
  /** 创建时间（RFC 3339）。 */
  created: string;
}

/**
 * 章节摘要，对应 Rust `ChapterSummary`。
 *
 * 刻意不含正文：卷章树渲染 300 章时，这个结构的内存占用必须与
 * 书籍总字数无关（计划书不变量 4 与内存指标 M2）。
 */
export interface ChapterSummary {
  /** 章 ID，形如 `ch_\u2026`。 */
  id: string;
  /** 所属卷 ID。 */
  volumeId: string;
  /** 章标题。 */
  title: string;
  /** 写作状态。 */
  status: ChapterStatus;
  /** 卷内排序。 */
  sort: number;
  /** 相对工作区根的路径，用 `/` 分隔。 */
  path: string;
  /** 字数（默认口径）。 */
  wordCount: number;
  /** 目标字数，0 表示未设置。 */
  wordGoal: number;
  /** 一句话摘要。 */
  summary: string;
  /** 最后修改时间（RFC 3339）。 */
  updated: string;
}

/**
 * 章节正文载荷，对应 Rust 侧 `read_chapter` 的返回。
 *
 * ## 为什么正文与摘要分开取
 *
 * 卷章树要渲染 300 章，但同一时刻只有一章的正文在编辑。
 * 如果列表命令把正文一起带回来，一本 100 万字的书每次刷新树
 * 都要传输并驻留 100 万字 —— 直接违反计划书的不变量 4 与内存指标 M2。
 *
 * 因此契约写死：**列表只给摘要（ChapterSummary），正文按需单独读**。
 * 这个类型就是"单独读"的结果。
 */
export interface ChapterContent {
  /** 章 ID。 */
  id: string;
  /** 章标题。 */
  title: string;
  /** 正文（不含 Front Matter）。 */
  body: string;
  /** 正文的三口径统计。 */
  words: WordCount;
  /** 文件最后修改时间（Unix 毫秒）。 */
  mtime: number;
  /** 正文内容哈希，用于保存时的乐观并发检测。 */
  contentHash: string;
}

/** 大纲节点，对应 Rust `OutlineNode`。 */
export interface OutlineNode {
  /** 卷 ID。 */
  volumeId: string;
  /** 卷名。 */
  title: string;
  /** 卷排序。 */
  sort: number;
  /** 本卷章节摘要。 */
  chapters: ChapterSummary[];
  /** 本卷总字数。 */
  wordCount: number;
  /** 本卷章节数。 */
  chapterCount: number;
}

/** 字数统计，对应 Rust `WordStats`。 */
export interface WordStats {
  /** 本章字数。 */
  chapter: number;
  /** 本卷字数。 */
  volume: number;
  /** 全书字数。 */
  book: number;
  /** 章数。 */
  chapterCount: number;
  /** 卷数。 */
  volumeCount: number;
}

/** 高亮片段，对应 Rust `HighlightSnippet`。 */
export interface HighlightSnippet {
  /** 片段文本。 */
  text: string;
  /**
   * 关键词在 text 中的**字符**区间列表。
   *
   * Rust 侧给的是字节区间；这里按字符给是因为前端渲染需要
   * 按字符切 JS 字符串（中文一个字符占 3 字节，按字节切会切出乱码）。
   * 转换在 ipc 层完成，见 {@link adaptSnippet}。
   */
  ranges: Array<[number, number]>;
}

/** 一条检索结果，对应 Rust `SearchHit`。 */
export interface SearchHit {
  /** 章节 ID。 */
  chapterId: string;
  /** 章节标题。 */
  title: string;
  /** 相对路径。 */
  path: string;
  /** 所属卷 ID。 */
  volumeId: string;
  /** 相关度分值（越小越相关）。 */
  score: number;
  /** 高亮片段。 */
  snippets: HighlightSnippet[];
}

/** 检索结果集，对应 Rust `SearchResults`。 */
export interface SearchResults {
  /** 当前页结果。 */
  hits: SearchHit[];
  /** 命中章节总数。 */
  total: number;
  /** 每页条数。 */
  limit: number;
  /** 偏移量。 */
  offset: number;
  /** 查询被识别出的 token，用于解释「为什么没搜到」。 */
  tokens: string[];
}

/** 检索请求。 */
export interface SearchQuery {
  /** 关键词。 */
  keyword: string;
  /** 每页条数，默认 30，上限 200。 */
  limit?: number;
  /** 偏移量。 */
  offset?: number;
  /** 是否只搜标题。 */
  titleOnly?: boolean;
  /** 限定某一卷。 */
  volumeId?: string;
}

/** 工作区摘要，对应 Rust `WorkspaceSummary`。 */
export interface WorkspaceSummary {
  /** 工作区根路径（绝对路径）。 */
  root: string;
  /** 工作区 ID。 */
  workspaceId: string;
  /** 书名。 */
  title: string;
  /** 创建时间。 */
  created: string;
  /** 最近打开时间。 */
  lastOpened: string | null;
  /** 该路径当前是否仍然可用（可能已被移动或删除）。 */
  available: boolean;
}

/** 云盘冲突副本，对应 Rust `DetectedConflict`。 */
export interface DetectedConflict {
  /** 冲突副本的绝对路径。 */
  path: string;
  /** 相对工作区根的路径。 */
  relativePath: string;
  /** 文件名。 */
  fileName: string;
  /** 推测它对应哪一章。 */
  originalFileName: string;
  /** 命中的云盘命名习惯。 */
  pattern: string;
}

/** 崩溃恢复报告，对应 Rust `RecoveryReport`。 */
export interface RecoveryReport {
  /** 清理的临时文件数。 */
  sweptTempFiles: number;
  /** 上次崩溃时未完成的操作描述。 */
  interruptedOperations: string[];
  /** 未完成操作涉及的文件。 */
  pendingPaths: string[];
  /** 清理的过期回收站条目数。 */
  purgedTrashItems: number;
  /** 发现的云盘冲突副本（只报告，绝不自动删除）。 */
  conflicts: DetectedConflict[];
}

/** 回收站条目，对应 Rust `TrashEntry`。 */
export interface TrashEntry {
  /** 删除前的 ID。 */
  originalId: string;
  /** 删除前的显示名。 */
  originalTitle: string;
  /** 删除前的相对路径。 */
  originalPath: string;
  /** 在 .trash/ 中的存放目录名。 */
  trashDirName: string;
  /** 删除时间。 */
  deletedAt: string;
  /** 条目类型：chapter / volume / book。 */
  kind: string;
}

/** 整本文稿的内存视图，对应 Rust `Document`。 */
export interface WorkspaceDocument {
  /** 书。 */
  book: Book;
  /** 卷列表（已按 sort 排序）。 */
  volumes: Volume[];
  /** 章列表（不含正文）。 */
  chapters: ChapterSummary[];
  /** 打开时的崩溃恢复报告。 */
  recovery: RecoveryReport;
}

/** 打开工作区后的完整载荷。 */
export interface OpenWorkspaceResult {
  /** 工作区根路径。 */
  root: string;
  /** 文稿结构。 */
  document: WorkspaceDocument;
}

/**
 * 统一错误形状。
 *
 * 与 Rust 侧 `YuhuaError` / `CommandError` 的手写 Serialize 完全一致：
 * `{ code, message, recoverable, detail }`。前端**按 code 分支**，
 * 绝不解析 message 文本 —— message 是给用户看的，随时可能改。
 */
export interface IpcError {
  /** 稳定的机器可读错误码，如 `NO_WORKSPACE`、`IO_ERROR`。 */
  code: string;
  /** 面向用户的中文说明。 */
  message: string;
  /** 用户是否可以通过某个操作后重试。 */
  recoverable: boolean;
  /** 底层原因，供报 bug 时复制。 */
  detail: string | null;
}

/** 已知的错误码。用作 switch 的取值，未列出的码归入 default 分支。 */
export const ERROR_CODES = {
  workspaceInvalid: "WORKSPACE_INVALID",
  notFound: "NOT_FOUND",
  invariantViolation: "INVARIANT_VIOLATION",
  invalidInput: "INVALID_INPUT",
  ioError: "IO_ERROR",
  parseError: "PARSE_ERROR",
  databaseError: "DATABASE_ERROR",
  exportError: "EXPORT_ERROR",
  unimplemented: "UNIMPLEMENTED",
  noWorkspace: "NO_WORKSPACE",
  internal: "INTERNAL",
} as const;

/** 新建卷的参数。 */
export interface CreateVolumeInput {
  /** 卷名。 */
  title: string;
  /** 插入位置；省略表示追加到末尾。 */
  sort?: number;
}

/** 新建章的参数。 */
export interface CreateChapterInput {
  /** 所属卷 ID。 */
  volumeId: string;
  /** 章标题；省略时由后端按序号生成。 */
  title?: string;
  /** 插入位置；省略表示追加到本卷末尾。 */
  sort?: number;
}

/** 更新章节元数据的参数。 */
export interface UpdateChapterMetaInput {
  /** 章 ID。 */
  chapterId: string;
  /** 新标题。 */
  title?: string;
  /** 新状态。 */
  status?: ChapterStatus;
  /** 新目标字数。 */
  wordGoal?: number;
  /** 新摘要。 */
  summary?: string;
  /** 新便签。 */
  notes?: string;
}

/**
 * 把 Rust 侧的字节区间转成 JS 的字符区间。
 *
 * 为什么必须转：Rust 的 `str` 索引是字节，中文一个字占 3 字节，
 * 直接拿字节下标去 `String.prototype.slice` 会把汉字切成半个。
 * 这里按片段文本重建「字节位置 → 字符位置」映射。
 */
export function byteRangesToCharRanges(text: string, byteRanges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  if (byteRanges.length === 0) return [];

  // 先建一次映射表，避免每个区间都重扫全文
  const byteToChar: number[] = new Array(text.length + 1);
  let bytePos = 0;
  let charPos = 0;
  for (const ch of text) {
    const size = utf8Length(ch);
    for (let i = 0; i < size; i += 1) {
      byteToChar[bytePos + i] = charPos;
    }
    bytePos += size;
    charPos += 1;
  }
  byteToChar[bytePos] = charPos;

  return byteRanges.map(([start, end]) => {
    const s = byteToChar[start] ?? charPos;
    const e = byteToChar[end] ?? charPos;
    return [s, Math.max(s, e)] as [number, number];
  });
}

/** 一个字符的 UTF-8 字节长度。 */
export function utf8Length(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}
