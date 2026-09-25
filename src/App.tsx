/**
 * 应用壳（T5.1）。
 *
 * ## 布局模型
 *
 * ```
 * ┌─────────────────────────────────────────────┐
 * │ Toolbar（固定高度）                          │
 * ├──────────┬──────────────────────┬───────────┤
 * │ 卷章树    │ 编辑区                │ 元数据     │
 * │ (可折叠)  │ (自适应)              │ (可折叠)   │
 * └──────────┴──────────────────────┴───────────┘
 * ```
 *
 * 用 CSS Grid 而不是 flex：三栏布局里"中间自适应、两侧固定"在 Grid 里
 * 就是 `auto 1fr auto`，而 flex 需要给中间栏加 `flex: 1; min-width: 0`
 * 才能防止内容把栏撑破 —— Grid 的 `1fr` 天然不会溢出。
 *
 * ## 折叠动效
 *
 * 计划书 5.5 节要求「列宽过渡 + 内容 opacity 与 translateX，240ms」。
 * 实现上**折叠时把列宽过渡到 0**，而不是 `display: none`：
 * 后者没有过渡，界面会闪一下。内容额外做透明度与位移，
 * 让"收起来"的感觉更自然（只动画 transform 与 opacity）。
 *
 * ## 视图切换
 *
 * 书架与写作台是同一个组件的两个分支。用 `switch` 而不是路由库：
 * 第一阶段只有两个视图，引入路由库（以及它的 history 抽象）
 * 不划算，而且 Tauri 里没有 URL 语义。
 */

import { Match, Show, Switch, createEffect, createMemo, createSignal, onMount, type JSX } from "solid-js";

import { t } from "@/strings";
import { isTauri } from "@/lib/ipc";
import { ChapterTree } from "@/features/chapters/ChapterTree";
import { LibraryView } from "@/features/library/LibraryView";
import { NewWorkspace } from "@/features/library/NewWorkspace";
import { EditorPane } from "./app/EditorPane";
import { MetaPanel } from "./app/MetaPanel";
import { Resizer } from "./app/Resizer";
import { LibraryToolbar, Toolbar, type SaveState } from "./app/Toolbar";
import { IconClose, IconWarning } from "./app/ui/icons";
import { IconButton } from "./app/ui/IconButton";
import { SEARCH_HINT, SETTINGS_HINT } from "./app/placeholders";
import {
  LEFT_MAX,
  LEFT_MIN,
  RIGHT_MAX,
  RIGHT_MIN,
  layout,
  setLeftWidth,
  setRightWidth,
  setView,
} from "./app/layout-store";
import {
  addVolume as addVolumeRemote,
  clearError,
  closeWorkspace,
  createWorkspace,
  hasOpenWorkspace,
  openWorkspace,
  refreshRecents,
  workspaceState,
  createFirstChapter,
  volumes,
} from "./app/workspace-store";
import { defaultVolumeTitle } from "@/features/chapters/tree-ops";

/** 应用外壳。 */
export function App(): JSX.Element {
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [creatingWorkspace, setCreatingWorkspace] = createSignal(false);

  onMount(() => {
    void refreshRecents();
  });

  // 有打开的章节就切到写作台，否则停在书架。
  // 用 createEffect 而不是 onMount：工作区可能在会话中途被打开
  createEffect(() => {
    if (hasOpenWorkspace()) setView("workspace");
  });

  const bookTitle = createMemo(() => workspaceState.document?.book.title ?? "");
  const saveState = createMemo<SaveState>(() => (workspaceState.status === "loading" ? "saving" : "idle"));

  /** 新建卷：工具栏入口。 */
  const handleNewVolume = (): void => {
    void addVolumeRemote(defaultVolumeTitle(volumes().length));
  };

  /** 新建章。 */
  const handleNewChapter = (): void => void createFirstChapter();

  const handleOpen = (root: string): void => {
    void openWorkspace(root);
  };

  const handleCreateWorkspace = async (root: string, title: string): Promise<boolean> => {
    const ok = await createWorkspace(root, title);
    if (ok) setCreatingWorkspace(false);
    return ok;
  };

  const handleLibrary = (): void => {
    void closeWorkspace().then(() => setView("library"));
  };

  return (
    <div class="app">
      <Show when={!isTauri()}>
        <div class="banner banner--info" role="status">
          {t("app.browserMode")}
        </div>
      </Show>

      <Show when={workspaceState.error !== null}>
        <ErrorBanner onDismiss={clearError} />
      </Show>

      <Switch>
        <Match when={layout.view === "library" || creatingWorkspace()}>
          <LibraryToolbar
            onSearch={() => setSearchOpen(true)}
            onSettings={() => setSettingsOpen(true)}
            onNewWorkspace={() => setCreatingWorkspace(true)}
          />
          <Show
            when={!creatingWorkspace()}
            fallback={
              <NewWorkspace
                onCreate={handleCreateWorkspace}
                onCancel={() => setCreatingWorkspace(false)}
                defaultRoot="C:/Users/示例/Documents"
              />
            }
          >
            <LibraryView recents={workspaceState.recents} onOpen={handleOpen} onNewWorkspace={() => setCreatingWorkspace(true)} />
          </Show>
        </Match>

        <Match when={true}>
          <Toolbar
            bookTitle={bookTitle()}
            showTreeActions={true}
            saveState={saveState()}
            onNewVolume={handleNewVolume}
            onNewChapter={handleNewChapter}
            onSearch={() => setSearchOpen(true)}
            onSettings={() => setSettingsOpen(true)}
            onLibrary={handleLibrary}
          />

          <div
            class="shell"
            classList={{
              "shell--left-collapsed": layout.leftCollapsed,
              "shell--right-collapsed": layout.rightCollapsed,
            }}
            style={{
              "--left-w": `${layout.leftWidth}px`,
              "--right-w": `${layout.rightWidth}px`,
            }}
          >
            <div class="shell__left" aria-label={t("a11y.leftPanel")} aria-hidden={layout.leftCollapsed}>
              <ChapterTree />
            </div>

            <Show when={!layout.leftCollapsed}>
              <Resizer side="left" getWidth={() => layout.leftWidth} setWidth={setLeftWidth} min={LEFT_MIN} max={LEFT_MAX} />
            </Show>

            <EditorPane />

            <Show when={!layout.rightCollapsed}>
              <Resizer side="right" getWidth={() => layout.rightWidth} setWidth={setRightWidth} min={RIGHT_MIN} max={RIGHT_MAX} />
            </Show>

            <div class="shell__right" aria-label={t("a11y.rightPanel")} aria-hidden={layout.rightCollapsed}>
              <MetaPanel />
            </div>
          </div>
        </Match>
      </Switch>

      {/* 搜索与设置：本阶段是占位面板，但入口与键盘可达性已经就位 */}
      <Show when={searchOpen()}>
        <Overlay title={t("search.title")} hint={SEARCH_HINT} onClose={() => setSearchOpen(false)}>
          <p class="overlay__placeholder">{t("search.empty")}</p>
        </Overlay>
      </Show>

      <Show when={settingsOpen()}>
        <Overlay title={t("settings.title")} hint={SETTINGS_HINT} onClose={() => setSettingsOpen(false)}>
          <p class="overlay__placeholder">{t("settings.placeholder")}</p>
        </Overlay>
      </Show>
    </div>
  );
}

/** 错误提示条。 */
function ErrorBanner(props: { onDismiss: () => void }): JSX.Element {
  const message = (): string => {
    const err = workspaceState.error;
    if (err === null) return "";
    // 按错误码分支，绝不解析 message 文本 —— 那是给用户看的，随时会改
    switch (err.code) {
      case "NO_WORKSPACE":
        return t("error.noWorkspace");
      case "NOT_FOUND":
        return t("error.notFound");
      case "WORKSPACE_INVALID":
        return t("error.workspaceInvalid");
      case "IO_ERROR":
        return t("error.io");
      case "PARSE_ERROR":
        return t("error.parse");
      case "DATABASE_ERROR":
        return t("error.database");
      case "UNIMPLEMENTED":
        return t("error.unimplemented");
      default:
        return err.message || t("error.generic");
    }
  };

  return (
    <div class="banner banner--error" role="alert">
      <IconWarning size={16} />
      <span class="banner__text">{message()}</span>
      <IconButton size="sm" label={t("action.close")} onClick={props.onDismiss}>
        <IconClose size={14} />
      </IconButton>
    </div>
  );
}

/** 一个简单的模态浮层。 */
function Overlay(props: { title: string; hint: string; onClose: () => void; children: JSX.Element }): JSX.Element {
  return (
    <div
      class="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      onClick={(event) => {
        // 只有点在遮罩本身（不是内容）上才关闭
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div class="overlay__panel">
        <header class="overlay__head">
          <h2 class="overlay__title">{props.title}</h2>
          <IconButton label={t("action.close")} onClick={props.onClose}>
            <IconClose size={15} />
          </IconButton>
        </header>
        <div class="overlay__body">{props.children}</div>
        <p class="overlay__hint">{props.hint}</p>
      </div>
    </div>
  );
}
