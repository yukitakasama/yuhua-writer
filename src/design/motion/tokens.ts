/**
 * 动效令牌（计划书 5.3）
 *
 * 为什么要有这份 TS 常量，而不是只在 CSS 里写一遍：
 * Web Animations API 的 `duration` / `easing` 只接受 JS 值，
 * 若两边各写一份，改设计时必然出现「CSS 180ms、WAAPI 200ms」的漂移。
 * 因此这里与 tokens.css 严格一一对应，改任意一边都必须同步另一边
 * （tokens.test.ts 会校验两侧数值一致）。
 */

/** 动效时长（毫秒）。与 tokens.css 的 --d-* 对应。 */
export const DURATION = {
  /** 按压反馈：必须快到「像瞬时的」，再长就有粘滞感。 */
  instant: 80,
  /** 悬停、焦点、开关。 */
  fast: 120,
  /** 弹层、面板、列表项进出。 */
  base: 180,
  /** 页面切换、抽屉。 */
  slow: 240,
  /** 首次进入、大范围布局变化。 */
  page: 320,
} as const;

export type DurationToken = keyof typeof DURATION;

/**
 * 缓动曲线。与 tokens.css 的 --e-* 对应，握手点是 cubic-bezier 的四个参数，
 * 这样 CSS 与 WAAPI 用的确实是同一条曲线。
 */
export const EASING = {
  /** 通用：两端都有缓冲。 */
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  /** 入场：快进慢停，让新内容「冲刺后停下」。 */
  decelerate: "cubic-bezier(0, 0, 0, 1)",
  /** 出场：慢起快走，让离开的东西「迅速让位」。 */
  accelerate: "cubic-bezier(0.3, 0, 1, 1)",
} as const;

export type EasingToken = keyof typeof EASING;

/** cubic-bezier 的四参数形式，便于自研弹簧/采样时复用同一曲线。 */
export const EASING_POINTS = {
  standard: [0.2, 0, 0, 1],
  decelerate: [0, 0, 0, 1],
  accelerate: [0.3, 0, 1, 1],
} as const satisfies Record<EasingToken, readonly [number, number, number, number]>;

/** 弹簧参数（计划书 5.3 的 --spring-soft / --spring-snappy）。 */
export interface SpringConfig {
  /** 刚度：越大越快到达目标。 */
  readonly stiffness: number;
  /** 阻尼：越小越弹，过大则无回弹。 */
  readonly damping: number;
  /** 初始质量，固定为 1；暴露出来是为了将来能做「重物」手感。 */
  readonly mass?: number;
}

/** 软弹簧：面板、抽屉、弹层入场，回弹克制。 */
export const SPRING_SOFT: SpringConfig = { stiffness: 300, damping: 30, mass: 1 };

/** 脆弹簧：拖拽落位、分隔条吸附，需要「咔」地一下到位。 */
export const SPRING_SNAPPY: SpringConfig = { stiffness: 500, damping: 35, mass: 1 };

/**
 * 同屏并发动效元素上限（计划书 5.4）。
 * 超过这个数说明用户在做大范围操作（如整页切换叠加列表入场），
 * 此时继续逐个动画只会掉帧，不如直接切换来得清爽。
 */
export const MAX_CONCURRENT_ANIMATIONS = 30;

/** 媒体查询字符串，集中一处避免拼写漂移。 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 判断当前环境是否要求减弱动效。
 *
 * 在无 window 的环境（SSR、Node 单测）返回 false：
 * 宁可当作「正常动效」，也不要因为环境缺失就把全部动效静默关掉。
 *
 * @param target 可注入的匹配器来源，便于测试
 * @returns 需要减弱动效时为 true
 */
export function prefersReducedMotion(
  target?: Pick<Window, "matchMedia"> | null,
): boolean {
  const source =
    target ?? (typeof window === "undefined" ? null : (window as Window));
  if (!source || typeof source.matchMedia !== "function") return false;
  try {
    return source.matchMedia(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    // 某些受限环境下 matchMedia 会抛错，按「不减弱」处理
    return false;
  }
}

/**
 * 按 reduced-motion 决策换算实际时长。
 * 减弱时统一压到 100ms 以内，且只允许透明度变化（由调用方保证）。
 *
 * @param duration 正常情况下的时长（毫秒）
 * @param reduced 是否减弱动效
 * @returns 实际使用的时长（毫秒）
 */
export function resolveDuration(duration: number, reduced: boolean): number {
  return reduced ? Math.min(duration, 100) : duration;
}
