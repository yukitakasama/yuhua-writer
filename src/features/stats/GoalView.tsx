/**
 * 目标设置与进度环（T8.11）。
 *
 * ## 为什么目标用受控输入而不是可编辑数字
 *
 * `<input type="number">` 在各个浏览器里的行为差异很大（滚轮误改、
 * 步进器样式不可控、空值语义不一致）。写作软件里目标是个位数级别的
 * 低频设置，一个受控的 text 输入加显式校验反而更可预测。
 *
 * ## 校验必须给出**可操作**的原因
 *
 * 「输入不合法」是没用的提示。这里区分三种情况：空、不是整数、
 * 超出上限 —— 并直接说出上限是多少（对应 Input 原语的 error 通道）。
 *
 * ## 保存后重新计算
 *
 * 连续天数阈值改变会影响「连续天数」这个数字本身，
 * 因此保存后必须重算汇总，否则界面上会同时出现新旧两套口径。
 */

import { Show, createMemo, createSignal, type JSX } from "solid-js";

import { t } from "@/strings";
import { Input } from "@/design/primitives";
import { Button } from "@/app/ui/Button";
import { ProgressRing } from "./ProgressRing";
import {
  GOAL_MAX,
  ratio,
  validateGoal,
  type GoalConfig,
  type StatsSummary,
} from "./model";

/** 目标视图属性。 */
export interface GoalViewProps {
  /** 当前目标。 */
  goal: GoalConfig;
  /** 汇总（用于进度环）。 */
  summary: StatsSummary;
  /** 保存目标。 */
  onSave: (next: Partial<GoalConfig>) => void;
}

/** 目标与进度。 */
export function GoalView(props: GoalViewProps): JSX.Element {
  const [daily, setDaily] = createSignal(String(props.goal.daily));
  const [weekly, setWeekly] = createSignal(String(props.goal.weekly));
  const [threshold, setThreshold] = createSignal(
    String(props.goal.streakThreshold),
  );
  const [saved, setSaved] = createSignal(false);

  /** 三个字段各自的错误文案；返回 null 表示这一项没问题。 */
  const errorFor = (raw: string): string | null => {
    const problem = validateGoal(raw);
    if (problem === null) return null;
    return t("stats.goalInvalid");
  };

  const hasError = createMemo(
    () =>
      errorFor(daily()) !== null ||
      errorFor(weekly()) !== null ||
      errorFor(threshold()) !== null,
  );

  const handleSave = (): void => {
    if (hasError()) return;
    props.onSave({
      daily: Number(daily()),
      weekly: Number(weekly()),
      streakThreshold: Number(threshold()),
    });
    setSaved(true);
  };

  const dailyProgress = createMemo(() =>
    ratio(props.summary.today, props.goal.daily),
  );
  const weeklyProgress = createMemo(() =>
    ratio(props.summary.thisWeek, props.goal.weekly),
  );

  return (
    <div class="stats-goal">
      <section class="stats-goal__rings">
        <ProgressRing
          done={props.summary.today}
          goal={props.goal.daily}
          label={t("stats.goalProgressTitle")}
          centerText={
            props.goal.daily > 0
              ? `${Math.round((dailyProgress() ?? 0) * 100)}%`
              : undefined
          }
          caption={t("stats.goalProgressTitle")}
          percentText={`${Math.round((dailyProgress() ?? 0) * 100)}%`}
        />
        <ProgressRing
          done={props.summary.thisWeek}
          goal={props.goal.weekly}
          label={t("stats.goalProgressWeek")}
          centerText={
            props.goal.weekly > 0
              ? `${Math.round((weeklyProgress() ?? 0) * 100)}%`
              : undefined
          }
          caption={t("stats.goalProgressWeek")}
          percentText={`${Math.round((weeklyProgress() ?? 0) * 100)}%`}
        />
      </section>

      <form
        class="stats-goal__form"
        onSubmit={(event) => {
          event.preventDefault();
          handleSave();
        }}
      >
        <Input
          label={t("stats.goalDaily")}
          hint={t("stats.goalDailyHint")}
          value={daily()}
          inputmode="numeric"
          maxlength={7}
          onInput={setDaily}
          {...(errorFor(daily()) !== null
            ? { error: errorFor(daily()) as string }
            : {})}
        />
        <Input
          label={t("stats.goalWeekly")}
          hint={t("stats.goalWeeklyHint")}
          value={weekly()}
          inputmode="numeric"
          maxlength={7}
          onInput={setWeekly}
          {...(errorFor(weekly()) !== null
            ? { error: errorFor(weekly()) as string }
            : {})}
        />
        <Input
          label={t("stats.goalStreakThreshold")}
          hint={t("stats.goalStreakHint")}
          value={threshold()}
          inputmode="numeric"
          maxlength={7}
          onInput={setThreshold}
          {...(errorFor(threshold()) !== null
            ? { error: errorFor(threshold()) as string }
            : {})}
        />

        <div class="stats-goal__actions">
          <Button type="submit" variant="solid" onClick={handleSave}>
            {t("stats.goalSave")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDaily("0");
              setWeekly("0");
              setThreshold(String(props.goal.streakThreshold));
              props.onSave({
                daily: 0,
                weekly: 0,
                streakThreshold: props.goal.streakThreshold,
              });
            }}
          >
            {t("stats.goalClear")}
          </Button>
        </div>

        <Show when={saved() && !hasError()}>
          <p class="stats-goal__saved" role="status">
            {t("stats.goalSaved")}
          </p>
        </Show>
        <p class="stats-goal__limit">{`≤ ${GOAL_MAX.toLocaleString("zh-CN")}`}</p>
      </form>
    </div>
  );
}
