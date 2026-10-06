/**
 * 回收站分区（T2.6 的界面层）。
 *
 * ## 为什么它必须存在
 *
 * `list_trash` / `restore_trash` / `purge_trash` / `empty_trash` 四个后端命令
 * 早就写完且有测试，mock 也齐备，但界面上一个入口都没有 —— 于是「删掉的章节
 * 能找回」这句写在 README 里的承诺，实际上要求用户自己去开
 * `.yuhua/.trash/` 目录手工挪文件。契约一致性检查全绿也掩盖不了这件事，
 * 因为「命令有绑定」和「用户点得到」之间隔着的正是这一层。
 *
 * ## 破坏性动作用两步内联确认，而不是再开一个 Dialog
 *
 * 本组件渲染在设置面板这个 Dialog 内部。再套一层模态会带来两个真实问题：
 * 焦点陷阱嵌套（Esc 该关哪一层说不清）与读屏的层 announcement 混乱。
 * 所以「彻底删除」「清空」都先在原位把按钮换成「确认 / 取消」，
 * 一次点击生效、Esc 取消 —— 少一层模态，语义反而更明确。
 *
 * 同一行正在确认时，其它行的确认态会被收起：屏幕上同时出现两组
 * 「确认删除」按钮时，人很容易点错行。
 *
 * ## 不显示「还剩几天」
 *
 * 保留天数（30）只有一个真源，在 Rust 的 `TrashEntry::RETENTION_DAYS`。
 * 前端再抄一份常量去算倒计时，就是本次刚在 `yuhua-core::clock` 那件事上
 * 吃过亏的同一类错误：两处口径，改一处忘一处，且不会报错。
 * 到期条目会在打开工作区做崩溃恢复时被自动清理（见 `purgedTrashItems`），
 * 所以这里只说明机制，不重复那个数字。
 */

import { For, Show, createSignal, onMount, type JSX } from "solid-js";

import { Button } from "@/design/primitives";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@/features/library/time";
import * as ipc from "@/lib/ipc";
import type { TrashEntry } from "@/lib/ipc";
import { reloadDocument } from "@/app/workspace-store";
import { t } from "@/strings";

/** 分区自己的加载状态，不复用工作区状态机：它的生命周期比工作区短得多。 */
type Phase = "loading" | "ready" | "failed";

/**
 * 回收站列表。
 *
 * @example
 * <TrashSection />
 */
export function TrashSection(): JSX.Element {
  const [phase, setPhase] = createSignal<Phase>("loading");
  const [entries, setEntries] = createSignal<TrashEntry[]>([]);
  const [errorMessage, setErrorMessage] = createSignal("");
  /** 正在等待二次确认的那一条；`__all__` 表示「清空回收站」。 */
  const [awaiting, setAwaiting] = createSignal<string | null>(null);
  /** 正在执行动作的条目名，用于禁用按钮避免重复提交。 */
  const [busy, setBusy] = createSignal<string | null>(null);

  async function refresh(): Promise<void> {
    setPhase("loading");
    try {
      setEntries(await ipc.listTrash());
      setPhase("ready");
    } catch (error) {
      setErrorMessage(String(error));
      setPhase("failed");
    }
  }

  onMount(() => {
    void refresh();
  });

  /** 统一的动作包装：忙位 + 收起确认态 + 失败信息落到界面上。 */
  async function run(
    key: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    setBusy(key);
    setAwaiting(null);
    setErrorMessage("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setErrorMessage(String(error));
      // 不重刷：让失败时看到的那份列表保持原样，避免「看起来成功了」
      setPhase("ready");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section class="trash-section" aria-labelledby="trash-heading">
      <header class="trash-section__head">
        <h4 id="trash-heading" class="trash-section__title-row">
          {t("settings.trash.title")}
        </h4>
        <p class="trash-section__hint">{t("settings.trash.retentionNote")}</p>
      </header>

      <Show when={errorMessage()}>
        <p class="trash-section__error" role="alert">
          {errorMessage()}
        </p>
      </Show>

      <Show when={phase() === "loading"}>
        <p class="trash-section__hint">{t("settings.trash.loading")}</p>
      </Show>

      <Show when={phase() === "ready"}>
        <Show
          when={entries().length > 0}
          fallback={
            <p class="trash-section__empty">{t("settings.trash.empty")}</p>
          }
        >
          <ul class="trash-section__list">
            <For each={entries()}>
              {(entry) => (
                <li class="trash-section__item">
                  <div class="trash-section__meta">
                    <span class="trash-section__title">
                      {entry.originalTitle}
                    </span>
                    <span
                      class="trash-section__path"
                      title={entry.originalPath}
                    >
                      {entry.originalPath}
                    </span>
                    <span
                      class="trash-section__when"
                      title={formatAbsoluteTime(entry.deletedAt)}
                    >
                      {t("settings.trash.deletedAt", {
                        when: formatRelativeTime(entry.deletedAt),
                      })}
                    </span>
                  </div>

                  <div class="trash-section__actions">
                    <Show
                      when={awaiting() === entry.trashDirName}
                      fallback={
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy() !== null}
                            onClick={() =>
                              void run(entry.trashDirName, async () => {
                                await ipc.restoreFromTrash(entry.trashDirName);
                                // 恢复的就是卷章树里的一个节点：不重读文档，
                                // 那章在界面上仍然不存在，用户会以为没恢复成功，
                                // 于是再恢复一次或在原地新建同名章。
                                // reloadDocument 自己把失败记进 store 的错误态，
                                // 不会 reject，所以这里可以直接 await。
                                await reloadDocument();
                              })
                            }
                          >
                            {t("settings.trash.restore")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy() !== null}
                            onClick={() => setAwaiting(entry.trashDirName)}
                          >
                            {t("settings.trash.purge")}
                          </Button>
                        </>
                      }
                    >
                      <span class="trash-section__confirm-text">
                        {t("settings.trash.purgeConfirm", {
                          title: entry.originalTitle,
                        })}
                      </span>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busy() !== null}
                        onClick={() =>
                          void run(entry.trashDirName, () =>
                            ipc.purgeFromTrash(entry.trashDirName),
                          )
                        }
                      >
                        {t("settings.trash.purge")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAwaiting(null)}
                      >
                        {t("action.cancel")}
                      </Button>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>

          <div class="trash-section__footer">
            <Show
              when={awaiting() === ALL_KEY}
              fallback={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy() !== null}
                  onClick={() => setAwaiting(ALL_KEY)}
                >
                  {t("settings.trash.emptyAll")}
                </Button>
              }
            >
              <span class="trash-section__confirm-text">
                {t("settings.trash.emptyAllConfirm", {
                  count: entries().length,
                })}
              </span>
              <Button
                variant="danger"
                size="sm"
                disabled={busy() !== null}
                onClick={() => void run(ALL_KEY, () => ipc.emptyTrash())}
              >
                {t("settings.trash.emptyAll")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAwaiting(null)}
              >
                {t("action.cancel")}
              </Button>
            </Show>
          </div>
        </Show>
      </Show>
    </section>
  );
}

/** 「清空回收站」在 `awaiting` / `busy` 里占用的键，不会与真实目录名冲突。 */
const ALL_KEY = "__all__";
