/**
 * 左对齐（排版）图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 *
 * 四条长度递减的横线是排版工具的通用语汇，用户不需要学习成本。
 * 线长刻意不等（18 / 12 / 15 / 10），等长的四条线看起来像「列表」而不是「对齐」。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染左对齐图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function AlignLeftIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3 6h18" />
      <path d="M3 10.5h12" />
      <path d="M3 15h15" />
      <path d="M3 19.5h9" />
    </svg>
  );
}
