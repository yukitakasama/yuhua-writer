/**
 * 统计图标。
 *
 * 三根高低不同的柱子：读作「写作量的分布」，与热力图的语义一致。
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染统计图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function StatsIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 19.5h15" />
      <path d="M7.5 19.5v-6.5" />
      <path d="M12 19.5V8.5" />
      <path d="M16.5 19.5v-9.5" />
    </svg>
  );
}
