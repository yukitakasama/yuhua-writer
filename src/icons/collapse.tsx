/**
 * 折叠图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染折叠图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function CollapseIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5v5.2" />
      <path d="M9.6 6.3L12 8.7l2.4-2.4" />
      <path d="M12 20.5v-5.2" />
      <path d="M9.6 17.7l2.4-2.4 2.4 2.4" />
      <path d="M4.5 12h15" />
    </svg>
  );
}
