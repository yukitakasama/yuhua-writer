/**
 * 动效原语（计划书 5.4 / T1.6 的前置）
 *
 * 三条不可违反的约束，全部在本文件内落实：
 *   1. 只驱动 transform 与 opacity —— 见 buildKeyframes。
 *      其余属性每帧都要重算样式与布局，多元素并发必然掉帧。
 *   2. will-change 在动画结束后必须清除 —— 见 releaseLocked。
 *      残留的 will-change 会让元素永久占据一个合成层，直接反映到指标 M1/M2。
 *   3. 同屏并发动效元素上限 30，超出降级为直接切换 —— 见 acquireSlot。
 *
 * 不用 framer-motion 之类的库：它们的体积与运行时对象分配和「内存占用最低」
 * 的目标直接冲突，而这里需要的只是一层很薄的 WAAPI 封装。
 */

import {
  DURATION,
  EASING,
  MAX_CONCURRENT_ANIMATIONS,
  SPRING_SOFT,
  prefersReducedMotion,
  resolveDuration,
  type SpringConfig,
} from "./tokens";

/** 可被动画的元素：真实 DOM 元素或任何有 animate 方法的对象（便于测试打桩）。 */
export type Animatable = Element & {
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;
};

/** 动效方向。 */
export type Direction = "up" | "down" | "left" | "right";

/** 通用动效选项。 */
export interface MotionOptions {
  /** 时长（毫秒），默认取令牌 ---d-base---。 */
  readonly duration?: number;
  /** 缓动曲线，默认 standard。 */
  readonly easing?: string;
  /** 延迟（毫秒）。 */
  readonly delay?: number;
  /**
   * 是否在结束后清除触发的内联样式。
   * 默认 true：动效只负责「过渡态」，终态应由 CSS 类或样式表决定，
   * 否则内联样式会污染后续的状态切换。
   */
  readonly clearOnFinish?: boolean;
  /** 显式覆盖 reduced-motion 判断，测试与设置页预览用。 */
  readonly reducedMotion?: boolean;
}

/* ============================================================
   并发配额
   ============================================================ */

/** 当前正在运行的动效数量。 */
let runningAnimations = 0;
/** 因超限被降级的次数，供性能面板与测试观测。 */
let degradedCount = 0;

/**
 * 尝试占用一个动效配额。
 * @returns 拿到配额返回 true；超过上限返回 false，调用方应直接切换到终态
 */
export function acquireSlot(): boolean {
  if (runningAnimations >= MAX_CONCURRENT_ANIMATIONS) {
    degradedCount += 1;
    return false;
  }
  runningAnimations += 1;
  return true;
}

/** 归还一个动效配额（必须与 acquireSlot 成对出现）。 */
export function releaseSlot(): void {
  if (runningAnimations > 0) runningAnimations -= 1;
}

/** 当前并发动效数量。 */
export function getRunningCount(): number {
  return runningAnimations;
}

/** 因超出并发上限而降级的累计次数。 */
export function getDegradedCount(): number {
  return degradedCount;
}

/** 重置并发计数器。仅用于测试与开发期诊断，不要在业务代码里调用。 */
export function resetMotionCounters(): void {
  runningAnimations = 0;
  degradedCount = 0;
}

/* ============================================================
   自研弹簧（约 1KB，不引入任何依赖）
   ============================================================ */

/**
 * 解出弹簧在给定时间的归一化进度（阻尼谐振子闭式解）。
 *
 * 用途：把弹簧参数换算成 WAAPI 能用的多段关键帧。
 * 相比每帧手动 requestAnimationFrame 驱动，WAAPI 的关键帧由合成器执行，
 * 主线程即使被上层业务占住也不会掉帧（指标 P2）。
 *
 * @param config 弹簧参数
 * @param timeMs 从动画开始算起的毫秒数
 * @returns 进度值，通常落在 [0, 1] 附近，可能短暂超过 1（回弹）
 */
export function springValue(config: SpringConfig, timeMs: number): number {
  const mass = config.mass ?? 1;
  const stiffness = Math.max(config.stiffness, 1);
  const damping = Math.max(config.damping, 0);
  const t = timeMs / 1000;

  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta < 1) {
    // 欠阻尼：有回弹，这是「弹」的来源
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * omega0 * t);
    return (
      1 - envelope * (Math.cos(omegaD * t) + ((zeta * omega0) / omegaD) * Math.sin(omegaD * t))
    );
  }

  if (zeta === 1) {
    // 临界阻尼：最快到位且不越界
    return 1 - Math.exp(-omega0 * t) * (1 + omega0 * t);
  }

  // 过阻尼：慢一些但不回弹
  const root = omega0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * omega0 + root;
  const r2 = -zeta * omega0 - root;
  const c2 = 1 / (1 - r1 / r2);
  const c1 = 1 - c2;
  return 1 - (c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t));
}

/**
 * 估算弹簧稳定所需时长（毫秒）。
 * 弹簧没有「固定时长」，但 WAAPI 需要一个 duration 才能生成关键帧，
 * 这里以「振幅衰减到 0.1% 以下」为判据求出实际时长。
 *
 * @param config 弹簧参数
 * @returns 稳定的毫秒数，下限 100、上限 1200 防止异常参数卡死
 */
export function springDuration(config: SpringConfig): number {
  const mass = config.mass ?? 1;
  const stiffness = Math.max(config.stiffness, 1);
  const damping = Math.max(config.damping, 0);
  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  // 判据：包络衰减到 0.1%（ln(1000) = 6.9）所需时间。
  // 关键是「用哪条衰减率」：
  //   欠阻尼与临界阻尼的主导衰减率是 zeta*omega0；
  //   过阻尼则取两条实根中**较慢**的那一条（绝对值更小者），
  //   直接套 zeta*omega0 会严重低估时长，动画会在弹到位前就被截断。
  let rate: number;
  if (zeta < 1) {
    rate = zeta * omega0;
  } else {
    // 过阻尼：取两条实根中衰减最慢的（|r| 最小）
    const root = omega0 * Math.sqrt(zeta * zeta - 1);
    const slow = Math.abs(-zeta * omega0 + root); // 对应 r1，绝对值较小
    rate = Math.min(slow, zeta * omega0);
  }

  // zeta 为 0 时弹簧永不衰减，给一个人为上限避免无限长。
  // 临界阻尼多一个多项式因子 (1 + omega0 * t)，包络不再是纯指数，
  // 因此额外放宽到 1.6 倍，否则动画会在差 0.8% 时就被截断（肉眼可见的「没弹到位」）。
  const slack = Math.abs(zeta - 1) < 1e-6 ? 1.6 : 1;
  const decay = rate > 1e-6 ? (6.9 / rate) * slack : 1.2;
  return Math.min(Math.max(decay * 1000, 100), 1200);
}

/**
 * 把弹簧采样成 WAAPI 关键帧数组。
 *
 * @param config 弹簧参数
 * @param from 起点（0 = 起始态，1 = 终态）
 * @param to 终点
 * @param samples 采样段数，默认 30：足够平滑，且关键帧对象数可控
 * @returns 归一化进度关键帧（offset 由 WAAPI 线性插值）
 */
export function springKeyframeOffsets(
  config: SpringConfig,
  from = 0,
  to = 1,
  samples = 30,
): { offset: number; value: number }[] {
  const total = springDuration(config);
  const frames: { offset: number; value: number }[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const p = i / samples;
    const progress = springValue(config, p * total);
    frames.push({ offset: p, value: from + (to - from) * progress });
  }
  return frames;
}

/* ============================================================
   内部工具
   ============================================================ */

/** 判断元素是否真的能动画（jsdom 里没有 WAAPI，必须优雅退化）。 */
function canAnimate(el: Animatable): boolean {
  return typeof el.animate === "function";
}

/** 位移方向到 transform 的映射。 */
function translateFor(direction: Direction, distance: number): string {
  const d = Math.round(distance);
  switch (direction) {
    case "up":
      return `translateY(${d}px)`;
    case "down":
      return `translateY(-${d}px)`;
    case "left":
      return `translateX(${d}px)`;
    case "right":
      return `translateX(-${d}px)`;
  }
}

/**
 * 加锁 will-change。
 * 只在动画期间加，因为它会让元素独占合成层；
 * 长列表里几百个元素常驻 will-change 会直接吃掉几十 MB 显存。
 */
function lock(el: Animatable): void {
  if (el instanceof Element) {
    (el as HTMLElement).style.willChange = "transform, opacity";
  }
}

/** 释放 will-change。这是硬性要求，任何成功启动的动画都必须走到这里。 */
function releaseLocked(el: Animatable): void {
  if (el instanceof Element) {
    (el as HTMLElement).style.willChange = "";
  }
}

/** 打包动画选项。 */
function optionsFor(
  duration: number,
  easing: string,
  delay: number,
): KeyframeAnimationOptions {
  return { duration, easing, delay, fill: "both" };
}

/**
 * 内部执行入口：处理配额、reduced-motion、will-change 生命周期。
 *
 * @param el 目标元素
 * @param reducedFrames reduced-motion 下使用的关键帧（只允许 opacity）
 * @param normalFrames 正常关键帧（transform + opacity）
 * @param opts 动效选项
 * @returns 动画结束的 Promise；被降级或元素不可动画时立即 resolve
 */
function run(
  el: Animatable | null | undefined,
  reducedFrames: Keyframe[],
  normalFrames: Keyframe[],
  opts: MotionOptions = {},
): Promise<void> {
  if (!el) return Promise.resolve();

  const duration = opts.duration ?? DURATION.base;
  const easing = opts.easing ?? EASING.standard;
  const delay = opts.delay ?? 0;
  const reduced = opts.reducedMotion ?? prefersReducedMotion();

  // 降级路径①：环境不要求动效时用最短的纯透明度变化
  if (reduced) {
    if (!canAnimate(el)) return Promise.resolve();
    const anim = (el as Required<Animatable>).animate(reducedFrames, optionsFor(
      resolveDuration(duration, true),
      "linear",
      delay,
    ));
    return finish(el, anim, opts.clearOnFinish !== false);
  }

  // 降级路径②：并发超限直接切到终态（调用方通过 resolve 立即拿到控制权）
  if (!acquireSlot()) {
    return Promise.resolve();
  }

  if (!canAnimate(el)) {
    releaseSlot();
    return Promise.resolve();
  }

  lock(el);
  const anim = (el as Required<Animatable>).animate(
    normalFrames,
    optionsFor(duration, easing, delay),
  );
  // 必须把 releaseSlot 传下去：这个配额是在上面 acquireSlot 里拿的，
  // 漏还一次就会永久占掉一个名额，30 次之后全部动效静默降级。
  return finish(el, anim, opts.clearOnFinish !== false, releaseSlot);
}

/** 收尾：无论成功、取消还是异常，都要归还配额并清除 will-change。 */
function finish(
  el: Animatable,
  anim: Animation,
  clear: boolean,
  onRelease?: () => void,
): Promise<void> {
  let released = false;
  const cleanup = (): void => {
    if (released) return;
    released = true;
    releaseLocked(el);
    if (onRelease) onRelease();
  };

  return new Promise<void>((resolve) => {
    anim.addEventListener("finish", () => {
      cleanup();
      if (clear && el instanceof Element) {
        // 取消 fill:both 留下的内联影响，交还给样式表
        (el as HTMLElement).style.removeProperty("transform");
        (el as HTMLElement).style.removeProperty("opacity");
      }
      resolve();
    });
    anim.addEventListener("cancel", () => {
      cleanup();
      resolve();
    });
  });
}

/* ============================================================
   公开原语
   ============================================================ */

/**
 * 淡入。对应计划书 5.5 的「章节切换」「导出结果卡片」。
 *
 * @param el 目标元素
 * @param opts 动效选项
 * @returns 动画结束的 Promise
 */
export function fadeIn(el: Animatable | null | undefined, opts: MotionOptions = {}): Promise<void> {
  return run(
    el,
    [{ opacity: 0 }, { opacity: 1 }],
    [{ opacity: 0 }, { opacity: 1 }],
    { duration: DURATION.base, easing: EASING.decelerate, ...opts },
  );
}

/**
 * 淡出。对应「弹层关闭」「删除章节」。
 *
 * @param el 目标元素
 * @param opts 动效选项
 * @returns 动画结束的 Promise
 */
export function fadeOut(el: Animatable | null | undefined, opts: MotionOptions = {}): Promise<void> {
  return run(
    el,
    [{ opacity: 1 }, { opacity: 0 }],
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: DURATION.fast, easing: EASING.accelerate, ...opts },
  );
}

/**
 * 滑入。位移只用 transform，绝不碰 top/left。
 *
 * @param el 目标元素
 * @param opts 动效选项，另可传 direction 与 distance
 * @returns 动画结束的 Promise
 */
export function slideIn(
  el: Animatable | null | undefined,
  opts: MotionOptions & { direction?: Direction; distance?: number } = {},
): Promise<void> {
  const { direction = "up", distance = 8, ...rest } = opts;
  const from = translateFor(direction, distance);
  return run(
    el,
    [{ opacity: 0 }, { opacity: 1 }],
    [
      { transform: from, opacity: 0 },
      { transform: "translateX(0) translateY(0)", opacity: 1 },
    ],
    { duration: DURATION.base, easing: EASING.decelerate, ...rest },
  );
}

/**
 * 缩放入场。对应「命令面板 / 弹窗 scale(0.96 -> 1)」。
 *
 * @param el 目标元素
 * @param opts 动效选项，另可传 from 初始缩放
 * @returns 动画结束的 Promise
 */
export function scaleIn(
  el: Animatable | null | undefined,
  opts: MotionOptions & { from?: number } = {},
): Promise<void> {
  const { from = 0.96, ...rest } = opts;
  return run(
    el,
    [{ opacity: 0 }, { opacity: 1 }],
    [
      { transform: `scale(${from})`, opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: DURATION.base, easing: EASING.standard, ...rest },
  );
}

/**
 * 折叠 / 展开。
 *
 * 注意这里用的是 scaleY 而不是 height 过渡：height 每帧都要重排，
 * 在卷章树这种长列表里会立刻掉帧。视觉上通过 transform-origin: top
 * 保持「从顶部展开」的观感。
 *
 * @param el 目标元素
 * @param collapsing true 为折叠（1 -> 0），false 为展开（0 -> 1）
 * @param opts 动效选项
 * @returns 动画结束的 Promise
 */
export function collapse(
  el: Animatable | null | undefined,
  collapsing = true,
  opts: MotionOptions = {},
): Promise<void> {
  const [from, to] = collapsing ? [1, 0] : [0, 1];
  return run(
    el,
    [{ opacity: from }, { opacity: to }],
    [
      { transform: `scaleY(${from})`, opacity: from },
      { transform: `scaleY(${to})`, opacity: to },
    ],
    {
      duration: collapsing ? DURATION.base : DURATION.slow,
      easing: collapsing ? EASING.accelerate : EASING.decelerate,
      ...opts,
    },
  );
}

/**
 * FLIP：先记录首末位置，只在 transform 上补出差值。
 *
 * 典型用法是拖拽排序——被拖项之外的兄弟节点用 FLIP 让位，
 * 全程不触发一次布局，因此可以做到「实时跟手」。
 *
 * @param el 目标元素
 * @param first 变化前的 getBoundingClientRect（只需 left/top）
 * @param last 变化后的 getBoundingClientRect
 * @param opts 动效选项，另可传 spring 选择弹簧参数
 * @returns 动画结束的 Promise
 */
export function flip(
  el: Animatable | null | undefined,
  first: { left: number; top: number },
  last: { left: number; top: number },
  opts: MotionOptions & { spring?: SpringConfig } = {},
): Promise<void> {
  const { spring = SPRING_SOFT, ...rest } = opts;
  const dx = Math.round(first.left - last.left);
  const dy = Math.round(first.top - last.top);

  // 无位移时不必起动画，省下一次配额与合成层切换
  if (dx === 0 && dy === 0) return Promise.resolve();

  const reduced = rest.reducedMotion ?? prefersReducedMotion();
  const frameOpts = optionsFor(springDuration(spring), "linear", rest.delay ?? 0);

  if (reduced) {
    return run(el, [{ opacity: 1 }, { opacity: 1 }], [], {
      ...rest,
      reducedMotion: true,
    });
  }

  if (!el || !canAnimate(el) || !acquireSlot()) return Promise.resolve();

  lock(el);
  const frames: Keyframe[] = springKeyframeOffsets(spring, 1, 0, 24).map((f) => ({
    offset: f.offset,
    transform: `translate(${Math.round(dx * f.value)}px, ${Math.round(dy * f.value)}px)`,
  }));
  const anim = (el as Required<Animatable>).animate(frames, frameOpts);
  return finish(el, anim, true, releaseSlot);
}

/**
 * 按压反馈。对应 5.5 的「按钮按下 scale(0.97) 回弹」。
 *
 * @param el 目标元素
 * @param opts 动效选项
 * @returns 动画结束的 Promise
 */
export function pressFeedback(el: Animatable | null | undefined, opts: MotionOptions = {}): Promise<void> {
  return run(
    el,
    [{ opacity: 1 }, { opacity: 1 }],
    [
      { transform: "scale(1)" },
      { transform: "scale(0.97)" },
      { transform: "scale(1)" },
    ],
    { duration: DURATION.instant, easing: EASING.standard, ...opts },
  );
}

/**
 * 数字滚动进位。对应「字数变化 / 统计数字变化」。
 *
 * 这里刻意动画的是 opacity 与 transform 的组合，而不是文本数值本身：
 * 逐帧改文本会触发文字重排，正是性能铁律禁止的做法。
 *
 * @param el 目标元素
 * @param opts 动效选项
 * @returns 动画结束的 Promise
 */
export function rollNumber(el: Animatable | null | undefined, opts: MotionOptions = {}): Promise<void> {
  return run(
    el,
    [{ opacity: 0.4 }, { opacity: 1 }],
    [
      { transform: "translateY(-0.35em)", opacity: 0 },
      { transform: "translateY(0)", opacity: 1 },
    ],
    { duration: DURATION.fast, easing: EASING.decelerate, ...opts },
  );
}

/**
 * 一次性淡入，专供热力图这类「几百个格子」的场景。
 *
 * 计划书 5.4 规定热力图只允许整体淡入一次，这个函数把该约束固化成 API：
 * 它作用于容器而非每一格，调用方没有机会逐格动画。
 *
 * @param el 容器元素（整张 SVG）
 * @param opts 动效选项
 * @returns 动画结束的 Promise
 */
export function fadeInContainer(el: Animatable | null | undefined, opts: MotionOptions = {}): Promise<void> {
  return fadeIn(el, { duration: DURATION.page, easing: EASING.decelerate, ...opts });
}
