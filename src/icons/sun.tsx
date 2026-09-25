/**
 * 太阳图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染太阳图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function SunIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2" />
    <path d="M12 19.5v2" />
    <path d="M2.5 12h2" />
    <path d="M19.5 12h2" />
    <path d="M5.2 5.2l1.4 1.4" />
    <path d="M17.4 17.4l1.4 1.4" />
    <path d="M18.8 5.2l-1.4 1.4" />
    <path d="M6.6 17.4l-1.4 1.4" />
    </svg>
  );
}
