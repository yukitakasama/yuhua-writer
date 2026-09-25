/**
 * TXT 纯文本图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染TXT 纯文本图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function FormatTxtIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
    <path d="M13.5 3.5V9H19" />
    <path d="M8 12.6h6" />
    <path d="M8 15.2h6" />
    <path d="M8 17.8h3.4" />
    </svg>
  );
}
