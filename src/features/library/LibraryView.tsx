/**
 * 书架（T5.2）。
 *
 * ## 两个区块的理由
 *
 * **最近打开**在上、**全部书籍**在下。长篇小说作者通常同时只有一两本
 * 在写，全部书籍列表会很长。把"最近"提出来放在最上方，让日常动作
 * （继续写昨天那本）永远在第一时间可见，不必在长列表里找。
 *
 * ## 空状态与引导的关系
 *
 * 书架为空时**不显示两个空区块**，而是只显示一个引导 ——
 * 用两个空状态表达同一件事（"你还没有书"）是冗余的噪音。
 *
 * ## 时间显示
 *
 * 「3 天前」比「2026-09-22 14:30」更容易扫视，但**精确时间也要有**
 * （title 属性），因为作者会想知道"我上次写到几点"。
 */

import { For, Show, createMemo, type JSX } from "solid-js";

import { t } from "@/strings";
import { Button } from "@/app/ui/Button";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyLibrary } from "@/app/ui/illustrations";
import type { WorkspaceSummary } from "@/lib/ipc";
import { BookCover } from "./BookCover";
import { formatRelativeTime } from "./time";

/** 书架属性。 */
export interface LibraryViewProps {
  /** 最近打开的工作区。 */
  recents: WorkspaceSummary[];
  /** 打开一个工作区。 */
  onOpen: (root: string) => void;
  /** 进入新建工作区引导。 */
  onNewWorkspace: () => void;
}

/** 书架主视图。 */
export function LibraryView(props: LibraryViewProps): JSX.Element {
  /** 只保留仍然可用的最近项：失效的路径点进去只会报错。 */
  const usableRecents = createMemo(() => props.recents.slice(0, 6));

  return (
    <div class="library">
      <Show
        when={props.recents.length > 0}
        fallback={
          <EmptyState
            illustration={<IllustrationEmptyLibrary size={148} />}
            title={t("library.emptyTitle")}
            body={t("library.emptyBody")}
            action={
              <Button variant="solid" onClick={props.onNewWorkspace}>
                {t("library.newWorkspace")}
              </Button>
            }
          />
        }
      >
        <section class="library__section">
          <h2 class="library__heading">{t("library.recent")}</h2>
          <Show
            when={usableRecents().length > 0}
            fallback={<p class="library__hint">{t("library.recentEmpty")}</p>}
          >
            <ul class="recents">
              <For each={usableRecents()}>
                {(item) => (
                  <RecentRow
                    item={item}
                    onOpen={() => props.onOpen(item.root)}
                  />
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="library__section">
          <h2 class="library__heading">{t("library.allBooks")}</h2>
          <ul class="shelf">
            <For each={props.recents}>
              {(item) => (
                <ShelfCard item={item} onOpen={() => props.onOpen(item.root)} />
              )}
            </For>
            <li class="shelf__add">
              <button
                type="button"
                class="shelf__add-btn"
                onClick={props.onNewWorkspace}
              >
                <IllustrationEmptyLibrary size={44} />
                <span>{t("library.newWorkspace")}</span>
              </button>
            </li>
          </ul>
        </section>
      </Show>
    </div>
  );
}

/** 最近打开列表里的一行。 */
function RecentRow(props: {
  item: WorkspaceSummary;
  onOpen: () => void;
}): JSX.Element {
  const time = () =>
    props.item.lastOpened === null
      ? t("library.neverOpened")
      : formatRelativeTime(props.item.lastOpened);
  return (
    <li>
      <button
        type="button"
        class="recent"
        disabled={!props.item.available}
        onClick={props.onOpen}
      >
        <span class="recent__cover" aria-hidden="true">
          <BookCover title={props.item.title} width={34} showTitle={false} />
        </span>
        <span class="recent__body">
          <span class="recent__title">{props.item.title}</span>
          <span class="recent__meta" title={props.item.lastOpened ?? ""}>
            {time()}
          </span>
        </span>
        <Show when={!props.item.available}>
          <span class="recent__flag">{t("library.unavailable")}</span>
        </Show>
      </button>
    </li>
  );
}

/** 书籍网格里的一张卡片。 */
function ShelfCard(props: {
  item: WorkspaceSummary;
  onOpen: () => void;
}): JSX.Element {
  return (
    <li class={`shelf__card${props.item.available ? "" : " is-unavailable"}`}>
      <button
        type="button"
        class="shelf__card-btn"
        disabled={!props.item.available}
        onClick={props.onOpen}
      >
        <BookCover title={props.item.title} width={132} />
        <span class="shelf__title">{props.item.title}</span>
        <span class="shelf__meta">
          <Show
            when={!props.item.available}
            fallback={formatRelativeTime(
              props.item.lastOpened ?? props.item.created,
            )}
          >
            {t("library.unavailable")}
          </Show>
        </span>
      </button>
    </li>
  );
}
