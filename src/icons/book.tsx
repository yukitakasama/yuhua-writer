/**
 * 书图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染书图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function BookIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 4.5h9a3 3 0 0 1 3 3v12h-9a3 3 0 0 0-3 3z" />
      <path d="M19.5 6v13.5" />
      <path d="M7.5 8.5h6" />
      <path d="M7.5 12h6" />
    </svg>
  );
}
