/**
 * 图标公共基础。
 *
 * 为什么图标不直接用 solid-js 的 JSX 类型而是自己声明 SvgIconProps：
 * 一是要统一收口描边参数（画布、线宽、端点全部在这里固定，
 * 单图文件里不再出现，避免出现「有的 1.5、有的 2」这种不一致）；
 * 二是 size 与 aria-label 的联动规则只写一遍。
 *
 * 规范来自计划书 7.2：24x24 viewBox、stroke-width 1.5、
 * linecap/linejoin round、默认无填充、stroke 取 currentColor。
 */

import type { JSX } from "solid-js";

/** 画布尺寸，所有图标共用。 */
export const ICON_VIEW_BOX = "0 0 24 24";

/** 统一线宽。 */
export const ICON_STROKE_WIDTH = 1.5;

/** 图标组件的通用属性。 */
export interface SvgIconProps {
  /** 附加类名，用于布局与颜色微调（颜色继承 currentColor）。 */
  class?: string;
  /** 边长（像素），默认 24。 */
  size?: number;
  /**
   * 无障碍标签。纯装饰图标不传即可（会自动 aria-hidden）；
   * 图标是唯一语义来源时（如只有图标的按钮）必须传。
   */
  "aria-label"?: string;
  /** 覆盖线宽，仅用于超大尺寸（如空状态插画）时视觉配平。 */
  "stroke-width"?: number;
}

/**
 * 构造统一的 svg 属性集合。
 *
 * @param props 调用方传入的图标属性
 * @returns 可直接展开到 <svg> 上的属性对象
 */
export function iconProps(props: SvgIconProps): JSX.IntrinsicElements["svg"] {
  const hasLabel =
    typeof props["aria-label"] === "string" && props["aria-label"].length > 0;
  const size = props.size ?? 24;
  return {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: ICON_VIEW_BOX,
    width: size,
    height: size,
    // 默认无填充：线条图标靠描边表达，填充会糊掉内部结构
    fill: "none",
    stroke: "currentColor",
    "stroke-width": props["stroke-width"] ?? ICON_STROKE_WIDTH,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: props.class,
    // 有 aria-label 时是语义图标，其余一律 aria-hidden，
    // 避免读屏软件把每个装饰性图标都念一遍
    ...(hasLabel
      ? { "aria-label": props["aria-label"], role: "img" }
      : { "aria-hidden": "true" }),
  };
}
