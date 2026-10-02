/**
 * 写作统计的纯函数测试（T8.7 到 T8.13）。
 *
 * ## 为什么这批测试值得写
 *
 * 日历与热力图的正确性几乎完全落在日期运算上，而日期运算是
 * **最容易写错又最难肉眼发现**的一类代码：闰年、跨月、跨年、
 * 周一为起始日、时区……任何一个错了，界面上都只是"某一格颜色不对"，
 * 不盯着看根本发现不了。
 *
 * 因此这里把每一个边界都钉死：闰年的 2 月、1 月 1 日不在周一、
 * 12 月 31 日不在周日、连续天数的三种断法。
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_GOAL,
  GOAL_MAX,
  averageOverWindow,
  breakdownRows,
  buildThresholds,
  countStreak,
  dayKey,
  daysInMonth,
  estimateCompletion,
  formatMinutes,
  levelOf,
  monthGrid,
  monthLabel,
  monthOf,
  parseDayKey,
  progressRing,
  ratio,
  shiftDay,
  shiftMonth,
  summarize,
  summarizeCells,
  validateGoal,
  weekStart,
  weekdayIndex,
  yearGrid,
  type DayMap,
} from "./model";

/** 造一份按天记录。 */
function days(entries: Array<[string, number]>): DayMap {
  const map: DayMap = {};
  for (const [date, words] of entries) {
    map[date] = {
      date,
      words,
      minutes: Math.max(1, Math.round(words / 30)),
      chapters: words > 0 ? 1 : 0,
    };
  }
  return map;
}

describe("日期运算", () => {
  it("dayKey 用本地日历而不是 UTC", () => {
    // 用本地构造的日期：toISOString 在东八区会把 0 点算成前一天
    const date = new Date(2026, 0, 5, 0, 30);
    expect(dayKey(date)).toBe("2026-01-05");
  });

  it("parseDayKey 与 dayKey 互逆", () => {
    expect(dayKey(new Date(parseDayKey("2026-03-09")))).toBe("2026-03-09");
  });

  it("parseDayKey 对坏输入返回 NaN", () => {
    expect(Number.isNaN(parseDayKey("2026/03/09"))).toBe(true);
    expect(Number.isNaN(parseDayKey("2026-03"))).toBe(true);
    expect(Number.isNaN(parseDayKey("abcd-01-01"))).toBe(true);
  });

  it("shiftDay 跨月跨年都正确", () => {
    expect(shiftDay("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("闰年的 2 月有 29 天", () => {
    expect(shiftDay("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDay("2024-02-29", 1)).toBe("2024-03-01");
    expect(shiftDay("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("daysInMonth 覆盖闰年与非闰年", () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it("weekdayIndex 以周一为 0", () => {
    // 2026-01-05 是周一，2026-01-11 是周日
    expect(weekdayIndex("2026-01-05")).toBe(0);
    expect(weekdayIndex("2026-01-11")).toBe(6);
    expect(weekdayIndex("2026-01-08")).toBe(3);
  });

  it("weekStart 取所在周的周一", () => {
    expect(weekStart("2026-01-08")).toBe("2026-01-05");
    expect(weekStart("2026-01-05")).toBe("2026-01-05");
    expect(weekStart("2026-01-11")).toBe("2026-01-05");
    expect(weekStart("2026-01-12")).toBe("2026-01-12");
  });

  it("monthOf 与 monthLabel 互逆", () => {
    expect(monthOf("2026-07-15")).toEqual({ year: 2026, month: 7 });
    expect(monthLabel({ year: 2026, month: 7 })).toBe("2026-07");
    expect(monthLabel({ year: 2026, month: 12 })).toBe("2026-12");
  });

  it("shiftMonth 在年边界上正确进位", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({
      year: 2027,
      month: 1,
    });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
    });
    // 3 月 31 日加一个月不该变成 4 月 31 日（Date 会滚动到 5 月 1 日），
    // 因此实现里用的是「当月 1 号」做算术
    expect(shiftMonth({ year: 2026, month: 1 }, 1)).toEqual({
      year: 2026,
      month: 2,
    });
  });
});

describe("色阶分档", () => {
  it("没有样本时全部是 0 档", () => {
    const thresholds = buildThresholds([]);
    expect(thresholds).toHaveLength(5);
    expect(thresholds.every((t) => t === 0)).toBe(true);
    expect(levelOf(5000, thresholds, false)).toBe(0);
  });

  it("第 0 档下界恒为 0", () => {
    expect(buildThresholds([100, 200, 300])[0]).toBe(0);
    expect(levelOf(0, buildThresholds([100]))).toBe(0);
  });

  it("各档下界严格递增（样本重复时也不会撞车）", () => {
    const thresholds = buildThresholds([100, 100, 100, 100, 100]);
    for (let i = 1; i < thresholds.length; i += 1) {
      expect(thresholds[i]!).toBeGreaterThan(thresholds[i - 1]!);
    }
  });

  it("日常量级落在中间档，爆发日落在最高档", () => {
    const thresholds = buildThresholds([
      200, 300, 400, 500, 600, 700, 800, 1000, 10_000,
    ]);
    const daily = levelOf(400, thresholds);
    expect(daily).toBeGreaterThanOrEqual(1);
    expect(levelOf(10_000, thresholds)).toBeGreaterThan(daily);
  });

  it("档位始终落在 0..4", () => {
    const thresholds = buildThresholds([10, 20, 30]);
    for (const words of [0, 1, 99, 5000, Number.MAX_SAFE_INTEGER]) {
      const level = levelOf(words, thresholds);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(4);
    }
  });
});

describe("连续天数（T8.10）", () => {
  const threshold = 100;

  it("连续五天计数为 5", () => {
    const map = days([
      ["2026-01-11", 500],
      ["2026-01-12", 500],
      ["2026-01-13", 500],
      ["2026-01-14", 500],
      ["2026-01-15", 500],
    ]);
    expect(countStreak(map, "2026-01-15", threshold)).toBe(5);
  });

  it("今天还没写不算断（从昨天继续数）", () => {
    const map = days([
      ["2026-01-13", 500],
      ["2026-01-14", 500],
    ]);
    expect(countStreak(map, "2026-01-15", threshold)).toBe(2);
  });

  it("昨天与今天都没写才算断", () => {
    const map = days([
      ["2026-01-12", 500],
      ["2026-01-13", 500],
    ]);
    expect(countStreak(map, "2026-01-15", threshold)).toBe(0);
  });

  it("中途断一天就从断点截断", () => {
    const map = days([
      ["2026-01-09", 500],
      ["2026-01-12", 500],
      ["2026-01-13", 500],
      ["2026-01-14", 500],
      ["2026-01-15", 500],
    ]);
    expect(countStreak(map, "2026-01-15", threshold)).toBe(4);
  });

  it("阈值下不达标的日子不算数", () => {
    const map = days([
      ["2026-01-14", 500],
      ["2026-01-15", 50],
    ]);
    expect(countStreak(map, "2026-01-15", threshold)).toBe(1);
    expect(countStreak(map, "2026-01-15", 10)).toBe(2);
  });

  it("恰好等于阈值算达标", () => {
    expect(countStreak(days([["2026-01-15", 100]]), "2026-01-15", 100)).toBe(1);
    expect(countStreak(days([["2026-01-15", 99]]), "2026-01-15", 100)).toBe(0);
  });

  it("空数据为 0 且不会死循环", () => {
    expect(countStreak({}, "2026-01-15", threshold)).toBe(0);
  });

  it("跨月连续也能数对", () => {
    const map = days([
      ["2026-01-30", 500],
      ["2026-01-31", 500],
      ["2026-02-01", 500],
    ]);
    expect(countStreak(map, "2026-02-01", threshold)).toBe(3);
  });
});

describe("汇总", () => {
  it("空数据全部为 0 且不除零", () => {
    const s = summarize({}, { today: "2026-01-15", streakThreshold: 100 });
    expect(s.totalWords).toBe(0);
    expect(s.activeDays).toBe(0);
    expect(s.averagePerDay7).toBe(0);
    expect(s.bestDay).toBe(0);
    expect(s.bestDayDate).toBeNull();
    expect(s.streak).toBe(0);
  });

  it("本月与本周各自限定范围", () => {
    const map = days([
      ["2025-12-20", 777],
      ["2026-01-01", 100],
      ["2026-01-12", 200],
      ["2026-01-15", 300],
      ["2026-01-18", 400],
      ["2026-01-19", 999],
    ]);
    // 2026-01-15 是周四，本周为 01-12 到 01-18
    const s = summarize(map, { today: "2026-01-15", streakThreshold: 100 });
    expect(s.thisMonth).toBe(100 + 200 + 300 + 400 + 999);
    expect(s.thisWeek).toBe(200 + 300 + 400);
    expect(s.today).toBe(300);
    expect(s.totalWords).toBe(777 + 100 + 200 + 300 + 400 + 999);
  });

  it("近 7 日平均的分母恒为 7（自然日）", () => {
    // 一周只写了一天 7000 字：平均日更是 1000，不是 7000
    const map = days([["2026-01-15", 7000]]);
    expect(averageOverWindow(map, "2026-01-15", 7)).toBe(1000);
  });

  it("窗口长度为 0 或负数时返回 0", () => {
    expect(
      averageOverWindow(days([["2026-01-15", 700]]), "2026-01-15", 0),
    ).toBe(0);
    expect(
      averageOverWindow(days([["2026-01-15", 700]]), "2026-01-15", -3),
    ).toBe(0);
  });

  it("最高单日并列时取更早的一天（结果稳定）", () => {
    const map = days([
      ["2026-01-10", 1000],
      ["2026-01-11", 1000],
    ]);
    const s = summarize(map, { today: "2026-01-11", streakThreshold: 100 });
    expect(s.bestDayDate).toBe("2026-01-10");
  });

  it("累计时长来自各天之和", () => {
    const map = days([
      ["2026-01-14", 900],
      ["2026-01-15", 600],
    ]);
    const s = summarize(map, { today: "2026-01-15", streakThreshold: 100 });
    expect(s.totalMinutes).toBe(30 + 20);
  });
});

describe("预计完稿日", () => {
  it("没有总目标时不猜", () => {
    expect(estimateCompletion(10_000, null, 1000, "2026-01-15")).toEqual({
      date: null,
      remainingDays: null,
    });
  });

  it("平均日更为 0 时返回 null 而不是除零", () => {
    expect(estimateCompletion(0, 100_000, 0, "2026-01-15")).toEqual({
      date: null,
      remainingDays: null,
    });
  });

  it("已达成时不再给日期", () => {
    expect(estimateCompletion(100_000, 100_000, 2000, "2026-01-15")).toEqual({
      date: null,
      remainingDays: 0,
    });
  });

  it("剩余天数向上取整", () => {
    // 还剩 80000 字，日更 2000：40 天
    expect(estimateCompletion(20_000, 100_000, 2000, "2026-01-15")).toEqual({
      date: "2026-02-24",
      remainingDays: 40,
    });
    // 还剩 3 字，日更 2：需要 2 天
    expect(estimateCompletion(97, 100, 2, "2026-01-15").remainingDays).toBe(2);
  });

  it("跨年也算得对", () => {
    expect(estimateCompletion(0, 3100, 100, "2026-12-25")).toEqual({
      date: "2027-01-25",
      remainingDays: 31,
    });
  });

  it("荒谬的远期不给出年份", () => {
    const result = estimateCompletion(0, 100_000_000, 1, "2026-01-15");
    expect(result.remainingDays).toBe(100_000_000);
    expect(result.date).toBeNull();
  });
});

describe("网格摆放", () => {
  it("月历固定 42 格、7 列 6 行", () => {
    const cells = monthGrid(
      {},
      { year: 2026, month: 1 },
      buildThresholds([]),
      false,
    );
    expect(cells).toHaveLength(42);
    expect(Math.max(...cells.map((c) => c.column))).toBe(6);
    expect(Math.max(...cells.map((c) => c.row))).toBe(5);
  });

  it("月历首格是本月 1 号所在周的周一", () => {
    // 2026-01-01 是周四，因此首格是 2025-12-29（周一）
    const cells = monthGrid(
      {},
      { year: 2026, month: 1 },
      buildThresholds([]),
      false,
    );
    expect(cells[0]!.date).toBe("2025-12-29");
    expect(weekdayIndex(cells[0]!.date)).toBe(0);
  });

  it("月历恰好标出本月的天数", () => {
    const jan = monthGrid(
      {},
      { year: 2026, month: 1 },
      buildThresholds([]),
      false,
    );
    expect(jan.filter((c) => c.inRange)).toHaveLength(31);
    const feb = monthGrid(
      {},
      { year: 2024, month: 2 },
      buildThresholds([]),
      false,
    );
    expect(feb.filter((c) => c.inRange)).toHaveLength(29);
  });

  it("月历相邻格严格相差一天", () => {
    const cells = monthGrid(
      {},
      { year: 2026, month: 3 },
      buildThresholds([]),
      false,
    );
    for (let i = 1; i < cells.length; i += 1) {
      expect(shiftDay(cells[i - 1]!.date, 1)).toBe(cells[i]!.date);
    }
  });

  it("月历带上数据与档位", () => {
    const map = days([
      ["2026-01-06", 8000],
      ["2026-01-07", 100],
    ]);
    const thresholds = buildThresholds([100, 8000]);
    const cells = monthGrid(map, { year: 2026, month: 1 }, thresholds, true);
    const big = cells.find((c) => c.date === "2026-01-06");
    const small = cells.find((c) => c.date === "2026-01-07");
    expect(big?.words).toBe(8000);
    expect(small?.words).toBe(100);
    expect(big!.level).toBeGreaterThan(small!.level);
  });

  it("月历的补位格带真实字数但不计入本月", () => {
    const map = days([["2025-12-29", 999]]);
    const cells = monthGrid(
      map,
      { year: 2026, month: 1 },
      buildThresholds([999]),
      true,
    );
    const padding = cells.find((c) => c.date === "2025-12-29");
    expect(padding?.words).toBe(999);
    expect(padding?.inRange).toBe(false);
    expect(summarizeCells(cells).totalWords).toBe(0);
  });

  it("热力图固定 371 格、53 周 7 天", () => {
    const cells = yearGrid({}, 2026, buildThresholds([]), false);
    expect(cells).toHaveLength(371);
    expect(Math.max(...cells.map((c) => c.column))).toBe(52);
    expect(Math.max(...cells.map((c) => c.row))).toBe(6);
  });

  it("热力图覆盖整年 365 或 366 天", () => {
    expect(
      yearGrid({}, 2026, buildThresholds([]), false).filter((c) => c.inRange),
    ).toHaveLength(365);
    expect(
      yearGrid({}, 2024, buildThresholds([]), false).filter((c) => c.inRange),
    ).toHaveLength(366);
  });

  it("热力图首列是 1 月 1 日所在周的周一", () => {
    const cells = yearGrid({}, 2026, buildThresholds([]), false);
    expect(weekdayIndex(cells[0]!.date)).toBe(0);
    // 2026-01-01 是周四，首格应是 2025-12-29
    expect(cells[0]!.date).toBe("2025-12-29");
  });

  it("热力图的每一周都是完整的周一到周日", () => {
    const cells = yearGrid({}, 2026, buildThresholds([]), false);
    for (let week = 0; week < 53; week += 1) {
      const slice = cells.slice(week * 7, week * 7 + 7);
      expect(slice.map((c) => c.row)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(slice.map((c) => weekdayIndex(c.date))).toEqual([
        0, 1, 2, 3, 4, 5, 6,
      ]);
    }
  });

  it("热力图相邻格严格相差一天且无重复", () => {
    const cells = yearGrid({}, 2026, buildThresholds([]), false);
    const keys = cells.map((c) => c.date);
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 1; i < cells.length; i += 1) {
      expect(shiftDay(cells[i - 1]!.date, 1)).toBe(cells[i]!.date);
    }
  });

  it("summarizeCells 只统计 inRange 的格子", () => {
    const cells = yearGrid(
      days([["2026-03-01", 5000]]),
      2026,
      buildThresholds([5000]),
      true,
    );
    const summary = summarizeCells(cells);
    expect(summary.totalWords).toBe(5000);
    expect(summary.activeDays).toBe(1);
    expect(summary.bestDay).toBe(5000);
  });
});

describe("目标校验（T8.11）", () => {
  it("接受合法的十进制整数", () => {
    expect(validateGoal("2000")).toBeNull();
    expect(validateGoal("0")).toBeNull();
    expect(validateGoal(" 3000 ")).toBeNull();
    expect(validateGoal(String(GOAL_MAX))).toBeNull();
  });

  it("空串单独归类为 empty 而不是格式错误", () => {
    expect(validateGoal("")).toBe("empty");
    expect(validateGoal("   ")).toBe("empty");
  });

  it("拒绝小数、负数、科学计数法与十六进制", () => {
    expect(validateGoal("1.5")).toBe("notANumber");
    expect(validateGoal("-100")).toBe("notANumber");
    expect(validateGoal("1e3")).toBe("notANumber");
    expect(validateGoal("0x10")).toBe("notANumber");
    expect(validateGoal("两千")).toBe("notANumber");
  });

  it("超出上限会被拒绝", () => {
    expect(validateGoal(String(GOAL_MAX + 1))).toBe("outOfRange");
    expect(validateGoal("99999999999")).toBe("outOfRange");
  });

  it("默认目标合法且阈值与 Rust 侧一致", () => {
    expect(validateGoal(String(DEFAULT_GOAL.daily))).toBeNull();
    expect(DEFAULT_GOAL.streakThreshold).toBe(100);
  });
});

describe("达成率", () => {
  it("分母为 0 时返回 null 而不是除零", () => {
    expect(ratio(50, 0)).toBeNull();
    expect(ratio(50, Number.NaN)).toBeNull();
  });

  it("可超过 1", () => {
    expect(ratio(50, 100)).toBe(0.5);
    expect(ratio(200, 100)).toBe(2);
  });
});

describe("进度环几何", () => {
  it("满进度是一条完整实线", () => {
    const ring = progressRing(10, 1);
    expect(ring.circumference).toBeCloseTo(2 * Math.PI * 10, 5);
    expect(ring.dashArray).toBe(`${ring.circumference} 0`);
  });

  it("零进度全部留白", () => {
    const ring = progressRing(10, 0);
    expect(ring.dashArray).toBe(`0 ${ring.circumference}`);
  });

  it("超出范围会被夹紧", () => {
    expect(progressRing(10, 2).dashArray).toBe(progressRing(10, 1).dashArray);
    expect(progressRing(10, -1).dashArray).toBe(progressRing(10, 0).dashArray);
  });

  it("半径为 0 或负数时不产生 NaN", () => {
    expect(progressRing(0, 0.5).circumference).toBe(0);
    expect(progressRing(-5, 0.5).circumference).toBe(0);
    expect(progressRing(10, Number.NaN).dashArray).not.toContain("NaN");
  });
});

describe("分章分卷（T8.12）", () => {
  const input = [
    {
      volumeId: "v1",
      volumeTitle: "第一卷",
      volumeWords: 300,
      chapters: [
        { id: "c1", title: "第一章", words: 200, goal: 1000 },
        { id: "c2", title: "第二章", words: 100, goal: 0 },
      ],
    },
    {
      volumeId: "v2",
      volumeTitle: "第二卷",
      volumeWords: 700,
      chapters: [{ id: "c3", title: "第三章", words: 700, goal: 2000 }],
    },
  ];

  it("摊平成卷 + 章的层级行", () => {
    const rows = breakdownRows(input);
    expect(rows.map((r) => r.id)).toEqual(["v1", "c1", "c2", "v2", "c3"]);
    expect(rows[0]!.depth).toBe(0);
    expect(rows[1]!.depth).toBe(1);
  });

  it("占比的分母是全书合计（卷与章同一根轴）", () => {
    const rows = breakdownRows(input);
    expect(rows.find((r) => r.id === "v2")!.share).toBeCloseTo(0.7, 5);
    expect(rows.find((r) => r.id === "c3")!.share).toBeCloseTo(0.7, 5);
    expect(rows.find((r) => r.id === "c1")!.share).toBeCloseTo(0.2, 5);
  });

  it("空输入不会除零", () => {
    expect(breakdownRows([])).toEqual([]);
    const zero = breakdownRows([
      { volumeId: "v", volumeTitle: "空卷", volumeWords: 0, chapters: [] },
    ]);
    expect(zero[0]!.share).toBe(0);
  });

  it("limit 会截断行的数量", () => {
    expect(breakdownRows(input, 2)).toHaveLength(2);
  });

  it("保留每章的目标字数", () => {
    const rows = breakdownRows(input);
    expect(rows.find((r) => r.id === "c1")!.goal).toBe(1000);
    expect(rows.find((r) => r.id === "c2")!.goal).toBe(0);
  });
});

describe("时长格式化", () => {
  it("时分组合读起来自然", () => {
    expect(formatMinutes(0)).toBe("0 分钟");
    expect(formatMinutes(47)).toBe("47 分钟");
    expect(formatMinutes(60)).toBe("1 小时");
    expect(formatMinutes(121)).toBe("2 小时 1 分钟");
  });

  it("负数与非有限数是 0 分钟而不是 NaN", () => {
    expect(formatMinutes(-5)).toBe("0 分钟");
    expect(formatMinutes(Number.NaN)).toBe("0 分钟");
  });
});
