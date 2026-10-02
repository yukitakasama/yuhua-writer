/**
 * 日历图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染日历图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function CalendarIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17" />
      <path d="M8 3.5v4" />
      <path d="M16 3.5v4" />
      <path d="M7.5 14h1.5" />
      <path d="M12 14h1.5" />
      <path d="M16.5 14H18" />
      <path d="M7.5 17.2h1.5" />
      <path d="M12 17.2h1.5" />
    </svg>
  );
}
