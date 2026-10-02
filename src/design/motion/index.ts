/**
 * 动效模块统一出口。
 * 令牌与 TS 常量必须成对使用，因此放在同一个入口导出，降低用错的风险。
 */

export {
  DURATION,
  EASING,
  EASING_POINTS,
  SPRING_SOFT,
  SPRING_SNAPPY,
  MAX_CONCURRENT_ANIMATIONS,
  REDUCED_MOTION_QUERY,
  prefersReducedMotion,
  resolveDuration,
} from "./tokens";
export type { DurationToken, EasingToken, SpringConfig } from "./tokens";

export {
  acquireSlot,
  releaseSlot,
  getRunningCount,
  getDegradedCount,
  resetMotionCounters,
  springValue,
  springDuration,
  springKeyframeOffsets,
  fadeIn,
  fadeOut,
  slideIn,
  scaleIn,
  collapse,
  flip,
  pressFeedback,
  rollNumber,
  fadeInContainer,
} from "./primitives";
export type { Animatable, Direction, MotionOptions } from "./primitives";

export {
  FrameRateMonitor,
  frameMonitor,
  benchmarkMotionPrimitives,
  findMaxConcurrency,
} from "./performance";
export type { PerformanceReport } from "./performance";
