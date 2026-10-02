/**
 * 分割线图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染分割线图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function DividerIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3.5 12h17" />
      <path d="M7 7h10" />
      <path d="M9.5 16.8h5" />
    </svg>
  );
}
