/**
 * 统计页组件渲染测试（T8.7 到 T8.13）。
 *
 * ## 与 stats.test.ts 的分工
 *
 * stats.test.ts 锁的是**几何与日期**（42 格、371 格、阈值递增）；
 * 这里锁的是**接线**：SVG 到底有没有被渲染出来、格子有没有绑上
 * data-* 属性（事件委托靠它）、进度环有没有被拒绝渲染。
 *
 * ## 最要紧的一条断言：逐格不动画
 *
 * 计划书 T8.9 明确要求「365 格逐格不做动画」。这条约束在代码里
 * 没有"看得见"的痕迹（它只是"没写 transition"），因此必须有一条测试
 * 把它钉住 —— 否则后来者顺手加一个 `.stats-cell { transition: fill }`，
 * 统计页首次渲染就会掉出 200ms 预算，而且没人会立刻发现。
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BreakdownView } from "./BreakdownView";
import { CalendarView } from "./CalendarView";
import { GoalView } from "./GoalView";
import { HeatmapView } from "./HeatmapView";
import { OverviewView } from "./OverviewView";
import { PrivacyNote } from "./PrivacyNote";
import { ProgressRing } from "./ProgressRing";
import { buildThresholds, type DayMap, type StatsSummary } from "./model";

const here = dirname(fileURLToPath(import.meta.url));

/** 把组件渲染到临时节点里，返回清理函数。 */
function mount(component: () => unknown): {
  root: HTMLElement;
  dispose: () => void;
} {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = render(component as never, root);
  return {
    root,
    dispose: () => {
      dispose();
      root.remove();
    },
  };
}

/** 造一份按天记录。 */
function days(entries: Array<[string, number]>): DayMap {
  const map: DayMap = {};
  for (const [date, words] of entries) {
    map[date] = { date, words, minutes: 30, chapters: 1 };
  }
  return map;
}

/** 造一份汇总。 */
function summary(overrides: Partial<StatsSummary> = {}): StatsSummary {
  return {
    totalWords: 0,
    thisMonth: 0,
    thisWeek: 0,
    today: 0,
    activeDays: 0,
    averagePerDay7: 0,
    bestDay: 0,
    bestDayDate: null,
    totalMinutes: 0,
    streak: 0,
    streakThreshold: 100,
    estimatedCompletion: null,
    remainingDays: null,
    ...overrides,
  };
}

describe("码字日历（T8.7）", () => {
  const baseProps = {
    days: days([["2026-01-06", 8000]]),
    month: { year: 2026, month: 1 },
    thresholds: buildThresholds([100, 8000]),
    hasSamples: true,
    onPrev: () => undefined,
    onNext: () => undefined,
    onToday: () => undefined,
  };

  it("渲染出 42 个日期格", () => {
    const { root, dispose } = mount(() => <CalendarView {...baseProps} />);
    expect(root.querySelectorAll("rect.stats-cell")).toHaveLength(42);
    dispose();
  });

  it("每格带 data-date 与 data-value（事件委托靠它反查）", () => {
    const { root, dispose } = mount(() => <CalendarView {...baseProps} />);
    const cells = [...root.querySelectorAll("rect.stats-cell")];
    const cell = cells.find(
      (c) => c.getAttribute("data-date") === "2026-01-06",
    );
    expect(cell).toBeTruthy();
    expect(cell?.getAttribute("data-value")).toBe("8000");
    dispose();
  });

  it("格子用色阶取色，写出字的那天不是 0 档", () => {
    const { root, dispose } = mount(() => <CalendarView {...baseProps} />);
    const filled = root.querySelector(
      "rect.stats-cell[data-date='2026-01-06']",
    );
    const empty = root.querySelector("rect.stats-cell[data-date='2026-01-20']");
    expect(filled?.getAttribute("fill")).not.toBe(empty?.getAttribute("fill"));
    dispose();
  });

  it("补位格带 is-outside 类（视觉淡化）", () => {
    const { root, dispose } = mount(() => <CalendarView {...baseProps} />);
    // 2025-12-29 属于上个月，是补位格
    expect(
      root
        .querySelector("rect.stats-cell[data-date='2025-12-29']")
        ?.classList.contains("is-outside"),
    ).toBe(true);
    dispose();
  });

  it("显示本月合计", () => {
    const { root, dispose } = mount(() => <CalendarView {...baseProps} />);
    expect(root.textContent).toContain("8,000");
    dispose();
  });

  it("翻月与回到本月的按钮分别触发各自的回调", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onToday = vi.fn();
    const { root, dispose } = mount(() => (
      <CalendarView
        {...baseProps}
        onPrev={onPrev}
        onNext={onNext}
        onToday={onToday}
      />
    ));
    const buttons = [...root.querySelectorAll("button.stats-nav-btn")];
    buttons.forEach((b) =>
      b.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onToday).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("SVG 带可读的 aria-label", () => {
    const { root, dispose } = mount(() => <CalendarView {...baseProps} />);
    const svg = root.querySelector("svg.stats-grid__svg");
    expect(svg?.getAttribute("aria-label")).toContain("2026");
    dispose();
  });

  it("没有数据时也能渲染（不抛异常）", () => {
    const { root, dispose } = mount(() => (
      <CalendarView
        {...baseProps}
        days={{}}
        thresholds={buildThresholds([])}
        hasSamples={false}
      />
    ));
    expect(root.querySelectorAll("rect.stats-cell")).toHaveLength(42);
    dispose();
  });
});

describe("年热力图（T8.8）", () => {
  const baseProps = {
    days: days([
      ["2026-01-15", 1000],
      ["2026-06-01", 5000],
    ]),
    year: 2026,
    thresholds: buildThresholds([1000, 5000]),
    hasSamples: true,
    onPrev: () => undefined,
    onNext: () => undefined,
  };

  it("365 格全部在同一个 SVG 里（T8.8 的硬要求）", () => {
    const { root, dispose } = mount(() => <HeatmapView {...baseProps} />);
    const svgs = root.querySelectorAll("svg");
    // 网格 SVG 必须只有一个，且包含全部格子
    const grid = [...svgs].filter((s) =>
      s.classList.contains("stats-grid__svg"),
    );
    expect(grid).toHaveLength(1);
    expect(grid[0]!.querySelectorAll("rect.stats-cell")).toHaveLength(371);
    dispose();
  });

  it("当年有 365 个 inRange 的格子", () => {
    const { root, dispose } = mount(() => <HeatmapView {...baseProps} />);
    const inRange = [...root.querySelectorAll("rect.stats-cell")].filter(
      (c) => !c.classList.contains("is-outside"),
    );
    expect(inRange).toHaveLength(365);
    dispose();
  });

  it("闰年是 366 格", () => {
    const { root, dispose } = mount(() => (
      <HeatmapView {...baseProps} year={2024} />
    ));
    const inRange = [...root.querySelectorAll("rect.stats-cell")].filter(
      (c) => !c.classList.contains("is-outside"),
    );
    expect(inRange).toHaveLength(366);
    dispose();
  });

  it("格子带 data-date 供委托反查", () => {
    const { root, dispose } = mount(() => <HeatmapView {...baseProps} />);
    expect(
      root
        .querySelector("rect.stats-cell[data-date='2026-01-15']")
        ?.getAttribute("data-value"),
    ).toBe("1000");
    dispose();
  });

  it("渲染色阶图例（5 档色块 + 少/多）", () => {
    const { root, dispose } = mount(() => <HeatmapView {...baseProps} />);
    expect(root.querySelectorAll(".stats-legend__swatch")).toHaveLength(5);
    expect(root.textContent).toContain("少");
    expect(root.textContent).toContain("多");
    dispose();
  });

  it("显示全年合计与有产出的天数", () => {
    const { root, dispose } = mount(() => <HeatmapView {...baseProps} />);
    expect(root.textContent).toContain("6,000");
    expect(root.textContent).toContain("2");
    dispose();
  });

  it("换年按钮触发回调", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { root, dispose } = mount(() => (
      <HeatmapView {...baseProps} onPrev={onPrev} onNext={onNext} />
    ));
    const buttons = [...root.querySelectorAll("button.stats-nav-btn")];
    buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("全部为空时不会崩", () => {
    const { root, dispose } = mount(() => (
      <HeatmapView
        {...baseProps}
        days={{}}
        thresholds={buildThresholds([])}
        hasSamples={false}
      />
    ));
    expect(root.querySelectorAll("rect.stats-cell")).toHaveLength(371);
    dispose();
  });
});

describe("逐格不做动画（T8.9 的硬约束）", () => {
  it("app.css 里 .stats-cell 没有任何 transition / animation", () => {
    // 这是「没有写某个东西」的测试：没有它，后来者顺手加一条
    // transition 就能悄悄把统计页的渲染预算吃掉
    const css = readFileSync(
      resolve(here, "..", "..", "styles", "app.css"),
      "utf8",
    );
    const cellRules = css.match(/\.stats-cell[^{]*\{[^}]*\}/g) ?? [];
    expect(cellRules.length).toBeGreaterThan(0);
    for (const rule of cellRules) {
      expect(rule, rule).not.toContain("transition");
      expect(rule, rule).not.toContain("animation");
    }
  });

  it("格子元素本身没有内联的 transition 样式", () => {
    const { root, dispose } = mount(() => (
      <HeatmapView
        days={days([["2026-01-15", 1000]])}
        year={2026}
        thresholds={buildThresholds([1000])}
        hasSamples={true}
        onPrev={() => undefined}
        onNext={() => undefined}
      />
    ));
    for (const cell of root.querySelectorAll("rect.stats-cell")) {
      expect(cell.getAttribute("style")).toBeNull();
    }
    dispose();
  });
});

describe("进度环（T5.5 / T8.11）", () => {
  it("按进度画 dasharray", () => {
    const { root, dispose } = mount(() => (
      <ProgressRing done={500} goal={1000} label="今日目标" />
    ));
    const circle = root.querySelector("circle.ring__value");
    expect(circle?.getAttribute("stroke-dasharray")).toBeTruthy();
    // 半进度：实线长度约等于半周长
    const full = mount(() => (
      <ProgressRing done={1000} goal={1000} label="今日目标" />
    ));
    expect(circle?.getAttribute("stroke-dasharray")).not.toBe(
      full.root
        .querySelector("circle.ring__value")
        ?.getAttribute("stroke-dasharray"),
    );
    full.dispose();
    dispose();
  });

  it("带完整的无障碍描述而不是只有一个数字", () => {
    const { root, dispose } = mount(() => (
      <ProgressRing done={500} goal={1000} label="今日目标" percentText="50%" />
    ));
    const svg = root.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toContain("今日目标");
    expect(svg?.getAttribute("aria-label")).toContain("50%");
    dispose();
  });

  it("达成时用不同的描边色（颜色之外还有类名可断言）", () => {
    const { root, dispose } = mount(() => (
      <ProgressRing done={1500} goal={1000} label="今日目标" />
    ));
    expect(
      root
        .querySelector("circle.ring__value")
        ?.classList.contains("is-reached"),
    ).toBe(true);
    dispose();
  });

  it("目标为 0 时不画进度（避免 0 比 0 的误导）", () => {
    const { root, dispose } = mount(() => (
      <ProgressRing done={500} goal={0} label="今日目标" />
    ));
    expect(
      root
        .querySelector("circle.ring__value")
        ?.getAttribute("stroke-dasharray"),
    ).toBe(`0 ${2 * Math.PI * ((68 - 7) / 2)}`);
    dispose();
  });

  it("中心文字与说明都会渲染", () => {
    const { root, dispose } = mount(() => (
      <ProgressRing
        done={500}
        goal={1000}
        label="今日"
        centerText="50%"
        caption="今日目标"
      />
    ));
    expect(root.textContent).toContain("50%");
    expect(root.textContent).toContain("今日目标");
    dispose();
  });
});

describe("总览（T8.6 / T8.10）", () => {
  it("渲染八张概览卡片", () => {
    const { root, dispose } = mount(() => (
      <OverviewView
        summary={summary({ totalWords: 123_456, today: 1200, streak: 12 })}
        dailyGoal={2000}
      />
    ));
    expect(root.querySelectorAll(".stats-card")).toHaveLength(8);
    expect(root.textContent).toContain("123,456");
    dispose();
  });

  it("连续天数大于 0 时画火焰图标", () => {
    const { root, dispose } = mount(() => (
      <OverviewView summary={summary({ streak: 12 })} dailyGoal={0} />
    ));
    expect(root.querySelector(".stats-streak__flame svg")).not.toBeNull();
    expect(root.textContent).toContain("12");
    dispose();
  });

  it("连续天数为 0 时不画火焰（燃着的火配 0 天会误导）", () => {
    const { root, dispose } = mount(() => (
      <OverviewView summary={summary({ streak: 0 })} dailyGoal={0} />
    ));
    expect(root.querySelector(".stats-streak__flame svg")).toBeNull();
    expect(root.querySelector(".stats-streak__cold")).not.toBeNull();
    dispose();
  });

  it("预计完稿日为空时显示说明而不是破折号", () => {
    const { root, dispose } = mount(() => (
      <OverviewView summary={summary()} dailyGoal={0} />
    ));
    expect(root.textContent).toContain("写几天");
    dispose();
  });

  it("有预计完稿日时显示日期与剩余天数", () => {
    const { root, dispose } = mount(() => (
      <OverviewView
        summary={summary({
          estimatedCompletion: "2026-05-01",
          remainingDays: 40,
        })}
        dailyGoal={0}
      />
    ));
    expect(root.textContent).toContain("2026-05-01");
    expect(root.textContent).toContain("40");
    dispose();
  });

  it("累计时长按小时分钟读", () => {
    const { root, dispose } = mount(() => (
      <OverviewView summary={summary({ totalMinutes: 135 })} dailyGoal={0} />
    ));
    expect(root.textContent).toContain("2 小时 15 分钟");
    dispose();
  });
});

describe("目标设置（T8.11）", () => {
  const goal = { daily: 2000, weekly: 12_000, streakThreshold: 100 };

  it("渲染两个进度环与三个输入框", () => {
    const { root, dispose } = mount(() => (
      <GoalView
        goal={goal}
        summary={summary({ today: 1000, thisWeek: 6000 })}
        onSave={() => undefined}
      />
    ));
    expect(root.querySelectorAll(".ring")).toHaveLength(2);
    expect(root.querySelectorAll("input.yh-input")).toHaveLength(3);
    dispose();
  });

  it("合法的输入会被保存", () => {
    const onSave = vi.fn();
    const { root, dispose } = mount(() => (
      <GoalView goal={goal} summary={summary()} onSave={onSave} />
    ));
    const input = root.querySelectorAll(
      "input.yh-input",
    )[0] as HTMLInputElement;
    input.value = "3000";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    (root.querySelector("button.btn--solid") as HTMLButtonElement).click();
    expect(onSave).toHaveBeenCalledWith({
      daily: 3000,
      weekly: 12_000,
      streakThreshold: 100,
    });
    dispose();
  });

  it("非法输入给出错误文案且不保存", () => {
    const onSave = vi.fn();
    const { root, dispose } = mount(() => (
      <GoalView goal={goal} summary={summary()} onSave={onSave} />
    ));
    const input = root.querySelectorAll(
      "input.yh-input",
    )[0] as HTMLInputElement;
    input.value = "abc";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    (root.querySelector("button.btn--solid") as HTMLButtonElement).click();
    expect(onSave).not.toHaveBeenCalled();
    expect(root.querySelector(".yh-field__error")).not.toBeNull();
    dispose();
  });

  it("输入框带 aria-invalid（颜色不是唯一通道）", () => {
    const { root, dispose } = mount(() => (
      <GoalView goal={goal} summary={summary()} onSave={() => undefined} />
    ));
    const input = root.querySelectorAll(
      "input.yh-input",
    )[0] as HTMLInputElement;
    input.value = "-5";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    dispose();
  });

  it("清除目标会把两项都置 0", () => {
    const onSave = vi.fn();
    const { root, dispose } = mount(() => (
      <GoalView goal={goal} summary={summary()} onSave={onSave} />
    ));
    const buttons = [...root.querySelectorAll("button")];
    const clear = buttons.find((b) => b.textContent?.includes("清除"));
    clear?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSave).toHaveBeenCalledWith({
      daily: 0,
      weekly: 0,
      streakThreshold: 100,
    });
    dispose();
  });
});

describe("分章分卷（T8.12）", () => {
  const volumes = [
    {
      volumeId: "v1",
      volumeTitle: "第一卷 落羽",
      volumeWords: 3000,
      chapters: [
        { id: "c1", title: "第一章 落羽", words: 2000, goal: 3000 },
        { id: "c2", title: "第二章 山雨", words: 1000, goal: 0 },
      ],
    },
    {
      volumeId: "v2",
      volumeTitle: "第二卷 惊蛰",
      volumeWords: 1000,
      chapters: [{ id: "c3", title: "第三章 惊蛰", words: 1000, goal: 3000 }],
    },
  ];

  it("默认按卷展示", () => {
    const { root, dispose } = mount(() => <BreakdownView volumes={volumes} />);
    expect(root.querySelectorAll(".stats-bar")).toHaveLength(2);
    expect(root.textContent).toContain("第一卷 落羽");
    dispose();
  });

  it("切到按章后展示章级行", () => {
    const { root, dispose } = mount(() => <BreakdownView volumes={volumes} />);
    const chapterTab = [...root.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("按章"),
    );
    chapterTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.querySelectorAll(".stats-bar")).toHaveLength(5);
    expect(root.textContent).toContain("第一章 落羽");
    dispose();
  });

  it("条形用 scaleX 而不是 width（只动画 transform）", () => {
    const { root, dispose } = mount(() => <BreakdownView volumes={volumes} />);
    const fill = root.querySelector(".stats-bar__fill") as HTMLElement;
    expect(fill.style.transform).toContain("scaleX");
    dispose();
  });

  it("占比以全书为分母", () => {
    const { root, dispose } = mount(() => <BreakdownView volumes={volumes} />);
    // 第一卷 3000 / 全书 4000 = 75.0%
    expect(root.textContent).toContain("75.0%");
    dispose();
  });

  it("空数据给出说明而不是空白", () => {
    const { root, dispose } = mount(() => <BreakdownView volumes={[]} />);
    expect(root.textContent).toContain("还没有章节数据");
    dispose();
  });

  it("标签带 title（长章名被截断时仍可悬停查看）", () => {
    const { root, dispose } = mount(() => <BreakdownView volumes={volumes} />);
    expect(
      root.querySelector(".stats-bar__label")?.getAttribute("title"),
    ).toBeTruthy();
    dispose();
  });
});

describe("隐私说明（T8.14）", () => {
  it("四条承诺都出现", () => {
    const { root, dispose } = mount(() => <PrivacyNote />);
    expect(root.textContent).toContain("只记字数与时长");
    expect(root.textContent).toContain("不记正文、标题与路径");
    expect(root.textContent).toContain("不联网、不上报");
    expect(root.textContent).toContain("数据留在你的工作区内");
    dispose();
  });

  it("给出统计文件的存放位置", () => {
    const { root, dispose } = mount(() => <PrivacyNote />);
    expect(root.textContent).toContain(".yuhua/stats");
    dispose();
  });

  it("没有 emoji（全仓硬约定）", () => {
    const { root, dispose } = mount(() => <PrivacyNote />);
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    expect(emoji.test(root.textContent ?? "")).toBe(false);
    dispose();
  });
});
