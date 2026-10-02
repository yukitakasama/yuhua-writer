/**
 * 粗体图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染粗体图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function BoldIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path
        fill="currentColor"
        stroke="none"
        d="M7.2 4.6h6.3c2.3 0 3.9 1.3 3.9 3.3 0 1.4-.8 2.4-2 2.9 1.5.5 2.5 1.6 2.5 3.2 0 2.2-1.7 3.6-4.2 3.6H7.2zm3.2 2.6v3h2.4c1 0 1.6-.6 1.6-1.5s-.6-1.5-1.6-1.5zm0 5.4v3.4h2.8c1.1 0 1.8-.7 1.8-1.7s-.7-1.7-1.8-1.7z"
      />
    </svg>
  );
}
