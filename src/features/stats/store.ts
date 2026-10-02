/**
 * 统计页的状态（T8.13 的信息架构落地处）。
 *
 * ## 数据从哪里来
 *
 * 两条路，按优先级：
 *
 * 1. `getStatsSummary()` —— 后端算好的一切（按天记录、汇总、色阶）。
 *    这是**正常情况下**的唯一来源，前端不做二次计算，避免两套口径漂移。
 * 2. 后端命令还不存在时（Rust 命令层仍在演进），降级成「没有统计记录」，
 *    界面显示诚实的空状态，而不是编造一份好看的假数据。
 *
 * ## 为什么目标存在 localStorage 而不是工作区
 *
 * 目标在一个人的不同作品之间往往一致（「每天两千字」是他的作息，
 * 不是某一本书的属性）。放进工作区会随云盘同步到另一台设备，
 * 而那台设备上的人可能正在写另一本。若将来需要「本书专属目标」，
 * 再在目标结构里加一个可选的覆盖层即可。
 */

import { createStore, produce } from "solid-js/store";

import * as ipc from "@/lib/ipc";
import {
  isFiniteNumber,
  isPlainObject,
  readJson,
  writeJson,
} from "@/app/persistent";
import {
  DEFAULT_GOAL,
  GOAL_MAX,
  buildThresholds,
  dayKey,
  monthOf,
  summarize,
  todayKey,
  type DayMap,
  type GoalConfig,
  type MonthKey,
  type StatsSummary,
} from "./model";

/** 统计页内的分区（T8.13 的导航）。 */
export type StatsSection =
  "overview" | "calendar" | "heatmap" | "goal" | "breakdown" | "privacy";

/** 分区顺序：与导航渲染顺序一致，测试会断言它包含全部取值。 */
export const STATS_SECTIONS: readonly StatsSection[] = [
  "overview",
  "calendar",
  "heatmap",
  "goal",
  "breakdown",
  "privacy",
] as const;

/** 统计状态形状。 */
export interface StatsState {
  /** 是否正在加载。 */
  loading: boolean;
  /** 加载失败的原因（已本地化的用户可见文本）。 */
  error: string | null;
  /** 当前分区。 */
  section: StatsSection;
  /** 日历当前月份。 */
  calendarMonth: MonthKey;
  /** 热力图当前年份。 */
  heatmapYear: number;
  /** 按天记录。 */
  days: DayMap;
  /** 汇总。 */
  summary: StatsSummary;
  /** 目标设置。 */
  goal: GoalConfig;
}

/** localStorage 键。 */
const GOAL_KEY = "stats.goal.v1";

/** 校验读回来的目标对象。 */
function validateGoal(value: unknown): value is Partial<GoalConfig> {
  return isPlainObject(value);
}

/** 把一个可能的输入夹到合法目标值。 */
function clampGoal(value: unknown, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  return Math.max(0, Math.min(GOAL_MAX, Math.round(value)));
}

/** 从 localStorage 读目标。任何一项不合法就退回默认值。 */
export function loadGoal(): GoalConfig {
  const raw = readJson<Partial<GoalConfig>>(GOAL_KEY, {}, validateGoal);
  return {
    daily: clampGoal(raw.daily, DEFAULT_GOAL.daily),
    weekly: clampGoal(raw.weekly, DEFAULT_GOAL.weekly),
    streakThreshold: clampGoal(
      raw.streakThreshold,
      DEFAULT_GOAL.streakThreshold,
    ),
  };
}

/** 写回 localStorage。 */
function persistGoal(goal: GoalConfig): void {
  writeJson(GOAL_KEY, goal);
}

/** 初始状态：默认停在本月的日历、当年热力图、总览分区。 */
export function initialState(now: Date = new Date()): StatsState {
  const today = dayKey(now);
  const goal = loadGoal();
  return {
    loading: false,
    error: null,
    section: "overview",
    calendarMonth: monthOf(today),
    heatmapYear: now.getFullYear(),
    days: {},
    summary: summarize({}, { today, streakThreshold: goal.streakThreshold }),
    goal,
  };
}

const [state, setState] = createStore<StatsState>(initialState());

export { state as statsState };

/** 直接暴露 setter：字段局部更新很多，包一层只会更啰嗦。 */
export const setStatsState = setState;

/** 重置为初始状态（测试用）。 */
export function __resetStatsState(now: Date = new Date()): void {
  setState(initialState(now));
}

// ---------------------------------------------------------------------------
// 载入
// ---------------------------------------------------------------------------

/**
 * 载入统计。
 *
 * 后端命令不存在时**不报错**：这是「功能尚未接通」而不是「出错了」，
 * 界面应该显示空状态让用户照常写作，而不是弹一条红色错误。
 * 真正的错误（IO / 数据库）才写进 error。
 */
export async function loadStats(): Promise<void> {
  setState({ loading: true, error: null });
  try {
    const payload = await ipc.getStatsSummary();
    // 数组折成对象：日历与热力图每格都要查一次，线性扫描 365 格会变成 O(n²)
    const days: DayMap = {};
    for (const day of payload.days) {
      days[day.date] = {
        date: day.date,
        words: day.words,
        minutes: day.minutes,
        chapters: day.chapters,
      };
    }
    setState(
      produce((s) => {
        s.loading = false;
        s.days = days;
        s.summary = { ...payload.summary };
      }),
    );
  } catch (err) {
    const failure = ipc.toFailure(err);
    // UNIMPLEMENTED 是预期的过渡状态，不当成失败
    if (failure.error.code === "UNIMPLEMENTED") {
      setState("loading", false);
      return;
    }
    setState({ loading: false, error: failure.error.message });
  }
}

/** 重新计算汇总（目标变了之后要重算，因为它影响连续天数与预计完稿）。 */
export function recomputeSummary(now: Date = new Date()): void {
  const today = todayKey(now);
  setState(
    "summary",
    summarize(state.days, {
      today,
      streakThreshold: state.goal.streakThreshold,
    }),
  );
}

// ---------------------------------------------------------------------------
// 导航
// ---------------------------------------------------------------------------

/** 切换分区。 */
export function setSection(section: StatsSection): void {
  setState("section", section);
}

/** 日历翻月。 */
export function shiftCalendarMonth(delta: number): void {
  setState("calendarMonth", (key) => {
    const d = new Date(key.year, key.month - 1 + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
}

/** 日历回到本月。 */
export function resetCalendarMonth(now: Date = new Date()): void {
  setState("calendarMonth", monthOf(dayKey(now)));
}

/** 热力图换年。 */
export function shiftHeatmapYear(delta: number): void {
  setState("heatmapYear", (year) =>
    Math.max(1970, Math.min(9999, year + delta)),
  );
}

// ---------------------------------------------------------------------------
// 目标（T8.11）
// ---------------------------------------------------------------------------

/** 保存目标。传入的值会先夹到合法区间。 */
export function saveGoal(next: Partial<GoalConfig>): void {
  const merged: GoalConfig = {
    daily: clampGoal(next.daily ?? state.goal.daily, state.goal.daily),
    weekly: clampGoal(next.weekly ?? state.goal.weekly, state.goal.weekly),
    streakThreshold: clampGoal(
      next.streakThreshold ?? state.goal.streakThreshold,
      state.goal.streakThreshold,
    ),
  };
  setState("goal", merged);
  persistGoal(merged);
  recomputeSummary();
}

// ---------------------------------------------------------------------------
// 供视图直接消费的派生数据
// ---------------------------------------------------------------------------

/**
 * 当前数据的色阶阈值。
 *
 * 用**当年**的样本而不是全量样本：热力图与日历各自算各自的档位，
 * 一张图里「深色 = 那天写得多」，跨图比较本来就不是这个视图的用途。
 */
export function thresholdsFor(samples: readonly number[]): {
  thresholds: number[];
  hasSamples: boolean;
} {
  const thresholds = buildThresholds(samples);
  return { thresholds, hasSamples: samples.some((w) => w > 0) };
}
