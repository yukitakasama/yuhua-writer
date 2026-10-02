/**
 * 写作统计主视图（T8.13 的信息架构与导航）。
 *
 * ## 信息架构
 *
 * 六个分区，按「从近期到长期、从结论到依据、最后是承诺」排列：
 *
 * 1. **总览** —— 一行回答「我最近写得怎么样」
 * 2. **码字日历** —— 一个月一张图，看日常节奏
 * 3. **年热力图** —— 一整年一张图，看长期趋势
 * 4. **目标** —— 可调的目标与进度环
 * 5. **分章分卷** —— 字数分布，回答「书的结构健不健康」
 * 6. **隐私** —— 这一段数据到底记了什么
 *
 * 为什么是侧边导航而不是标签页：六个分区里有两个是"图"（日历、热力图），
 * 它们需要完整的横向空间与固定的高度，标签页在窄窗口下会把图压扁。
 * 侧栏在窄窗口下退回成一行横向滚动的胶囊按钮（见 app.css）。
 *
 * ## 数据载入的时机
 *
 * **只有进入这个视图时才载入**。统计是典型的"偶尔看一眼"的功能，
 * 在应用启动时预载会在每次打开软件时多做一次磁盘扫描，
 * 直接违反计划书对启动时间的要求。
 *
 * ## 空状态是诚实的
 *
 * 新用户看到的是「还没有可统计的数据」而不是一片 0 和空格子。
 * 一片 0 会让人以为软件坏了；一句说明则准确地表达了
 * 「你还没开始写」。
 */

import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onMount,
  type JSX,
} from "solid-js";

import { t } from "@/strings";
import { Button } from "@/app/ui/Button";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyEditor } from "@/app/ui/illustrations";
import {
  CalendarIcon,
  FlameIcon,
  GoalIcon,
  InfoIcon,
  StatsIcon,
  TargetIcon,
} from "@/icons";
import { chaptersIn, volumes, workspaceState } from "@/app/workspace-store";
import { BreakdownView } from "./BreakdownView";
import { CalendarView } from "./CalendarView";
import { GoalView } from "./GoalView";
import { HeatmapView } from "./HeatmapView";
import { OverviewView } from "./OverviewView";
import { PrivacyNote } from "./PrivacyNote";
import {
  STATS_SECTIONS,
  loadStats,
  resetCalendarMonth,
  saveGoal,
  setSection,
  shiftCalendarMonth,
  shiftHeatmapYear,
  statsState,
  thresholdsFor,
  type StatsSection,
} from "./store";
import { monthGrid, yearGrid, type BreakdownInput } from "./model";

/** 统计页属性。 */
export interface StatsViewProps {
  /** 返回写作台。 */
  onBack: () => void;
}

/** 分区到图标与文案的映射。 */
interface SectionMeta {
  /** 分区名（已本地化）。 */
  label: string;
  /** 分区图标。 */
  icon: (props: { size?: number }) => JSX.Element;
}

const SECTION_META: Record<StatsSection, SectionMeta> = {
  overview: { label: t("stats.navOverview"), icon: StatsIcon },
  calendar: { label: t("stats.navCalendar"), icon: CalendarIcon },
  heatmap: { label: t("stats.navHeatmap"), icon: FlameIcon },
  goal: { label: t("stats.navGoal"), icon: TargetIcon },
  breakdown: { label: t("stats.navBreakdown"), icon: GoalIcon },
  privacy: { label: t("stats.navPrivacy"), icon: InfoIcon },
};

/** 写作统计主视图。 */
export function StatsView(props: StatsViewProps): JSX.Element {
  const [loadAttempted, setLoadAttempted] = createSignal(false);

  onMount(() => {
    // 只载一次：切分区不重新读盘（数据在同一会话内不会变）
    if (loadAttempted()) return;
    setLoadAttempted(true);
    void loadStats();
  });

  const days = createMemo(() => statsState.days);

  /**
   * 月历的色阶：用**当月网格**的样本。
   *
   * 不用全年样本，是因为月历要回答的是「这个月里哪天写得多」，
   * 用全年分布分档会让淡季的整月都变成最浅的一档，看不出层次。
   */
  const calendarScale = createMemo(() => {
    const cells = monthGrid(days(), statsState.calendarMonth, [], false);
    return thresholdsFor(cells.map((c) => c.words));
  });

  /** 热力图的色阶：用**当年**的样本。 */
  const heatmapScale = createMemo(() => {
    const cells = yearGrid(days(), statsState.heatmapYear, [], false);
    return thresholdsFor(cells.map((c) => c.words));
  });

  /** 是否已经写过字。全空时整个统计页退化成空状态。 */
  const hasData = createMemo(
    () => Object.keys(days()).length > 0 || statsState.summary.totalWords > 0,
  );

  /** 分章分卷的输入：直接来自工作区文档，不需要后端统计。 */
  const breakdownInput = createMemo<BreakdownInput[]>(() => {
    const doc = workspaceState.document;
    if (!doc) return [];
    return volumes().map((volume) => {
      const chapters = chaptersIn(volume.id).map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        words: chapter.wordCount,
        goal: chapter.wordGoal,
      }));
      return {
        volumeId: volume.id,
        volumeTitle: volume.title,
        volumeWords: chapters.reduce((sum, c) => sum + c.words, 0),
        chapters,
      };
    });
  });

  return (
    <div class="stats">
      <header class="stats__head">
        <h1 class="stats__title">
          <StatsIcon size={19} />
          <span>{t("stats.title")}</span>
        </h1>
        <Button variant="outline" size="sm" onClick={props.onBack}>
          {t("action.back")}
        </Button>
      </header>

      <Show when={statsState.error}>
        {(message) => (
          <p class="stats__error" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <div class="stats__body">
        {/* 侧边导航。用 tablist 语义：它切换的正是右侧的 panel */}
        <nav class="stats__nav" aria-label={t("stats.title")}>
          <ul
            class="stats__nav-list"
            role="tablist"
            aria-orientation="vertical"
          >
            <For each={STATS_SECTIONS}>
              {(section) => {
                const meta = SECTION_META[section];
                const Icon = meta.icon;
                return (
                  <li>
                    <button
                      type="button"
                      role="tab"
                      class="stats__nav-item"
                      classList={{
                        "is-active": statsState.section === section,
                      }}
                      aria-selected={
                        statsState.section === section ? "true" : "false"
                      }
                      aria-controls="stats-panel"
                      onClick={() => setSection(section)}
                    >
                      <Icon size={15} />
                      <span>{meta.label}</span>
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>
        </nav>

        <section
          class="stats__panel"
          id="stats-panel"
          role="tabpanel"
          aria-label={SECTION_META[statsState.section].label}
        >
          <Show
            when={hasData() || statsState.section === "privacy"}
            fallback={
              <EmptyState
                illustration={<IllustrationEmptyEditor size={120} />}
                title={t("stats.emptyTitle")}
                body={t("stats.emptyBody")}
              />
            }
          >
            <Switch>
              <Match when={statsState.section === "overview"}>
                <OverviewView
                  summary={statsState.summary}
                  dailyGoal={statsState.goal.daily}
                />
              </Match>

              <Match when={statsState.section === "calendar"}>
                <CalendarView
                  days={days()}
                  month={statsState.calendarMonth}
                  thresholds={calendarScale().thresholds}
                  hasSamples={calendarScale().hasSamples}
                  onPrev={() => shiftCalendarMonth(-1)}
                  onNext={() => shiftCalendarMonth(1)}
                  onToday={() => resetCalendarMonth()}
                />
              </Match>

              <Match when={statsState.section === "heatmap"}>
                <HeatmapView
                  days={days()}
                  year={statsState.heatmapYear}
                  thresholds={heatmapScale().thresholds}
                  hasSamples={heatmapScale().hasSamples}
                  onPrev={() => shiftHeatmapYear(-1)}
                  onNext={() => shiftHeatmapYear(1)}
                />
              </Match>

              <Match when={statsState.section === "goal"}>
                <GoalView
                  goal={statsState.goal}
                  summary={statsState.summary}
                  onSave={saveGoal}
                />
              </Match>

              <Match when={statsState.section === "breakdown"}>
                <BreakdownView volumes={breakdownInput()} />
              </Match>

              <Match when={statsState.section === "privacy"}>
                <PrivacyNote />
              </Match>
            </Switch>
          </Show>
        </section>
      </div>
    </div>
  );
}
