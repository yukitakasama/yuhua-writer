/**
 * 动效性能验证测试（T1.10）。
 *
 * ## 测试范围
 *
 * 这个文件验证：
 * 1. FrameRateMonitor 本身的计量逻辑是否正确
 * 2. 各个动效原语在真实浏览器环境下是否满足 P2 指标
 *
 * ## 为什么部分测试标记为 `.skip`
 *
 * jsdom **没有真实的帧调度与布局引擎**，`requestAnimationFrame` 会立刻同步执行，
 * 因此在单测里帧率恒为无穷大。真实帧率测量必须在真实浏览器里跑，
 * 有两种方式：
 *
 * 1. **手动验收**：`pnpm tauri:dev` 后打开 `/dev/kit` 页面，
 *    点击「Run Performance Tests」按钮，查看每个原语的实际帧率。
 * 2. **自动化 E2E**：用 Playwright/Puppeteer 驱动真实浏览器执行这些测试。
 *
 * 本文件里的 `.skip` 测试提供了自动化的骨架，将来接入 E2E 时取消 skip 即可。
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  benchmarkMotionPrimitives,
  findMaxConcurrency,
  FrameRateMonitor,
} from "./performance";
import {
  fadeIn,
  fadeOut,
  scaleIn,
  slideIn,
  collapse,
  flip,
  pressFeedback,
  rollNumber,
} from "./primitives";
import { resetMotionCounters } from "./primitives";

describe("FrameRateMonitor · 计量逻辑", () => {
  it("创建实例并启动", () => {
    const monitor = new FrameRateMonitor();
    expect(monitor.isRunning()).toBe(false);
    monitor.start();
    expect(monitor.isRunning()).toBe(true);
    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
  });

  it("重复 start 会先停止前一次", () => {
    const monitor = new FrameRateMonitor();
    monitor.start();
    const firstRunning = monitor.isRunning();
    monitor.start();
    expect(firstRunning).toBe(true);
    expect(monitor.isRunning()).toBe(true);
    monitor.stop();
  });

  it("stop 返回报告对象，包含必需字段", () => {
    const monitor = new FrameRateMonitor();
    monitor.start();
    const report = monitor.stop();
    expect(report).toHaveProperty("avgFps");
    expect(report).toHaveProperty("minFps");
    expect(report).toHaveProperty("droppedFrames");
    expect(report).toHaveProperty("duration");
    expect(report).toHaveProperty("totalFrames");
    expect(report).toHaveProperty("passed");
  });

  it("未启动时调用 stop 不崩溃，返回零值报告", () => {
    const monitor = new FrameRateMonitor();
    const report = monitor.stop();
    expect(report.totalFrames).toBe(0);
    expect(report.duration).toBe(0);
  });
});

describe.skip("动效原语帧率验证（需在真实浏览器中运行）", () => {
  /**
   * 这些测试在 jsdom 里跑不出真实帧率。
   * 将来接入 Playwright 时，把这个 describe.skip 改成 describe，
   * 在真实 Chromium 里执行。
   */

  beforeEach(() => {
    resetMotionCounters();
    document.body.innerHTML = "";
  });

  it("fadeIn 保持 58fps 以上", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const monitor = new FrameRateMonitor();
    monitor.start();
    await fadeIn(el, { duration: 300 });
    const report = monitor.stop();

    expect(report.avgFps, `平均 fps: ${report.avgFps}`).toBeGreaterThanOrEqual(
      58,
    );
    expect(
      report.droppedFrames,
      `掉帧: ${report.droppedFrames}`,
    ).toBeLessThanOrEqual(2);
    expect(report.passed).toBe(true);
  });

  it("fadeOut 保持 58fps 以上", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const monitor = new FrameRateMonitor();
    monitor.start();
    await fadeOut(el, { duration: 300 });
    const report = monitor.stop();

    expect(report.avgFps).toBeGreaterThanOrEqual(58);
    expect(report.droppedFrames).toBeLessThanOrEqual(2);
  });

  it("slideIn 保持 58fps 以上", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const monitor = new FrameRateMonitor();
    monitor.start();
    await slideIn(el, { duration: 300, direction: "up", distance: 16 });
    const report = monitor.stop();

    expect(report.avgFps).toBeGreaterThanOrEqual(58);
    expect(report.droppedFrames).toBeLessThanOrEqual(2);
  });

  it("scaleIn 保持 58fps 以上", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const monitor = new FrameRateMonitor();
    monitor.start();
    await scaleIn(el, { duration: 300 });
    const report = monitor.stop();

    expect(report.avgFps).toBeGreaterThanOrEqual(58);
    expect(report.droppedFrames).toBeLessThanOrEqual(2);
  });

  it("collapse 展开保持 58fps 以上", async () => {
    const el = document.createElement("div");
    el.style.height = "100px";
    document.body.appendChild(el);

    const monitor = new FrameRateMonitor();
    monitor.start();
    await collapse(el, false, { duration: 300 });
    const report = monitor.stop();

    expect(report.avgFps).toBeGreaterThanOrEqual(58);
    expect(report.droppedFrames).toBeLessThanOrEqual(2);
  });

  it("collapse 折叠保持 58fps 以上", async () => {
    const el = document.createElement("div");
    el.style.height = "100px";
    document.body.appendChild(el);

    const monitor = new FrameRateMonitor();
    monitor.start();
    await collapse(el, true, { duration: 300 });
    const report = monitor.stop();

    expect(report.avgFps).toBeGreaterThanOrEqual(58);
    expect(report.droppedFrames).toBeLessThanOrEqual(2);
  });

  it("flip (FLIP 动画) 保持 58fps 以上", async () => {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.left = "0px";
    el.style.top = "0px";
    document.body.appendChild(el);

    const first = { left: 0, top: 0 };
    el.style.left = "100px";
    el.style.top = "100px";
    const last = { left: 100, top: 100 };

    const monitor = new FrameRateMonitor();
    monitor.start();
    await flip(el, first, last);
    const report = monitor.stop();

    expect(report.avgFps).toBeGreaterThanOrEqual(58);
    expect(report.droppedFrames).toBeLessThanOrEqual(2);
  });

  it("pressFeedback 保持 58fps 以上", async () => {
    const el = document.createElement("button");
    document.body.appendChild(el);

    const monitor = new FrameRateMonitor();
    monitor.start();
    await pressFeedback(el);
    const report = monitor.stop();

    expect(report.avgFps).toBeGreaterThanOrEqual(58);
    expect(report.droppedFrames).toBeLessThanOrEqual(2);
  });

  it("rollNumber 保持 58fps 以上", async () => {
    const el = document.createElement("span");
    el.textContent = "1234";
    document.body.appendChild(el);

    const monitor = new FrameRateMonitor();
    monitor.start();
    await rollNumber(el);
    const report = monitor.stop();

    expect(report.avgFps).toBeGreaterThanOrEqual(58);
    expect(report.droppedFrames).toBeLessThanOrEqual(2);
  });
});

describe.skip("并发上限验证（M2 指标，需在真实浏览器中运行）", () => {
  beforeEach(() => {
    resetMotionCounters();
    document.body.innerHTML = "";
  });

  it("30 个并发 fadeIn 保持 58fps 以上", async () => {
    const elements: HTMLElement[] = [];
    for (let i = 0; i < 30; i += 1) {
      const el = document.createElement("div");
      el.style.width = "50px";
      el.style.height = "50px";
      document.body.appendChild(el);
      elements.push(el);
    }

    const monitor = new FrameRateMonitor();
    monitor.start();

    const tasks = elements.map((el) => fadeIn(el, { duration: 300 }));
    await Promise.all(tasks);

    const report = monitor.stop();
    expect(
      report.avgFps,
      `30 并发平均 fps: ${report.avgFps}`,
    ).toBeGreaterThanOrEqual(58);
    expect(
      report.droppedFrames,
      `30 并发掉帧: ${report.droppedFrames}`,
    ).toBeLessThanOrEqual(2);
  });

  it("超过 30 个并发时降级为直接切换（不做动画）", async () => {
    const elements: HTMLElement[] = [];
    for (let i = 0; i < 35; i += 1) {
      const el = document.createElement("div");
      document.body.appendChild(el);
      elements.push(el);
    }

    const tasks = elements.map((el) => fadeIn(el, { duration: 300 }));
    await Promise.all(tasks);

    // 前 30 个应该执行动画，后 5 个应该降级
    // 这个断言依赖 primitives.ts 里的 acquireSlot / releaseSlot 实现
  });
});

describe("benchmarkMotionPrimitives 批量测试", () => {
  it("接受测试用例数组并返回报告", async () => {
    const tests = [
      {
        name: "test-1",
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      },
      {
        name: "test-2",
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      },
    ];

    const results = await benchmarkMotionPrimitives(tests);
    expect(results).toHaveLength(2);
    expect(results[0]?.name).toBe("test-1");
    expect(results[1]?.name).toBe("test-2");
    expect(results[0]?.report).toHaveProperty("avgFps");
  });

  it("测试之间有冷却间隔，避免前一个测试污染下一个", async () => {
    const timestamps: number[] = [];
    const tests = [
      {
        name: "a",
        run: async () => {
          timestamps.push(Date.now());
        },
      },
      {
        name: "b",
        run: async () => {
          timestamps.push(Date.now());
        },
      },
    ];

    await benchmarkMotionPrimitives(tests);
    expect(timestamps).toHaveLength(2);
    // 冷却间隔是 100ms，实际间隔应 >= 100ms
    const gap = (timestamps[1] ?? 0) - (timestamps[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(90); // 留 10ms 余量
  });
});

describe("findMaxConcurrency 并发上限查找", () => {
  it("返回能保持帧率的最大并发数", async () => {
    let callCount = 0;
    const createAnimation = async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    // 在 jsdom 里这个测试意义不大（帧率恒为无穷），但至少能验证函数不崩溃
    const maxN = await findMaxConcurrency(createAnimation, 5);
    expect(callCount).toBeGreaterThanOrEqual(maxN);
    expect(maxN).toBeGreaterThanOrEqual(1);
    expect(maxN).toBeLessThanOrEqual(5);
  });
});
