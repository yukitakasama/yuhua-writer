/**
 * 向左箭头图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染向左箭头图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function ArrowLeftIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M19.5 12H5" />
      <path d="M11.5 5.5L5 12l6.5 6.5" />
    </svg>
  );
}
