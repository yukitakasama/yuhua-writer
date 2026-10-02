/**
 * 羽毛图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染羽毛图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function FeatherIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M19.5 4.5c0 5.2-2.4 9-6.1 11.2L8.6 18l-1.8-1.8 2.3-4.8C11.2 7.7 14.6 5.4 19.5 4.5Z" />
      <path d="M4 20l4.6-4.6" />
      <path d="M9.2 14.8l3.4 3.4" />
      <path d="M11.6 11.6l3.2 3.2" />
      <path d="M14 8.6l2.8 2.8" />
    </svg>
  );
}
