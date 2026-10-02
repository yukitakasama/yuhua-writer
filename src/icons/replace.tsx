/**
 * 替换图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染替换图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function ReplaceIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 6.2h10" />
      <path d="M11.5 3.4l2.8 2.8-2.8 2.8" />
      <path d="M19.5 17.8h-10" />
      <path d="M12.5 15l-2.8 2.8 2.8 2.8" />
      <path d="M12 10.4v3.4" />
    </svg>
  );
}
