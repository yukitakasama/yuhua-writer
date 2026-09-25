/**
 * 动效原语测试。
 *
 * 重点是三条硬性约束的验证，而不是像素级效果：
 *   1. 并发计数与超限降级
 *   2. will-change 的开与关成对出现
 *   3. 关键帧里绝不出现被禁动画属性
 *
 * jsdom 不实现 WAAPI，因此这里用一个最小 Animation 替身来控制
 * 「动画何时结束」，从而稳定地测试收尾逻辑。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSlot,
  collapse,
  fadeIn,
  fadeOut,
  flip,
  fadeInContainer,
  getDegradedCount,
  getRunningCount,
  pressFeedback,
  releaseSlot,
  resetMotionCounters,
  rollNumber,
  scaleIn,
  slideIn,
  springDuration,
  springKeyframeOffsets,
  springValue,
} from "./primitives";
import { MAX_CONCURRENT_ANIMATIONS, SPRING_SNAPPY, SPRING_SOFT } from "./tokens";

/** 记录一次 animate 调用的全部细节。 */
interface AnimCall {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  el: HTMLElement;
}

/** 受控的 Animation 替身。 */
class FakeAnimation {
  private readonly listeners = new Map<string, (() => void)[]>();
  public cancelled = false;

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** 手动触发 finish，模拟动画自然结束。 */
  emitFinish(): void {
    for (const fn of this.listeners.get("finish") ?? []) fn();
  }

  /** 手动触发 cancel，模拟动画被打断。 */
  emitCancel(): void {
    for (const fn of this.listeners.get("cancel") ?? []) fn();
  }
}

let calls: AnimCall[] = [];
let pending: FakeAnimation[] = [];

/** 给元素装上 animate 替身。 */
function attach(el: HTMLElement): FakeAnimation[] {
  const created: FakeAnimation[] = [];
  Object.defineProperty(el, "animate", {
    configurable: true,
    writable: true,
    value: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const anim = new FakeAnimation();
      calls.push({ keyframes, options, el });
      created.push(anim);
      pending.push(anim);
      return anim as unknown as Animation;
    },
  });
  return created;
}

/** 结束全部尚未结束的动画，避免测试间互相污染计数。 */
function finishAll(): void {
  const list = pending;
  pending = [];
  for (const a of list) a.emitFinish();
}

beforeEach(() => {
  calls = [];
  pending = [];
  resetMotionCounters();
});

afterEach(() => {
  finishAll();
  resetMotionCounters();
  vi.restoreAllMocks();
});

describe("并发配额", () => {
  it("初始计数为 0", () => {
    expect(getRunningCount()).toBe(0);
    expect(getDegradedCount()).toBe(0);
  });

  it("每次占用使计数加一，每次归还会减一", () => {
    expect(acquireSlot()).toBe(true);
    expect(acquireSlot()).toBe(true);
    expect(getRunningCount()).toBe(2);
    releaseSlot();
    expect(getRunningCount()).toBe(1);
  });

  it("恰好用满 30 个配额时仍然成功", () => {
    for (let i = 0; i < MAX_CONCURRENT_ANIMATIONS; i += 1) {
      expect(acquireSlot()).toBe(true);
    }
    expect(getRunningCount()).toBe(MAX_CONCURRENT_ANIMATIONS);
    expect(getDegradedCount()).toBe(0);
  });

  it("第 31 个配额被拒绝并记入降级计数", () => {
    for (let i = 0; i < MAX_CONCURRENT_ANIMATIONS; i += 1) acquireSlot();
    expect(acquireSlot()).toBe(false);
    expect(acquireSlot()).toBe(false);
    expect(getRunningCount()).toBe(MAX_CONCURRENT_ANIMATIONS);
    expect(getDegradedCount()).toBe(2);
  });

  it("多余的归还会把计数压到 0 而不是负数", () => {
    releaseSlot();
    releaseSlot();
    expect(getRunningCount()).toBe(0);
  });

  it("释放一个配额后又能重新占用", () => {
    for (let i = 0; i < MAX_CONCURRENT_ANIMATIONS; i += 1) acquireSlot();
    releaseSlot();
    expect(acquireSlot()).toBe(true);
    expect(getRunningCount()).toBe(MAX_CONCURRENT_ANIMATIONS);
  });
});

describe("fadeIn / fadeOut", () => {
  it("只动画 opacity，不碰任何布局属性", () => {
    const el = document.createElement("div");
    attach(el);
    void fadeIn(el, { reducedMotion: false });

    expect(calls).toHaveLength(1);
    const frames = calls[0]!.keyframes;
    for (const frame of frames) {
      expect(Object.keys(frame).filter((k) => k !== "offset")).toEqual(["opacity"]);
    }
    expect(frames[0]!.opacity).toBe(0);
    expect(frames[1]!.opacity).toBe(1);
  });

  it("默认使用 base 时长与 decelerate 曲线", () => {
    const el = document.createElement("div");
    attach(el);
    void fadeIn(el, { reducedMotion: false });
    expect(calls[0]!.options.duration).toBe(180);
    expect(calls[0]!.options.easing).toBe("cubic-bezier(0, 0, 0, 1)");
  });

  it("结束后清除 will-change 与内联 transform", async () => {
    const el = document.createElement("div");
    const anims = attach(el);
    const done = fadeIn(el, { reducedMotion: false });

    expect(el.style.willChange).toContain("transform");
    anims[0]!.emitFinish();
    await done;

    expect(el.style.willChange).toBe("");
    expect(el.style.transform).toBe("");
    expect(el.style.opacity).toBe("");
  });

  it("动画被取消时同样清干净并归还配额", async () => {
    const el = document.createElement("div");
    const anims = attach(el);
    const done = fadeIn(el, { reducedMotion: false });
    expect(getRunningCount()).toBe(1);

    anims[0]!.emitCancel();
    await done;

    expect(getRunningCount()).toBe(0);
    expect(el.style.willChange).toBe("");
  });

  it("重复 finish 事件不会把计数减成负数", async () => {
    const el = document.createElement("div");
    const anims = attach(el);
    const done = fadeIn(el, { reducedMotion: false });
    anims[0]!.emitFinish();
    anims[0]!.emitFinish();
    await done;
    expect(getRunningCount()).toBe(0);
  });

  it("淡出方向与淡入相反", () => {
    const el = document.createElement("div");
    attach(el);
    void fadeOut(el, { reducedMotion: false });
    expect(calls[0]!.keyframes[0]!.opacity).toBe(1);
    expect(calls[0]!.keyframes[1]!.opacity).toBe(0);
  });

  it("元素为 null 时安静返回，不抛错也不占配额", async () => {
    await expect(fadeIn(null)).resolves.toBeUndefined();
    await expect(fadeOut(undefined)).resolves.toBeUndefined();
    expect(getRunningCount()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("slideIn", () => {
  it("位移通过 transform 表达", () => {
    const el = document.createElement("div");
    attach(el);
    void slideIn(el, { reducedMotion: false, direction: "up", distance: 8 });
    expect(calls[0]!.keyframes[0]!.transform).toBe("translateY(8px)");
    expect(calls[0]!.keyframes[1]!.transform).toBe("translateX(0) translateY(0)");
  });

  it("四个方向各自映射到正确的位移轴", () => {
    const cases: [string, string][] = [
      ["up", "translateY(10px)"],
      ["down", "translateY(-10px)"],
      ["left", "translateX(10px)"],
      ["right", "translateX(-10px)"],
    ];
    for (const [dir, expected] of cases) {
      calls = [];
      const el = document.createElement("div");
      attach(el);
      void slideIn(el, { reducedMotion: false, direction: dir as "up", distance: 10 });
      expect(calls[0]!.keyframes[0]!.transform, dir).toBe(expected);
    }
  });

  it("reduced-motion 下降级为纯透明度变化", () => {
    const el = document.createElement("div");
    attach(el);
    void slideIn(el, { reducedMotion: true });
    for (const frame of calls[0]!.keyframes) {
      expect(frame.transform).toBeUndefined();
    }
    expect(calls[0]!.options.duration).toBeLessThanOrEqual(100);
  });
});

describe("scaleIn", () => {
  it("默认从 0.96 缩放到 1", () => {
    const el = document.createElement("div");
    attach(el);
    void scaleIn(el, { reducedMotion: false });
    expect(calls[0]!.keyframes[0]!.transform).toBe("scale(0.96)");
    expect(calls[0]!.keyframes[1]!.transform).toBe("scale(1)");
  });

  it("可以自定义起始缩放", () => {
    const el = document.createElement("div");
    attach(el);
    void scaleIn(el, { reducedMotion: false, from: 0.8 });
    expect(calls[0]!.keyframes[0]!.transform).toBe("scale(0.8)");
  });
});

describe("collapse", () => {
  it("用 scaleY 而不是 height 过渡", () => {
    const el = document.createElement("div");
    attach(el);
    void collapse(el, true, { reducedMotion: false });
    const frames = calls[0]!.keyframes;
    expect(frames[0]!.transform).toBe("scaleY(1)");
    expect(frames[1]!.transform).toBe("scaleY(0)");
    for (const frame of frames) {
      expect(frame.height).toBeUndefined();
    }
  });

  it("展开方向与折叠相反", () => {
    const el = document.createElement("div");
    attach(el);
    void collapse(el, false, { reducedMotion: false });
    expect(calls[0]!.keyframes[0]!.transform).toBe("scaleY(0)");
    expect(calls[0]!.keyframes[1]!.transform).toBe("scaleY(1)");
  });

  it("折叠用 accelerate，展开用 decelerate", () => {
    const a = document.createElement("div");
    attach(a);
    void collapse(a, true, { reducedMotion: false });
    expect(calls[0]!.options.easing).toBe("cubic-bezier(0.3, 0, 1, 1)");

    calls = [];
    const b = document.createElement("div");
    attach(b);
    void collapse(b, false, { reducedMotion: false });
    expect(calls[0]!.options.easing).toBe("cubic-bezier(0, 0, 0, 1)");
  });
});

describe("flip", () => {
  it("按首末位置差生成位移关键帧", () => {
    const el = document.createElement("div");
    attach(el);
    void flip(el, { left: 10, top: 60 }, { left: 10, top: 20 }, { reducedMotion: false });

    expect(calls).toHaveLength(1);
    const first = calls[0]!.keyframes[0]!;
    const last = calls[0]!.keyframes.at(-1)!;
    // 起点要「补回」原有位移，终点回到 0
    expect(String(first.transform)).toContain("translate(0px, 40px)");
    expect(String(last.transform)).toContain("translate(0px, 0px)");
  });

  it("位置没变时不起动画，也不占配额", async () => {
    const el = document.createElement("div");
    attach(el);
    await flip(el, { left: 5, top: 5 }, { left: 5, top: 5 });
    expect(calls).toHaveLength(0);
    expect(getRunningCount()).toBe(0);
  });

  it("关键帧 offset 单调递增且覆盖 0..1", () => {
    const el = document.createElement("div");
    attach(el);
    void flip(el, { left: 0, top: 100 }, { left: 0, top: 0 }, { reducedMotion: false });
    const offsets = calls[0]!.keyframes.map((f) => Number(f.offset));
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(1);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
    }
  });

  it("reduced-motion 时不产生位移动画", () => {
    const el = document.createElement("div");
    attach(el);
    void flip(el, { left: 0, top: 100 }, { left: 0, top: 0 }, { reducedMotion: true });
    for (const frame of calls[0]!.keyframes) {
      expect(frame.transform).toBeUndefined();
    }
  });
});

describe("pressFeedback / rollNumber / fadeInContainer", () => {
  it("按压反馈回到原尺寸，不留残余缩放", () => {
    const el = document.createElement("div");
    attach(el);
    void pressFeedback(el, { reducedMotion: false });
    const frames = calls[0]!.keyframes;
    expect(frames[0]!.transform).toBe("scale(1)");
    expect(frames[1]!.transform).toBe("scale(0.97)");
    expect(frames.at(-1)!.transform).toBe("scale(1)");
  });

  it("按压反馈用 instant 时长", () => {
    const el = document.createElement("div");
    attach(el);
    void pressFeedback(el, { reducedMotion: false });
    expect(calls[0]!.options.duration).toBe(80);
  });

  it("数字滚动只用 transform 与 opacity，不写文本", () => {
    const el = document.createElement("div");
    attach(el);
    void rollNumber(el, { reducedMotion: false });
    for (const frame of calls[0]!.keyframes) {
      const keys = Object.keys(frame).filter((k) => k !== "offset");
      for (const key of keys) {
        expect(["transform", "opacity"]).toContain(key);
      }
    }
  });

  it("热力图整体淡入用 page 时长，且作用在容器上", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    attach(svg as unknown as HTMLElement);
    void fadeInContainer(svg as unknown as HTMLElement, { reducedMotion: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.duration).toBe(320);
    expect(calls[0]!.el).toBe(svg);
  });
});

describe("超限降级", () => {
  it("超过 30 个并发动效后不再起新动画", async () => {
    const anims: FakeAnimation[] = [];
    for (let i = 0; i < MAX_CONCURRENT_ANIMATIONS; i += 1) {
      const el = document.createElement("div");
      anims.push(...attach(el));
      void fadeIn(el, { reducedMotion: false });
    }
    expect(calls).toHaveLength(MAX_CONCURRENT_ANIMATIONS);
    expect(getRunningCount()).toBe(MAX_CONCURRENT_ANIMATIONS);

    // 第 31 个：应当被降级，既不产生 animate 调用，也不长时间挂起
    const extra = document.createElement("div");
    attach(extra);
    const done = fadeIn(extra, { reducedMotion: false });

    expect(calls).toHaveLength(MAX_CONCURRENT_ANIMATIONS);
    await expect(done).resolves.toBeUndefined();
    expect(getDegradedCount()).toBe(1);
    // 降级不占用合成层，因此不应留下 will-change
    expect(extra.style.willChange).toBe("");
  });

  it("释放配额后降级的元素重新获得动画机会", async () => {
    for (let i = 0; i < MAX_CONCURRENT_ANIMATIONS; i += 1) {
      const el = document.createElement("div");
      attach(el);
      void fadeIn(el, { reducedMotion: false });
    }
    expect(getRunningCount()).toBe(MAX_CONCURRENT_ANIMATIONS);

    // attach 返回的数组是在 animate 真正被调用时才填充的，
    // 因此这里必须从 pending 取，否则拿到的是空数组，配额永远不会归还。
    const started = [...pending];
    expect(started).toHaveLength(MAX_CONCURRENT_ANIMATIONS);
    for (const a of started) a.emitFinish();
    await Promise.resolve();
    expect(getRunningCount()).toBe(0);

    calls = [];
    const el = document.createElement("div");
    attach(el);
    void fadeIn(el, { reducedMotion: false });
    expect(calls).toHaveLength(1);
  });
});

describe("缺少 WAAPI 时的退化", () => {
  it("元素没有 animate 方法时安静返回", async () => {
    const el = document.createElement("div");
    await expect(fadeIn(el, { reducedMotion: false })).resolves.toBeUndefined();
    expect(getRunningCount()).toBe(0);
  });

  it("没有 animate 时不会留下 will-change", async () => {
    const el = document.createElement("div");
    await fadeIn(el, { reducedMotion: false });
    expect(el.style.willChange).toBe("");
  });
});

describe("自研弹簧", () => {
  it("t=0 时进度为 0", () => {
    expect(springValue(SPRING_SOFT, 0)).toBeCloseTo(0, 5);
    expect(springValue(SPRING_SNAPPY, 0)).toBeCloseTo(0, 5);
  });

  it("足够长的时间后收敛到 1", () => {
    expect(springValue(SPRING_SOFT, springDuration(SPRING_SOFT))).toBeCloseTo(1, 2);
    expect(springValue(SPRING_SNAPPY, springDuration(SPRING_SNAPPY))).toBeCloseTo(1, 2);
  });

  it("软弹簧会产生超过 1 的回弹", () => {
    let max = 0;
    for (let t = 0; t < springDuration(SPRING_SOFT); t += 4) {
      max = Math.max(max, springValue(SPRING_SOFT, t));
    }
    expect(max).toBeGreaterThan(1);
  });

  it("进度不会失控到荒谬的量级", () => {
    for (let t = 0; t <= 1200; t += 25) {
      const v = springValue(SPRING_SOFT, t);
      expect(v).toBeLessThan(2);
      expect(v).toBeGreaterThan(-1);
    }
  });

  it("临界阻尼与过阻尼都不会发散", () => {
    const critical = { stiffness: 300, damping: 2 * Math.sqrt(300) };
    const over = { stiffness: 300, damping: 80 };
    for (const cfg of [critical, over]) {
      expect(springValue(cfg, 0)).toBeCloseTo(0, 5);
      expect(springValue(cfg, springDuration(cfg))).toBeCloseTo(1, 2);
    }
  });

  it("异常刚度不会导致除零或 NaN", () => {
    const broken = { stiffness: 0, damping: 0 };
    expect(Number.isFinite(springValue(broken, 100))).toBe(true);
    expect(Number.isFinite(springDuration(broken))).toBe(true);
  });

  it("稳定时长落在合理区间且脆弹簧更短", () => {
    const soft = springDuration(SPRING_SOFT);
    const snappy = springDuration(SPRING_SNAPPY);
    expect(soft).toBeGreaterThanOrEqual(100);
    expect(soft).toBeLessThanOrEqual(1200);
    expect(snappy).toBeLessThan(soft);
  });

  it("关键帧 offset 从 0 到 1 且单调不减", () => {
    const frames = springKeyframeOffsets(SPRING_SOFT);
    expect(frames).toHaveLength(31);
    expect(frames[0]!.offset).toBe(0);
    expect(frames.at(-1)!.offset).toBe(1);
    expect(frames[0]!.value).toBeCloseTo(0, 5);
    expect(frames.at(-1)!.value).toBeCloseTo(1, 2);
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i]!.offset).toBeGreaterThan(frames[i - 1]!.offset);
    }
  });

  it("支持自定义采样段数", () => {
    expect(springKeyframeOffsets(SPRING_SOFT, 0, 1, 4)).toHaveLength(5);
  });

  it("可以反向插值（从 1 到 0）", () => {
    const frames = springKeyframeOffsets(SPRING_SOFT, 1, 0, 4);
    expect(frames[0]!.value).toBeCloseTo(1, 5);
    expect(frames.at(-1)!.value).toBeCloseTo(0, 2);
  });
});
