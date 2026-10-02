/**
 * 图表几何计算（计划书 10.5）
 *
 * 这些函数是纯函数，不碰 DOM、不依赖日期库：
 * 输入原始数字，输出矩形坐标。这样做的好处是「几何计算的测试是好测试」——
 * 断言的是确定的数字关系，不涉及快照与渲染，因此非常稳定。
 *
 * 两套网格：
 *   月历   7 列 x 6 行，共 42 格
 *   年热力图 53 周 x 7 天，共 371 格（末周可能不满）
 */

/** 一天的毫秒数，日期推进用。 */
export const MS_PER_DAY = 86_400_000;

/** 月历列数（一周七天）。 */
export const CALENDAR_COLUMNS = 7;
/** 月历行数。固定 6 行保证月份切换时高度不跳动。 */
export const CALENDAR_ROWS = 6;
/** 月历总格数。 */
export const CALENDAR_CELLS = CALENDAR_COLUMNS * CALENDAR_ROWS;

/** 热力图周数（53 周覆盖一整年并留出首尾余量）。 */
export const HEATMAP_WEEKS = 53;
/** 热力图一周的天数。 */
export const HEATMAP_DAYS = 7;
/** 热力图总格数。 */
export const HEATMAP_CELLS = HEATMAP_WEEKS * HEATMAP_DAYS;

/** 网格布局参数。 */
export interface GridOptions {
  /** 单格边长。 */
  readonly cellSize: number;
  /** 格间距。 */
  readonly gap: number;
  /** 左上角 x。 */
  readonly originX?: number;
  /** 左上角 y。 */
  readonly originY?: number;
}

/** 单个格子的几何信息。 */
export interface CellBox {
  /** 列下标（从 0 开始）。 */
  readonly column: number;
  /** 行下标（从 0 开始）。 */
  readonly row: number;
  /** 左上角 x。 */
  readonly x: number;
  /** 左上角 y。 */
  readonly y: number;
  /** 边长。 */
  readonly size: number;
}

/**
 * 由格间距推算整张网格的尺寸。
 *
 * @param columns 列数
 * @param rows 行数
 * @param opts 网格参数
 * @returns 宽度与高度
 */
export function gridSize(
  columns: number,
  rows: number,
  opts: GridOptions,
): { width: number; height: number } {
  const { cellSize, gap } = opts;
  // n 个格子之间有 n-1 个间距；列数为 0 时不应出现负的间距补偿
  const width = columns <= 0 ? 0 : columns * cellSize + (columns - 1) * gap;
  const height = rows <= 0 ? 0 : rows * cellSize + (rows - 1) * gap;
  return { width, height };
}

/**
 * 计算某个格子（column, row）的矩形位置。
 *
 * @param column 列下标
 * @param row 行下标
 * @param opts 网格参数
 * @returns 格子几何信息
 */
export function cellBox(
  column: number,
  row: number,
  opts: GridOptions,
): CellBox {
  const { cellSize, gap, originX = 0, originY = 0 } = opts;
  return {
    column,
    row,
    x: originX + column * (cellSize + gap),
    y: originY + row * (cellSize + gap),
    size: cellSize,
  };
}

/**
 * 计算整个网格的全部格子位置。
 *
 * 热力图有 371 格，逐格调用 cellBox 会产生 371 次函数调用；
 * 这里用增量累加（每列只加一次 x，每行只加一次 y）来摊薄成本，
 * 对应计划书 10.5「不做逐格 JS 计算」的要求。
 *
 * @param columns 列数
 * @param rows 行数
 * @param opts 网格参数
 * @returns 按行优先顺序排列的格子数组
 */
export function buildGrid(
  columns: number,
  rows: number,
  opts: GridOptions,
): CellBox[] {
  const { cellSize, gap, originX = 0, originY = 0 } = opts;
  const boxes: CellBox[] = [];
  let y = originY;
  for (let row = 0; row < rows; row += 1) {
    let x = originX;
    for (let column = 0; column < columns; column += 1) {
      boxes.push({ column, row, x, y, size: cellSize });
      x += cellSize + gap;
    }
    y += cellSize + gap;
  }
  return boxes;
}

/**
 * 由周下标与星期下标取热力图格子位置。
 *
 * 加热图是「按周分列、按星期分行」的布局，与月历的阅读顺序相反，
 * 因此单独提供一个语义化的入口，避免调用方写错行列顺序。
 *
 * @param week 周下标 0..52
 * @param weekday 星期下标 0..6（0 为周一）
 * @param opts 网格参数
 * @returns 格子几何信息
 */
export function heatmapCellBox(
  week: number,
  weekday: number,
  opts: GridOptions,
): CellBox {
  return cellBox(week, weekday, opts);
}

/** 日期单元：只保留计算需要的字段，避免依赖 Date 对象。 */
export interface DateParts {
  /** 年 */
  readonly year: number;
  /** 月，1-12 */
  readonly month: number;
  /** 日，1-31 */
  readonly day: number;
}

/**
 * 判断是否为闰年。
 *
 * @param year 四位年份
 * @returns 闰年返回 true
 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 取某年某月的天数。
 *
 * @param year 年
 * @param month 月，1-12
 * @returns 天数；月份非法时返回 0
 */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  const table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) return 29;
  return table[month - 1] ?? 0;
}

/**
 * 把 UTC 毫秒时间戳归一化到「当天 0 点」。
 *
 * 为什么用 UTC 而不是本地时区：热力图的格子归属必须稳定，
 * 若用本地时区，用户在跨时区 traveling 时同一份数据会落到不同的格子。
 * 写作日期由上层按本地日历写入，这里只负责几何归位。
 *
 * @param timestamp 毫秒时间戳
 * @returns 当天 0 点的毫秒时间戳
 */
export function startOfDay(timestamp: number): number {
  const d = new Date(timestamp);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * 取某天是星期几（0 为周一，6 为周日）。
 *
 * 为什么不用 Date.getUTCDay()：它返回 0 为周日，
 * 与「周一开头」的热力图布局不符，直接换算比每次调用处再修正更不容易出错。
 *
 * @param timestamp 毫秒时间戳
 * @returns 0..6，0 为周一
 */
export function weekdayIndex(timestamp: number): number {
  const day = new Date(startOfDay(timestamp)).getUTCDay();
  return (day + 6) % 7;
}

/**
 * 计算月历所需的 42 个日期格。
 *
 * 首行从「当月 1 号所在周的周一」开始，因此会包含上月的末尾几天；
 * 固定 42 格保证任何月份都占满 6 行，切月时不会出现高度跳变
 * （计划书 5.5 要求「日历月份切换」平滑）。
 *
 * @param year 年
 * @param month 月，1-12
 * @returns 42 个 UTC 时间戳与「是否属于当月」标记
 */
export function monthGrid(
  year: number,
  month: number,
): { timestamp: number; inMonth: boolean }[] {
  const first = Date.UTC(year, month - 1, 1);
  // 回退到该周周一：weekdayIndex 已经是周一为 0 的口径
  const offset = weekdayIndex(first);
  const gridStart = first - offset * MS_PER_DAY;

  const cells: { timestamp: number; inMonth: boolean }[] = [];
  for (let i = 0; i < CALENDAR_CELLS; i += 1) {
    const ts = gridStart + i * MS_PER_DAY;
    const d = new Date(ts);
    cells.push({
      timestamp: ts,
      inMonth: d.getUTCFullYear() === year && d.getUTCMonth() === month - 1,
    });
  }
  return cells;
}

/**
 * 计算年热力图所需的 371 个日期格。
 *
 * 起点是「当年 1 月 1 日所在周的周日（或周一）」，与 GitHub 贡献图一致：
 * 首列与末列可能属于上一年 / 下一年，用 inYear 标记区分。
 *
 * @param year 年
 * @param weekStartsOnMonday 周起始日，默认周一
 * @returns 371 个格子的时间戳、周下标、星期下标与是否属于当年
 */
export function yearHeatmapGrid(
  year: number,
  weekStartsOnMonday = true,
): { timestamp: number; week: number; weekday: number; inYear: boolean }[] {
  const jan1 = Date.UTC(year, 0, 1);
  const rawWeekday = new Date(jan1).getUTCDay(); // 0 为周日
  const offset = weekStartsOnMonday ? (rawWeekday + 6) % 7 : rawWeekday;
  const gridStart = jan1 - offset * MS_PER_DAY;

  const cells: {
    timestamp: number;
    week: number;
    weekday: number;
    inYear: boolean;
  }[] = [];
  for (let i = 0; i < HEATMAP_CELLS; i += 1) {
    const ts = gridStart + i * MS_PER_DAY;
    const d = new Date(ts);
    cells.push({
      timestamp: ts,
      week: Math.floor(i / HEATMAP_DAYS),
      weekday: i % HEATMAP_DAYS,
      inYear: d.getUTCFullYear() === year,
    });
  }
  return cells;
}

/**
 * 把时间戳格式化为 YYYY-MM-DD。
 *
 * 不依赖 Intl：数据键格式必须与 Rust 侧 stats 文件的键完全一致，
 * 用 Intl 受系统区域设置影响，容易出现「2026/1/5」这样的键。
 *
 * @param timestamp 毫秒时间戳
 * @returns 零填充的日期字符串
 */
export function formatDateKey(timestamp: number): string {
  const d = new Date(timestamp);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 计算进度环的 stroke-dasharray。
 *
 * 用 dasharray 而不是缩放圆，因为缩放会改变线宽，在大半径下明显失真。
 *
 * @param radius 半径
 * @param progress 进度 0..1，超出范围会被夹紧
 * @returns dasharray 字符串与周长
 */
export function progressRing(
  radius: number,
  progress: number,
): { dashArray: string; circumference: number; offset: number } {
  const r = Math.max(radius, 0);
  const circumference = 2 * Math.PI * r;
  const clamped = Math.min(Math.max(progress, 0), 1);
  const dash = circumference * clamped;
  return {
    dashArray: `${dash} ${circumference - dash}`,
    circumference,
    // 用 dashoffset 旋转起点时保持周长口径，便于调用方做动画
    offset: circumference,
  };
}
