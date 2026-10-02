/**
 * 码字日历 SVG 视图（T8.7）。
 *
 * ## 一次插入，不做逐格动画
 *
 * 42 个 `<rect>` 在一次渲染里全部生成，**逐格不做动画**
 * （计划书 T8.9 明确要求）。月份切换的动效只发生在**整张 SVG** 上：
 * 换月时容器做一次极短的透明度变化，格子本身没有任何 transition。
 *
 * ## 悬停浮层用事件委托
 *
 * 42 个格子若各绑一个 pointerover，光监听器就是 42 个闭包。
 * 委托实现在 design/charts/delegate.ts（整张 SVG 一个监听器）。
 *
 * ## 单日明细
 *
 * 浮层跟着指针走而不是固定在格子下方：36px 的格子附近放不下固定面板，
 * 靠近边缘时会被容器裁掉。跟随用 transform，符合「只动画 transform」。
 *
 * ## 星期表头为什么用 DOM 而不是 SVG
 *
 * 它只有七个汉字、没有坐标语义。放进 SVG 就得自己算基线、
 * 还得处理它不参与 hover 委托。用一条 CSS Grid 更短也更稳。
 */

import { For, Show, createMemo, type JSX } from "solid-js";

import { t } from "@/strings";
import { CalendarIcon } from "@/icons";
import { palette } from "./heat";
import { CALENDAR_CELL, CALENDAR_GAP, calendarCanvas } from "./geometry";
import { CellGrid } from "./CellGrid";
import { monthGrid, summarizeCells, type DayMap, type MonthKey } from "./model";

/** 日历视图属性。 */
export interface CalendarViewProps {
  /** 按天记录。 */
  days: DayMap;
  /** 当前月份。 */
  month: MonthKey;
  /** 色阶阈值。 */
  thresholds: readonly number[];
  /** 样本中是否有一天写过字（没有时全部归 0 档）。 */
  hasSamples: boolean;
  /** 翻到上一个月。 */
  onPrev: () => void;
  /** 翻到下一个月。 */
  onNext: () => void;
  /** 回到本月。 */
  onToday: () => void;
}

/** 星期表头。索引 0 为周一。 */
const WEEKDAY_HEADS = ["一", "二", "三", "四", "五", "六", "日"] as const;

/** 码字日历。 */
export function CalendarView(props: CalendarViewProps): JSX.Element {
  const cells = createMemo(() =>
    monthGrid(props.days, props.month, props.thresholds, props.hasSamples),
  );
  const total = createMemo(() => summarizeCells(cells()));
  const canvas = calendarCanvas();

  /** 月份的展示文本，日历网格的无障碍标签里也要用。 */
  const monthText = (): string =>
    `${props.month.year} 年 ${props.month.month} 月`;

  return (
    <div class="stats-cal">
      <div class="stats-cal__head">
        <p class="stats-cal__total yh-num">
          {t("stats.calendarMonthTotal", {
            words: total().totalWords.toLocaleString("zh-CN"),
          })}
        </p>
        <ul class="stats-legend" aria-label={t("stats.heatmapLegend")}>
          <li class="stats-legend__text">{t("stats.heatmapLess")}</li>
          <For each={palette()}>
            {(color) => (
              <li
                class="stats-legend__swatch"
                style={{ background: color }}
                aria-hidden="true"
              />
            )}
          </For>
          <li class="stats-legend__text">{t("stats.heatmapMore")}</li>
        </ul>
      </div>

      <div class="stats-cal__nav">
        <button type="button" class="stats-nav-btn" onClick={props.onPrev}>
          {t("stats.calendarPrev")}
        </button>
        <span class="stats-cal__month">
          <CalendarIcon size={15} />
          <span class="yh-num">{monthText()}</span>
        </span>
        <button type="button" class="stats-nav-btn" onClick={props.onNext}>
          {t("stats.calendarNext")}
        </button>
        <button
          type="button"
          class="stats-nav-btn stats-nav-btn--quiet"
          onClick={props.onToday}
        >
          {t("stats.calendarToday")}
        </button>
      </div>

      <div class="stats-cal__body">
        <div
          class="stats-cal__weekdays"
          aria-hidden="true"
          style={{ "grid-template-columns": `repeat(7, ${CALENDAR_CELL}px)` }}
        >
          <For each={WEEKDAY_HEADS}>{(label) => <span>{label}</span>}</For>
        </div>

        <CellGrid
          cells={cells()}
          spec={{
            columns: 7,
            rows: 6,
            cellSize: CALENDAR_CELL,
            gap: CALENDAR_GAP,
            headHeight: 0,
            headWidth: 0,
          }}
          width={canvas.width}
          height={canvas.height}
          label={t("stats.calendarGrid", { month: monthText() })}
          showDayNumbers={true}
          tooltip={(cell) => (
            <>
              <p class="stats-pop__date">{cell.date}</p>
              <Show
                when={cell.words > 0}
                fallback={
                  <p class="stats-pop__muted">{t("stats.calendarNoRecord")}</p>
                }
              >
                <p class="stats-pop__value yh-num">
                  {t("stats.calendarDayWords", {
                    words: cell.words.toLocaleString("zh-CN"),
                  })}
                </p>
              </Show>
            </>
          )}
        />
      </div>
    </div>
  );
}
