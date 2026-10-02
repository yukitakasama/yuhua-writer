/**
 * 保存图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染保存图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function SaveIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5.5 4.5h10L19.5 8.5v11h-14z" />
      <path d="M8.5 4.5v5h6v-5" />
      <path d="M8.5 19.5v-5h7v5" />
    </svg>
  );
}
