/**
 * 字体（字形 "A" 与基线的组合）图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 *
 * 为什么不是直接画一个汉字：图标要在 16px 下仍然可辨，
 * 汉字笔画在这个尺寸会糊成一团。用拉丁字母 A 的骨架加一条基线，
 * 既表达了「字体」，也能和「排版」图标（对齐线）在形状上区分开。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染字体图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function TypeIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5 6.5V5h14v1.5" />
      <path d="M12 5v14" />
      <path d="M9 19h6" />
    </svg>
  );
}
