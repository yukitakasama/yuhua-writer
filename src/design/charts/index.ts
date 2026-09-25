/**
 * SVG 图表基座统一出口（T1.13，供 M8 统计页复用）。
 *
 * 分成四个职责单一的模块：
 *   scale.ts    色阶映射——预计算 5 档，不做逐格计算
 *   geometry.ts 网格几何——月历 7x6、热力图 53x7、进度环
 *   delegate.ts 事件委托——365 格只绑一个监听器
 *   format.ts   tabular-nums 配套的数字/日期格式化
 *
 * 全部是纯函数，可脱离 DOM 单元测试。
 */

export {
  HEAT_LEVELS,
  HEAT_COLORS_LIGHT,
  HEAT_COLORS_DARK,
  heatColors,
  levelForWords,
  heatColorFor,
  buildPalette,
  levelProbeValue,
  heatLegendLabels,
} from "./scale";
export type { ChartTheme } from "./scale";

export {
  MS_PER_DAY,
  CALENDAR_COLUMNS,
  CALENDAR_ROWS,
  CALENDAR_CELLS,
  HEATMAP_WEEKS,
  HEATMAP_DAYS,
  HEATMAP_CELLS,
  gridSize,
  cellBox,
  buildGrid,
  heatmapCellBox,
  isLeapYear,
  daysInMonth,
  startOfDay,
  weekdayIndex,
  monthGrid,
  yearHeatmapGrid,
  formatDateKey,
  progressRing,
} from "./geometry";
export type { GridOptions, CellBox, DateParts } from "./geometry";

export { findCell, delegateEvents, cellDataAttrs, crossHighlight } from "./delegate";
export type { DelegatedHit, DelegatedHandler, DelegatedHandlers } from "./delegate";

export {
  formatNumber,
  formatCompact,
  formatDuration,
  formatPercent,
  weekdayLabel,
  formatDateLabel,
  rollSequence,
} from "./format";
