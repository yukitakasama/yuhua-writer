/**
 * 卷图标。
 *
 * 手写 SVG，无图标字体、无外链（计划书 7.1）。
 * 画布 24x24、线宽 1.5 等描边参数由 base.tsx 统一注入。
 */

import { iconProps, type SvgIconProps } from "./base";

/**
 * 渲染卷图标。
 *
 * @param props 图标属性（尺寸、类名、无障碍标签）
 * @returns SVG 元素
 */
export function VolumeIcon(props: SvgIconProps) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 5.6a1.4 1.4 0 0 1 1.4-1.4h5.4a1.4 1.4 0 0 1 1.4 1.4v13.6H5.9a1.4 1.4 0 0 1-1.4-1.4z" />
      <path d="M12.7 6.2a1.4 1.4 0 0 1 1.4-1.4h5.4v14.4h-5.4a1.4 1.4 0 0 1-1.4-1.4z" />
      <path d="M8.3 8.2h4.4" />
      <path d="M8.3 11.4h4.4" />
    </svg>
  );
}
