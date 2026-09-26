/**
 * 自研内联 SVG 图标。
 *
 * ## 为什么不用图标字体 / 外链图标
 *
 * 计划书 5.1 节与第 7 章：**零 emoji、零图标字体、零外链图片**。
 * 内联 SVG 每次渲染不产生额外网络请求，也不需要有字体文件的
 * 解析与字形缓存（省内存，对应要求②）。
 *
 * ## 为什么放在 `app/ui/` 而不是 `src/icons/`
 *
 * `src/icons/`（一图一文件）由设计系统代理负责。为了让两边互不阻塞，
 * 这里放**应用壳自用的一组**图标，等 `src/icons/` 落地后按名替换即可。
 * 所有图标统一 24x24 viewBox、`currentColor` 描边、`stroke-width` 1.5，
 * 保证与将来设计系统的视觉一致。
 *
 * ## 约定
 *
 * - 一律 `fill="none"` + 描边：细线风格与本项目的中性色阶搭
 * - `aria-hidden="true"`：图标永远只是文字标签的补充，
 *   无障碍信息由包裹它的按钮的 `aria-label` 提供
 */

import type { JSX } from "solid-js";

/** 图标通用属性。 */
export interface IconProps {
  /** 视觉尺寸，默认 16px。 */
  size?: number;
  /** 附加类名。 */
  class?: string;
}

/** 图标外壳，统一 viewBox 与描边参数。 */
function Svg(props: IconProps & { children: JSX.Element }): JSX.Element {
  const size = () => props.size ?? 16;
  return (
    <svg
      class={props.class}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

/** 加号：新建。 */
export function IconPlus(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** 放大镜：搜索。 */
export function IconSearch(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Svg>
  );
}

/** 齿轮：设置。 */
export function IconSettings(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.2v2.1M12 18.7v2.1M4.8 12H6.9M17.1 12h2.1M6.9 6.9l1.5 1.5M15.6 15.6l1.5 1.5M17.1 6.9l-1.5 1.5M8.4 15.6l-1.5 1.5" />
    </Svg>
  );
}

/** 书堆：书架。 */
export function IconLibrary(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 5.5h5.5v13H4z" />
      <path d="M9.5 5.5H15v13H9.5z" />
      <path d="M15 7.2l4.3-1.1 1.5 12.4-4.3 1.1z" />
    </Svg>
  );
}

/** 双向箭头：折叠面板。 */
export function IconPanelLeft(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </Svg>
  );
}

/** 右侧栏。 */
export function IconPanelRight(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15" />
    </Svg>
  );
}

/** 三角：展开 / 折叠树节点。 */
export function IconChevron(props: IconProps & { open?: boolean }): JSX.Element {
  return (
    <Svg {...props}>
      {/* 用一条直角折线表示，旋转由 CSS 的 transform 完成（只动画 transform） */}
      <path d={props.open ? "M6 9.5l6 6 6-6" : "M9.5 6l6 6-6 6"} />
    </Svg>
  );
}

/** 抓取手柄：拖拽排序。 */
export function IconGrip(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01" />
    </Svg>
  );
}

/** 垃圾桶：删除。 */
export function IconTrash(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4.5 6.5h15M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
      <path d="M6.5 6.5l1 12a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-12" />
      <path d="M10.5 10v6M13.5 10v6" />
    </Svg>
  );
}

/** 铅笔：重命名。 */
export function IconPencil(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4.5 19.5h3l10-10a2.1 2.1 0 0 0-3-3l-10 10z" />
      <path d="M13.5 7.5l3 3" />
    </Svg>
  );
}

/** 卷（文件夹）。 */
export function IconVolume(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18z" />
    </Svg>
  );
}

/** 文档（章）。 */
export function IconChapter(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6.5 3.5h7l5 5v12h-12z" />
      <path d="M13.5 3.5v5h5" />
      <path d="M9.5 13h6M9.5 16.5h4" />
    </Svg>
  );
}

/** 返回箭头。 */
export function IconBack(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Svg>
  );
}

/** 关闭叉。 */
export function IconClose(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7 7l10 10M17 7L7 17" />
    </Svg>
  );
}

/** 警示三角：错误提示。 */
export function IconWarning(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4M12 17h.01" />
    </Svg>
  );
}

/** 命令行提示符：命令面板入口。 */
export function IconCommand(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 7.5l4 4.5-4 4.5" />
      <path d="M12.5 17h6.5" />
    </Svg>
  );
}

/** 三根高低不同的柱子：写作统计入口。 */
export function IconStats(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 19.5h14" />
      <path d="M8 19.5v-5.5" />
      <path d="M12 19.5V9" />
      <path d="M16 19.5v-8.5" />
    </Svg>
  );
}
