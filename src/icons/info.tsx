/**
 * 信息图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 *
 * 圆 + 竖线 + 点：点的半径压到 0.6 是为了在 1.5 线宽下仍与
 * 竖线区分开 —— 用同宽的短线会在小尺寸下被读成字母 i 的重复描边。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染信息图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function InfoIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6v.4" />
    </svg>
  );
}
