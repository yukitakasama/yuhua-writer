/**
 * 右侧章节元数据面板（T5.4）+ 字数面板（T5.5）+ 本书信息。
 *
 * ## 「本书信息」为什么也在这一栏
 *
 * 作者与简介存在 `.yuhua/workspace.json`，填的入口在导出面板
 * （{@link saveBookMeta}），这里只**展示**已经存着的值 —— 让作者能不问
 * 「我上次署的名还在不在」。空值显示「未填写」而不是编一个名字。
 *
 * ## 为什么字数面板与元数据放同一个右侧栏
 *
 * 它们都是"关于当前这一章的信息"，作者在写作时会来回看。
 * 分成两个可折叠区块而不是两个标签页：标签页会藏起一半信息，
 * 而这两类信息都不占地方。
 *
 * ## 字数面板的两个进度环（T5.5）
 *
 * 「本章 / 目标」与「今日 / 每日目标」是作者在写作时唯一真正会看的
 * 两个进度。其余的累计数字用文字给，因为**数字是用来查的，环是用来看的** ——
 * 给每一个数字都配一个环，等于一个环都不重要。
 *
 * 今日字数来自写作统计（`getStatsSummary`），不是本章字数：
 * 作者一天可能写好几章，"今天写了多少"才是他关心的量。
 * 统计拿不到时**不显示环**，而不是画一个 0% —— 那会误导。
 *
 * 计划书 5.2 节的 `--c-*` 系列令牌在 CSS 里消费。
 */

import { Show, createMemo, type JSX } from "solid-js";

import { t } from "@/strings";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyEditor } from "@/app/ui/illustrations";
import { StatusDot } from "@/app/ui/StatusDot";
import { ProgressRing } from "@/features/stats/ProgressRing";
import { loadStats, statsState } from "@/features/stats/store";
import { ratio } from "@/features/stats/model";
import { onMount } from "solid-js";
import {
  currentBook,
  selectedChapter,
  totalChapters,
  totalWords,
  volumes,
  workspaceState,
} from "./workspace-store";

/** 右侧信息面板。 */
export function MetaPanel(): JSX.Element {
  const chapter = createMemo(() => selectedChapter());
  const book = createMemo(() => currentBook());

  // 今日字数需要统计。这里**按需触发一次**：已有数据时（用户去过统计页）
  // 什么都不做，没有时才拉一次。放在 onMount 里而不是 createMemo 里，
  // 是因为它在语义上是副作用而不是派生值
  onMount(() => {
    if (Object.keys(statsState.days).length === 0 && !statsState.loading)
      void loadStats();
  });

  /** 本章的目标进度。没设目标时返回 null，环整个不渲染。 */
  const chapterGoalRatio = createMemo(() => {
    const current = chapter();
    if (!current || current.wordGoal <= 0) return null;
    return ratio(current.wordCount, current.wordGoal);
  });

  /** 今日目标进度。没设目标时返回 null。 */
  const todayGoalRatio = createMemo(() => {
    if (statsState.goal.daily <= 0) return null;
    return ratio(statsState.summary.today, statsState.goal.daily);
  });

  return (
    <aside class="meta" aria-label={t("a11y.rightPanel")}>
      {/* 本书信息放在选章的空态**之外**：作者是这本书的属性，
          与「当前选中哪一章」无关。跟着章走会让人以为没选章就没有署名。

          `when` 传的是**对象本身**而不是 `!== null`：Show 给回调的那个
          accessor 就是 `when` 的值，写成布尔时 `info().title` 全是不存在的
          属性，界面会安静地渲染出一排空值 —— 有标签、没数据，最难发现的那种坏。 */}
      <Show when={book()}>
        {(info) => (
          <section class="meta__section">
            <h3 class="meta__heading">{t("book.panelTitle")}</h3>
            <dl class="meta__list">
              <MetaRow label={t("book.title")} value={info().title} />
              <MetaRow
                label={t("book.author")}
                value={info().author === "" ? t("book.unset") : info().author}
              />
              <div class="meta__row meta__row--wrap">
                <dt class="meta__key">{t("book.description")}</dt>
                <dd class="meta__value meta__value--wrap">
                  {info().description === ""
                    ? t("book.unset")
                    : info().description}
                </dd>
              </div>
            </dl>
            <p class="meta__note">{t("book.editHint")}</p>
          </section>
        )}
      </Show>

      <Show
        when={chapter()}
        fallback={
          <EmptyState
            compact
            illustration={<IllustrationEmptyEditor size={88} />}
            title={t("meta.noSelection")}
          />
        }
      >
        {(current) => (
          <>
            <section class="meta__section">
              <h3 class="meta__heading">{t("meta.panelTitle")}</h3>
              <dl class="meta__list">
                <MetaRow label={t("meta.title")} value={current().title} />
                <MetaRow
                  label={t("meta.volume")}
                  value={volumeName(current().volumeId)}
                />
                <div class="meta__row">
                  <dt class="meta__key">{t("meta.status")}</dt>
                  <dd class="meta__value">
                    <StatusDot status={current().status} withLabel />
                  </dd>
                </div>
                <MetaRow
                  label={t("meta.wordGoal")}
                  value={
                    current().wordGoal > 0
                      ? `${current().wordGoal.toLocaleString("zh-CN")} ${t("wordCount.unit")}`
                      : t("meta.wordGoalPlaceholder")
                  }
                />
                <MetaRow label={t("meta.updated")} value={current().updated} />
                <MetaRow label={t("meta.path")} value={current().path} mono />
              </dl>
            </section>

            <section class="meta__section">
              <h3 class="meta__heading">{t("wordCount.panelTitle")}</h3>

              {/* 两个进度环：本章与今日。没设目标时整个不渲染，
                  而不是画一个 0 比 0 的环 —— 那看起来像"进度极差" */}
              <div class="meta__rings">
                <Show when={chapterGoalRatio() !== null}>
                  <ProgressRing
                    done={current().wordCount}
                    goal={current().wordGoal}
                    size={62}
                    thickness={6}
                    label={t("wordCount.chapterGoal")}
                    centerText={percentText(chapterGoalRatio() ?? 0)}
                    caption={t("wordCount.chapterGoal")}
                    percentText={percentText(chapterGoalRatio() ?? 0)}
                  />
                </Show>
                <Show when={todayGoalRatio() !== null}>
                  <ProgressRing
                    done={statsState.summary.today}
                    goal={statsState.goal.daily}
                    size={62}
                    thickness={6}
                    label={t("wordCount.todayGoal")}
                    centerText={percentText(todayGoalRatio() ?? 0)}
                    caption={t("wordCount.todayGoal")}
                    percentText={percentText(todayGoalRatio() ?? 0)}
                  />
                </Show>
              </div>

              <dl class="meta__list">
                <MetaRow
                  label={t("wordCount.thisChapter")}
                  value={`${current().wordCount.toLocaleString("zh-CN")} ${t("wordCount.unit")}`}
                />
                <MetaRow
                  label={t("wordCount.thisVolume")}
                  value={`${volumeWords(current().volumeId).toLocaleString("zh-CN")} ${t("wordCount.unit")}`}
                />
                <MetaRow
                  label={t("wordCount.thisBook")}
                  value={`${totalWords().toLocaleString("zh-CN")} ${t("wordCount.unit")}`}
                />
                <MetaRow
                  label={t("wordCount.today")}
                  value={`${statsState.summary.today.toLocaleString("zh-CN")} ${t("wordCount.unit")}`}
                />
                <MetaRow
                  label={t("wordCount.chapterCount")}
                  value={`${totalChapters()}`}
                />
                <MetaRow
                  label={t("wordCount.volumeCount")}
                  value={`${volumes().length}`}
                />
              </dl>
              <p class="meta__note">{t("wordCount.todayHint")}</p>
            </section>
          </>
        )}
      </Show>
    </aside>
  );
}

/** 一行"标签 — 值"。 */
function MetaRow(props: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div class="meta__row">
      <dt class="meta__key">{props.label}</dt>
      <dd
        class={["meta__value", props.mono ? "meta__value--mono" : ""]
          .filter(Boolean)
          .join(" ")}
        title={props.value}
      >
        {props.value}
      </dd>
    </div>
  );
}

/** 把 0 起可超过 1 的比例格式化成百分比文本。 */
function percentText(progress: number): string {
  const clamped = Number.isFinite(progress) ? Math.max(progress, 0) : 0;
  return `${Math.round(clamped * 100)}%`;
}

/** 取卷名。找不到时返回空串而不是 "undefined"。 */
function volumeName(volumeId: string): string {
  return volumes().find((v) => v.id === volumeId)?.title ?? "";
}

/** 本卷字数。 */
function volumeWords(volumeId: string): number {
  const doc = workspaceState.document;
  if (!doc) return 0;
  return doc.chapters
    .filter((c) => c.volumeId === volumeId)
    .reduce((sum, c) => sum + c.wordCount, 0);
}
