/**
 * 年热力图 SVG 视图（T8.8）。
 *
 * ## 365 格在同一个 SVG 里
 *
 * 计划书 T8.8 的原话是「365 格单个 SVG」。这里严格照做：
 * 整年的格子由 {@link CellGrid} 一次插入，**逐格不做动画**（T8.9）。
 * 之所以能这么做，是因为格子是纯 `<rect>`，没有子节点、没有监听器
 * （整张图共用一个委托），所以 371 个元素的插入成本很低。
 *
 * ## 月份表头怎么摆
 *
 * 每月的标签放在**当月 1 号所在的周列**，而不是把 53 列等分 12 份。
 * 等分会给每个标签半格的偏移，越往右偏得越多，读起来对不上图。
 *
 * ## 色阶图例
 *
 * 图例与日历共用一份（`stats-legend`）：5 档色块 + 两端「少 / 多」。
 * 档位含义是「相对本年的分布」，不是绝对字数，这一点在文案里说清楚。
 */

import { For, Show, createMemo, type JSX } from "solid-js";

import { t } from "@/strings";
import { palette } from "./heat";
import {
  HEATMAP_CELL,
  HEATMAP_DAYS,
  HEATMAP_GAP,
  HEATMAP_HEAD_HEIGHT,
  HEATMAP_HEAD_WIDTH,
  HEATMAP_ROW_LABELS,
  HEATMAP_WEEKS,
  heatmapCanvas,
  monthTicks,
} from "./geometry";
import { CellGrid } from "./CellGrid";
import { yearGrid, type DayMap } from "./model";

/** 热力图属性。 */
export interface HeatmapViewProps {
  /** 按天记录。 */
  days: DayMap;
  /** 当前年份。 */
  year: number;
  /** 色阶阈值。 */
  thresholds: readonly number[];
  /** 样本中是否有一天写过字。 */
  hasSamples: boolean;
  /** 上一年。 */
  onPrev: () => void;
  /** 下一年。 */
  onNext: () => void;
}

/** 年热力图。 */
export function HeatmapView(props: HeatmapViewProps): JSX.Element {
  const cells = createMemo(() => yearGrid(props.days, props.year, props.thresholds, props.hasSamples));
  const canvas = heatmapCanvas();
  const ticks = createMemo(() => monthTicks(props.year));

  const total = createMemo(() => {
    let words = 0;
    let active = 0;
    let best = 0;
    for (const cell of cells()) {
      if (!cell.inRange) continue;
      words += cell.words;
      if (cell.words > 0) active += 1;
      if (cell.words > best) best = cell.words;
    }
    return { words, active, best };
  });

  const xOf = (column: number): number => HEATMAP_HEAD_WIDTH + column * (HEATMAP_CELL + HEATMAP_GAP);
  const yOf = (row: number): number => HEATMAP_HEAD_HEIGHT + row * (HEATMAP_CELL + HEATMAP_GAP);

  return (
    <div class="stats-heat">
      <div class="stats-cal__head">
        <p class="stats-cal__total yh-num">
          {t("stats.heatmapTotal", { words: total().words.toLocaleString("zh-CN") })}
        </p>
        <ul class="stats-legend" aria-label={t("stats.heatmapLegend")}>
          <li class="stats-legend__text">{t("stats.heatmapLess")}</li>
          <For each={palette()}>
            {(color) => <li class="stats-legend__swatch" style={{ background: color }} aria-hidden="true" />}
          </For>
          <li class="stats-legend__text">{t("stats.heatmapMore")}</li>
        </ul>
      </div>

      <div class="stats-cal__nav">
        <button type="button" class="stats-nav-btn" onClick={props.onPrev}>
          {t("stats.heatmapPrev")}
        </button>
        <span class="stats-cal__month yh-num">{props.year}</span>
        <button type="button" class="stats-nav-btn" onClick={props.onNext}>
          {t("stats.heatmapNext")}
        </button>
      </div>

      <p class="stats-heat__meta">
        <span class="yh-num">{t("stats.heatmapActiveDays", { days: total().active })}</span>
        <span aria-hidden="true"> · </span>
        <span class="yh-num">{t("stats.heatmapBestDay", { words: total().best.toLocaleString("zh-CN") })}</span>
      </p>

      {/* 月份表头与行标签：跟着 SVG 的坐标系走，因此也用 SVG 画 */}
      <div class="stats-heat__wrap">
        <svg
          class="stats-heat__axis"
          width={canvas.width}
          height={HEATMAP_HEAD_HEIGHT}
          viewBox={`0 0 ${canvas.width} ${HEATMAP_HEAD_HEIGHT}`}
          aria-hidden="true"
        >
          <For each={ticks()}>
            {(tick) => (
              <text class="stats-heat__month" x={xOf(tick.column)} y={11}>
                {tick.month}
              </text>
            )}
          </For>
        </svg>

        <div class="stats-heat__row">
          <svg class="stats-heat__labels" width={HEATMAP_HEAD_WIDTH} height={canvas.height} viewBox={`0 0 ${HEATMAP_HEAD_WIDTH} ${canvas.height}`} aria-hidden="true">
            <For each={HEATMAP_ROW_LABELS}>
              {(label) => (
                <text class="stats-heat__weekday" x={0} y={yOf(label.row) + HEATMAP_CELL - 1}>
                  {label.text}
                </text>
              )}
            </For>
          </svg>

          <CellGrid
            cells={cells()}
            spec={{
              columns: HEATMAP_WEEKS,
              rows: HEATMAP_DAYS,
              cellSize: HEATMAP_CELL,
              gap: HEATMAP_GAP,
              headHeight: 0,
              headWidth: 0,
            }}
            width={canvas.width - HEATMAP_HEAD_WIDTH}
            height={canvas.height - HEATMAP_HEAD_HEIGHT}
            label={t("stats.heatmapGrid", { year: props.year })}
            tooltip={(cell) => (
              <Show when={cell.inRange} fallback={<p class="stats-pop__muted">{cell.date}</p>}>
                <p class="stats-pop__value yh-num">
                  {t("stats.heatmapCellA11y", { date: cell.date, words: cell.words.toLocaleString("zh-CN") })}
                </p>
              </Show>
            )}
          />
        </div>
      </div>
    </div>
  );
}
