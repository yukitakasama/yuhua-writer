/**
 * P3 / P4 埋点的行为测试。
 *
 * ## 为什么这条测试重要
 *
 * 埋点最容易出的问题不是「没数」，而是**数错了还看起来很合理**：
 * 起点终点选错、快速切章时把两次请求混算成一次、重复触发把首次值覆盖掉。
 * 这些都会产出一个像模像样的毫秒数。所以这里全部围绕
 * 「什么情况下必须不记录」来写。
 *
 * ## 时钟
 *
 * `performance.now()` 被替换成可推进的假时钟，断言的是**精确差值**而不是
 * 「大于 0」—— 后者连「起点终点写反了」都测不出来。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetPerfForTests,
  finishChapterOpen,
  markEditorReady,
  perfSnapshot,
  startChapterOpen,
} from "./perf";

/** 可控时钟：`now()` 内部走全局 performance。 */
let clock = 0;

beforeEach(() => {
  clock = 1000;
  vi.stubGlobal("performance", { now: () => clock });
  __resetPerfForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("P3：启动到可输入", () => {
  it("没触发就绪前不编造数字", () => {
    expect(perfSnapshot().editorReadyMs).toBeNull();
  });

  it("记录的是相对模块加载的差值，不是绝对时间戳", () => {
    clock = 1337;
    markEditorReady();
    // origin 在 perf.ts 求值时取的，本用例里是 beforeEach 设定的 1000
    expect(perfSnapshot().editorReadyMs).toBe(337);
  });

  it("只认第一次：重挂编辑器不会把冷启动数字改小或改大", () => {
    markEditorReady();
    const first = perfSnapshot().editorReadyMs;
    clock += 5000;
    markEditorReady();
    expect(perfSnapshot().editorReadyMs).toBe(first);
  });
});

describe("P4：打开一章的耗时", () => {
  it("起点到终点的完整差值", () => {
    startChapterOpen("ch_a");
    clock = 1180;
    finishChapterOpen("ch_a");

    const snap = perfSnapshot();
    expect(snap.lastChapterOpenMs).toBe(180);
    expect(snap.chapterOpens).toEqual([180]);
  });

  it("没有起点就不记录（新建章等路径不会污染样本）", () => {
    finishChapterOpen("ch_new");
    expect(perfSnapshot().lastChapterOpenMs).toBeNull();
    expect(perfSnapshot().chapterOpens).toEqual([]);
  });

  it("id 不匹配时忽略：快速连点两章，慢回来的那次不算数", () => {
    startChapterOpen("ch_a");
    startChapterOpen("ch_b");
    clock += 40;
    // 迟到完成的 ch_a：现在的计时对象已经是 ch_b
    finishChapterOpen("ch_a");
    expect(perfSnapshot().chapterOpens).toEqual([]);

    clock += 60;
    finishChapterOpen("ch_b");
    // ch_b 从它自己的起点算起，是 100 ms 而不是 140 ms
    expect(perfSnapshot().lastChapterOpenMs).toBe(100);
  });

  it("一次完成后可以开始下一次", () => {
    startChapterOpen("ch_a");
    clock += 50;
    finishChapterOpen("ch_a");
    startChapterOpen("ch_b");
    clock += 80;
    finishChapterOpen("ch_b");
    expect(perfSnapshot().chapterOpens).toEqual([50, 80]);
  });

  it("中位数用样本中间值，一次离群值拉不歪它", () => {
    // P4 是「≤ 150 ms」这种阈值判定，均值会被一次 GC 顶过去
    for (const [index, ms] of [100, 120, 110, 5000].entries()) {
      startChapterOpen(`ch_${index}`);
      clock += ms;
      finishChapterOpen(`ch_${index}`);
    }
    const snap = perfSnapshot();
    expect(snap.chapterOpens).toEqual([100, 120, 110, 5000]);
    expect(snap.medianChapterOpenMs).toBe(115);
    expect(
      snap.chapterOpens.reduce((a, b) => a + b, 0) / snap.chapterOpens.length,
    ).toBeGreaterThan(1325);
  });

  it("样本只保留最近 20 个", () => {
    for (let i = 0; i < 25; i += 1) {
      startChapterOpen(`ch_${i}`);
      clock += 10 + i;
      finishChapterOpen(`ch_${i}`);
    }
    const snap = perfSnapshot();
    // 耗时各不相同，所以这条能真正区分「丢最旧」与「丢最新」：
    // 若实现写成 push 后 pop()（丢最新），基准会永久停在开头那几个样本上
    expect(snap.chapterOpens).toHaveLength(20);
    expect(snap.chapterOpens[0]).toBe(15);
    expect(snap.chapterOpens.at(-1)).toBe(34);
  });
});

describe("快照是值拷贝", () => {
  it("改快照里的数组不会影响内部状态", () => {
    startChapterOpen("ch_a");
    clock += 10;
    finishChapterOpen("ch_a");

    const snapshot = perfSnapshot();
    (snapshot.chapterOpens as number[]).push(99999);
    expect(perfSnapshot().chapterOpens).toEqual([10]);
  });
});
