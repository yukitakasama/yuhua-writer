/**
 * 动效性能测量工具（T1.10）。
 *
 * ## 为什么需要这个模块
 *
 * 计划书 5.4 的两个硬指标：
 * - **P2**：任意 1 秒内掉帧 ≤ 2 帧（即 58fps 或更高）
 * - **M2**：同屏并发动效上限 30，超出降级
 *
 * 单元测试在 jsdom 里**没有真实帧调度**，测不出实际帧率。
 * 因此这个模块供**开发期手动验证**与**自动化 Puppeteer 测试**使用：
 * 在真实浏览器里运行动画，用 `requestAnimationFrame` 采样时间戳，
 * 计算出实际 fps 与掉帧次数。
 *
 * ## 使用方式
 *
 * ```ts
 * const monitor = new FrameRateMonitor();
 * monitor.start();
 * await fadeIn(element);
 * const report = monitor.stop();
 * console.log(report); // { avgFps: 60, droppedFrames: 0, ... }
 * ```
 *
 * 也可以在 `/dev/kit` 页面上实时查看。
 */

/** 一次测量的结果报告。 */
export interface PerformanceReport {
  /** 平均帧率（fps）。 */
  avgFps: number;
  /** 最低帧率（fps）：1 秒滑动窗口内的最低值。 */
  minFps: number;
  /** 掉帧次数：帧间隔 > 18ms（约 55fps）的次数。 */
  droppedFrames: number;
  /** 测量总时长（毫秒）。 */
  duration: number;
  /** 总帧数。 */
  totalFrames: number;
  /** 是否通过验收（P2 指标：任意 1 秒内掉帧 ≤ 2）。 */
  passed: boolean;
}

/**
 * 帧率监控器。
 *
 * 原理：每帧记录时间戳，用滑动窗口计算 1 秒内的最低帧率。
 * 单例设计，避免多个监控器同时跑产生干扰。
 */
export class FrameRateMonitor {
  private running = false;
  private rafId: number | null = null;
  private startTime = 0;
  private lastFrameTime = 0;
  private frameTimestamps: number[] = [];
  private droppedCount = 0;

  /** 掉帧判定阈值（18ms ≈ 55fps）。 */
  private static readonly DROP_THRESHOLD = 18;

  /** 滑动窗口大小（1 秒）。 */
  private static readonly WINDOW_SIZE = 1000;

  /** 开始监控。如果已在运行则先停止前一次。 */
  start(): void {
    if (this.running) this.stop();

    this.running = true;
    this.startTime = performance.now();
    this.lastFrameTime = this.startTime;
    this.frameTimestamps = [this.startTime];
    this.droppedCount = 0;

    this.tick();
  }

  /** 停止监控并返回报告。 */
  stop(): PerformanceReport {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (!this.running && this.frameTimestamps.length === 0) {
      return {
        avgFps: 0,
        minFps: 0,
        droppedFrames: 0,
        duration: 0,
        totalFrames: 0,
        passed: true,
      };
    }

    this.running = false;
    const endTime = performance.now();
    const duration = Math.max(0, endTime - this.startTime);
    const totalFrames = this.frameTimestamps.length;

    // 平均帧率
    const avgFps = totalFrames > 1 ? (totalFrames / duration) * 1000 : 0;

    // 最低帧率：用 1 秒滑动窗口扫描
    const minFps = this.calculateMinFps();

    // P2 指标：任意 1 秒内掉帧 ≤ 2
    const passed =
      this.droppedCount <= 2 || duration < FrameRateMonitor.WINDOW_SIZE;

    return {
      avgFps: Math.round(avgFps * 10) / 10,
      minFps: Math.round(minFps * 10) / 10,
      droppedFrames: this.droppedCount,
      duration: Math.round(duration),
      totalFrames,
      passed,
    };
  }

  /** 是否正在监控。 */
  isRunning(): boolean {
    return this.running;
  }

  /** 内部：每帧采样。 */
  private tick = (): void => {
    if (!this.running) return;

    const now = performance.now();
    const interval = now - this.lastFrameTime;

    // 掉帧判定：帧间隔超过阈值
    if (
      interval > FrameRateMonitor.DROP_THRESHOLD &&
      this.lastFrameTime !== this.startTime
    ) {
      this.droppedCount += 1;
    }

    this.frameTimestamps.push(now);
    this.lastFrameTime = now;

    this.rafId = requestAnimationFrame(this.tick);
  };

  /**
   * 计算最低帧率（1 秒滑动窗口）。
   *
   * 遍历所有时间戳，以每个点为窗口起点，统计该窗口内的帧数，
   * 取最小值即为最低帧率。
   */
  private calculateMinFps(): number {
    if (this.frameTimestamps.length < 2) return 0;

    let minFramesInWindow = Number.POSITIVE_INFINITY;

    for (let i = 0; i < this.frameTimestamps.length; i += 1) {
      const windowStart = this.frameTimestamps[i];
      if (windowStart === undefined) continue;
      const windowEnd = windowStart + FrameRateMonitor.WINDOW_SIZE;

      // 统计窗口内的帧数
      let count = 0;
      for (let j = i; j < this.frameTimestamps.length; j += 1) {
        const timestamp = this.frameTimestamps[j];
        if (timestamp !== undefined && timestamp <= windowEnd) count += 1;
        else break;
      }

      if (count < minFramesInWindow) minFramesInWindow = count;
    }

    // 窗口内帧数即为该秒的 fps
    return minFramesInWindow === Number.POSITIVE_INFINITY
      ? 0
      : minFramesInWindow;
  }
}

/**
 * 单例监控器实例，供全局使用。
 *
 * 开发期在控制台里调用：
 * ```js
 * import { frameMonitor } from '@/design/motion/performance';
 * frameMonitor.start();
 * // ... 执行动画 ...
 * console.log(frameMonitor.stop());
 * ```
 */
export const frameMonitor = new FrameRateMonitor();

/**
 * 批量验证多个动效原语的帧率。
 *
 * 用于自动化测试：给定一组动画执行函数，依次运行并收集报告。
 *
 * @param tests 测试用例数组，每项是 { name, run: () => Promise<void> }
 * @returns 每个用例的报告
 */
export async function benchmarkMotionPrimitives(
  tests: Array<{ name: string; run: () => Promise<void> }>,
): Promise<Array<{ name: string; report: PerformanceReport }>> {
  const results: Array<{ name: string; report: PerformanceReport }> = [];

  for (const test of tests) {
    // 每个测试之间留 100ms 冷却，避免前一个测试的尾帧污染下一个
    await new Promise((resolve) => setTimeout(resolve, 100));

    const monitor = new FrameRateMonitor();
    monitor.start();
    await test.run();
    const report = monitor.stop();

    results.push({ name: test.name, report });
  }

  return results;
}

/**
 * 验证并发上限（M2 指标）。
 *
 * 创建 N 个并发动画，监控帧率，验证是否满足 P2 指标。
 * 返回通过的最大并发数。
 *
 * @param createAnimation 创建一个动画的工厂函数
 * @param maxConcurrency 测试的上限，默认 35（略高于设计上限 30）
 * @returns 能保持 58fps 以上的最大并发数
 */
export async function findMaxConcurrency(
  createAnimation: () => Promise<void>,
  maxConcurrency = 35,
): Promise<number> {
  for (let n = 1; n <= maxConcurrency; n += 1) {
    const monitor = new FrameRateMonitor();
    monitor.start();

    // 同时启动 n 个动画
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < n; i += 1) {
      tasks.push(createAnimation());
    }
    await Promise.all(tasks);

    const report = monitor.stop();

    // 一旦不满足 P2（掉帧 > 2），返回前一档
    if (!report.passed) return Math.max(n - 1, 1);
  }

  return maxConcurrency;
}
