/**
 * SVG 图表基座测试（T1.13）。
 *
 * 几何计算的测试是好测试：断言的是确定的数字关系，
 * 不依赖渲染、不依赖快照，因此改版时不会因为一个像素的差异集体爆红。
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CALENDAR_CELLS,
  CALENDAR_COLUMNS,
  CALENDAR_ROWS,
  HEATMAP_CELLS,
  HEATMAP_DAYS,
  HEATMAP_WEEKS,
  HEAT_LEVELS,
  buildGrid,
  buildPalette,
  cellBox,
  crossHighlight,
  daysInMonth,
  formatCompact,
  formatDateKey,
  formatDateLabel,
  formatDuration,
  formatNumber,
  formatPercent,
  gridSize,
  heatColorFor,
  heatColors,
  heatLegendLabels,
  heatmapCellBox,
  isLeapYear,
  levelForWords,
  levelProbeValue,
  monthGrid,
  progressRing,
  rollSequence,
  startOfDay,
  weekdayIndex,
  weekdayLabel,
  yearHeatmapGrid,
} from "./index";

const here = dirname(fileURLToPath(import.meta.url));

describe("色阶映射", () => {
  it("提供 5 档预计算颜色", () => {
    expect(HEAT_LEVELS).toBe(5);
    for (const theme of ["light", "dark"] as const) {
      const palette = heatColors(theme);
      expect(palette).toHaveLength(HEAT_LEVELS);
      for (const color of palette) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("五个档位颜色互不相同", () => {
    for (const theme of ["light", "dark"] as const) {
      expect(new Set(heatColors(theme)).size).toBe(HEAT_LEVELS);
    }
  });

  it("亮暗主题给出不同色板", () => {
    expect(heatColors("light")).not.toEqual(heatColors("dark"));
  });

  it("色值与 tokens.css 的 --c-heat-* 完全一致", () => {
    // 这是最容易静默漂移的地方：TS 数组改了、CSS 变量没改，
    // 日历格子与图例就会显示成两种颜色。因此在这里钉死。
    const css = readFileSync(resolve(here, "..", "tokens.css"), "utf8");

    /** 从 CSS 的某个作用域块里取 5 档热力色。 */
    function heatFromCss(startMarker: string, endMarker: string): string[] {
      const start = css.indexOf(startMarker);
      const block = css.slice(start, css.indexOf(endMarker, start));
      return [0, 1, 2, 3, 4].map((i) => {
        const m = block.match(new RegExp(`--c-heat-${i}:\\s*(#[0-9a-f]{6})`, "i"));
        return m?.[1] ?? "";
      });
    }

    const light = heatFromCss(":root {", '[data-theme="dark"]');
    const dark = heatFromCss('[data-theme="dark"]', "@media (prefers-color-scheme");

    expect(light).toEqual([...heatColors("light")]);
    expect(dark).toEqual([...heatColors("dark")]);
  });

  describe("levelForWords", () => {
    it("0 字与负数都落在 0 档", () => {
      expect(levelForWords(0, 1000)).toBe(0);
      expect(levelForWords(-50, 1000)).toBe(0);
    });

    it("按完成率四档递进", () => {
      expect(levelForWords(100, 1000)).toBe(1);
      expect(levelForWords(400, 1000)).toBe(2);
      expect(levelForWords(800, 1000)).toBe(3);
      expect(levelForWords(1000, 1000)).toBe(4);
    });

    it("超出目标仍然封顶在 4 档", () => {
      expect(levelForWords(999_999, 1000)).toBe(4);
    });

    it("档位边界取闭区间下界", () => {
      expect(levelForWords(330, 1000)).toBe(2);
      expect(levelForWords(660, 1000)).toBe(3);
      expect(levelForWords(329, 1000)).toBe(1);
    });

    it("目标非法时退化为固定阈值而不是崩溃", () => {
      expect(levelForWords(50, 0)).toBe(1);
      expect(levelForWords(300, Number.NaN)).toBe(2);
      expect(levelForWords(2000, -100)).toBe(4);
    });

    it("非有限字数按 0 处理", () => {
      expect(levelForWords(Number.NaN, 1000)).toBe(0);
      expect(levelForWords(Number.POSITIVE_INFINITY, 1000)).toBe(0);
    });

    it("档位始终落在合法区间", () => {
      for (const words of [0, 1, 99, 500, 999, 1000, 5000]) {
        const level = levelForWords(words, 1000);
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(HEAT_LEVELS - 1);
      }
    });
  });

  describe("heatColorFor", () => {
    it("取到的颜色确实来自对应主题的色板", () => {
      const palette = heatColors("light");
      expect(heatColorFor(0, 1000)).toBe(palette[0]);
      expect(heatColorFor(1000, 1000)).toBe(palette[4]);
      expect(heatColorFor(500, 1000, "dark")).toBe(heatColors("dark")[2]);
    });

    it("字数越多颜色档位越高", () => {
      const palette = heatColors("light");
      const low = palette.indexOf(heatColorFor(100, 1000));
      const high = palette.indexOf(heatColorFor(1000, 1000));
      expect(high).toBeGreaterThan(low);
    });
  });

  describe("buildPalette", () => {
    it("生成的 5 档都落在同一主题色板内", () => {
      const palette = heatColors("light");
      const table = buildPalette(2000);
      expect(table).toHaveLength(HEAT_LEVELS);
      for (const color of table) {
        expect(palette).toContain(color);
      }
    });

    it("第一档为空白色，最后一档为达标色", () => {
      const table = buildPalette(2000);
      expect(table[0]).toBe(heatColors("light")[0]);
      expect(table[4]).toBe(heatColors("light")[4]);
    });

    it("档位序号越大颜色档位越高（单调）", () => {
      const palette = heatColors("light");
      const table = buildPalette(1000);
      let previous = -1;
      for (const color of table) {
        const index = palette.indexOf(color);
        expect(index).toBeGreaterThanOrEqual(previous);
        previous = index;
      }
    });

    it("levelProbeValue 取到的值确实落在对应档", () => {
      for (let level = 0; level < HEAT_LEVELS; level += 1) {
        expect(levelForWords(levelProbeValue(level, 1000), 1000)).toBe(level);
      }
    });

    it("目标非法时仍能生成完整色板", () => {
      expect(buildPalette(0)).toHaveLength(HEAT_LEVELS);
      expect(buildPalette(Number.NaN)).toHaveLength(HEAT_LEVELS);
    });
  });

  it("图例标签为 5 条中文说明", () => {
    const labels = heatLegendLabels();
    expect(labels).toHaveLength(HEAT_LEVELS);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });
});

describe("网格几何", () => {
  const opts = { cellSize: 10, gap: 2 };

  it("网格尺寸把间距算在内", () => {
    // 7 列：7*10 + 6*2 = 82
    expect(gridSize(7, 6, opts)).toEqual({ width: 82, height: 70 });
  });

  it("单列单行没有间距", () => {
    expect(gridSize(1, 1, opts)).toEqual({ width: 10, height: 10 });
  });

  it("零行列返回零尺寸而不是负数", () => {
    expect(gridSize(0, 0, opts)).toEqual({ width: 0, height: 0 });
    expect(gridSize(0, 3, opts).width).toBe(0);
  });

  it("cellBox 从原点开始排布", () => {
    expect(cellBox(0, 0, opts)).toMatchObject({ x: 0, y: 0, size: 10 });
    expect(cellBox(1, 0, opts)).toMatchObject({ x: 12, y: 0 });
    expect(cellBox(0, 1, opts)).toMatchObject({ x: 0, y: 12 });
    expect(cellBox(3, 2, opts)).toMatchObject({ x: 36, y: 24 });
  });

  it("cellBox 支持指定原点", () => {
    expect(cellBox(2, 1, { ...opts, originX: 5, originY: 8 })).toMatchObject({
      x: 5 + 24,
      y: 8 + 12,
    });
  });

  it("buildGrid 生成的行列数正确且按行优先", () => {
    const boxes = buildGrid(3, 2, opts);
    expect(boxes).toHaveLength(6);
    expect(boxes.map((b) => [b.column, b.row])).toEqual([
      [0, 0], [1, 0], [2, 0],
      [0, 1], [1, 1], [2, 1],
    ]);
  });

  it("buildGrid 与逐个 cellBox 结果一致", () => {
    const boxes = buildGrid(7, 6, opts);
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 7; col += 1) {
        const box = boxes[row * 7 + col]!;
        expect(box).toEqual(cellBox(col, row, opts));
      }
    }
  });

  it("buildGrid 在零行列时返回空数组", () => {
    expect(buildGrid(0, 5, opts)).toHaveLength(0);
    expect(buildGrid(5, 0, opts)).toHaveLength(0);
  });

  it("月历网格恰好 7 列 6 行", () => {
    const boxes = buildGrid(CALENDAR_COLUMNS, CALENDAR_ROWS, opts);
    expect(boxes).toHaveLength(CALENDAR_CELLS);
    expect(Math.max(...boxes.map((b) => b.column))).toBe(6);
    expect(Math.max(...boxes.map((b) => b.row))).toBe(5);
  });

  it("热力图网格恰好 53 周 7 天", () => {
    const boxes = buildGrid(HEATMAP_WEEKS, HEATMAP_DAYS, opts);
    expect(boxes).toHaveLength(HEATMAP_CELLS);
    expect(HEATMAP_CELLS).toBe(371);
  });

  it("heatmapCellBox 的参数顺序是「周, 星期」", () => {
    expect(heatmapCellBox(2, 3, opts)).toEqual(cellBox(2, 3, opts));
  });

  it("网格最右下角的格子不超出网格尺寸", () => {
    const { width, height } = gridSize(7, 6, opts);
    const last = buildGrid(7, 6, opts).at(-1)!;
    expect(last.x + last.size).toBeLessThanOrEqual(width);
    expect(last.y + last.size).toBeLessThanOrEqual(height);
  });
});

describe("日期计算", () => {
  it("闰年判定覆盖百年与四百年规则", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it("各月天数正确", () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("非法月份返回 0 而不是越界", () => {
    expect(daysInMonth(2026, 0)).toBe(0);
    expect(daysInMonth(2026, 13)).toBe(0);
    expect(daysInMonth(2026, -1)).toBe(0);
  });

  it("startOfDay 归零到当天 0 点", () => {
    const ts = Date.UTC(2026, 4, 17, 13, 45, 30, 500);
    expect(startOfDay(ts)).toBe(Date.UTC(2026, 4, 17));
  });

  it("weekdayIndex 以周一为 0", () => {
    // 2026-01-05 是周一
    expect(weekdayIndex(Date.UTC(2026, 0, 5))).toBe(0);
    // 2026-01-11 是周日
    expect(weekdayIndex(Date.UTC(2026, 0, 11))).toBe(6);
    expect(weekdayIndex(Date.UTC(2026, 0, 10))).toBe(5);
  });

  it("weekdayIndex 恒在 0..6", () => {
    for (let i = 0; i < 400; i += 1) {
      const v = weekdayIndex(Date.UTC(2026, 0, 1) + i * 86_400_000);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it("formatDateKey 输出零填充的 YYYY-MM-DD", () => {
    expect(formatDateKey(Date.UTC(2026, 0, 5))).toBe("2026-01-05");
    expect(formatDateKey(Date.UTC(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("月历网格", () => {
  it("固定 42 格", () => {
    expect(monthGrid(2026, 1)).toHaveLength(CALENDAR_CELLS);
    expect(monthGrid(2024, 2)).toHaveLength(CALENDAR_CELLS);
  });

  it("首格是当月 1 号所在周的周一", () => {
    // 2026-01-01 是周四，因此首格应是 2025-12-29（周一）
    const grid = monthGrid(2026, 1);
    expect(formatDateKey(grid[0]!.timestamp)).toBe("2025-12-29");
    expect(weekdayIndex(grid[0]!.timestamp)).toBe(0);
  });

  it("每格恰好包含本月应有的天数", () => {
    const grid = monthGrid(2026, 1);
    expect(grid.filter((c) => c.inMonth)).toHaveLength(31);
    expect(monthGrid(2026, 2).filter((c) => c.inMonth)).toHaveLength(28);
    expect(monthGrid(2024, 2).filter((c) => c.inMonth)).toHaveLength(29);
  });

  it("相邻格严格相差一天且时间戳递增", () => {
    const grid = monthGrid(2026, 3);
    for (let i = 1; i < grid.length; i += 1) {
      expect(grid[i]!.timestamp - grid[i - 1]!.timestamp).toBe(86_400_000);
    }
  });

  it("当月 1 号必然落在第 0 行", () => {
    for (let month = 1; month <= 12; month += 1) {
      const grid = monthGrid(2026, month);
      const firstIndex = grid.findIndex((c) => c.inMonth);
      expect(firstIndex, `${month} 月`).toBeLessThan(CALENDAR_COLUMNS);
    }
  });

  it("每列恰好 6 格，保证切月高度不跳动", () => {
    const grid = monthGrid(2026, 7);
    for (let col = 0; col < CALENDAR_COLUMNS; col += 1) {
      expect(grid.filter((_, i) => i % CALENDAR_COLUMNS === col)).toHaveLength(CALENDAR_ROWS);
    }
  });

  it("二月的边界（闰年与非闰年）都能铺满", () => {
    expect(monthGrid(2024, 2).filter((c) => c.inMonth)).toHaveLength(29);
    expect(monthGrid(2100, 2).filter((c) => c.inMonth)).toHaveLength(28);
  });
});

describe("年热力图网格", () => {
  it("固定 371 格", () => {
    expect(yearHeatmapGrid(2026)).toHaveLength(HEATMAP_CELLS);
  });

  it("首格是当年 1 月 1 日所在周的周一", () => {
    const grid = yearHeatmapGrid(2026);
    expect(weekdayIndex(grid[0]!.timestamp)).toBe(0);
    // 首格不应晚于 1 月 1 日，且不超过一周
    const jan1 = Date.UTC(2026, 0, 1);
    expect(grid[0]!.timestamp).toBeLessThanOrEqual(jan1);
    expect(jan1 - grid[0]!.timestamp).toBeLessThan(7 * 86_400_000);
  });

  it("格子按「周在外、星期在内」编号", () => {
    const grid = yearHeatmapGrid(2026);
    expect(grid[0]).toMatchObject({ week: 0, weekday: 0 });
    expect(grid[6]).toMatchObject({ week: 0, weekday: 6 });
    expect(grid[7]).toMatchObject({ week: 1, weekday: 0 });
    expect(grid.at(-1)).toMatchObject({ week: HEATMAP_WEEKS - 1, weekday: HEATMAP_DAYS - 1 });
  });

  it("覆盖整年 365 或 366 天", () => {
    expect(yearHeatmapGrid(2026).filter((c) => c.inYear)).toHaveLength(365);
    expect(yearHeatmapGrid(2024).filter((c) => c.inYear)).toHaveLength(366);
  });

  it("相邻格严格相差一天且时间戳递增", () => {
    const grid = yearHeatmapGrid(2026);
    for (let i = 1; i < grid.length; i += 1) {
      expect(grid[i]!.timestamp - grid[i - 1]!.timestamp).toBe(86_400_000);
    }
  });

  it("每一周的连续 7 格就是完整的周一到周日", () => {
    const grid = yearHeatmapGrid(2026);
    for (let week = 0; week < HEATMAP_WEEKS; week += 1) {
      const slice = grid.slice(week * 7, week * 7 + 7);
      expect(slice.map((c) => c.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(slice.map((c) => weekdayIndex(c.timestamp))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it("可以切换为周日开头", () => {
    const sunday = yearHeatmapGrid(2026, false);
    // 2026-01-01 是周四，周日开头时首格应是 2025-12-28
    expect(formatDateKey(sunday[0]!.timestamp)).toBe("2025-12-28");
  });

  it("日历键唯一，没有重复日期", () => {
    const keys = yearHeatmapGrid(2026).map((c) => formatDateKey(c.timestamp));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("事件委托", () => {
  /** 造一个带若干「格子」的容器。 */
  function makeContainer(count: number): HTMLDivElement {
    const container = document.createElement("div");
    for (let i = 0; i < count; i += 1) {
      const cell = document.createElement("div");
      cell.setAttribute("data-index", String(i));
      cell.setAttribute("data-date", `2026-01-${String((i % 28) + 1).padStart(2, "0")}`);
      cell.setAttribute("data-value", String(i * 10));
      container.appendChild(cell);
    }
    return container;
  }

  it("只绑一个监听器就能覆盖全部子格", async () => {
    const { delegateEvents, findCell } = await import("./delegate");
    const container = makeContainer(365);
    const seen: number[] = [];
    const off = delegateEvents(container, {
      click: (hit) => seen.push(hit.index ?? -1),
    });

    // 点击第 200 个格子
    const cell = container.children[200]!;
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen).toEqual([200]);

    off();
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen).toEqual([200]);
    expect(findCell(cell, container)).toBe(cell);
  });

  it("从子节点冒泡上来也能命中最近的格子", async () => {
    const { delegateEvents } = await import("./delegate");
    const container = makeContainer(3);
    const inner = document.createElement("span");
    container.children[1]!.appendChild(inner);

    const seen: (number | null)[] = [];
    const off = delegateEvents(container, { click: (hit) => seen.push(hit.index) });
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen).toEqual([1]);
    off();
  });

  it("命中的不是格子时处理器不被调用", async () => {
    const { delegateEvents } = await import("./delegate");
    const container = makeContainer(2);
    const handle = vi.fn();
    const off = delegateEvents(container, { click: handle });
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handle).not.toHaveBeenCalled();
    off();
  });

  it("携带 data-date 与 data-value", async () => {
    const { delegateEvents } = await import("./delegate");
    const container = makeContainer(5);
    let hit: { date: string | null; value: number | null } | null = null;
    const off = delegateEvents(container, {
      click: (h) => {
        hit = { date: h.date, value: h.value };
      },
    });
    container.children[3]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(hit).toEqual({ date: "2026-01-04", value: 30 });
    off();
  });

  it("data-value 缺失或非法时返回 null 而不是 NaN", async () => {
    const { delegateEvents } = await import("./delegate");
    const container = document.createElement("div");
    const cell = document.createElement("div");
    cell.setAttribute("data-index", "0");
    cell.setAttribute("data-value", "abc");
    container.appendChild(cell);

    let value: number | null = 1;
    const off = delegateEvents(container, {
      click: (h) => {
        value = h.value;
      },
    });
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(value).toBeNull();
    off();
  });

  it("一次可挂多个事件类型，解绑时全部移除", async () => {
    const { delegateEvents } = await import("./delegate");
    const container = makeContainer(2);
    const calls: string[] = [];
    const off = delegateEvents(container, {
      pointerover: () => calls.push("over"),
      pointerout: () => calls.push("out"),
      click: () => calls.push("click"),
    });
    const cell = container.children[0]!;
    cell.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    cell.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toEqual(["over", "out", "click"]);

    off();
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toEqual(["over", "out", "click"]);
  });

  it("解绑函数可以安全地重复调用", async () => {
    const { delegateEvents } = await import("./delegate");
    const container = makeContainer(1);
    const off = delegateEvents(container, { click: () => undefined });
    off();
    expect(() => off()).not.toThrow();
  });

  it("cellDataAttrs 生成的属性可被 findCell 识别", async () => {
    const { cellDataAttrs, findCell } = await import("./delegate");
    const container = document.createElement("div");
    const cell = document.createElement("div");
    for (const [k, v] of Object.entries(cellDataAttrs(42, "2026-05-01", 1234))) {
      cell.setAttribute(k, v);
    }
    container.appendChild(cell);
    expect(findCell(cell, container)).toBe(cell);
    expect(cell.dataset["index"]).toBe("42");
  });

  it("crossHighlight 返回同行与同列但不含自身", () => {
    const result = crossHighlight(0);
    expect(result).not.toContain(0);
    // 首格所在周还有 6 格，所在列还有 52 格
    expect(result).toHaveLength(6 + 52);
    // 所在列的格子编号是 7 的倍数
    expect(result.filter((i) => i % 7 === 0)).toHaveLength(52);
  });

  it("crossHighlight 越界时返回空数组", () => {
    expect(crossHighlight(-1)).toEqual([]);
    expect(crossHighlight(HEATMAP_CELLS)).toEqual([]);
  });

  it("crossHighlight 在中间格上不重复计数", () => {
    const result = crossHighlight(HEATMAP_CELLS - 1);
    expect(new Set(result).size).toBe(result.length);
  });
});

describe("数字与日期格式化", () => {
  describe("formatNumber", () => {
    it("四位以上加千分位", () => {
      expect(formatNumber(1000)).toBe("1,000");
      expect(formatNumber(1234567)).toBe("1,234,567");
    });

    it("三位以内不加分隔符", () => {
      expect(formatNumber(0)).toBe("0");
      expect(formatNumber(999)).toBe("999");
    });

    it("负数保留符号", () => {
      expect(formatNumber(-1500)).toBe("-1,500");
    });

    it("小数四舍五入到整数", () => {
      expect(formatNumber(1234.6)).toBe("1,235");
      expect(formatNumber(1234.4)).toBe("1,234");
    });

    it("非有限数按 0 处理", () => {
      expect(formatNumber(Number.NaN)).toBe("0");
      expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0");
    });

    it("中文数字场景下分组正确", () => {
      expect(formatNumber(880000)).toBe("880,000");
      expect(formatNumber(100000000)).toBe("100,000,000");
    });
  });

  describe("formatCompact", () => {
    it("一万以上用万", () => {
      expect(formatCompact(12000)).toBe("1.2 万");
      expect(formatCompact(300000)).toBe("30 万");
    });

    it("一亿以上用亿", () => {
      expect(formatCompact(120_000_000)).toBe("1.2 亿");
    });

    it("一万以下仍用千分位", () => {
      expect(formatCompact(9999)).toBe("9,999");
    });

    it("整数不显示多余的 .0", () => {
      expect(formatCompact(10000)).toBe("1 万");
      expect(formatCompact(200_000_000)).toBe("2 亿");
    });
  });

  describe("formatDuration", () => {
    it("不足一小时只显示分钟", () => {
      expect(formatDuration(47)).toBe("47 分钟");
    });

    it("整小时不带分钟", () => {
      expect(formatDuration(120)).toBe("2 小时");
    });

    it("时分组合", () => {
      expect(formatDuration(135)).toBe("2 小时 15 分钟");
    });

    it("0 或负数显示 0 分钟", () => {
      expect(formatDuration(0)).toBe("0 分钟");
      expect(formatDuration(-10)).toBe("0 分钟");
    });

    it("非有限数不崩溃", () => {
      expect(formatDuration(Number.NaN)).toBe("0 分钟");
    });

    it("极小值给出人类可读说法", () => {
      expect(formatDuration(0.4)).toBe("不到 1 分钟");
    });
  });

  describe("formatPercent", () => {
    it("保留一位小数", () => {
      expect(formatPercent(0.425)).toBe("42.5%");
      expect(formatPercent(1)).toBe("100.0%");
      expect(formatPercent(0)).toBe("0.0%");
    });

    it("超出范围会被夹紧", () => {
      expect(formatPercent(1.5)).toBe("100.0%");
      expect(formatPercent(-0.3)).toBe("0.0%");
    });

    it("非有限数按 0 处理", () => {
      expect(formatPercent(Number.NaN)).toBe("0.0%");
    });
  });

  describe("weekdayLabel", () => {
    it("周一为索引 0", () => {
      expect(weekdayLabel(0)).toBe("周一");
      expect(weekdayLabel(6)).toBe("周日");
    });

    it("越界返回空字符串", () => {
      expect(weekdayLabel(7)).toBe("");
      expect(weekdayLabel(-1)).toBe("");
    });
  });

  describe("formatDateLabel", () => {
    it("输出中文日期", () => {
      expect(formatDateLabel("2026-01-05")).toBe("2026 年 1 月 5 日");
    });

    it("格式不符时原样返回", () => {
      expect(formatDateLabel("2026/01/05")).toBe("2026/01/05");
      expect(formatDateLabel("")).toBe("");
      expect(formatDateLabel("2026-01")).toBe("2026-01");
    });
  });

  describe("rollSequence", () => {
    it("包含两端且长度可控", () => {
      const seq = rollSequence(0, 100, 4);
      expect(seq).toEqual([0, 25, 50, 75, 100]);
    });

    it("输出全为整数（避免数字跳动）", () => {
      for (const v of rollSequence(0, 7, 3)) {
        expect(Number.isInteger(v)).toBe(true);
      }
    });

    it("起点等于终点时退化为常量序列", () => {
      expect(rollSequence(50, 50, 3)).toEqual([50, 50, 50, 50]);
    });

    it("递减也支持", () => {
      const seq = rollSequence(100, 0, 2);
      expect(seq[0]).toBe(100);
      expect(seq.at(-1)).toBe(0);
    });

    it("段数为 0 或负数时至少返回两端", () => {
      expect(rollSequence(0, 10, 0)).toHaveLength(2);
      expect(rollSequence(0, 10, -5)).toHaveLength(2);
    });
  });
});

describe("进度环", () => {
  it("满进度时 dasharray 全部实线", () => {
    const ring = progressRing(10, 1);
    expect(ring.circumference).toBeCloseTo(2 * Math.PI * 10, 5);
    expect(ring.dashArray).toBe(`${ring.circumference} 0`);
  });

  it("零进度时全部留白", () => {
    const ring = progressRing(10, 0);
    expect(ring.dashArray).toBe(`0 ${ring.circumference}`);
  });

  it("半进度的实线长度是半周长", () => {
    const ring = progressRing(10, 0.5);
    const [dash] = ring.dashArray.split(" ");
    expect(Number(dash)).toBeCloseTo(Math.PI * 10, 5);
  });

  it("超出范围会被夹紧到 0..1", () => {
    expect(progressRing(10, 2).dashArray).toBe(progressRing(10, 1).dashArray);
    expect(progressRing(10, -1).dashArray).toBe(progressRing(10, 0).dashArray);
  });

  it("半径为 0 时不会产生 NaN", () => {
    const ring = progressRing(0, 0.5);
    expect(ring.circumference).toBe(0);
    expect(ring.dashArray).not.toContain("NaN");
  });

  it("负半径按 0 处理", () => {
    expect(progressRing(-5, 0.5).circumference).toBe(0);
  });
});
