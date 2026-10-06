/**
 * 应用内性能埋点（P3 / P4）。
 *
 * ## 为什么必须有这一层
 *
 * P3「冷启动到编辑器可用」与 P4「打开 1 万字章节」这两条指标，
 * 外部探针是**测不出来**的：`Get-Process` 只知道窗口句柄什么时候出现，
 * 不知道 CodeMirror 的视图什么时候建好、正文什么时候装进去。
 * 之前 `docs/benchmarks.md` 只能把 P3 写成「代理指标」（窗口出现 336 ms），
 * 并把 P4 列为未采集 —— 代理值不是达标值，把它当 P3 报出去就是自欺。
 *
 * ## 时钟边界：这里只量「应用内」的那一段
 *
 * `performance.now()` 的原点是**文档开始加载**，不是进程启动。
 * 所以本模块的数不能与外部探针的数相加 —— 两个时钟没有共同原点，
 * 相加得到的「冷启动总时间」是假的。报告时明确分成两段：
 *
 * | 段                        | 谁测               | 指标         |
 * | ------------------------- | ------------------ | ------------ |
 * | 进程启动 → 窗口句柄出现   | `measure-startup.ps1` | P3 代理    |
 * | 模块求值 → 编辑器视图建好 | 本模块             | P3 应用内    |
 * | 发起读章 → 正文灌入完成   | 本模块             | **P4 完整**  |
 *
 * P4 的两端都在应用内，同一个时钟，所以它是可以被完整测量的指标。
 * P3 应用内段刻意记的是「视图建好」而不是「能打字」：编辑器现在一直挂着，
 * 正文还在读时它已经存在但处于只读，把只读期间也算进去会让这个数
 * 与 P4 混在一起，看不出各自在测什么。
 *
 * ## 为什么不写进 localStorage
 *
 * 埋点的读者是「正在跑基准的人」和「报 bug 的用户」，两种场景都在本次运行内。
 * 持久化会带来两个新问题：版本升级后读到旧数据、以及把性能数字留在
 * 用户磁盘上（它可能包含机器信息推断）。真要跨会话统计时再单独设计。
 */

/** 最近 N 次的样本数。超过就丢最旧的：基准只关心稳定性，不关心历史。 */
const RECENT_LIMIT = 20;

/** 当前记录的状态。全部只在本模块内可变，对外只给快照。 */
interface PerfState {
  /** 编辑器视图建好的时刻；未发生则为 null。 */
  editorReadyMs: number | null;
  /** 正在计时的章节 id（读章开始但还没灌完）。 */
  openStartedFor: string | null;
  /** 开始读章的时刻。 */
  openStartedMs: number | null;
  /** 最近一次「读章 → 灌入完成」的耗时。 */
  lastChapterOpenMs: number | null;
  /** 最近的若干次章节打开耗时。 */
  chapterOpens: number[];
}

/**
 * 本模块被求值的时刻，当作「应用内起点」。
 *
 * 刻意不用 `performance.now()` 的绝对值：那是从文档 timeOrigin 算起的，
 * 会把 HTML 解析与首屏资源的耗时也算进「启动到编辑器就绪」。
 * 用 `let` 是为了可测 —— {@link __resetPerfForTests} 会重设它，
 * 否则测试里的假时钟永远对不上一个在导入期就取好的常量。
 */
let origin = now();

const state: PerfState = {
  editorReadyMs: null,
  openStartedFor: null,
  openStartedMs: null,
  lastChapterOpenMs: null,
  chapterOpens: [],
};

/** `performance.now()` 的薄封装：测试里可以替换实现。 */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/** 记录「编辑器视图已经建好」。只认第一次，之后的重挂不算冷启动。 */
export function markEditorReady(): void {
  if (state.editorReadyMs !== null) return;
  state.editorReadyMs = now() - origin;
}

/** 开始为某一章计时读章。与 {@link finishChapterOpen} 成对出现。 */
export function startChapterOpen(chapterId: string): void {
  state.openStartedFor = chapterId;
  state.openStartedMs = now();
}

/**
 * 结束读章计时并记录耗时。
 *
 * id 不匹配或没有对应的开始时**静默忽略**：快速连续切章时
 * 先发起的请求可能后完成，把它的耗时记下来会污染 P4 的样本。
 * 宁可少一个样本，也不要一个错的样本。
 */
export function finishChapterOpen(chapterId: string): void {
  const started = state.openStartedMs;
  if (started === null || state.openStartedFor !== chapterId) return;
  const elapsed = now() - started;
  state.openStartedFor = null;
  state.openStartedMs = null;
  state.lastChapterOpenMs = elapsed;
  state.chapterOpens.push(elapsed);
  if (state.chapterOpens.length > RECENT_LIMIT) state.chapterOpens.shift();
}

/** 一次读取的快照，供界面与基准脚本消费。 */
export interface PerfSnapshot {
  /** 模块求值 → 编辑器视图建好（ms）；未发生为 null。 */
  readonly editorReadyMs: number | null;
  /** 最近一次打开章节的耗时（ms）；没有为 null。 */
  readonly lastChapterOpenMs: number | null;
  /** 最近若干次打开章节的耗时，按时间顺序。 */
  readonly chapterOpens: readonly number[];
  /** 上述样本的中位数；无样本为 null。基准用它，不用均值 —— 一次 GC 就能拉歪均值。 */
  readonly medianChapterOpenMs: number | null;
}

/** 取当前快照。 */
export function perfSnapshot(): PerfSnapshot {
  return {
    editorReadyMs: state.editorReadyMs,
    lastChapterOpenMs: state.lastChapterOpenMs,
    chapterOpens: [...state.chapterOpens],
    medianChapterOpenMs: median(state.chapterOpens),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * 清空白盒状态。
 *
 * 只给测试用：`origin` 是模块级常量，所以跨用例复用同一份模块实例时，
 * 「第一次编辑器就绪」会被后面的用例读到前面用例留下的值。
 */
export function __resetPerfForTests(): void {
  origin = now();
  state.editorReadyMs = null;
  state.openStartedFor = null;
  state.openStartedMs = null;
  state.lastChapterOpenMs = null;
  state.chapterOpens = [];
}
