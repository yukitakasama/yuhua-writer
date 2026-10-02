/**
 * 应用级快捷键绑定（T4.9 的运行时部分）。
 *
 * ## 为什么挂在 window 上而不是编辑器上
 *
 * 因为一半的快捷键要在**编辑器没有焦点**时也生效：
 * 作者刚点完左侧的章节、或者鼠标停在元数据面板上，
 * 此时按 Ctrl+K 仍然应该打开命令面板。
 *
 * ## 为什么"在输入框里打字"要特别放行
 *
 * 作者在重命名章节、在搜索框里输入时，`Ctrl+B` 这类键
 * 不应该被应用抢走。但反过来，`Ctrl+S`、`Ctrl+K`、`Esc`
 * 这类"全局且无歧义"的键必须穿透 —— 否则作者在搜索框里
 * 按 Ctrl+S 会什么都不发生，而他会以为已经保存了。
 *
 * 因此把快捷键分两类：`throughInput` 为真的键在输入框里也生效。
 */

import { onCleanup, onMount } from "solid-js";

import {
  detectMac,
  eventToChord,
  DEFAULT_BINDINGS,
  type KeyBinding,
} from "@/features/editor/shortcuts";

/** 一个快捷键处理器的注册项。 */
export interface ShortcutRegistration {
  /** 对应 {@link KeyBinding.id}。 */
  id: string;
  /** 触发时的动作。 */
  run: () => void;
  /**
   * 是否在输入框（input / textarea / contenteditable）里也生效。
   *
   * 默认 false。只有"全局且无歧义"的键才设为 true。
   */
  throughInput?: boolean;
  /** 返回 false 表示当前不可用（比如没有打开的章节）。 */
  enabled?: () => boolean;
}

/**
 * 在输入框里也要放行的键。
 *
 * 判据是「这个键在任何上下文下语义都唯一」：
 * 保存、打开命令面板、退出专注模式。而 Ctrl+B（折叠左栏）
 * 在写一段加粗文字时可能是有歧义的，因此不放行。
 */
const THROUGH_INPUT_IDS = new Set([
  "save",
  "commandPalette",
  "shortcutPanel",
  "focusMode",
]);

/** 判断事件目标是不是一个文本输入上下文。 */
export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/**
 * 注册一组应用级快捷键。
 *
 * 返回一个解绑函数（`onCleanup` 里调，或者由组件自己管理）。
 */
export function registerShortcuts(
  registrations: ShortcutRegistration[],
): () => void {
  const isMac = detectMac();
  const byChord = new Map<string, ShortcutRegistration>();
  for (const reg of registrations) {
    const binding = DEFAULT_BINDINGS.find((b) => b.id === reg.id);
    if (binding) byChord.set(binding.keys, reg);
  }

  const handler = (event: KeyboardEvent): void => {
    // 组合键不抢输入法的键（Esc 要留着取消候选框）
    if (event.isComposing) return;
    const chord = eventToChord(event, isMac);
    if (chord === "") return;
    const reg = byChord.get(chord);
    if (!reg) return;
    if (
      isTextInput(event.target) &&
      !(reg.throughInput ?? THROUGH_INPUT_IDS.has(reg.id))
    ) {
      // 还要放行一种情况：焦点就在编辑器里。编辑器的 DOM 是 contenteditable，
      // 上面那个判断会把它当成"输入上下文"，于是 Ctrl+S 就失效了。
      // 编辑器内的键由 CodeMirror 的 keymap 处理，应用级只处理
      // 明确放行的那些
      if (!(reg.throughInput ?? THROUGH_INPUT_IDS.has(reg.id))) return;
    }
    if (reg.enabled && !reg.enabled()) return;
    event.preventDefault();
    reg.run();
  };

  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}

/**
 * 在组件里注册快捷键的便捷封装。
 *
 * 注册表可能在运行时变化（比如"下一章"的可用性取决于有没有下一章），
 * 因此每次渲染都重建 —— 键的查找是 O(1) 的 Map，重建成本可以忽略。
 */
export function useShortcuts(
  registrations: () => ShortcutRegistration[],
): void {
  onMount(() => {
    const unbind = registerShortcuts(registrations());
    onCleanup(unbind);
  });
}

/** 供快捷键面板展示的默认绑定表。 */
export function shortcutList(): readonly KeyBinding[] {
  return DEFAULT_BINDINGS;
}
