/**
 * 写作统计的前端数据模型与纯计算（T8.7 到 T8.13 的共用底座）。
 *
 * ## 为什么前端还要算一遍
 *
 * Rust 侧的 `yuhua-stats` 已经算好了 `Summary`、色阶与分档。前端**默认
 * 直接用后端的结果**（`getStatsSummary` 返回现成的数组），本文件负责另外两件事：
 *
 * 1. **网格摆放**：把「日期 -> 字数」折成 SVG 需要的坐标数组。这一层
 *    与日期库、DOM 都无关，是纯函数，因此可以脱离浏览器单元测试。
 * 2. **降级**：后端还没实现 `get_stats_summary` 时（Rust 命令层仍在演进），
 *    前端从已有的按天记录自行折算，保证界面不空转。
 *
 * ## 日期一律用本地日历
 *
 * 阅读统计的人永远在本地时区里看「今天」。所以这里所有「今天是几号」
 * 都走 `new Date()` 的本地分量，而不是 `toISOString()` —— 后者在东八区
 * 会把 8 月 1 日 0 点 30 分算成 7 月 31 日，日历上就错一格。
 */

/** 一天的毫秒数。 */
export const MS_PER_DAY = 86_400_000;

/** 热力图色阶档数，与 Rust 侧 `HEATMAP_LEVELS` 一致。 */
export const HEAT_LEVELS = 5;

/** 把 Date 归一化成 `YYYY-MM-DD`（本地日历）。 */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 取今天的日期键。 */
export function todayKey(now: Date = new Date()): string {
  return dayKey(now);
}

/** 由日期键解析出本地时间戳（当天 0 点）。格式不符时返回 NaN。 */
export function parseDayKey(key: string): number {
  const parts = key.split("-");
  if (parts.length !== 3) return Number.NaN;
  const [y, m, d] = parts;
  if (y === undefined || m === undefined || d === undefined) return Number.NaN;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  )
    return Number.NaN;
  return new Date(year, month - 1, day).getTime();
}

/** 在日期键上加减天数（跨月跨年由 Date 自己处理）。 */
export function shiftDay(key: string, deltaDays: number): string {
  const base = parseDayKey(key);
  if (Number.isNaN(base)) return key;
  const d = new Date(base);
  d.setDate(d.getDate() + deltaDays);
  return dayKey(d);
}

/** 月份键，形如 2026-01。 */
export interface MonthKey {
  /** 年。 */
  year: number;
  /** 月，1 到 12。 */
  month: number;
}

/** 由任意日期键取所属月份。 */
export function monthOf(key: string): MonthKey {
  const parts = key.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    month < 1 ||
    month > 12
  ) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }
  return { year, month };
}

/** 月份键转字符串，形如 `2026-01`。 */
export function monthLabel(key: MonthKey): string {
  return `${key.year}-${String(key.month).padStart(2, "0")}`;
}

/** 月份加减。 */
export function shiftMonth(key: MonthKey, delta: number): MonthKey {
  // 用 Date 做算术而不是手写进位：12 月加一等于次年 1 月这种事只该写对一次
  const d = new Date(key.year, key.month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/** 某年某月的天数。 */
export function daysInMonth(year: number, month: number): number {
  // 下个月的第 0 天就是本月最后一天，不用记闰年表
  return new Date(year, month, 0).getDate();
}

/** 某个日期键是星期几（0 为周一，6 为周日）。 */
export function weekdayIndex(key: string): number {
  const ts = parseDayKey(key);
  if (Number.isNaN(ts)) return 0;
  // getDay() 里 0 是周日，这里换算成周一为 0 的口径，与热力图的行序一致
  return (new Date(ts).getDay() + 6) % 7;
}

// ---------------------------------------------------------------------------
// 按天记录
// ---------------------------------------------------------------------------

/** 某一天的统计记录。 */
export interface DayEntry {
  /** 日期键 YYYY-MM-DD。 */
  date: string;
  /** 当日新增字数。 */
  words: number;
  /** 当日累计写作时长（分钟）。 */
  minutes: number;
  /** 当日涉及的章节数。 */
  chapters: number;
}

/**
 * 日期键到记录的映射。
 *
 * 用普通对象而不是 Map：它需要被序列化到 localStorage（目标与阈值），
 * 且所有遍历都要稳定顺序，普通对象配合显式排序更直观。
 */
export type DayMap = Record<string, DayEntry>;

/** 安全取某天的记录（缺失时给零值，调用方不必到处判空）。 */
export function dayEntry(days: DayMap, key: string): DayEntry {
  return days[key] ?? { date: key, words: 0, minutes: 0, chapters: 0 };
}

/** 某天写了多少字。 */
export function wordsOn(days: DayMap, key: string): number {
  return days[key]?.words ?? 0;
}

// ---------------------------------------------------------------------------
// 色阶（T8.8）
// ---------------------------------------------------------------------------

/**
 * 分位数色阶。
 *
 * 与 Rust 侧 `heatmap::build_scale` 同构：把非零样本升序排列，
 * 取 20/40/60/80 分位作为第 1 到 4 档的下界，并保证严格递增
 * （样本大量重复时分位数会撞在一起，撞了就逐档抬一）。
 */
export function buildThresholds(samples: readonly number[]): number[] {
  const nonzero = samples.filter((w) => w > 0).sort((a, b) => a - b);
  const thresholds = new Array<number>(HEAT_LEVELS).fill(0);
  if (nonzero.length === 0) return thresholds;

  const count = nonzero.length;
  for (let level = 1; level < HEAT_LEVELS; level += 1) {
    const position = Math.floor((count * level) / HEAT_LEVELS);
    thresholds[level] = nonzero[Math.min(position, count - 1)] ?? 0;
  }
  for (let level = 1; level < thresholds.length; level += 1) {
    const previous = thresholds[level - 1] ?? 0;
    const current = thresholds[level] ?? 0;
    if (current <= previous) thresholds[level] = previous + 1;
  }
  return thresholds;
}

/** 把字数映射到 0..4 档。 */
export function levelOf(
  words: number,
  thresholds: readonly number[],
  hasSamples = true,
): number {
  if (!hasSamples || !Number.isFinite(words) || words <= 0) return 0;
  let level = 0;
  for (let i = 0; i < thresholds.length; i += 1) {
    if (words >= (thresholds[i] ?? 0)) level = i;
  }
  return Math.min(Math.max(level, 0), HEAT_LEVELS - 1);
}

/** 色阶图例的一条。 */
export interface LegendEntry {
  /** 档位 0..4。 */
  level: number;
  /** 该档的下界字数。 */
  from: number;
}

/** 由阈值生成图例。 */
export function legendFromThresholds(
  thresholds: readonly number[],
): LegendEntry[] {
  return thresholds.map((from, level) => ({ level, from }));
}

// ---------------------------------------------------------------------------
// 汇总（T8.6 的前端降级实现）
// ---------------------------------------------------------------------------

/** 汇总结果。字段与 Rust 侧 `Summary` 一一对应。 */
export interface StatsSummary {
  /** 全部历史累计字数。 */
  totalWords: number;
  /** 本月字数。 */
  thisMonth: number;
  /** 本周字数（周一起算）。 */
  thisWeek: number;
  /** 今日字数。 */
  today: number;
  /** 有记录的天数。 */
  activeDays: number;
  /** 近 7 个自然日的平均日更（分母恒为 7）。 */
  averagePerDay7: number;
  /** 最高单日字数。 */
  bestDay: number;
  /** 最高单日是哪一天。 */
  bestDayDate: string | null;
  /** 累计写作时长（分钟）。 */
  totalMinutes: number;
  /** 连续码字天数。 */
  streak: number;
  /** 计算连续天数用的阈值。 */
  streakThreshold: number;
  /** 预计完稿日（无法估算时为 null）。 */
  estimatedCompletion: string | null;
  /** 预计还需多少天。 */
  remainingDays: number | null;
}

/** 取某一天所在周的周一。 */
export function weekStart(key: string): string {
  return shiftDay(key, -weekdayIndex(key));
}

/**
 * 计算连续码字天数。
 *
 * 规则与 Rust 侧 `count_streak` 完全一致：
 * 1. 当日字数达到阈值才算「写了」
 * 2. **今天还没写不算断**：从昨天开始往前数
 * 3. 今天与昨天都不达标即停止
 */
export function countStreak(
  days: DayMap,
  today: string,
  threshold: number,
): number {
  const reached = (key: string): boolean => wordsOn(days, key) >= threshold;
  let cursor = reached(today) ? today : shiftDay(today, -1);
  let streak = 0;
  // 上限 10000 天：数据被改坏时也不至于死循环
  for (let guard = 0; guard < 10_000; guard += 1) {
    if (!reached(cursor)) break;
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

/** 近 N 个自然日的平均日更。分母恒为 N（自然日），不是「有写字的天数」。 */
export function averageOverWindow(
  days: DayMap,
  end: string,
  length: number,
): number {
  if (length <= 0) return 0;
  let sum = 0;
  for (let i = length - 1; i >= 0; i -= 1) {
    sum += wordsOn(days, shiftDay(end, -i));
  }
  return Math.floor(sum / length);
}

/**
 * 预计完稿日。
 *
 * 三种返回 null 的情形（与 Rust 侧一致）：没有总目标、已经达成、
 * 以及近 7 日平均为 0（不能除零）。
 */
export function estimateCompletion(
  totalWords: number,
  totalTarget: number | null,
  averagePerDay7: number,
  today: string,
): { date: string | null; remainingDays: number | null } {
  if (totalTarget === null || totalTarget <= 0)
    return { date: null, remainingDays: null };
  const remaining = Math.max(0, totalTarget - totalWords);
  if (remaining === 0) return { date: null, remainingDays: 0 };
  if (averagePerDay7 <= 0) return { date: null, remainingDays: null };
  const days = Math.ceil(remaining / averagePerDay7);
  // 天数过大时日期会溢出到荒谬的年份，此时宁可返回 null
  if (days > 36_500) return { date: null, remainingDays: days };
  return { date: shiftDay(today, days), remainingDays: days };
}

/** 汇总选项。 */
export interface SummarizeOptions {
  /** 今天（日期键）。测试必须显式传入，界面才该用 todayKey()。 */
  today: string;
  /** 连续天数阈值。 */
  streakThreshold: number;
  /** 全书目标字数；不传则不估算完稿日。 */
  totalTarget?: number | null;
}

/**
 * 由按天记录折算汇总。
 *
 * 这是**降级路径**：优先使用后端 `getStatsSummary` 的返回值，
 * 只有当后端还没有该命令时才走这里。两条路径的字段名完全一致，
 * 因此界面代码不需要知道自己在用哪一条。
 */
export function summarize(
  days: DayMap,
  options: SummarizeOptions,
): StatsSummary {
  const { today, streakThreshold } = options;
  const totalTarget = options.totalTarget ?? null;
  const month = monthOf(today);
  const week = weekStart(today);
  const weekEnd = shiftDay(week, 7);

  let totalWords = 0;
  let totalMinutes = 0;
  let activeDays = 0;
  let thisMonth = 0;
  let thisWeek = 0;
  let bestDay = 0;
  let bestDayDate: string | null = null;

  // 遍历排序后的键，保证「最高单日并列取更早的一天」这条稳定规则可复现
  for (const key of Object.keys(days).sort()) {
    const entry = days[key];
    if (!entry) continue;
    totalWords += entry.words;
    totalMinutes += entry.minutes;
    if (entry.words > 0) activeDays += 1;
    if (entry.words > bestDay) {
      bestDay = entry.words;
      bestDayDate = key;
    }
    const keyMonth = monthOf(key);
    if (keyMonth.year === month.year && keyMonth.month === month.month)
      thisMonth += entry.words;
    if (key >= week && key < weekEnd) thisWeek += entry.words;
  }

  const averagePerDay7 = averageOverWindow(days, today, 7);
  const estimate = estimateCompletion(
    totalWords,
    totalTarget,
    averagePerDay7,
    today,
  );

  return {
    totalWords,
    thisMonth,
    thisWeek,
    today: wordsOn(days, today),
    activeDays,
    averagePerDay7,
    bestDay,
    bestDayDate,
    totalMinutes,
    streak: countStreak(days, today, streakThreshold),
    streakThreshold,
    estimatedCompletion: estimate.date,
    remainingDays: estimate.remainingDays,
  };
}

// ---------------------------------------------------------------------------
// 网格摆放（T8.7 / T8.8）
// ---------------------------------------------------------------------------

/** 一个网格格子。 */
export interface GridCell {
  /** 日期键 YYYY-MM-DD。 */
  date: string;
  /** 当日字数。 */
  words: number;
  /** 色阶档位 0..4。 */
  level: number;
  /** 是否属于本次渲染的月份 / 年份（前后补位格为 false）。 */
  inRange: boolean;
  /** 列下标（月历为星期，热力图为周）。 */
  column: number;
  /** 行下标（月历为周，热力图为星期）。 */
  row: number;
}

/**
 * 月历网格：7 列 × 6 行，共 42 格。
 *
 * 固定 6 行而不是按月份裁到 5 行：切月时高度不跳动（计划书 5.5）。
 * 首格是本月 1 号所在周的周一，因此会带上上月末的几天。
 */
export function monthGrid(
  days: DayMap,
  key: MonthKey,
  thresholds: readonly number[],
  hasSamples: boolean,
): GridCell[] {
  const first = dayKey(new Date(key.year, key.month - 1, 1));
  const daysInThis = daysInMonth(key.year, key.month);
  const gridStart = weekStart(first);
  const cells: GridCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const date = shiftDay(gridStart, i);
    const words = wordsOn(days, date);
    const dayOfMonth = Number(date.split("-")[2]);
    cells.push({
      date,
      words,
      level: levelOf(words, thresholds, hasSamples),
      inRange:
        date >= first &&
        dayOfMonth <= daysInThis &&
        monthOf(date).month === key.month &&
        monthOf(date).year === key.year,
      column: i % 7,
      row: Math.floor(i / 7),
    });
  }
  return cells;
}

/**
 * 年热力图网格：53 列 × 7 行，共 371 格。
 *
 * 首列是 1 月 1 日所在周的周一，因此首尾可能属于相邻年份，
 * 用 inRange 标出来由渲染层淡化。**一年 365（或 366）格全部在同一个
 * SVG 里**，逐格不做动画（计划书 T8.9）。
 */
export function yearGrid(
  days: DayMap,
  year: number,
  thresholds: readonly number[],
  hasSamples: boolean,
): GridCell[] {
  const jan1 = dayKey(new Date(year, 0, 1));
  const gridStart = weekStart(jan1);
  const cells: GridCell[] = [];
  for (let i = 0; i < 371; i += 1) {
    const date = shiftDay(gridStart, i);
    const words = wordsOn(days, date);
    cells.push({
      date,
      words,
      level: levelOf(words, thresholds, hasSamples),
      inRange: Number(date.slice(0, 4)) === year,
      column: Math.floor(i / 7),
      row: i % 7,
    });
  }
  return cells;
}

/** 一段区间的汇总，供热力图页眉使用。 */
export interface RangeSummary {
  /** 区间总字数。 */
  totalWords: number;
  /** 有产出的天数。 */
  activeDays: number;
  /** 最高单日。 */
  bestDay: number;
}

/** 汇总网格内的数据。 */
export function summarizeCells(cells: readonly GridCell[]): RangeSummary {
  let totalWords = 0;
  let activeDays = 0;
  let bestDay = 0;
  for (const cell of cells) {
    if (!cell.inRange) continue;
    totalWords += cell.words;
    if (cell.words > 0) activeDays += 1;
    if (cell.words > bestDay) bestDay = cell.words;
  }
  return { totalWords, activeDays, bestDay };
}

// ---------------------------------------------------------------------------
// 目标（T8.11）
// ---------------------------------------------------------------------------

/** 目标设置。 */
export interface GoalConfig {
  /** 每日目标字数，0 表示不限制。 */
  daily: number;
  /** 每周目标字数，0 表示不限制。 */
  weekly: number;
  /** 连续天数阈值。 */
  streakThreshold: number;
}

/** 默认目标：每天 2000 字，阈值取与 Rust 侧一致的 100。 */
export const DEFAULT_GOAL: GoalConfig = {
  daily: 2000,
  weekly: 12_000,
  streakThreshold: 100,
};

/** 目标字数的合法上限。再高就不是「目标」而是「许愿」了。 */
export const GOAL_MAX = 1_000_000;

/** 校验一个目标值。返回 null 表示合法，否则返回错误码。 */
export function validateGoal(
  raw: string,
): "empty" | "notANumber" | "outOfRange" | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "empty";
  // 只接受十进制整数：允许 "1e3" 或 "0x10" 会让用户以为软件在装聪明
  if (!/^\d+$/.test(trimmed)) return "notANumber";
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > GOAL_MAX) return "outOfRange";
  return null;
}

/** 达成率（0 起，可超过 1）；分母为 0 时返回 null。 */
export function ratio(done: number, target: number): number | null {
  if (!Number.isFinite(target) || target <= 0) return null;
  return done / target;
}

// ---------------------------------------------------------------------------
// 分章 / 分卷（T8.12）
// ---------------------------------------------------------------------------

/** 一行统计。 */
export interface BreakdownRow {
  /** 实体 ID。 */
  id: string;
  /** 显示名（卷名或章名）。 */
  label: string;
  /** 字数。 */
  words: number;
  /** 目标字数（0 表示未设置）。 */
  goal: number;
  /** 占总量的比例 0..1。 */
  share: number;
  /** 层级：0 为卷，1 为章。 */
  depth: 0 | 1;
}

/** 分卷分章视图的一行输入。 */
export interface BreakdownInput {
  /** 卷 ID。 */
  volumeId: string;
  /** 卷名。 */
  volumeTitle: string;
  /** 本卷总字数。 */
  volumeWords: number;
  /** 本卷章节。 */
  chapters: Array<{ id: string; title: string; words: number; goal: number }>;
}

/**
 * 把卷章结构摊平成带占比的行列表。
 *
 * 占比的分母是**全书合计**而不是本卷合计：分章视图与分卷视图
 * 共用同一根横轴的刻度，条形长度才可以直接比较 ——
 * 若分章用本卷做分母，一个 50 字的小章会画出和整卷一样长的条。
 */
export function breakdownRows(
  volumes: readonly BreakdownInput[],
  limit = 200,
): BreakdownRow[] {
  const total = volumes.reduce((sum, v) => sum + v.volumeWords, 0);
  const safeTotal = total > 0 ? total : 1;
  const rows: BreakdownRow[] = [];
  for (const volume of volumes) {
    rows.push({
      id: volume.volumeId,
      label: volume.volumeTitle,
      words: volume.volumeWords,
      goal: 0,
      share: volume.volumeWords / safeTotal,
      depth: 0,
    });
    for (const chapter of volume.chapters) {
      if (rows.length >= limit) return rows;
      rows.push({
        id: chapter.id,
        label: chapter.title,
        words: chapter.words,
        goal: chapter.goal,
        share: chapter.words / safeTotal,
        depth: 1,
      });
    }
  }
  return rows;
}

/** 环形进度环的几何。 */
export interface RingGeometry {
  /** stroke-dasharray。 */
  dashArray: string;
  /** 周长。 */
  circumference: number;
}

/** 计算进度环的 dasharray。半径非法时给零周长而不是 NaN。 */
export function progressRing(radius: number, progress: number): RingGeometry {
  const r = Math.max(Number.isFinite(radius) ? radius : 0, 0);
  const circumference = 2 * Math.PI * r;
  const clamped = Number.isFinite(progress)
    ? Math.min(Math.max(progress, 0), 1)
    : 0;
  const dash = circumference * clamped;
  return { dashArray: `${dash} ${circumference - dash}`, circumference };
}

/** 把分钟数折成「X 小时 Y 分钟」。 */
export function formatMinutes(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0 分钟";
  const rounded = Math.round(total);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  if (hours === 0) return `${minutes} 分钟`;
  if (minutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分钟`;
}
