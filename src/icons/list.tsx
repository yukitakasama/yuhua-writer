/**
 * 无序列表图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染无序列表图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function ListIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M9 6.5h11" />
    <path d="M9 12h11" />
    <path d="M9 17.5h11" />
    <circle cx="5" cy="6.5" r="1" />
    <circle cx="5" cy="12" r="1" />
    <circle cx="5" cy="17.5" r="1" />
    </svg>
  );
}
