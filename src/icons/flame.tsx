/**
 * 连续写作天数图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染连续写作天数图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function FlameIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 21a5.6 5.6 0 0 0 5.6-5.6c0-3.4-2.3-5.4-3.6-7.6-.5 1.6-1.4 2.6-2.6 3.1.3-2.8-.7-5.5-2.9-7.4.2 3.1-2.1 5-2.1 9.2A5.6 5.6 0 0 0 12 21z" />
    <path d="M12 21a2.2 2.2 0 0 0 2.2-2.2c0-1.5-1.1-2.3-1.6-3.4-.9.5-2.8 1.6-2.8 3.4A2.2 2.2 0 0 0 12 21z" />
    </svg>
  );
}
