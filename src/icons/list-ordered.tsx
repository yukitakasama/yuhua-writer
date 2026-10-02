/**
 * 有序列表图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染有序列表图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function ListOrderedIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M10 6.5h10" />
      <path d="M10 12h10" />
      <path d="M10 17.5h10" />
      <path d="M4 5.5h1v3" />
      <path d="M3.6 11.4h2.1L3.6 14h2.1" />
      <path d="M3.6 16.6h2.1v2.4H3.6" />
    </svg>
  );
}
