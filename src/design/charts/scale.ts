/**
 * 色阶映射（计划书 10.5）
 *
 * 核心约束：**不做逐格 JS 计算**。
 * 年热力图有 365 格，若每格都跑一次插值函数，仅在渲染阶段就会产生
 * 上千次函数调用与中间对象，直接冲击指标 P11（统计页首次渲染 ≤ 200ms）。
 *
 * 因此这里预计算好 5 档颜色数组（色值本身来自 tokens.css 的 --c-heat-*），
 * 每格只需要一次「档位 -> 颜色」的数组取值。
 */

/**
 * 色阶档位数。
 * 5 档是经验值：再多则在暗色主题下相邻档位几乎无法区分，
 * 再少则看不出「今天比昨天多写了多少」。
 */
export const HEAT_LEVELS = 5;

/**
 * 预计算的 5 档颜色（亮色主题）。
 * 与 tokens.css 的 --c-heat-0..4 保持同步，改任一处都要同步另一处。
 */
export const HEAT_COLORS_LIGHT: readonly string[] = [
  "#ebedea",
  "#cfe0d9",
  "#9cc3b6",
  "#5f9a89",
  "#2b6b5f",
];

/** 预计算的 5 档颜色（暗色主题）。 */
export const HEAT_COLORS_DARK: readonly string[] = [
  "#23272a",
  "#2c4540",
  "#3d6b60",
  "#579486",
  "#8ecdb9",
];

/** 主题类型。 */
export type ChartTheme = "light" | "dark";

/**
 * 按主题取预计算的色阶数组。
 *
 * @param theme 主题，默认亮色
 * @returns 5 档颜色数组（只读）
 */
export function heatColors(theme: ChartTheme = "light"): readonly string[] {
  return theme === "dark" ? HEAT_COLORS_DARK : HEAT_COLORS_LIGHT;
}

/**
 * 把字数映射到 0..4 的档位索引。
 *
 * 分档依据是「相对当日目标」而不是绝对字数：
 * 日目标 1000 字的人和日目标 6000 字的人，对「写得多」的定义完全不同。
 *
 * 规则（与计划书 10.2 的默认阈值口径一致）：
 *   0 字          -> 0 档（空格）
 *   未达目标      -> 1..3 档，按完成率三分
 *   达到或超过目标 -> 4 档
 *
 * @param words 当日新增字数
 * @param goal 当日目标字数，必须为正数，否则退化为固定阈值
 * @returns 档位索引 0..4
 */
export function levelForWords(words: number, goal: number): number {
  if (!Number.isFinite(words) || words <= 0) return 0;

  if (!Number.isFinite(goal) || goal <= 0) {
    // 没有设置目标时用固定阈值，保证仍能看出相对强弱
    if (words < 100) return 1;
    if (words < 500) return 2;
    if (words < 1500) return 3;
    return 4;
  }

  const ratio = words / goal;
  if (ratio >= 1) return 4;
  if (ratio >= 0.66) return 3;
  if (ratio >= 0.33) return 2;
  return 1;
}

/**
 * 一步到位取色：字数 + 目标 -> 颜色字符串。
 *
 * 这是热力图逐格调用的热路径函数，因此内部只做两次数组取值，
 * 不创建任何中间对象。
 *
 * @param words 当日新增字数
 * @param goal 当日目标字数
 * @param theme 主题
 * @returns CSS 颜色字符串
 */
export function heatColorFor(
  words: number,
  goal: number,
  theme: ChartTheme = "light",
): string {
  const palette = heatColors(theme);
  const level = levelForWords(words, goal);
  return palette[level] ?? palette[0] ?? "#ebedea";
}

/**
 * 生成一次映射表，供整张热力图复用。
 *
 * 为什么需要它：365 格共用同一个目标值时，档位只需要按阈值切一刀，
 * 不必每格都算一遍除法。调用方拿到的数组可以直接按格子下标取色。
 *
 * @param goal 目标字数
 * @param theme 主题
 * @returns 长度 5 的档位颜色数组
 */
export function buildPalette(goal: number, theme: ChartTheme = "light"): readonly string[] {
  const palette = heatColors(theme);
  const table: string[] = [];
  for (let i = 0; i < HEAT_LEVELS; i += 1) {
    // 每档取该档的下界值反查颜色，保证与 levelForWords 完全一致
    const probe = levelProbeValue(i, goal);
    table.push(heatColorFor(probe, goal, theme) || palette[0] || "#ebedea");
  }
  return table;
}

/**
 * 取第 level 档的代表值，用于反查颜色。
 *
 * @param level 档位 0..4
 * @param goal 目标字数
 * @returns 落在该档内的一个字数
 */
export function levelProbeValue(level: number, goal: number): number {
  const g = Number.isFinite(goal) && goal > 0 ? goal : 1000;
  switch (level) {
    case 0:
      return 0;
    case 1:
      return Math.max(1, Math.floor(g * 0.1));
    case 2:
      return Math.floor(g * 0.5);
    case 3:
      return Math.floor(g * 0.8);
    default:
      return g;
  }
}

/**
 * 色阶图例的档位标签，供图例组件渲染「少 -> 多」。
 *
 * @returns 5 档的文字说明
 */
export function heatLegendLabels(): readonly string[] {
  return ["未写作", "少量", "适中", "较多", "达标"];
}
