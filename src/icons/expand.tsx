/**
 * 展开图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染展开图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function ExpandIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5v9" />
      <path d="M8.5 9l3.5 3.5L15.5 9" />
      <path d="M4.5 20.5h15" />
    </svg>
  );
}
