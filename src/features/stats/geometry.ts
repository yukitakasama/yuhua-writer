/**
 * 统计页的 SVG 几何参数（T8.7 / T8.8）。
 *
 * ## 为什么格子尺寸写死在代码里而不是 CSS
 *
 * SVG 的 `<rect>` 坐标是**用户坐标**，由 `viewBox` 与 `width/height` 共同
 * 决定最终像素大小。若用 CSS 改 `width`，格子间距不会跟着变，
 * 网格就会错位。因此尺寸只在 JS 里定义一次，CSS 只负责
 * `max-width: 100%` 这类整体缩放。
 *
 * ## 为什么日历与热力图的格子尺寸不同
 *
 * 日历一格要放得下日期数字（需要 ≥ 34px），而热力图有 53 列 ——
 * 同样的尺寸会让整张图画到 1800px 宽，右栏根本放不下。
 * 因此热力图用小格子 + 悬浮提示来表达同样的信息量。
 */

/** 月历：单格边长。要放得下两位数字，因此比热力图大得多。 */
export const CALENDAR_CELL = 36;
/** 月历：格间距。 */
export const CALENDAR_GAP = 5;
/** 月历：顶部星期表头高度。 */
export const CALENDAR_HEAD_HEIGHT = 20;
/** 月历：网格列数（一周七天）。 */
export const CALENDAR_COLUMNS = 7;
/** 月历：网格行数。固定 6 行，切月时高度不跳动。 */
export const CALENDAR_ROWS = 6;

/** 热力图：单格边长。53 列下必须小，否则整张图放不进侧栏。 */
export const HEATMAP_CELL = 11;
/** 热力图：格间距。 */
export const HEATMAP_GAP = 3;
/** 热力图：顶部月份表头高度。 */
export const HEATMAP_HEAD_HEIGHT = 16;
/** 热力图：左侧星期标签宽度。 */
export const HEATMAP_HEAD_WIDTH = 16;
/** 热力图：周数。53 周覆盖一整年并留出首尾余量。 */
export const HEATMAP_WEEKS = 53;
/** 热力图：一周七天。 */
export const HEATMAP_DAYS = 7;

/** 网格的像素尺寸。 */
export interface GridSize {
  /** 宽。 */
  width: number;
  /** 高。 */
  height: number;
}

/** 计算网格尺寸。列或行为 0 时返回 0 而不是负的间距补偿。 */
export function gridSize(columns: number, rows: number, cell: number, gap: number): GridSize {
  if (columns <= 0 || rows <= 0) return { width: 0, height: 0 };
  return {
    width: columns * cell + (columns - 1) * gap,
    height: rows * cell + (rows - 1) * gap,
  };
}

/** 月历 SVG 的画布尺寸（含表头）。 */
export function calendarCanvas(): GridSize {
  const inner = gridSize(CALENDAR_COLUMNS, CALENDAR_ROWS, CALENDAR_CELL, CALENDAR_GAP);
  return { width: inner.width, height: inner.height + CALENDAR_HEAD_HEIGHT };
}

/** 热力图 SVG 的画布尺寸（含月份表头与星期标签）。 */
export function heatmapCanvas(): GridSize {
  const inner = gridSize(HEATMAP_WEEKS, HEATMAP_DAYS, HEATMAP_CELL, HEATMAP_GAP);
  return {
    width: inner.width + HEATMAP_HEAD_WIDTH,
    height: inner.height + HEATMAP_HEAD_HEIGHT,
  };
}

/**
 * 热力图每月表头的位置。
 *
 * 返回 12 条（月号 + 列下标）。用**当月 1 号所在的周列**而不是等分 53 列：
 * 等分会让每个标签都偏半格，读起来对不上。
 */
export function monthTicks(year: number): Array<{ month: number; column: number }> {
  const ticks: Array<{ month: number; column: number }> = [];
  for (let month = 1; month <= 12; month += 1) {
    const date = new Date(year, month - 1, 1);
    const jan1 = new Date(year, 0, 1);
    const gridStart = new Date(jan1.getTime());
    // 回退到 1 月 1 日所在周的周一
    gridStart.setDate(gridStart.getDate() - ((jan1.getDay() + 6) % 7));
    const days = Math.round((date.getTime() - gridStart.getTime()) / 86_400_000);
    ticks.push({ month, column: Math.floor(days / 7) });
  }
  return ticks;
}

/** 热力图左侧的星期标签（只标奇数行，避免拥挤）。 */
export const HEATMAP_ROW_LABELS: ReadonlyArray<{ row: number; text: string }> = [
  { row: 0, text: "一" },
  { row: 2, text: "三" },
  { row: 4, text: "五" },
  { row: 6, text: "日" },
];
