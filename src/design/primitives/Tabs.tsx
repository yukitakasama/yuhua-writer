/**
 * 标签页。
 *
 * 无障碍要点（T1.8）：
 * - 用 role="tablist" / "tab" / "tabpanel" 三段式，并通过 aria-controls +
 *   aria-labelledby 双向关联。只给 role 不建立关联，读屏无法把面板和标签对上。
 * - roving tabindex：Tab 键在「标签栏」与「面板」之间移动，方向键才在标签之间移动。
 *   这是 WAI-ARIA 对 tablist 的通行约定，照搬浏览器原生习惯。
 * - 激活方式改成「选中即激活」（selection follows focus），因为写作软件里
 *   切标签的成本只是换一个视图，没有加载代价，无需两段式操作。
 */

import {
  createEffect,
  createSignal,
  For,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js";
import { axisDelta } from "./keyboardNav";
import { cx, usePrimitivesStyle } from "./styles";

/** 单个标签定义。 */
export interface TabItem {
  /** 唯一值。 */
  value: string;
  /** 展示文案。 */
  label: JSX.Element;
  /** 是否禁用。 */
  disabled?: boolean;
}

/** {@link Tabs} 的 props。 */
export interface TabsProps {
  /** 标签定义列表。 */
  items: readonly TabItem[];
  /** 当前选中的值。 */
  value?: string;
  /** 选中变化回调。 */
  onChange?: (value: string) => void;
  /** 面板内容渲染函数。不传则不渲染面板，仅作为纯标签栏使用。 */
  children?: (value: string) => JSX.Element;
  /** 调用方自定义类名，透传到根元素。 */
  class?: string;
  /** 标签栏的无障碍名称，用于说明这组标签控制的是什么。 */
  label?: string;
}

/**
 * 标签页。
 *
 * @example
 * <Tabs items={tabs} value={tab()} onChange={setTab}>{(v) => <p>{v}</p>}</Tabs>
 */
export const Tabs: Component<TabsProps> = (props) => {
  usePrimitivesStyle();

  const [local] = splitProps(props, [
    "items",
    "value",
    "onChange",
    "children",
    "class",
    "label",
  ]);

  const selected = (): string | undefined => local.value;
  // 记录键盘意图上的「当前标签」。它是 selection follows focus 的基础：
  // 焦点在哪，哪一项就应是 tabindex=0 的那一项。
  const [focused, setFocused] = createSignal<string | undefined>(local.value);

  createEffect(() => {
    if (local.value !== undefined) setFocused(local.value);
  });

  /** 可导航的标签（跳过禁用项）。 */
  const navigable = (): TabItem[] =>
    local.items.filter((item) => item.disabled !== true);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Home") {
      event.preventDefault();
      const first = navigable()[0];
      if (first) select(first.value);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const list = navigable();
      const last = list[list.length - 1];
      if (last) select(last.value);
      return;
    }

    // 标签栏横向排列，所以用左右键；上下键在部分设计里也用，这里一并接受，
    // 因为用户对「标签栏方向」的心理模型并不统一。
    const delta = axisDelta(event.key, "both");
    if (delta === 0) return;
    event.preventDefault();

    const list = navigable();
    if (list.length === 0) return;
    const currentIndex = list.findIndex(
      (item) => item.value === (focused() ?? selected()),
    );
    const nextIndex =
      ((currentIndex < 0 ? 0 : currentIndex + delta) + list.length) %
      list.length;
    const next = list[nextIndex];
    if (next) select(next.value);
  };

  /** 选中并把焦点移过去（selection follows focus）。 */
  const select = (value: string): void => {
    setFocused(value);
    local.onChange?.(value);
    // 焦点移动放在下一帧：onChange 可能触发重渲染，提前 focus 会落到旧节点上。
    queueMicrotask(() => {
      document
        .querySelector<HTMLElement>('[data-tab-value="' + value + '"]')
        ?.focus();
    });
  };

  /** 每个标签对应的面板 id，用于 aria-controls。 */
  const panelId = (value: string): string => "yh-tabpanel-" + value;
  const tabId = (value: string): string => "yh-tab-" + value;

  return (
    <div class={cx("yh-tabs", local.class)}>
      <div
        class="yh-tabs__list"
        role="tablist"
        aria-label={local.label}
        onKeyDown={onKeyDown}
      >
        <For each={local.items}>
          {(item) => {
            const isSelected = (): boolean => selected() === item.value;
            return (
              <button
                type="button"
                role="tab"
                id={tabId(item.value)}
                data-tab-value={item.value}
                class="yh-tab"
                aria-selected={isSelected() ? "true" : "false"}
                aria-controls={local.children ? panelId(item.value) : undefined}
                // roving tabindex：只有当前项进入 Tab 序。
                tabindex={item.value === (focused() ?? selected()) ? 0 : -1}
                disabled={item.disabled === true}
                onClick={() => {
                  if (item.disabled) return;
                  setFocused(item.value);
                  local.onChange?.(item.value);
                }}
              >
                {item.label}
              </button>
            );
          }}
        </For>
      </div>
      <Show when={local.children && selected()}>
        <div
          role="tabpanel"
          id={panelId(selected() as string)}
          aria-labelledby={tabId(selected() as string)}
          tabindex={0}
          class="yh-tabs__panel"
        >
          {local.children?.(selected() as string)}
        </div>
      </Show>
    </div>
  );
};
