/**
 * 卷章树面板（T5.3）。
 *
 * ## 数据流
 *
 * `workspace-store`（后端真相）→ 本地 `TreeSnapshot`（纯函数操作的输入）
 * → 组件渲染。所有结构性操作（增删改移）都先经过 `tree-ops` 的纯函数
 * 算出新快照，再提交给 store 落盘。
 *
 * ## 为什么本地还要一份快照
 *
 * 拖拽时机敏感：用户松手时希望**立刻**看到新顺序，而 IPC 落盘 + 重读
 * 有几十毫秒的往返。因此先在本地应用纯函数的结果，再异步提交；
 * 失败时 store 的 reloadDocument 会把真相拉回来覆盖本地。
 *
 * 这与 workspace-store 里的乐观更新是同一套思路，只是这里的粒度为整棵树。
 */

import { For, Show, createMemo, type JSX } from "solid-js";

import { t } from "@/strings";
import { Button } from "@/app/ui/Button";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyTree } from "@/app/ui/illustrations";
import type { ChapterSummary, Volume } from "@/lib/ipc";
import { capturePositions, playFlip } from "@/lib/flip";
import {
  addVolume as addVolumeRemote,
  addChapter as addChapterRemote,
  chaptersIn,
  moveChapterTo,
  moveVolumeTo,
  removeChapter as removeChapterRemote,
  removeVolume as removeVolumeRemote,
  renameChapterLocal,
  renameVolumeLocal,
  selectChapter,
  selectedChapterId,
  volumes as storeVolumes,
  workspaceState,
} from "@/app/workspace-store";
import { VolumeGroup } from "./VolumeGroup";
import { createDragController } from "./use-drag";
import {
  chaptersOf,
  defaultChapterTitle,
  defaultVolumeTitle,
  moveChapter as moveChapterOp,
  removeChapter as removeChapterOp,
  removeVolume as removeVolumeOp,
  type TreeSnapshot,
} from "./tree-ops";

/** 卷章树面板。 */
export function ChapterTree(): JSX.Element {
  /** 本地快照：来自 store，但在拖拽期间会被本地演算结果覆盖。 */
  const snapshot = createMemo<TreeSnapshot>(() => ({
    volumes: storeVolumes(),
    chapters: (workspaceState.document?.chapters ?? []) as ChapterSummary[],
  }));

  /** 当前被拖拽的实体 ID（ch_xxx 或 vol:xxx），未拖拽时为 null。 */
  const draggingId = (): string | null => drag.state().draggedId;

  /**
   * 被拖拽的卷 ID。
   *
   * 单独抽一个访问器而不是在 JSX 里写 `draggedId?.startsWith(...) ? ... : null`：
   * 那种写法要么重复调用三次 state()，要么因为可选链的收窄失效而报
   * "可能为 null"。集中在这里也让"vol: 前缀代表卷"这条约定只出现一次。
   */
  const draggingVolumeId = (): string | null => {
    const id = draggingId();
    return id !== null && id.startsWith("vol:") ? id.slice(4) : null;
  };

  const drag = createDragController((draggedId, containerId, index) => {
    // 以 "vol:" 开头的是卷拖拽，否则是章拖拽
    if (draggedId.startsWith("vol:")) {
      const volumeId = draggedId.slice(4);
      void moveVolumeTo(volumeId, index);
      return;
    }

    const before = capturePositions();
    const result = moveChapterOp(snapshot(), draggedId, {
      volumeId: containerId,
      index,
    });
    if (!result.changed) return;
    // FLIP 必须在 DOM 更新之后播放。Solid 的更新是同步的，
    // 但为了确保拿到的是最新布局，放到微任务里执行。
    queueMicrotask(() => playFlip(before));
    void moveChapterTo(draggedId, containerId, index);
  });

  /** 把拖拽状态整理成每个卷需要的落点提示。 */
  const dropHintFor = (
    volumeId: string,
  ): { active: boolean; index: number } | null => {
    const st = drag.state();
    const draggedId = st.draggedId;
    if (draggedId === null || draggedId.startsWith("vol:")) return null;
    if (st.overContainerId !== volumeId) return null;
    return { active: true, index: st.dropIndex };
  };

  // ---- 卷操作 ----

  const handleAddVolume = (): void => {
    const existing = storeVolumes();
    const title = defaultVolumeTitle(existing.length);
    void addVolumeRemote(title);
  };

  const handleRenameVolume = (volumeId: string, title: string): void => {
    void renameVolumeLocal(volumeId, title);
  };

  const handleDeleteVolume = (volume: Volume): void => {
    const hasChapters = chaptersOf(snapshot(), volume.id).length > 0;
    if (
      hasChapters &&
      !confirmDelete(t("chapters.title"), `${volume.title}（含其下全部章节）`)
    )
      return;
    const before = capturePositions();
    // 本地演算仅用于让位动效立即发生，真相以后端为准
    void removeVolumeOp(snapshot(), volume.id);
    queueMicrotask(() => playFlip(before));
    void removeVolumeRemote(volume.id);
  };

  const handleAddChapter = (volume: Volume): void => {
    const count = chaptersOf(snapshot(), volume.id).length;
    const title = defaultChapterTitle(count);
    const before = capturePositions();
    queueMicrotask(() => playFlip(before));
    void addChapterRemote(volume.id, title).then((created) => {
      if (created) selectChapter(created.id);
    });
  };

  // ---- 章操作 ----

  const handleRenameChapter = (chapterId: string, title: string): void => {
    void renameChapterLocal(chapterId, title);
  };

  const handleDeleteChapter = (chapterId: string): void => {
    const chapter = workspaceState.document?.chapters.find(
      (c) => c.id === chapterId,
    );
    if (!chapter) return;
    if (!confirmDelete(t("action.moveToTrash"), chapter.title)) return;
    const before = capturePositions();
    // 本地先算一遍只为让位动效立即发生；真相以后端返回为准
    void removeChapterOp(snapshot(), chapterId);
    queueMicrotask(() => playFlip(before));
    void removeChapterRemote(chapterId);
  };

  return (
    <div class="tree">
      <div class="tree__head">
        <h2 class="tree__title">{t("chapters.title")}</h2>
        <Button variant="ghost" size="sm" onClick={handleAddVolume}>
          {t("chapters.addVolume")}
        </Button>
      </div>

      <Show
        when={storeVolumes().length > 0}
        fallback={
          <EmptyState
            illustration={<IllustrationEmptyTree size={112} />}
            title={t("chapters.emptyTitle")}
            body={t("chapters.emptyBody")}
            action={
              <Button variant="solid" onClick={handleAddVolume}>
                {t("chapters.emptyAction")}
              </Button>
            }
          />
        }
      >
        <ul
          class="tree__list"
          role="tree"
          aria-label={t("a11y.treeRole")}
          ref={(el) => drag.registerContainer("__volumes__", el)}
        >
          <For each={storeVolumes()}>
            {(volume) => (
              <VolumeGroup
                volume={volume}
                chapters={chaptersIn(volume.id)}
                selectedChapterId={selectedChapterId()}
                draggingId={draggingId()}
                draggingVolumeId={draggingVolumeId()}
                onSelectChapter={selectChapter}
                onRenameVolume={(title) => handleRenameVolume(volume.id, title)}
                onDeleteVolume={() => handleDeleteVolume(volume)}
                onAddChapter={() => handleAddChapter(volume)}
                onRenameChapter={handleRenameChapter}
                onDeleteChapter={handleDeleteChapter}
                onChapterDragStart={(event, chapter, element) => {
                  drag.registerRow(chapter.id, volume.id, element);
                  drag.begin(event, {
                    id: chapter.id,
                    containerId: volume.id,
                    rect: element.getBoundingClientRect(),
                  });
                }}
                onVolumeDragStart={(event, vol, element) => {
                  drag.registerRow(`vol:${vol.id}`, "__volumes__", element);
                  drag.begin(event, {
                    id: `vol:${vol.id}`,
                    containerId: "__volumes__",
                    rect: element.getBoundingClientRect(),
                  });
                }}
                registerContainer={drag.registerContainer}
                registerRow={drag.registerRow}
                registerVolumeRow={(volumeId, element) => {
                  // 卷头的行注册由 onVolumeDragStart 处理，这里只用于落点采样
                  if (element === undefined)
                    drag.registerRow(
                      `vol:${volumeId}`,
                      "__volumes__",
                      undefined,
                    );
                }}
                dropHint={dropHintFor(volume.id)}
              />
            )}
          </For>
        </ul>
      </Show>

      {/* 拖动跟随元素：固定在指针位置，用 transform 定位（只动画 transform） */}
      <Show when={drag.isDragging()}>
        <div
          class="drag-ghost"
          aria-hidden="true"
          style={{
            width: `${drag.state().size.width}px`,
            height: `${drag.state().size.height}px`,
            transform: `translate3d(${drag.state().pointer.x + 12}px, ${drag.state().pointer.y + 8}px, 0)`,
          }}
        >
          <span class="drag-ghost__text">{t("chapters.draggingTip")}</span>
        </div>
      </Show>

      {/* 拖拽时禁用文本选择，避免出现蓝色选区 */}
      <Show when={drag.isDragging()}>
        <div class="drag-shield" aria-hidden="true" />
      </Show>
    </div>
  );
}

/**
 * 破坏性操作前的确认。
 *
 * 章节删除是移入回收站（可恢复），卷删除会连带其下所有章节。
 * 这里用原生 confirm 是**临时实现**：设计系统的 Dialog 由另一个代理
 * 负责，等它落地后替换成自绘弹窗。之所以先用原生，是因为"删除整卷"
 * 这种不可逆的批量操作没有确认实在太危险，宁可视觉不统一。
 */
function confirmDelete(what: string, name: string): boolean {
  if (typeof window === "undefined" || typeof window.confirm !== "function")
    return true;
  return window.confirm(`确定要删除${what}「${name}」吗？`);
}

/** 供外部（工具栏）调用的新建章入口。 */
export async function createFirstChapter(): Promise<void> {
  const vols = storeVolumes();
  const first = vols[0];
  if (!first) return;
  const snapshot: TreeSnapshot = {
    volumes: vols,
    chapters: (workspaceState.document?.chapters ?? []) as ChapterSummary[],
  };
  const count = chaptersOf(snapshot, first.id).length;
  const created = await addChapterRemote(first.id, defaultChapterTitle(count));
  if (created) selectChapter(created.id);
}

/**
 * 构造一个纯快照。
 *
 * 导出给测试用：组件测试需要在不经过 IPC 的前提下准备树数据，
 * 且必须与 tree-ops 的输入形状完全一致。
 */
export function snapshotFrom(
  volumes: readonly Volume[],
  chapters: readonly ChapterSummary[],
): TreeSnapshot {
  return {
    volumes: volumes.map((v) => ({ ...v })),
    chapters: chapters.map((c) => ({ ...c })),
  };
}
