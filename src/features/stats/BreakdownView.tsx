/**
 * 分章 / 分卷统计（T8.12）。
 *
 * ## 为什么用横向条形而不是饼图或树
 *
 * 长篇小说的字数分布是**长尾**的：一两个大卷吃掉大部分字数，
 * 剩下几十章都很短。饼图在这种情况下会退化成一堆看不见的细缝，
 * 而横向条形对长尾天然友好 —— 短条只要还在，就仍然可读、可比较。
 *
 * ## 占比的分母是全书
 *
 * 分章视图与分卷视图共用同一根横轴刻度。若分章以本卷为分母，
 * 一个 50 字的小章会画出与整卷「第三卷」一样长的条，直接误导读者。
 *
 * ## 条形长度为什么不用百分比宽度
 *
 * `width: 42%` 会触发重排，而计划书 5.4 只允许动画 transform 与 opacity。
 * 这里改成 `transform: scaleX(share)` 加 `transform-origin: left`：
 * 只动合成层，且条目多时（几百章）仍然流畅。
 */

import { For, Show, createMemo, createSignal, type JSX } from "solid-js";

import { t } from "@/strings";
import { breakdownRows, type BreakdownInput, type BreakdownRow } from "./model";

/** 分章分卷属性。 */
export interface BreakdownViewProps {
  /** 卷章结构。 */
  volumes: readonly BreakdownInput[];
}

/** 视图模式：按卷或按章。 */
type Mode = "volume" | "chapter";

/** 分章分卷统计视图。 */
export function BreakdownView(props: BreakdownViewProps): JSX.Element {
  const [mode, setMode] = createSignal<Mode>("volume");

  const volumes = createMemo<BreakdownInput[]>(() => props.volumes.filter((v) => v.volumeWords > 0 || v.chapters.length > 0));

  const rows = createMemo<BreakdownRow[]>(() => {
    const all = breakdownRows(volumes());
    return mode() === "volume" ? all.filter((row) => row.depth === 0) : all;
  });

  const maxWords = createMemo(() => rows().reduce((max, row) => Math.max(max, row.words), 0));

  return (
    <div class="stats-breakdown">
      <div class="stats-breakdown__tabs" role="tablist" aria-label={t("stats.breakdownTitle")}>
        <button
          type="button"
          role="tab"
          class="stats-nav-btn"
          aria-selected={mode() === "volume" ? "true" : "false"}
          onClick={() => setMode("volume")}
        >
          {t("stats.breakdownByVolume")}
        </button>
        <button
          type="button"
          role="tab"
          class="stats-nav-btn"
          aria-selected={mode() === "chapter" ? "true" : "false"}
          onClick={() => setMode("chapter")}
        >
          {t("stats.breakdownByChapter")}
        </button>
      </div>

      <Show when={rows().length > 0} fallback={<p class="stats-empty-inline">{t("stats.breakdownEmpty")}</p>}>
        <ul class="stats-bars" aria-label={t("stats.breakdownChart")}>
          <For each={rows()}>
            {(row) => (
              <li class="stats-bar" classList={{ "is-chapter": row.depth === 1 }}>
                <span class="stats-bar__label" title={row.label}>
                  {row.label}
                </span>
                {/* 条长按「占全书比例」缩放；满格是最大的一行，不是 100% */}
                <span class="stats-bar__track" aria-hidden="true">
                  <span
                    class="stats-bar__fill"
                    style={{
                      width: "100%",
                      transform: `scaleX(${maxWords() > 0 ? row.words / maxWords() : 0})`,
                    }}
                  />
                </span>
                <span class="stats-bar__value yh-num">{row.words.toLocaleString("zh-CN")}</span>
                <span class="stats-bar__share yh-num">{formatShare(row.share)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** 把 0..1 的比例格式化成一位小数的百分比。 */
function formatShare(share: number): string {
  const clamped = Number.isFinite(share) ? Math.min(Math.max(share, 0), 1) : 0;
  return `${(clamped * 100).toFixed(1)}%`;
}
