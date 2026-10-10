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

import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import { t } from "@/strings";
import { isTauri, notifyFlushDone, onFlushAndClose } from "@/lib/ipc";
import { ChapterTree } from "@/features/chapters/ChapterTree";
import { LibraryView } from "@/features/library/LibraryView";
import { NewWorkspace } from "@/features/library/NewWorkspace";
import { EditorPane, type EditorSaveState } from "./app/EditorPane";
import { MetaPanel } from "./app/MetaPanel";
import { Resizer } from "./app/Resizer";
import { LibraryToolbar, Toolbar, type SaveState } from "./app/Toolbar";
import { IconClose, IconWarning } from "./app/ui/icons";
import { IconButton } from "./app/ui/IconButton";
import { SearchPanel } from "@/features/search/SearchPanel";
import { clearJump } from "@/features/search/search-store";
import {
  CommandPalette,
  type CommandItem,
} from "@/features/command/CommandPalette";
import { StatsView } from "@/features/stats/StatsView";
import { ExportDialog } from "@/features/export";
import { ShortcutPanel } from "@/features/editor/ShortcutPanel";
import { useShortcuts } from "@/features/editor/shortcut-bindings";
import { toggleFocusMode } from "@/features/editor/focus";
import {
  LEFT_MAX,
  LEFT_MIN,
  RIGHT_MAX,
  RIGHT_MIN,
  layout,
  setLeftWidth,
  setRightWidth,
  setView,
  toggleLeft,
  toggleRight,
} from "./app/layout-store";
import {
  addVolume as addVolumeRemote,
  clearError,
  closeWorkspace,
  createWorkspace,
  hasOpenWorkspace,
  openWorkspace,
  refreshRecents,
  selectedChapterId,
  selectChapter,
  workspaceState,
  createFirstChapter,
  volumes,
} from "./app/workspace-store";
import {
  allChaptersInOrder,
  defaultVolumeTitle,
} from "@/features/chapters/tree-ops";
import {
  FirstRunWizard,
  SettingsPanel,
  hasCompletedOnboarding,
  useAppearance,
} from "@/features/settings";

/**
 * 关闭屏障里「先刷盘、再放行」的那段编排。
 *
 * ## 为什么单独导出
 *
 * jsdom 里 `isTauri()` 恒为假，那条事件永远收不到，接线只能在真机验证；
 * 而这里的**次序与兜底**是可以钉住的：
 *
 * - ack 必须排在 flush 之后 —— 抢先 ack 等于让屏障形同不存在，
 *   作者按 Alt+F4 时丢的还是最新那一段；
 * - flush 失败也要 ack —— 落盘失败时继续拦着关闭，只会把作者困在
 *   一个关不掉的窗口里（要等 3 秒超时），而那 3 秒里他以为程序卡死了。
 *   失败本身已经由错误提示报出去了。
 */
export async function flushThenAck(
  flush: () => Promise<void>,
  ack: () => Promise<void>,
): Promise<void> {
  try {
    await flush();
  } finally {
    await ack();
  }
}

/** 应用外壳。 */
export function App(): JSX.Element {
  // 检索面板（M6）与命令面板（T5.7）是两个独立的东西：
  // 前者找"内容在哪"，后者找"功能在哪"。合用一个开关会让
  // Ctrl+F 与 Ctrl+K 变成同一个入口，用户就失去了对"我要做什么"的表达能力
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [commandOpen, setCommandOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  /**
   * 设置面板的深链目标分区。
   *
   * 只服务于「从命令面板直接跳到回收站」这类入口；关闭面板时清掉，
   * 否则下一次点普通「设置」会被上一次的深链劫持。
   */
  const [settingsTab, setSettingsTab] = createSignal<string | undefined>();
  function openSettings(): void {
    setSettingsTab(undefined);
    setSettingsOpen(true);
  }
  function openSettingsAt(tab: string): void {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }
  function closeSettings(): void {
    setSettingsOpen(false);
    setSettingsTab(undefined);
  }
  const [creatingWorkspace, setCreatingWorkspace] = createSignal(false);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  const [exportOpen, setExportOpen] = createSignal(false);
  // 首次启动向导（T9.7）：只在「从未引导过」时展示，走完或跳过都会写标记
  const [wizardOpen, setWizardOpen] = createSignal(!hasCompletedOnboarding());
  const [editorSaveState, setEditorSaveState] =
    createSignal<EditorSaveState>("idle");
  let saveEditor: (() => Promise<boolean>) | undefined;

  /**
   * 把编辑器里的改动落到磁盘；**没落成就抛**。
   *
   * 两个调用方都需要「磁盘上到底是不是这一版」：导出（后端现在按章读磁盘，
   * 没落盘的那一段不在导出里）与关窗（刷完才放行关闭）。
   * `saveEditor` 现在是报告布尔而不是抛异常 —— 自动保存那条路要靠返回值
   * 决定要不要重试，而这里需要的是「没落成就别往下走」。
   */
  async function flushPendingEdits(): Promise<void> {
    const landed = await saveEditor?.();
    if (landed === false) throw new Error(t("export.needsSaved"));
  }

  // 把生效的外观设置写进 CSS 变量与 html[data-theme]。
  // 必须在应用根部调用且只调用一次：多个 effect 争相写同一批变量时行为不确定。
  useAppearance();

  onMount(() => {
    void refreshRecents();
    // 关闭屏障的前端半边（Rust 侧见 `src-tauri/src/closing.rs`）：
    // 那边拦下 CloseRequested 后发一个事件过来，我们把防抖里的稿子刷完再放行。
    // 浏览器降级下 `onFlushAndClose` 返回空操作，调用方不必分支。
    let unsubscribe: (() => void) | null = null;
    let unmounted = false;
    void onFlushAndClose(() =>
      flushThenAck(flushPendingEdits, async () => {
        await notifyFlushDone();
      }).catch(() => undefined),
    ).then((fn) => {
      // 订阅是异步建立的，而测试里应用可能在这之前就卸载了
      if (unmounted) fn();
      else unsubscribe = fn;
    });
    onCleanup(() => {
      unmounted = true;
      unsubscribe?.();
    });
  });

  /**
   * 应用级快捷键（T4.9）。
   *
   * 这里只注册**真正是全局**的那些：命令面板、搜索、快捷键面板、
   * 保存、专注模式、折叠面板、新建章。
   * 与编辑器强相关的（查找替换、撤销重做）由 CodeMirror 自己的
   * keymap 处理 —— 它们依赖编辑器的选区状态，在这里处理会拿不到。
   */
  useShortcuts(() => [
    { id: "commandPalette", run: () => setCommandOpen(true) },
    { id: "search", run: () => setSearchOpen(true) },
    { id: "shortcutPanel", run: () => setShortcutsOpen(true) },
    {
      id: "save",
      run: () => void saveEditor?.(),
      enabled: () => hasOpenWorkspace() && editorSaveState() !== "saving",
    },
    {
      id: "focusMode",
      run: toggleFocusMode,
      enabled: () => layout.view === "workspace",
    },
    {
      id: "toggleLeft",
      run: toggleLeft,
      enabled: () => layout.view === "workspace",
    },
    {
      id: "toggleRight",
      run: toggleRight,
      enabled: () => layout.view === "workspace",
    },
    {
      id: "newChapter",
      run: () => void createFirstChapter(),
      enabled: () => hasOpenWorkspace(),
    },
    // 「下一章 / 上一章」按顺序在卷章树里走
    {
      id: "nextChapter",
      run: () => stepChapter(1),
      enabled: () => hasOpenWorkspace(),
    },
    {
      id: "prevChapter",
      run: () => stepChapter(-1),
      enabled: () => hasOpenWorkspace(),
    },
  ]);

  // 有打开的章节就切到写作台，否则停在书架。
  // 用 createEffect 而不是 onMount：工作区可能在会话中途被打开
  createEffect(() => {
    if (hasOpenWorkspace()) setView("workspace");
  });

  const bookTitle = createMemo(() => workspaceState.document?.book.title ?? "");
  const saveState = createMemo<SaveState>(() => {
    if (workspaceState.status === "loading") return "saving";
    return editorSaveState();
  });

  /** 新建卷：工具栏入口。 */
  const handleNewVolume = (): void => {
    void addVolumeRemote(defaultVolumeTitle(volumes().length));
  };

  /** 新建章。 */
  const handleNewChapter = (): void => void createFirstChapter();

  const handleOpen = (root: string): void => {
    void openWorkspace(root);
  };

  const handleCreateWorkspace = async (
    root: string,
    title: string,
  ): Promise<boolean> => {
    const ok = await createWorkspace(root, title);
    if (ok) setCreatingWorkspace(false);
    return ok;
  };

  /** 在卷章树里按扁平顺序前后移动一章。 */
  const stepChapter = (delta: number): void => {
    const list = allChaptersInOrder(workspaceState.document);
    if (list.length === 0) return;
    const currentId = selectedChapterId();
    const at =
      currentId === null ? -1 : list.findIndex((c) => c.id === currentId);
    // 没选中时：往后走取第一章，往前走取最后一章。
    // 这样两个方向都不会"按了没反应"
    const nextIndex = at < 0 ? (delta > 0 ? 0 : list.length - 1) : at + delta;
    const clamped = Math.max(0, Math.min(list.length - 1, nextIndex));
    const target = list[clamped];
    if (target) selectChapter(target.id);
  };

  /**
   * 回书架。
   *
   * 顺序是**先保存、再关工作区**，反过来会丢字：`closeWorkspace()` 一跑完，
   * 后端的根句柄与前端 store 都清空了，而 EditorPane 要到 `setView` 之后
   * 才卸载 —— 它 `onCleanup` 里那次保存于是必然失败（没有工作区）。
   * 自动保存有 1500 ms 防抖，作者最后打的那一段正好落在这个窗口里。
   *
   * 保存状态也要在离开时归位：`editorSaveState` 由 EditorPane 的 effect 同步，
   * 组件一卸载就没人再更新它。若此刻正卡在 `saving`，保存入口会被
   * `enabled` 判据一直锁到下次挂载。
   */
  const handleLibrary = async (): Promise<void> => {
    // 存不下也要让人走得掉：`saveNow` 是报告布尔而不是抛异常，
    // 失败已经由 store 的错误横幅报出，把作者锁在写作台里
    // 只会让他多打一段同样存不下的字。
    await saveEditor?.();
    await closeWorkspace();
    saveEditor = undefined;
    setEditorSaveState("idle");
    // 检索跳转也是一次意图：没消费掉就留着，下次重开同一本书、点到那一章
    // 会被那条旧意图牵着跑（`search-store` 的注释早就写了「关闭工作区时清」，
    // 但生产代码里从来没人清它）。
    clearJump();
    setView("library");
  };

  /**
   * 命令面板的命令表（T5.7）。
   *
   * 放在组件里而不是模块顶层：`enabled` 要读 store 的实时状态，
   * 而 store 是模块级单例 —— 写成模块常量的话，判断会在导入那一刻
   * 就被求值一次并永远固定下来。
   */
  const commands = (): CommandItem[] => [
    {
      id: "search",
      label: t("command.openSearch"),
      group: t("command.groupNavigate"),
      run: () => setSearchOpen(true),
    },
    {
      id: "stats",
      label: t("command.openStats"),
      group: t("command.groupNavigate"),
      run: () => setView("stats"),
      enabled: () => hasOpenWorkspace(),
    },
    {
      id: "library",
      label: t("command.openLibrary"),
      group: t("command.groupNavigate"),
      run: handleLibrary,
    },
    {
      id: "newChapter",
      label: t("command.newChapter"),
      group: t("command.groupWrite"),
      run: () => void createFirstChapter(),
      enabled: () => hasOpenWorkspace(),
    },
    {
      id: "save",
      label: t("action.save"),
      group: t("command.groupWrite"),
      run: () => void saveEditor?.(),
      enabled: () => hasOpenWorkspace() && editorSaveState() !== "saving",
    },
    {
      id: "newVolume",
      label: t("command.newVolume"),
      group: t("command.groupWrite"),
      run: handleNewVolume,
      enabled: () => hasOpenWorkspace(),
    },
    {
      // 导出属于「写作」组而不是「视图」组：它是交稿动作，
      // 与保存、新建章同级，而不是切换界面布局。
      id: "export",
      label: t("command.openExport"),
      group: t("command.groupWrite"),
      run: () => setExportOpen(true),
      enabled: () => hasOpenWorkspace(),
    },
    {
      id: "toggleLeft",
      label: t("command.toggleLeft"),
      group: t("command.groupView"),
      run: toggleLeft,
      enabled: () => layout.view === "workspace",
    },
    {
      id: "toggleRight",
      label: t("command.toggleRight"),
      group: t("command.groupView"),
      run: toggleRight,
      enabled: () => layout.view === "workspace",
    },
    {
      id: "shortcuts",
      label: t("shortcuts.title"),
      group: t("command.groupView"),
      run: () => setShortcutsOpen(true),
    },
    {
      id: "settings",
      label: t("settings.title"),
      group: t("command.groupView"),
      run: openSettings,
    },
    {
      // 回收站不是一个「视图」而是一次事故处理，所以不进左栏，
      // 但必须能从命令面板一步到达 —— 刚误删章节的人不知道去哪找。
      id: "trash",
      label: t("command.openTrash"),
      group: t("command.groupView"),
      run: () => openSettingsAt("data"),
      enabled: () => hasOpenWorkspace(),
    },
  ];

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
        {/* 写作统计（M8）：独立的一屏，因为它有六个分区与两张整幅的图，
            塞进三栏布局里的任何一栏都放不下 */}
        <Match when={layout.view === "stats" && !creatingWorkspace()}>
          <StatsView
            onBack={() => setView(hasOpenWorkspace() ? "workspace" : "library")}
          />
        </Match>

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
              />
            }
          >
            <LibraryView
              recents={workspaceState.recents}
              onOpen={handleOpen}
              onNewWorkspace={() => setCreatingWorkspace(true)}
            />
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
            onStats={() => setView("stats")}
            onCommands={() => setCommandOpen(true)}
            onSave={() => void saveEditor?.()}
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
            <div
              class="shell__left"
              aria-label={t("a11y.leftPanel")}
              aria-hidden={layout.leftCollapsed}
            >
              <ChapterTree />
            </div>

            <Show when={!layout.leftCollapsed}>
              <Resizer
                side="left"
                getWidth={() => layout.leftWidth}
                setWidth={setLeftWidth}
                min={LEFT_MIN}
                max={LEFT_MAX}
              />
            </Show>

            <EditorPane
              onSaveStateChange={setEditorSaveState}
              onSaveReady={(save) => {
                saveEditor = save;
              }}
            />

            <Show when={!layout.rightCollapsed}>
              <Resizer
                side="right"
                getWidth={() => layout.rightWidth}
                setWidth={setRightWidth}
                min={RIGHT_MIN}
                max={RIGHT_MAX}
              />
            </Show>

            <div
              class="shell__right"
              aria-label={t("a11y.rightPanel")}
              aria-hidden={layout.rightCollapsed}
            >
              <MetaPanel />
            </div>
          </div>
        </Match>
      </Switch>

      {/* 检索与大纲面板（M6）：关键词高亮、点击跳转并闪烁 */}
      <SearchPanel open={searchOpen()} onClose={() => setSearchOpen(false)} />

      {/* 命令面板（T5.7）：Ctrl/Cmd + K */}
      <CommandPalette
        open={commandOpen()}
        onClose={() => setCommandOpen(false)}
        commands={commands()}
      />

      {/* 设置面板（M9）：外观 / 字体 / 排版 / 数据安全 / 关于五个分区，全部即时生效 */}
      <SettingsPanel
        open={settingsOpen()}
        onClose={closeSettings}
        initialTab={settingsTab()}
      />

      {/* 导出对话框（M7）：格式 / 范围 / 保存位置，并展示降级记录 */}
      <ExportDialog
        open={exportOpen()}
        onClose={() => setExportOpen(false)}
        flushEditor={flushPendingEdits}
      />

      {/* 首次启动向导：可跳过，跳过与走完的效果完全相同 */}
      <FirstRunWizard
        open={wizardOpen()}
        onFinish={() => setWizardOpen(false)}
      />

      <Show when={shortcutsOpen()}>
        <ShortcutPanel onClose={() => setShortcutsOpen(false)} />
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
      case "CONFLICT":
        // 出路在编辑区里（那两个按钮），横幅只负责说清发生了什么
        return t("error.externalConflict");
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
