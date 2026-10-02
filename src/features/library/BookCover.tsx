/**
 * 书籍封面（SVG）。
 *
 * ## 渲染细节
 *
 * - 图案全部在 `viewBox="0 0 120 168"` 里画（接近真实书籍的 1:1.4 比例）
 * - 书名用 `foreignObject` 换成普通 DOM 文本？**不行** ——
 *   foreignObject 在部分 WebView 里渲染异常，且无法被
 *   `<use>` 复用。改为 SVG `<text>` + 手动截断。
 * - 长书名的截断在 JS 里做（按字符数），而不是靠 CSS：SVG 没有
 *   `text-overflow: ellipsis`，不截断就会溢出封面外。
 */

import { Show, type JSX } from "solid-js";

import { coverColors, designCover } from "./covers";

/** 封面属性。 */
export interface BookCoverProps {
  /** 书名。 */
  title: string;
  /** 渲染宽度（px），高度按比例算。 */
  width?: number;
  /** 是否显示书名文字（网格里的小封面可以不显示）。 */
  showTitle?: boolean;
  /** 附加类名。 */
  class?: string;
}

/** 书名最多显示几个字，超出截断。 */
const MAX_TITLE_CHARS = 6;

/** 一张算法生成的书籍封面。 */
export function BookCover(props: BookCoverProps): JSX.Element {
  const design = () => designCover(props.title);
  const colors = () => coverColors(design());
  const width = () => props.width ?? 120;
  const height = () => Math.round(width() * 1.4);
  // 用书名哈希做渐变 id 后缀：同一本书的 id 稳定，不会与其它书冲突
  const gradientId = () =>
    `cover-grad-${Math.abs(design().hue)}${design().pattern}`;

  const shortTitle = (): string => {
    const chars = [...props.title.trim()];
    if (chars.length <= MAX_TITLE_CHARS) return props.title.trim();
    return chars.slice(0, MAX_TITLE_CHARS).join("") + "…";
  };

  return (
    <svg
      class={["cover", props.class ?? ""].filter(Boolean).join(" ")}
      width={width()}
      height={height()}
      viewBox="0 0 120 168"
      role="img"
      aria-label={`${props.title} 的封面`}
    >
      <defs>
        <linearGradient id={gradientId()} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color={colors().from} />
          <stop offset="1" stop-color={colors().to} />
        </linearGradient>
      </defs>

      <rect width="120" height="168" rx="3" fill={`url(#${gradientId()})`} />

      {/* 书脊阴影：靠左一条窄的暗带，让封面看起来是立体的 */}
      <rect x="0" y="0" width="7" height="168" fill="rgb(0 0 0 / 0.16)" />
      <rect x="7" y="0" width="1" height="168" fill="rgb(255 255 255 / 0.10)" />

      <g stroke={colors().ink} fill="none" opacity="0.20" stroke-width="0.8">
        <CoverPattern pattern={design().pattern} density={design().density} />
      </g>

      {/* 书名：竖排不可能（西文混排会乱），用横排 + 底部对齐 */}
      <Show when={props.showTitle !== false}>
        <text
          x="60"
          y="118"
          text-anchor="middle"
          fill={colors().ink}
          font-size="13"
          font-family="var(--font-heading)"
          opacity="0.95"
        >
          {shortTitle()}
        </text>
        {/* 分隔短线：让文字与图案之间有个停顿 */}
        <path
          d="M46 130h28"
          stroke={colors().ink}
          stroke-width="0.8"
          opacity="0.35"
        />
      </Show>

      {/* 首字大标：作为没有自定义封面时的视觉识别点 */}
      <text
        x="60"
        y="72"
        text-anchor="middle"
        fill={colors().ink}
        font-size="42"
        font-family="var(--font-heading)"
        opacity="0.9"
      >
        {design().initial}
      </text>
    </svg>
  );
}

/** 四种几何图案。 */
function CoverPattern(props: {
  pattern: number;
  density: number;
}): JSX.Element {
  const lines = () => Array.from({ length: props.density }, (_, i) => i);

  switch (props.pattern) {
    case 0:
      // 同心弧：像羽毛的层层轮廓
      return (
        <>
          {lines().map((i) => (
            <circle cx="60" cy="150" r={20 + i * 11} />
          ))}
        </>
      );
    case 1:
      // 放射线：从右下角散开
      return (
        <>
          {lines().map((i) => (
            <path d={`M120 168 L${10 + i * 16} 0`} />
          ))}
        </>
      );
    case 2:
      // 横向波浪：像水面
      return (
        <>
          {lines().map((i) => (
            <path d={`M0 ${30 + i * 18} q30 -12 60 0 t60 0`} />
          ))}
        </>
      );
    default:
      // 斜向栅格
      return (
        <>
          {lines().map((i) => (
            <path d={`M${-20 + i * 26} 0 L${20 + i * 26} 168`} />
          ))}
        </>
      );
  }
}
