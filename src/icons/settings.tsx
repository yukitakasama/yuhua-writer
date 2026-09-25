/**
 * 设置图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染设置图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function SettingsIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="3.1" />
    <path d="M12 2.6l1.5 2.3 2.7-.5.3 2.7 2.4 1.3-1.5 2.3 1.5 2.3-2.4 1.3-.3 2.7-2.7-.5L12 21.4l-1.5-2.3-2.7.5-.3-2.7-2.4-1.3 1.5-2.3-1.5-2.3 2.4-1.3.3-2.7 2.7.5z" />
    </svg>
  );
}
