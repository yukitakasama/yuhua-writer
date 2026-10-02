/**
 * 热力图色阶配色（T8.8）。
 *
 * ## 单一色源
 *
 * 全部颜色来自 `src/design/charts/scale.ts` 的预计算数组，而那组色值
 * 又与 `tokens.css` 的 `--c-heat-0` 到 `--c-heat-4` 严格一致
 * （charts.test.ts 里有一条测试专门钉住这件事）。
 *
 * 这里**不**再定义一份色板，也不做渐变插值：染一格的代价必须是一次
 * 数组取值，而不是一次颜色计算 —— 365 格逐格算颜色会直接冲掉
 * P11（统计页首次渲染 ≤ 200ms）。
 */

import { heatColors, type ChartTheme } from "@/design/charts";

/** 当前主题。第一阶段由系统偏好决定，M9 接入主题切换后改由设置驱动。 */
export function currentTheme(): ChartTheme {
  if (typeof document === "undefined") return "light";
  // 主题是真源在 <html> 的 data-theme 属性上（见 tokens.css 的 [data-theme="dark"]）
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return "dark";
  if (attr === "light") return "light";
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

/** 取 5 档颜色（下标即档位）。 */
export function palette(theme: ChartTheme = currentTheme()): readonly string[] {
  return heatColors(theme);
}

/**
 * 取某一档的颜色。
 *
 * 这是逐格调用的热路径函数：只做一次数组取值，不创建中间对象。
 */
export function colorForLevel(
  level: number,
  theme: ChartTheme = currentTheme(),
): string {
  const colors = palette(theme);
  const index = Number.isFinite(level)
    ? Math.min(Math.max(Math.floor(level), 0), colors.length - 1)
    : 0;
  return colors[index] ?? colors[0] ?? "#ebedea";
}
