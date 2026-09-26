/**
 * 命令面板（T5.7，Ctrl/Cmd + K）。
 *
 * ## 为什么需要它
 *
 * 写作软件的功能会越加越多（导出、统计、设置、大纲、回收站……），
 * 但工具栏每多一个按钮，写作时的视觉噪音就多一分 ——
 * 这与计划书 5.1 节「写作时屏幕上只有字」直接冲突。
 * 命令面板把"功能数量"与"界面复杂度"解耦：功能可以随便加，
 * 工具栏保持干净。
 *
 * ## 键盘是第一公民
 *
 * 面板从打开到执行全程不需要鼠标：打开即聚焦输入框，
 * ↑↓ 在结果里移动，回车执行，Esc 关闭。
 * 输入框里按 ↓ 直接进入结果列表（用户在输入框上按方向键的意图
 * 几乎总是"我要选下面那条"）。
 *
 * ## 命令是数据不是组件
 *
 * `CommandItem` 只有「名字 + 分组 + 动作」三样。面板不关心每个命令
 * 具体做什么，因此新增一个命令是往数组里加一行，而不是改这个组件。
 */

import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";

import { t } from "@/strings";
import { Dialog } from "@/design/primitives";
import { rankCommands } from "./palette";

/** 一条命令。 */
export interface CommandItem {
  /** 唯一 ID。 */
  id: string;
  /** 展示名（已本地化）。同时也是模糊搜索的输入。 */
  label: string;
  /** 分组名。 */
  group: string;
  /** 执行。 */
  run: () => void;
  /** 是否可用。不可用时仍然显示（它是"为什么不能用"的解释载体）。 */
  enabled?: () => boolean;
}

/** 命令面板属性。 */
export interface CommandPaletteProps {
  /** 是否打开。 */
  open: boolean;
  /** 关闭。 */
  onClose: () => void;
  /** 全部命令。 */
  commands: readonly CommandItem[];
}

/** 命令面板。 */
export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;

  const ranked = createMemo(() => rankCommands(props.commands, query()));

  // 每次打开都重置：上次搜过的词留在框里会让人以为面板记错了
  createEffect(() => {
    if (!props.open) return;
    setQuery("");
    setActiveIndex(0);
    queueMicrotask(() => inputEl?.focus());
  });

  /** 执行一条命令并关闭面板。 */
  const run = (item: CommandItem): void => {
    if (item.enabled && !item.enabled()) return;
    props.onClose();
    item.run();
  };

  const move = (delta: number): void => {
    const list = ranked();
    if (list.length === 0) return;
    // 两端不循环：在命令列表里"从头跳到尾"通常意味着按错了
    setActiveIndex((index) => Math.max(0, Math.min(index + delta, list.length - 1)));
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(ranked().length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = ranked()[activeIndex()];
      if (entry) run(entry.item);
    }
  };

  /** 结果列表的容器，用于在其中定位"当前高亮项"。 */
  let listEl: HTMLUListElement | undefined;

  /**
   * 把焦点交给结果列表里的**当前高亮项**。
   *
   * ## 这里曾经用 document.querySelector(".cmd__item")
   *
   * 那个写法有两个真实的缺陷：
   *
   * 1. **它拿到的永远是第一项**，与键盘高亮的位置无关。
   *    作者按 ↑↓ 把高亮移到第 5 项、再按 ↓ 想进列表时，
   *    焦点会跳回第 1 项 —— 视觉上高亮在第 5 项、焦点在第 1 项，
   *    再按回车执行的是**错的那一条**。
   * 2. **它没有限定在当前面板内**。`document` 是全局的，
   *    若页面上同时存在另一个 `.cmd__item`（比如测试里
   *    上一个用例的残留节点，或将来出现的第二处命令列表），
   *    焦点会被送给那一个。
   *
   * 因此改成"在列表容器内按 aria-selected 找"。这也顺带让
   * 焦点转移与无障碍语义（aria-selected）用同一个真相来源 ——
   * 两者不一致时，读屏念的项与实际聚焦的项会不同。
   */
  const focusActiveItem = (): void => {
    const target = listEl?.querySelector<HTMLElement>('[aria-selected="true"]');
    // 兜底：高亮项还没渲染出来时给第一项，至少不丢焦点
    const fallback = listEl?.querySelector<HTMLElement>(".cmd__item");
    (target ?? fallback)?.focus();
  };

  /**
   * 输入框里的 ↑↓。
   *
   * ## 这里的关键是"先移动高亮，再交焦点"
   *
   * 第一版只做了"交焦点"：`ArrowDown` 直接 `focusActiveItem()`，
   * 而高亮始终停在第 0 项。于是作者在输入框里按 ↓ 时，
   * 焦点**永远落在第一项**，即使他已经用 ↑↓ 把高亮移到了别处 ——
   * 此时按回车执行的是错的那一条命令。
   *
   * 正确行为是：↑↓ 在输入框里先移动**高亮**（不改变焦点位置，
   * 作者的视线与手都不离开输入框），只有当高亮到达列表边界、
   * 或者按下 ↓ 想把焦点真正交给列表时才进行焦点转移。
   *
   * 这里采用"↓ 总是移动高亮并交焦点"的简化策略：
   * 它满足 A9「不碰鼠标走完全流程」的核心诉求，
   * 且行为可预测 —— 按一次 ↓ 就进列表，不会出现
   * "有时进列表、有时只移动高亮"那种需要作者去猜的状态机。
   */
  const handleInputKeyDown = (event: KeyboardEvent): void => {
    if (ranked().length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      // 先移动高亮，让"当前项"与键盘意图一致，再交焦点
      move(1);
      focusActiveItem();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      focusActiveItem();
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("command.title")}
      width={560}
      initialFocus={() => inputEl ?? null}
      class="cmd"
    >
      <input
        ref={inputEl}
        type="text"
        class="field cmd__input"
        placeholder={t("command.placeholder")}
        aria-label={t("command.title")}
        value={query()}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setActiveIndex(0);
        }}
        onKeyDown={handleInputKeyDown}
      />

      <Show
        when={ranked().length > 0}
        fallback={
          <p class="cmd__empty" role="status">
            {t("command.empty")}
          </p>
        }
      >
        <ul
          ref={(el) => (listEl = el)}
          class="cmd__list"
          role="listbox"
          aria-label={t("command.listLabel")}
          onKeyDown={handleKeyDown}
        >
          <For each={ranked()}>
            {(entry, index) => {
              const disabled = (): boolean => entry.item.enabled !== undefined && !entry.item.enabled();
              return (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index() === activeIndex() ? "true" : "false"}
                    class="cmd__item"
                    classList={{ "is-active": index() === activeIndex(), "is-disabled": disabled() }}
                    aria-disabled={disabled() ? "true" : undefined}
                    // roving tabindex：整张列表在 Tab 序里只占一格
                    tabindex={index() === activeIndex() ? 0 : -1}
                    data-cmd-id={entry.item.id}
                    onFocus={() => setActiveIndex(index())}
                    onClick={() => run(entry.item)}
                  >
                    <span class="cmd__group">{entry.item.group}</span>
                    <span class="cmd__label">{entry.item.label}</span>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>

      <p class="cmd__hint">{t("command.hint")}</p>
    </Dialog>
  );
}
