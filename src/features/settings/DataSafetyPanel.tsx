/**
 * 数据安全分区（M9 补的一块）。
 *
 * ## 为什么把这三件事放同一页
 *
 * 崩溃恢复、云盘冲突副本、回收站 —— 它们在用户心智里是同一个问题：
 * 「我的稿子会不会丢、丢了我上哪找」。拆到外观 / 高级 / 维护三个页签里，
 * 结果是真要出事时没有人知道去哪看。所以这一页是**面向事故**的，
 * 不是面向设置的。
 *
 * ## 恢复报告读的是 store 里那份，不重新请求
 *
 * `ipc.getRecoveryReport(root)` 的实现是 `openWorkspace(root)` 再取
 * `result.recovery` —— 后端没有独立的恢复报告命令，扫描只发生在打开工作区时。
 * 因此本页刻意不调用它：重新打开一次会重置编辑器状态，用户如果正带着
 * 未保存的改动点开设置想「看看有没有问题」，就会把稿子丢掉。
 * 一个「检查」按钮造成数据丢失，比没有这个按钮糟得多。
 *
 * 打开时那份报告本来就随 `document` 存在 store 里（`documentFromOpenResult`
 * 已经把 `recovery` 放进去了），所以这里直接读它，并在标题上说清楚它是
 * 「本次打开时」的结果 —— 时间语义诚实，比假装实时更可信。
 *
 * ## 冲突只报告、绝不自动删，也不给删除按钮
 *
 * 计划书 4.5 的取向：云盘冲突副本可能是用户唯一的一份改动，程序没有判断依据。
 * 这里给出路径与命中的命名规则，让用户自己决定。界面上不提供「删除冲突」
 * 按钮 —— 少一个可点的破坏性入口，就少一次误删的机会。
 *
 * ## 重建索引为什么敢不给二次确认
 *
 * 索引是可从正文完全重建的派生数据（计划书把「索引外置、可重建」列为设计约束），
 * `rebuild_index` 幂等且不触碰稿件文件。它与本页其它动作不在同一个风险等级：
 * 回收站的「彻底删除」需要确认，这个不需要。
 */

import { For, Show, createSignal, type JSX } from "solid-js";

import { Button } from "@/design/primitives";
import { workspaceState } from "@/app/workspace-store";
import * as ipc from "@/lib/ipc";
import { t } from "@/strings";
import { TrashSection } from "./TrashSection";

/** 索引重建的阶段。 */
type RebuildPhase = "idle" | "running" | "done" | "failed";

/**
 * 数据安全分区。
 *
 * @example
 * <DataSafetyPanel />
 */
export function DataSafetyPanel(): JSX.Element {
  const [rebuild, setRebuild] = createSignal<RebuildPhase>("idle");
  const [rebuildError, setRebuildError] = createSignal("");

  async function rebuildNow(): Promise<void> {
    setRebuild("running");
    setRebuildError("");
    try {
      await ipc.rebuildIndex();
      setRebuild("done");
    } catch (error) {
      setRebuildError(String(error));
      setRebuild("failed");
    }
  }

  // 报告随 document 一起存在 store 里；没打开工作区时为 null
  const recovery = () => workspaceState.document?.recovery ?? null;
  const interrupted = () => recovery()?.interruptedOperations ?? [];
  const conflicts = () => recovery()?.conflicts ?? [];

  return (
    <div class="data-safety">
      <section class="data-safety__block" aria-labelledby="recovery-heading">
        <h4 id="recovery-heading" class="data-safety__title">
          {t("settings.data.recovery")}
        </h4>
        <p class="data-safety__hint">{t("settings.data.recoveryNote")}</p>

        <Show
          when={interrupted().length > 0}
          fallback={
            <p class="data-safety__empty">
              {t("settings.data.noInterruption")}
            </p>
          }
        >
          <ul class="data-safety__list">
            <For each={interrupted()}>
              {(operation) => (
                <li class="data-safety__list-item">{operation}</li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={(recovery()?.pendingPaths.length ?? 0) > 0}>
          <ul class="data-safety__list data-safety__list--paths">
            <For each={recovery()?.pendingPaths ?? []}>
              {(path) => <li class="data-safety__path">{path}</li>}
            </For>
          </ul>
        </Show>

        <p class="data-safety__counts">
          {t("settings.data.sweptTemp", {
            count: recovery()?.sweptTempFiles ?? 0,
          })}
          {" · "}
          {t("settings.data.purgedTrash", {
            count: recovery()?.purgedTrashItems ?? 0,
          })}
        </p>
      </section>

      <section class="data-safety__block" aria-labelledby="conflict-heading">
        <h4 id="conflict-heading" class="data-safety__title">
          {t("settings.data.conflicts")}
        </h4>
        <p class="data-safety__hint">{t("settings.data.conflictNote")}</p>
        <Show
          when={conflicts().length > 0}
          fallback={
            <p class="data-safety__empty">{t("settings.data.noConflicts")}</p>
          }
        >
          <ul class="data-safety__list">
            <For each={conflicts()}>
              {(conflict) => (
                <li class="data-safety__list-item">
                  <span class="data-safety__file">{conflict.fileName}</span>
                  <span class="data-safety__path">{conflict.relativePath}</span>
                  <span class="data-safety__pattern">
                    {conflict.patternLabel}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="data-safety__block" aria-labelledby="index-heading">
        <h4 id="index-heading" class="data-safety__title">
          {t("settings.data.index")}
        </h4>
        <p class="data-safety__hint">{t("settings.data.indexNote")}</p>
        <Show when={rebuildError()}>
          <p class="data-safety__error" role="alert">
            {rebuildError()}
          </p>
        </Show>
        <div class="data-safety__actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={rebuild() === "running"}
            onClick={() => void rebuildNow()}
          >
            {t("settings.data.rebuild")}
          </Button>
          <Show when={rebuild() === "running"}>
            <span class="data-safety__status">
              {t("settings.data.rebuilding")}
            </span>
          </Show>
          <Show when={rebuild() === "done"}>
            <span class="data-safety__status" role="status">
              {t("settings.data.rebuildDone")}
            </span>
          </Show>
        </div>
      </section>

      <TrashSection />
    </div>
  );
}
