/**
 * 重做图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染重做图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function RedoIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 18.5a7 7 0 0 1 7-7h8" />
    <path d="M16 8l3.5 3.5L16 15" />
    </svg>
  );
}
