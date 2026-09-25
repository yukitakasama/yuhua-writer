/**
 * 卷章树中的一行（章）。
 *
 * ## 结构与职责
 *
 * 一行负责三件事：展示（标题 / 字数 / 状态）、交互（选中、内联改名、
 * 拖拽手柄）、无障碍（treeitem 角色 + 展开状态）。
 *
 * ## 为什么字数与状态放在同一行右侧
 *
 * 长篇作者的日常疑问是"今天这章写了多少""哪几章还没定稿"。
 * 把这两个信息固定在行尾右对齐，扫视时不用横向找位置——
 * 移动端列表应用里同样的理由。
 */

import { Show, createSignal, type JSX } from "solid-js";

import type { ChapterSummary } from "@/lib/ipc";
import { IconChapter, IconGrip, IconPencil, IconTrash } from "@/app/ui/icons";
import { IconButton } from "@/app/ui/IconButton";
import { StatusDot } from "@/app/ui/StatusDot";
import { t } from "@/strings";
import { InlineEdit, titleErrorMessage } from "./InlineEdit";

/** 行属性。 */
export interface ChapterRowProps {
  /** 章节数据。 */
  chapter: ChapterSummary;
  /** 是否被选中。 */
  selected: boolean;
  /** 序号（从 1 开始，用于无障碍朗读）。 */
  index: number;
  /** 是否正在被拖动（用于降低不透明度）。 */
  dragging: boolean;
  /** 点击选中。 */
  onSelect: () => void;
  /** 提交改名。 */
  onRename: (title: string) => void;
  /** 删除。 */
  onDelete: () => void;
  /** 指针在抓取手柄上按下。 */
  onDragStart: (event: PointerEvent, element: HTMLElement) => void;
  /** 行元素注册回调，供拖拽几何计算使用。 */
  registerRef: (element: HTMLElement | undefined) => void;
}

/** 一行章节。 */
export function ChapterRow(props: ChapterRowProps): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let rowRef: HTMLLIElement | undefined;

  const label = () => `第 ${props.index} 章 ${props.chapter.title}`;

  return (
    <li
      ref={(el) => {
        rowRef = el;
        props.registerRef(el);
      }}
      class={["tree-row", "tree-row--chapter", props.selected ? "is-selected" : "", props.dragging ? "is-dragging" : ""]
        .filter(Boolean)
        .join(" ")}
      data-flip-id={props.chapter.id}
      role="treeitem"
      aria-selected={props.selected}
      aria-label={label()}
      tabindex={props.selected ? 0 : -1}
      onClick={(event) => {
        // 点击改名框或按钮时不触发选中，否则会打断编辑
        if (event.target instanceof HTMLElement && event.target.closest("button, .inline-edit")) return;
        props.onSelect();
      }}
      onDblClick={() => setEditing(true)}
    >
      <span
        class="tree-row__grip"
        aria-label={t("chapters.dragHandle")}
        title={t("chapters.dragHandle")}
        onPointerDown={(event) => {
          if (rowRef) props.onDragStart(event, rowRef);
        }}
      >
        <IconGrip size={14} />
      </span>

      <span class="tree-row__glyph" aria-hidden="true">
        <IconChapter size={14} />
      </span>

      <Show
        when={editing()}
        fallback={
          <>
            <span class="tree-row__title" onDblClick={() => setEditing(true)}>
              {props.chapter.title}
            </span>
            <span class="tree-row__actions">
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
                danger
                label={t("action.moveToTrash")}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onDelete();
                }}
              >
                <IconTrash size={14} />
              </IconButton>
            </span>
          </>
        }
      >
        <InlineEdit
          class="tree-row__edit"
          value={props.chapter.title}
          label={t("action.rename")}
          onCommit={(value) => {
            setEditing(false);
            props.onRename(value);
          }}
          onCancel={() => setEditing(false)}
          onReject={(reason) => setError(titleErrorMessage(reason))}
        />
      </Show>

      <Show when={!editing()}>
        <span class="tree-row__meta">
          <StatusDot status={props.chapter.status} />
          <span class="tree-row__words">{props.chapter.wordCount.toLocaleString("zh-CN")}</span>
        </span>
      </Show>

      <Show when={error() !== null}>
        <span class="tree-row__error" role="alert">
          {error()}
        </span>
      </Show>
    </li>
  );
}
