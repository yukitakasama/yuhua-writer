/**
 * 目标图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染目标图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function TargetIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M14.6 4.2h5.2v5.2" />
      <path d="M19.8 4.2l-6.1 6.1" />
      <path d="M9.4 19.8H4.2v-5.2" />
      <path d="M4.2 19.8l6.1-6.1" />
      <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" />
    </svg>
  );
}
