/**
 * 图片图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染图片图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function ImageIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M3.5 16.5l4.6-4.2a2 2 0 0 1 2.7 0l3.3 3" />
    <path d="M12.6 14.4l2.2-2a2 2 0 0 1 2.7 0l2.9 2.6" />
    </svg>
  );
}
