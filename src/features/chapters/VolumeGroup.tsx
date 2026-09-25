/**
 * 卷章树中的一个卷分组。
 *
 * ## 折叠设计
 *
 * 卷的展开状态**不进 localStorage**：它是临时的浏览状态而非偏好，
 * 每次打开书时全部展开更符合"我先看看全局"的默认意图。
 * 只有面板宽度这类长期偏好才值得持久化（见 layout-store）。
 *
 * ## 拖拽落点
 *
 * 卷体本身是一个 drop 容器，因此空卷也能接住拖来的章节——
 * 这一点必须处理，否则"把章从第一卷拖到空着的第三卷"会失败，
 * 而这是最自然的用法之一。
 */

import { For, Show, createSignal, type JSX } from "solid-js";

import type { ChapterSummary, Volume } from "@/lib/ipc";
import { IconChevron, IconGrip, IconPencil, IconPlus, IconTrash, IconVolume } from "@/app/ui/icons";
import { IconButton } from "@/app/ui/IconButton";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyVolume } from "@/app/ui/illustrations";
import { Button } from "@/app/ui/Button";
import { t } from "@/strings";
import { ChapterRow } from "./ChapterRow";
import { InlineEdit, titleErrorMessage } from "./InlineEdit";

/** 卷分组属性。 */
export interface VolumeGroupProps {
  /** 卷数据。 */
  volume: Volume;
  /** 卷内章节（已排序）。 */
  chapters: ChapterSummary[];
  /** 当前选中的章节 ID。 */
  selectedChapterId: string | null;
  /** 正在被拖拽的实体 ID。 */
  draggingId: string | null;
  /** 正在被拖拽的卷 ID。 */
  draggingVolumeId: string | null;
  /** 选中章节。 */
  onSelectChapter: (chapterId: string) => void;
  /** 重命名卷。 */
  onRenameVolume: (title: string) => void;
  /** 删除卷。 */
  onDeleteVolume: () => void;
  /** 在本卷新建章。 */
  onAddChapter: () => void;
  /** 重命名章。 */
  onRenameChapter: (chapterId: string, title: string) => void;
  /** 删除章。 */
  onDeleteChapter: (chapterId: string) => void;
  /** 章行的拖拽开始。 */
  onChapterDragStart: (event: PointerEvent, chapter: ChapterSummary, element: HTMLElement) => void;
  /** 卷头的拖拽开始。 */
  onVolumeDragStart: (event: PointerEvent, volume: Volume, element: HTMLElement) => void;
  /** 注册卷体元素（作为 drop 容器）。 */
  registerContainer: (volumeId: string, element: HTMLElement | undefined) => void;
  /** 注册章行元素。 */
  registerRow: (chapterId: string, volumeId: string, element: HTMLElement | undefined) => void;
  /** 卷头元素注册（用于卷拖拽的几何计算）。 */
  registerVolumeRow: (volumeId: string, element: HTMLElement | undefined) => void;
  /** 当前落点是否在本卷，以及落点索引。 */
  dropHint: { active: boolean; index: number } | null;
}

/** 一个卷及其章节。 */
export function VolumeGroup(props: VolumeGroupProps): JSX.Element {
  const [open, setOpen] = createSignal(true);
  const [editing, setEditing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let headerRef: HTMLLIElement | undefined;

  const totalWords = () => props.chapters.reduce((sum, c) => sum + c.wordCount, 0);

  return (
    <li
      ref={(el) => {
        headerRef = el;
        props.registerVolumeRow(props.volume.id, el);
      }}
      class={["tree-group", props.draggingVolumeId === props.volume.id ? "is-dragging" : ""].filter(Boolean).join(" ")}
      data-flip-id={`vol:${props.volume.id}`}
      role="treeitem"
      aria-expanded={open()}
    >
      <div class="tree-group__header">
        <button
          type="button"
          class="tree-group__toggle"
          aria-label={open() ? t("action.collapse") : t("action.expand")}
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
        >
          <IconChevron size={14} open={open()} />
        </button>

        <span
          class="tree-group__grip"
          aria-label={t("chapters.dragHandle")}
          title={t("chapters.dragHandle")}
          onPointerDown={(event) => {
            if (headerRef) props.onVolumeDragStart(event, props.volume, headerRef);
          }}
        >
          <IconGrip size={14} />
        </span>

        <span class="tree-group__glyph" aria-hidden="true">
          <IconVolume size={14} />
        </span>

        <Show
          when={editing()}
          fallback={
            <span class="tree-group__title" onDblClick={() => setEditing(true)}>
              {props.volume.title}
            </span>
          }
        >
          <InlineEdit
            class="tree-group__edit"
            value={props.volume.title}
            label={t("action.rename")}
            onCommit={(value) => {
              setEditing(false);
              props.onRenameVolume(value);
            }}
            onCancel={() => setEditing(false)}
            onReject={(reason) => setError(titleErrorMessage(reason))}
          />
        </Show>

        <Show when={!editing()}>
          <span class="tree-group__meta">
            <span class="tree-group__words">{totalWords().toLocaleString("zh-CN")}</span>
          </span>
        </Show>

        <span class="tree-group__actions">
          <IconButton
            size="sm"
            label={t("action.rename")}
            onClick={(event) => {
              event.stopPropagation();
              setEditing(true);
            }}
          >
            <IconPencil size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("chapters.addChapter")}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(true);
              props.onAddChapter();
            }}
          >
            <IconPlus size={14} />
          </IconButton>
          <IconButton
            size="sm"
            danger
            label={t("action.moveToTrash")}
            onClick={(event) => {
              event.stopPropagation();
              props.onDeleteVolume();
            }}
          >
            <IconTrash size={14} />
          </IconButton>
        </span>
      </div>

      <Show when={error() !== null}>
        <span class="tree-group__error" role="alert">
          {error()}
        </span>
      </Show>

      <Show when={open()}>
        <ul
          class={["tree-group__body", props.dropHint?.active ? "is-drop-target" : ""].filter(Boolean).join(" ")}
          ref={(el) => props.registerContainer(props.volume.id, el)}
          role="group"
        >
          <Show
            when={props.chapters.length > 0}
            fallback={
              <li class="tree-group__empty">
                <EmptyState
                  compact
                  align="start"
                  illustration={<IllustrationEmptyVolume size={24} />}
                  title={t("chapters.volumeEmpty")}
                  action={
                    <Button variant="ghost" size="sm" onClick={() => props.onAddChapter()}>
                      {t("chapters.addChapter")}
                    </Button>
                  }
                />
              </li>
            }
          >
            <For each={props.chapters}>
              {(chapter, index) => (
                <>
                  {/* 落点指示线：插在两个行之间的缝隙上 */}
                  <Show when={props.dropHint?.active && props.dropHint.index === index()}>
                    <li class="drop-line" aria-hidden="true" />
                  </Show>
                  <ChapterRow
                    chapter={chapter}
                    index={index() + 1}
                    selected={props.selectedChapterId === chapter.id}
                    dragging={props.draggingId === chapter.id}
                    onSelect={() => props.onSelectChapter(chapter.id)}
                    onRename={(title) => props.onRenameChapter(chapter.id, title)}
                    onDelete={() => props.onDeleteChapter(chapter.id)}
                    onDragStart={(event, element) => props.onChapterDragStart(event, chapter, element)}
                    registerRef={(element) => props.registerRow(chapter.id, props.volume.id, element)}
                  />
                </>
              )}
            </For>
            {/* 末尾落点线：拖到卷内最后一行下方 */}
            <Show when={props.dropHint?.active && props.dropHint.index >= props.chapters.length}>
              <li class="drop-line" aria-hidden="true" />
            </Show>
          </Show>
        </ul>
      </Show>
    </li>
  );
}
