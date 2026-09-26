/**
 * 大纲图标。
 *
 * 用「一列长短不一的横线」表达层级：顶部两条为卷，缩进的短条为章。
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染大纲图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function OutlineIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 5.5h9" />
      <path d="M6.5 10h9" />
      <path d="M6.5 14.5h7" />
      <path d="M4 19h11" />
    </svg>
  );
}
