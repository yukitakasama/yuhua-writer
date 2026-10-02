/**
 * 全屏图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染全屏图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function FullscreenIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 9V4.5H9" />
      <path d="M15 4.5h4.5V9" />
      <path d="M19.5 15v4.5H15" />
      <path d="M9 19.5H4.5V15" />
    </svg>
  );
}
