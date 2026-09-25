/**
 * 文件夹图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染文件夹图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function FolderIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8l.9 1.2h6.8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}
