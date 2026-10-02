/**
 * 代码图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染代码图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function CodeIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M8.5 8.5L4.5 12l4 3.5" />
      <path d="M15.5 8.5l4 3.5-4 3.5" />
      <path d="M13.6 5.5l-3.2 13" />
    </svg>
  );
}
