/**
 * 引用图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染引用图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function QuoteIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M9.5 6.5C6.9 7.6 5.5 9.6 5.5 12.4v5.1h5.4v-5.4H8.3c0-1.8.7-3 2.3-3.7z" />
      <path d="M18.4 6.5c-2.6 1.1-4 3.1-4 5.9v5.1h5.4v-5.4h-2.6c0-1.8.7-3 2.3-3.7z" />
    </svg>
  );
}
