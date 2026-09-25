/**
 * 字数图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染字数图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function WordCountIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 5.5h5.8v13H4.5z" />
    <path d="M13.7 5.5h5.8v13h-5.8z" />
    <path d="M6.4 9h2" />
    <path d="M6.4 12h2" />
    <path d="M6.4 15h2" />
    <path d="M15.6 9h2" />
    <path d="M15.6 12h2" />
    </svg>
  );
}
