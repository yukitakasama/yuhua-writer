/**
 * 拖拽手柄图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染拖拽手柄图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function DragHandleIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="9.2" cy="6.6" r="1.15" />
      <circle cx="14.8" cy="6.6" r="1.15" />
      <circle cx="9.2" cy="12" r="1.15" />
      <circle cx="14.8" cy="12" r="1.15" />
      <circle cx="9.2" cy="17.4" r="1.15" />
      <circle cx="14.8" cy="17.4" r="1.15" />
    </svg>
  );
}
