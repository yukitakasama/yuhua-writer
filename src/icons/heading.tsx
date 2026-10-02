/**
 * 标题图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染标题图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function HeadingIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 5.5v13" />
      <path d="M12.5 5.5v13" />
      <path d="M4.5 12h8" />
      <path d="M16.4 11.2l2.2-1.6v9.4" />
      <path d="M15.9 19h5.2" />
    </svg>
  );
}
