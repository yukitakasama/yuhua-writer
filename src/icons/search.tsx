/**
 * 搜索图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染搜索图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function SearchIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="M15.5 15.5l4.4 4.4" />
    </svg>
  );
}
