/**
 * \`prefers-reduced-motion\` 检测与动效降级。
 *
 * 为什么单独抽成一个模块：计划书 5.6 与验收项 A10 都要求「开启系统减少动态效果后，
 * 无位移动效、功能不受影响」。把这个判断集中在一处，组件就不必各自去读媒体查询，
 * 也不会出现某个组件忘了降级的情况。
 *
 * 注意：这里刻意不依赖 \`window.matchMedia\` 一定存在。jsdom 默认不实现 matchMedia
 * （需要测试自行打桩），而 SSR / 单元测试环境里没有 window。缺失时按「不降级」处理，
 * 这样组件在浏览器里的默认行为与真机一致。
 */

/** 媒体查询字符串。降级判断与 CSS 侧的 @media 必须用同一个字符串，避免漏网。 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)" as const;

/** 可从外部注入的 matchMedia 实现，仅供测试与非浏览器环境替换。 */
export type MatchMediaLike = (query: string) => MediaQueryList;

/** 取当前的 matchMedia；不存在时返回 undefined，由调用方决定如何降级。 */
function resolveMatchMedia(): MatchMediaLike | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = (window as Window & { matchMedia?: MatchMediaLike }).matchMedia;
  return typeof candidate === "function" ? candidate.bind(window) : undefined;
}

/**
 * 读取一次「是否要求减少动效」。
 *
 * 一次性读取用于那些不需要响应系统设置变化的场景（例如计算一次动画时长）。
 * 需要跟随系统设置实时切换时请用 \`createReducedMotion\`。
 */
export function prefersReducedMotion(): boolean {
  const mql = resolveMatchMedia()?.(REDUCED_MOTION_QUERY);
  return mql?.matches ?? false;
}

/**
 * 动效降级策略。
 *
 * \`duration\` 与 \`easing\` 直接可喂给 \`element.animate()\` 或 CSS transition。
 * 降级后只保留极短的透明度变化（计划书要求 ≤ 100 ms），绝不保留位移与缩放：
 * 前庭功能障碍用户对位移最敏感，而透明度变化几乎不引发不适。
 */
export interface MotionPolicy {
  /** 该交互在遵守减少动效时是否应该做位移动画。 */
  readonly allowTransform: boolean;
  /** 实际使用的时长（毫秒）。 */
  readonly duration: number;
  /** 实际使用的缓动。降级后统一为线性，缩短时长时线性最不容易被感知到突兀。 */
  readonly easing: string;
}

/** 把期望时长裁剪到降级策略下允许的值。 */
export function reduceDuration(ms: number): number {
  if (!prefersReducedMotion()) return ms;
  // 降级目标：≤100ms 的纯透明度变化。取 80ms 而不是 0，
  // 因为 0ms 会让「状态确实变了」这一反馈消失，反而降低可用性。
  return Math.min(ms, 80);
}

/** 计算某个动效在当前环境下的实际策略。 */
export function motionPolicy(options: {
  /** 正常情况下的时长（毫秒）。 */
  duration: number;
  /** 正常情况下的缓动函数。 */
  easing?: string;
}): MotionPolicy {
  const reduced = prefersReducedMotion();
  if (!reduced) {
    return { allowTransform: true, duration: options.duration, easing: options.easing ?? "linear" };
  }
  return { allowTransform: false, duration: Math.min(options.duration, 80), easing: "linear" };
}
