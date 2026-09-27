/**
 * 顶部工具栏（T5.1）。
 *
 * ## 放什么、不放什么
 *
 * 只放**高频且全局**的动作：新建卷、新建章、搜索、设置、书架。
 * 低频操作（导出、统计、回收站）留给命令面板与右键菜单 ——
 * 工具栏每多一个按钮，写作时的视觉噪音就多一分，
 * 这与计划书 5.1 节「写作时屏幕上只有字」直接冲突。
 *
 * ## 保存状态指示
 *
 * 圆点的形状与颜色表达四种状态（已保存 / 保存中 / 有改动 / 失败）。
 * 计划书 5.6 节要求「动效永不作为唯一反馈」，因此状态同时有
 * `aria-live` 文本，屏幕阅读器可以听到。
 */

import { Show, type JSX } from "solid-js";

import { t } from "@/strings";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import {
  IconBack,
  IconCommand,
  IconLibrary,
  IconPanelLeft,
  IconPanelRight,
  IconPlus,
  IconSearch,
  IconSave,
  IconSettings,
  IconStats,
} from "./ui/icons";
import { layout, toggleLeft, toggleRight } from "./layout-store";

/** 保存状态。 */
export type SaveState = "idle" | "saving" | "dirty" | "failed";

/** 工具栏属性。 */
export interface ToolbarProps {
  /** 书名（显示在中间）。 */
  bookTitle: string;
  /** 是否显示「新建卷」按钮（书架页不显示）。 */
  showTreeActions: boolean;
  /** 保存状态。 */
  saveState: SaveState;
  /** 新建卷。 */
  onNewVolume: () => void;
  /** 新建章。 */
  onNewChapter: () => void;
  /** 打开搜索。 */
  onSearch: () => void;
  /** 打开设置。 */
  onSettings: () => void;
  /** 回到书架。 */
  onLibrary: () => void;
  /** 打开写作统计（M8）。 */
  onStats: () => void;
  /** 打开命令面板（T5.7）。 */
  onCommands: () => void;
  /** Save the current chapter immediately. */
  onSave: () => void;
}

/** 顶部工具栏。 */
export function Toolbar(props: ToolbarProps): JSX.Element {
  return (
    <header class="toolbar">
      <div class="toolbar__group toolbar__group--left">
        <IconButton label={t("toolbar.library")} onClick={props.onLibrary}>
          <IconBack size={17} />
        </IconButton>
        <IconButton
          label={layout.leftCollapsed ? t("toolbar.toggleLeft") : t("toolbar.toggleLeft")}
          active={!layout.leftCollapsed}
          onClick={toggleLeft}
        >
          <IconPanelLeft size={17} />
        </IconButton>
        <Show when={props.showTreeActions}>
          <span class="toolbar__sep" aria-hidden="true" />
          <Button variant="ghost" size="sm" onClick={props.onNewVolume}>
            <IconPlus size={14} />
            <span class="toolbar__label">{t("toolbar.newVolume")}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onNewChapter}>
            <IconPlus size={14} />
            <span class="toolbar__label">{t("toolbar.newChapter")}</span>
          </Button>
        </Show>
      </div>

      <div class="toolbar__group toolbar__group--center">
        <span class="toolbar__title" title={props.bookTitle}>
          {props.bookTitle}
        </span>
        <SaveIndicator state={props.saveState} />
      </div>

      <div class="toolbar__group toolbar__group--right">
        <Button
          variant={props.saveState === "dirty" || props.saveState === "failed" ? "solid" : "ghost"}
          size="sm"
          onClick={props.onSave}
          disabled={props.saveState === "saving"}
          title={`${t("action.save")} (Ctrl/Cmd+S)`}
          aria-keyshortcuts="Control+S Meta+S"
        >
          <IconSave size={14} />
          <span class="toolbar__label">{t("action.save")}</span>
        </Button>
        {/* 命令面板入口（Ctrl+K）。它把所有低频功能收进一个入口，
            这样工具栏才能保持"只有写作相关的东西" */}
        <IconButton label={t("toolbar.commands")} onClick={props.onCommands}>
          <IconCommand size={17} />
        </IconButton>
        <IconButton label={t("toolbar.search")} onClick={props.onSearch}>
          <IconSearch size={17} />
        </IconButton>
        <IconButton label={t("toolbar.stats")} onClick={props.onStats}>
          <IconStats size={17} />
        </IconButton>
        <IconButton
          label={layout.rightCollapsed ? t("toolbar.toggleRight") : t("toolbar.toggleRight")}
          active={!layout.rightCollapsed}
          onClick={toggleRight}
        >
          <IconPanelRight size={17} />
        </IconButton>
        <IconButton label={t("toolbar.settings")} onClick={props.onSettings}>
          <IconSettings size={17} />
        </IconButton>
      </div>
    </header>
  );
}

/** 保存状态指示点。 */
function SaveIndicator(props: { state: SaveState }): JSX.Element {
  const label = (): string => {
    switch (props.state) {
      case "saving":
        return t("saveState.saving");
      case "dirty":
        return t("saveState.dirty");
      case "failed":
        return t("saveState.failed");
      case "idle":
        return t("saveState.idle");
    }
  };

  return (
    <span class={`save-dot save-dot--${props.state}`} role="status" aria-live="polite" title={label()}>
      <span class="save-dot__mark" aria-hidden="true" />
      <span class="save-dot__text">{label()}</span>
    </span>
  );
}

/**
 * 书架页专用的极简顶栏。
 *
 * 与写作台的工具栏分开，因为两者可用动作差别很大
 * （书架没有"新建卷"，有的是"打开已有工作区"）。
 * 用一个组件加一堆条件判断会让每个按钮都得考虑"在不在书架"。
 */
export function LibraryToolbar(props: { onSearch: () => void; onSettings: () => void; onNewWorkspace: () => void }): JSX.Element {
  return (
    <header class="toolbar toolbar--library">
      <div class="toolbar__group toolbar__group--left">
        <span class="toolbar__brand">
          <IconLibrary size={18} />
          <span class="toolbar__brand-text">{t("app.name")}</span>
        </span>
      </div>
      <div class="toolbar__group toolbar__group--right">
        <Button variant="outline" size="sm" onClick={props.onNewWorkspace}>
          <IconPlus size={14} />
          <span class="toolbar__label">{t("library.newWorkspace")}</span>
        </Button>
        <IconButton label={t("toolbar.search")} onClick={props.onSearch}>
          <IconSearch size={17} />
        </IconButton>
        <IconButton label={t("toolbar.settings")} onClick={props.onSettings}>
          <IconSettings size={17} />
        </IconButton>
      </div>
    </header>
  );
}
