/**
 * 快捷键面板（T4.9）。
 *
 * 面向作者，不是给开发者看的快捷键表 —— 因此：
 *
 * - 按「写作 / 导航 / 视图 / 编辑器」分组，而不是按字母序
 * - 显示**当前平台**的按键名（macOS 上是 ⌘ 而不是 Ctrl）
 * - 冲突的键位标红（作者改键之后必须立刻看到撞了）
 */

import { For, Show, createMemo, type JSX } from "solid-js";

import { t } from "@/strings";
import { IconClose } from "@/app/ui/icons";
import { IconButton } from "@/app/ui/IconButton";
import {
  DEFAULT_BINDINGS,
  detectMac,
  displayChord,
  findConflicts,
  type KeyBinding,
} from "./shortcuts";

/** 分组顺序。写作排第一：那是这个软件的全部意义。 */
const GROUP_ORDER: Array<KeyBinding["group"]> = [
  "写作",
  "导航",
  "编辑器",
  "视图",
];

/** 快捷键面板。 */
export function ShortcutPanel(props: { onClose: () => void }): JSX.Element {
  const isMac = detectMac();

  /** 按分组整理过的绑定。 */
  const groups = createMemo(() =>
    GROUP_ORDER.map((group) => ({
      group,
      items: DEFAULT_BINDINGS.filter((b) => b.group === group),
    })).filter((entry) => entry.items.length > 0),
  );

  /** 冲突的键位集合。 */
  const conflicts = createMemo(
    () => new Set(findConflicts(DEFAULT_BINDINGS).keys()),
  );

  return (
    <div
      class="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("shortcuts.title")}
      onClick={(event) => {
        // 只有点在遮罩本身才关闭，点内容不关
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div class="overlay__panel overlay__panel--wide">
        <header class="overlay__head">
          <h2 class="overlay__title">{t("shortcuts.title")}</h2>
          <IconButton label={t("action.close")} onClick={props.onClose}>
            <IconClose size={15} />
          </IconButton>
        </header>
        <div class="overlay__body">
          <For each={groups()}>
            {(entry) => (
              <section class="shortcut-group">
                <h3 class="shortcut-group__title">{entry.group}</h3>
                <dl class="shortcut-list">
                  <For each={entry.items}>
                    {(binding) => (
                      <div
                        class="shortcut-row"
                        classList={{
                          "shortcut-row--conflict": conflicts().has(
                            binding.keys,
                          ),
                        }}
                      >
                        <dt class="shortcut-row__label">{binding.label}</dt>
                        <dd class="shortcut-row__keys">
                          <Show
                            when={conflicts().has(binding.keys)}
                            fallback={
                              <kbd class="kbd">
                                {displayChord(binding.keys, isMac)}
                              </kbd>
                            }
                          >
                            <kbd
                              class="kbd kbd--conflict"
                              title={t("shortcuts.conflict")}
                            >
                              {displayChord(binding.keys, isMac)}
                            </kbd>
                          </Show>
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>
              </section>
            )}
          </For>
        </div>
        <p class="overlay__hint">{t("shortcuts.hint")}</p>
      </div>
    </div>
  );
}
