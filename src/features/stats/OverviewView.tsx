/**
 * 统计总览（T8.6 的展示壳 + T8.10 的连续天数）。
 *
 * ## 信息架构的取舍
 *
 * 总览只回答一个问题：**「我最近写得怎么样？」**
 * 因此卡片按「读者提问的顺序」排，而不是按字段来源排：
 *
 * 1. 今天 / 本周 / 本月 —— 最近的努力
 * 2. 连续天数 —— 习惯
 * 3. 累计 / 写作天数 / 最高单日 / 累计时长 / 近 7 日平均 —— 底账
 * 4. 预计完稿 —— 只有一个**可用的**估算时才出现
 *
 * ## 预计完稿为什么不常显
 *
 * 没有总目标、或近 7 日没写过字时，这个数字**算不出来**。
 * 显示一个「—」比隐藏它更差：作者会以为软件坏了。
 * 因此 None 时整块卡片退化成一句「写几天就能估算」的说明。
 *
 * ## 连续天数的火焰
 *
 * 火焰图标来自 `@/icons/flame`（自绘 SVG，零 emoji）。
 * 连续为 0 时不画火焰而画灰点 —— 一个"燃着的火"配 0 天会误导。
 */

import { For, Show, createMemo, type JSX } from "solid-js";

import { t } from "@/strings";
import { ClockIcon, FlameIcon, GoalIcon } from "@/icons";
import { formatMinutes, type StatsSummary } from "./model";

/** 总览属性。 */
export interface OverviewViewProps {
  /** 汇总数据。 */
  summary: StatsSummary;
  /** 每日目标（用于把「今日」卡片的进度说清楚）。 */
  dailyGoal: number;
}

/** 一张概览卡片。 */
interface CardSpec {
  /** 标签。 */
  label: string;
  /** 主数值（已格式化）。 */
  value: string;
  /** 单位或补充说明。 */
  note?: string;
}

/** 写作统计总览。 */
export function OverviewView(props: OverviewViewProps): JSX.Element {
  const cards = createMemo<CardSpec[]>(() => {
    const s = props.summary;
    const todayNote =
      props.dailyGoal > 0
        ? `/ ${props.dailyGoal.toLocaleString("zh-CN")}`
        : undefined;
    return [
      {
        label: t("stats.cardToday"),
        value: format(s.today),
        ...(todayNote ? { note: todayNote } : {}),
      },
      { label: t("stats.cardThisWeek"), value: format(s.thisWeek) },
      { label: t("stats.cardThisMonth"), value: format(s.thisMonth) },
      { label: t("stats.cardTotal"), value: format(s.totalWords) },
      {
        label: t("stats.cardActiveDays"),
        value: format(s.activeDays),
        note: t("stats.unitDays"),
      },
      { label: t("stats.cardBestDay"), value: format(s.bestDay) },
      { label: t("stats.cardAverage7"), value: format(s.averagePerDay7) },
      { label: t("stats.cardMinutes"), value: formatMinutes(s.totalMinutes) },
    ];
  });

  return (
    <div class="stats-overview">
      <section class="stats-streak" aria-labelledby="stats-streak-title">
        <div class="stats-streak__flame" aria-hidden="true">
          <Show
            when={props.summary.streak > 0}
            fallback={<span class="stats-streak__cold" />}
          >
            <FlameIcon size={30} />
          </Show>
        </div>
        <div class="stats-streak__body">
          <h3 class="stats-streak__title" id="stats-streak-title">
            {t("stats.streakTitle")}
          </h3>
          <p class="stats-streak__value yh-num">
            <Show
              when={props.summary.streak > 0}
              fallback={t("stats.streakZero")}
            >
              {t("stats.streakDays", { days: props.summary.streak })}
            </Show>
          </p>
          <p class="stats-streak__note">
            {t("stats.streakBody", {
              threshold: props.summary.streakThreshold,
            })}
          </p>
        </div>
      </section>

      <ul class="stats-cards">
        <For each={cards()}>
          {(card) => (
            <li class="stats-card">
              <span class="stats-card__label">{card.label}</span>
              <span class="stats-card__value yh-num">
                {card.value}
                <Show when={card.note}>
                  <span class="stats-card__note"> {card.note}</span>
                </Show>
              </span>
            </li>
          )}
        </For>
      </ul>

      <section class="stats-estimate" aria-labelledby="stats-estimate-title">
        <h3 class="stats-estimate__title" id="stats-estimate-title">
          <GoalIcon size={15} />
          <span>{t("stats.estimateLabel")}</span>
        </h3>
        <Show
          when={
            props.summary.estimatedCompletion !== null ||
            props.summary.remainingDays === 0
          }
          fallback={
            <p class="stats-estimate__hint">{t("stats.estimateNone")}</p>
          }
        >
          <p class="stats-estimate__value yh-num">
            <Show
              when={props.summary.estimatedCompletion !== null}
              fallback={<span>{t("stats.estimateReached")}</span>}
            >
              <span>{props.summary.estimatedCompletion}</span>
              <Show when={props.summary.remainingDays !== null}>
                <span class="stats-estimate__days">
                  {t("stats.estimateDays", {
                    days: props.summary.remainingDays ?? 0,
                  })}
                </span>
              </Show>
            </Show>
          </p>
        </Show>
        <p class="stats-estimate__meta">
          <ClockIcon size={13} />
          <span class="yh-num">
            {formatMinutes(props.summary.totalMinutes)}
          </span>
        </p>
      </section>
    </div>
  );
}

/** 千分位格式化。数字全部走 `.yh-num`（tabular-nums），跳动时不会左右抖。 */
function format(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("zh-CN");
}
