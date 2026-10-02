/**
 * 自绘 SVG 插画（T5.6）。
 *
 * ## 设计原则
 *
 * - **零 emoji、零外链图片**：全部是手写路径，跟着 CSS 变量走色
 * - **留白为主**：空状态的插画是气氛，不是主角，线条一律细，
 *   用 `--c-border` 级别的低对比度，不抢正文字
 * - **动效克制**：计划书 5.5 节要求「SVG 插画淡入 + 极低频呼吸」，
 *   呼吸只动 `opacity` 与 `transform: scale`（可合成属性）
 * - **一图一义**：每张插画对应一个明确的空状态语义，
 *   不做"通用占位图"，那样会让用户分不清是空了还是加载中
 */

import type { JSX } from "solid-js";

/** 插画通用属性。 */
export interface IllustrationProps {
  /** 视觉宽度，默认 128px。 */
  size?: number;
  /** 附加类名。 */
  class?: string;
}

/** 外层 SVG，统一视图框与描边风格。 */
function Art(
  props: IllustrationProps & { children: JSX.Element; viewBox?: string },
): JSX.Element {
  const size = () => props.size ?? 128;
  return (
    <svg
      class={["illus", props.class ?? ""].filter(Boolean).join(" ")}
      width={size()}
      height={size()}
      viewBox={props.viewBox ?? "0 0 128 128"}
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

/**
 * 书架为空：几本立着的空书脊 + 一支斜靠的笔。
 *
 * 语义刻意选"空书架"而不是"打开的书"——后者容易被误读成
 * "正在加载书籍"。
 */
export function IllustrationEmptyLibrary(
  props: IllustrationProps,
): JSX.Element {
  return (
    <Art {...props}>
      {/* 书架底板 */}
      <path d="M16 100h96" />
      {/* 三本厚薄不同的书，中间一本略微倾斜，避免像条形码 */}
      <rect x="24" y="52" width="16" height="48" rx="2" />
      <rect x="44" y="40" width="18" height="60" rx="2" />
      <g transform="rotate(-8 74 76)">
        <rect x="66" y="44" width="15" height="56" rx="2" />
      </g>
      <rect x="88" y="60" width="16" height="40" rx="2" />
      {/* 书脊上的分隔线，暗示"排版"而不是"空白方块" */}
      <path
        d="M49 50h8M49 58h8M71 54h6M71 62h6M93 70h6M93 78h6"
        stroke-width="1"
        opacity="0.5"
      />
      {/* 斜靠的笔 */}
      <path d="M36 30l14 14" />
      <path d="M34 26l4 4-6 2z" />
    </Art>
  );
}

/**
 * 卷章树为空：一株只有主干、还没有分枝的幼苗。
 *
 * 用"未展开的枝叶"呼应"羽化"这个书名意象，同时明确表达
 * "骨架已就位，等你长出内容"。
 */
export function IllustrationEmptyTree(props: IllustrationProps): JSX.Element {
  return (
    <Art {...props}>
      {/* 主干 */}
      <path d="M64 104V56" />
      {/* 两条尚未长开的分枝，左右错落 */}
      <path d="M64 84c-10-2-16-9-18-18" />
      <path d="M64 72c10-2 16-8 18-17" />
      {/* 叶片：小小的水滴形，数量少才显得"还没长起来" */}
      <path d="M44 62c-6-2-8-8-5-13 5-1 10 2 11 7 0 3-2 5-6 6z" />
      <path d="M84 51c5-3 6-9 3-13-5 0-9 4-9 9 0 3 3 4 6 4z" />
      <path d="M64 50c-5-4-6-11-2-15 5 1 8 6 7 11-1 3-3 4-5 4z" />
      {/* 地平线 */}
      <path d="M30 104h68" opacity="0.5" />
    </Art>
  );
}

/**
 * 卷下无章：一个空的文件夹轮廓。
 *
 * 这张图会在树里重复出现（每个空卷一个），因此刻意画得**更小更轻**，
 * 并且不含任何细节线条——重复出现的元素越简单越好。
 */
export function IllustrationEmptyVolume(props: IllustrationProps): JSX.Element {
  return (
    <Art {...props} viewBox="0 0 32 32">
      <path d="M4 9a2 2 0 0 1 2-2h6l2.5 3H26a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M4 13h24" opacity="0.5" />
    </Art>
  );
}

/**
 * 未选中章节：一张摊开的稿纸与一支笔。
 *
 * 中间留白处不放任何文字（文字由 EmptyState 组件统一渲染），
 * 避免文案在两处重复、改一处漏一处。
 */
export function IllustrationEmptyEditor(props: IllustrationProps): JSX.Element {
  return (
    <Art {...props}>
      {/* 纸 */}
      <path d="M34 22h44l16 16v68H34z" />
      <path d="M78 22v16h16" />
      {/* 文字行：长度参差，读起来才像"稿纸"而不是"表格" */}
      <path
        d="M46 56h32M46 66h40M46 76h26M46 86h34"
        stroke-width="1.2"
        opacity="0.55"
      />
      {/* 笔 */}
      <path d="M92 74l14-14 6 6-14 14-7 1z" />
      <path d="M100 66l6 6" />
    </Art>
  );
}

/**
 * 搜索无结果：一个放大镜，镜中是空的。
 *
 * "镜中空"比"打叉"更中性——打叉会让人以为搜索出错了，
 * 而实际上只是没匹配到。
 */
export function IllustrationNoResults(props: IllustrationProps): JSX.Element {
  return (
    <Art {...props}>
      <circle cx="56" cy="56" r="26" />
      <path d="M75 75l18 18" />
      {/* 镜中只有一条极淡的横线，表示"空白"而非"错误" */}
      <path d="M45 56h22" opacity="0.35" />
    </Art>
  );
}

/**
 * 出错：一个倾斜的叹号方框。
 *
 * 用方框 + 叹号而不是通用的"云朵闪电"，因为错误大多来自
 * 文件系统操作，方框（文件）的隐喻更贴切。
 */
export function IllustrationError(props: IllustrationProps): JSX.Element {
  return (
    <Art {...props}>
      <path d="M36 20h40l16 16v72H36z" />
      <path d="M76 20v16h16" />
      <path d="M64 52v28" stroke-width="2" />
      <path d="M64 90h.01" stroke-width="2.5" />
    </Art>
  );
}
