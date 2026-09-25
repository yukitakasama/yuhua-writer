/**
 * 右侧章节元数据面板（T5.4 的骨架）。
 *
 * ## 本阶段的范围
 *
 * T5.4 完整实现（摘要、便签、状态的编辑与落盘）依赖编辑器内核，
 * 而编辑器属于 M4。这里实现**只读展示 + 字段骨架**：
 * 面板的布局、字段分组、空状态都要与最终形态一致，
 * 这样 M4 接入时只需要给字段加 onChange，不用重排版面。
 *
 * ## 为什么字数面板与元数据放同一个右侧栏
 *
 * 它们都是"关于当前这一章的信息"，作者在写作时会来回看。
 * 分成两个可折叠区块而不是两个标签页：标签页会藏起一半信息，
 * 而这两类信息都不占地方。
 *
 * 计划书 5.2 节的 `--c-*` 系列令牌在 CSS 里消费。
 */

import { Show, createMemo, type JSX } from "solid-js";

import { t } from "@/strings";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyEditor } from "@/app/ui/illustrations";
import { StatusDot } from "@/app/ui/StatusDot";
import { CHART_HINT } from "./placeholders";
import { selectedChapter, totalChapters, totalWords, workspaceState, volumes } from "./workspace-store";

/** 右侧信息面板。 */
export function MetaPanel(): JSX.Element {
  const chapter = createMemo(() => selectedChapter());

  return (
    <aside class="meta" aria-label={t("a11y.rightPanel")}>
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
                <MetaRow label={t("meta.volume")} value={volumeName(current().volumeId)} />
                <div class="meta__row">
                  <dt class="meta__key">{t("meta.status")}</dt>
                  <dd class="meta__value">
                    <StatusDot status={current().status} withLabel />
                  </dd>
                </div>
                <MetaRow
                  label={t("meta.wordGoal")}
                  value={current().wordGoal > 0 ? `${current().wordGoal.toLocaleString("zh-CN")} ${t("wordCount.unit")}` : t("meta.wordGoalPlaceholder")}
                />
                <MetaRow label={t("meta.updated")} value={current().updated} />
                <MetaRow label={t("meta.path")} value={current().path} mono />
              </dl>
            </section>

            <section class="meta__section">
              <h3 class="meta__heading">{t("wordCount.panelTitle")}</h3>
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
                <MetaRow label={t("wordCount.chapterCount")} value={`${totalChapters()}`} />
                <MetaRow label={t("wordCount.volumeCount")} value={`${volumes().length}`} />
              </dl>
              <p class="meta__note">{CHART_HINT}</p>
            </section>
          </>
        )}
      </Show>
    </aside>
  );
}

/** 一行"标签 — 值"。 */
function MetaRow(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div class="meta__row">
      <dt class="meta__key">{props.label}</dt>
      <dd class={["meta__value", props.mono ? "meta__value--mono" : ""].filter(Boolean).join(" ")} title={props.value}>
        {props.value}
      </dd>
    </div>
  );
}

/** 取卷名。找不到时返回空串而不是 "undefined"。 */
function volumeName(volumeId: string): string {
  return volumes().find((v) => v.id === volumeId)?.title ?? "";
}

/** 本卷字数。 */
function volumeWords(volumeId: string): number {
  const doc = workspaceState.document;
  if (!doc) return 0;
  return doc.chapters.filter((c) => c.volumeId === volumeId).reduce((sum, c) => sum + c.wordCount, 0);
}
