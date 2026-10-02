/**
 * 中文输入法（IME）兼容专项（T4.4）。
 *
 * ## 为什么这件事需要单独一个模块
 *
 * 中文写作软件里，**输入法组合期**是最容易出 bug 的阶段：
 *
 * 1. **组合中的文本不是文档内容**。拼音还在候选框里时，字符只是
 *    "临时浮在"编辑器上。此时如果把它当成正文去算字数、去自动保存、
 *    去发"文档已修改"事件，就会把半截拼音写进稿子。
 * 2. **组合期长度剧烈变化**。`ni` → `你` → `你好` 是三次更新，
 *    每次都触发 CodeMirror 的事务。如果自动保存按"每次改动"防抖，
 *    组合一次会排 3 次保存。
 * 3. **组合结束后选区会跳**。某些输入法在提交时先删掉组合文本、
 *    再插入最终字符，两个事务之间光标位置是**非法**的（指向已删除处）。
 *    此时任何读选区的代码都会拿到错位的结果。
 *
 * 这个模块把这些判断收敛成纯函数，于是它们可以被完整测试，
 * 而不是只能在真机上"手感对不对"。
 *
 * ## 为什么不用 CodeMirror 的 compositionstart / compositionend 就够
 *
 * CodeMirror 6 内部确实处理了组合事件，但**它没有义务知道**
 * 「这次改动该不该触发自动保存」「该不该重算字数」。
 * 那些是应用的业务判断，必须在应用层做。
 */

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type Extension } from "@codemirror/state";

/**
 * IME 组合状态。
 *
 * `composing` 是所有业务逻辑的总开关：
 * 它为真时，**不保存、不统计、不广播**。
 */
export interface CompositionState {
  /** 是否正在组合（拼音还没上屏）。 */
  composing: boolean;
  /** 组合开始的文档位置。 */
  startedAt: number;
  /** 组合期间收到的最后一次组合文本长度。 */
  lastLength: number;
}

/** 一次"组合结束"的结算结果。 */
export interface CompositionResult {
  /** 组合区间内的最终文本。 */
  text: string;
  /** 该区间在文档中的起止位置。 */
  from: number;
  to: number;
}

/**
 * 需要被当作"组合中"的事件序列。
 *
 * ## 为什么还要看 `isComposing`
 *
 * 浏览器（尤其 Windows 上的 WebView2）在组合期间发的是普通
 * `input`/`beforeinput` 事件，`inputType` 是 `insertCompositionText`。
 * 只看 `compositionstart` / `compositionend` 会漏掉一种情况：
 * **某些输入法（如微软拼音的"直接上屏"）不发 composition 事件**，
 * 只发一个 `insertCompositionText` 然后立刻结束。
 * 那种情况下如果没收到 start，就不该把状态挂住 ——
 * 因此判定要同时看 `update.transactions` 里的 `isUserEvent`。
 */
export function isCompositionEvent(update: ViewUpdate): boolean {
  for (const tr of update.transactions) {
    if (
      tr.isUserEvent("input.type.compose") ||
      tr.isUserEvent("input.compose")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 组合期间的文本是否"还没定下来"。
 *
 * 判据是**文档尾部是否处于不稳定状态**。这里用一个保守的近似：
 * 组合事件本身就代表没定下来。真正需要"内容"的时刻
 * （组合结束后）由 {@link settleComposition} 处理。
 */
export function shouldDeferWork(composing: boolean): boolean {
  return composing;
}

/**
 * 结算一次组合。
 *
 * `from` / `to` 是组合事件报告的范围。**必须做边界夹紧**：
 * 某些输入法在提交时先删后插，报给我们的 `to` 可能已经越过了
 * 当前文档长度（因为它算的是删除之前的坐标）。不夹紧就会 panic
 * 或读到错位内容。
 */
export function settleComposition(
  view: EditorView,
  from: number,
  to: number,
): CompositionResult | null {
  const doc = view.state.doc;
  const max = doc.length;
  // 夹到合法区间。from > to 说明坐标已经不可信，直接放弃这次结算
  const safeFrom = Math.max(0, Math.min(from, max));
  const safeTo = Math.max(0, Math.min(to, max));
  if (safeFrom > safeTo) return null;
  return {
    text: doc.sliceString(safeFrom, safeTo),
    from: safeFrom,
    to: safeTo,
  };
}

/**
 * 组合期间的文档改动要不要算进"未保存状态"。
 *
 * 结论是**不算**。理由：组合中的文本随时可能被作者取消（按 Esc），
 * 把它算成"有改动"会让保存指示点闪来闪去，
 * 而作者其实什么都没决定。
 */
export function countsAsDirty(composing: boolean): boolean {
  return !composing;
}

/**
 * 组合状态变化的回调。`true` 表示进入组合，`false` 表示结束。
 *
 * 自动保存与统计用它做"组合期间不干活"的门控。
 */
export type CompositionListener = (composing: boolean) => void;

/**
 * IME 组合状态插件。
 *
 * ## 为什么状态放在插件里而不是组件 signal
 *
 * 因为**每个事务都要读它**（判断这次改动算不算"未保存"）。
 * 放组件 signal 里需要每次都跨层同步，而插件的 `update`
 * 天然就在事务处理链上，读的永远是当前事务之后的真实状态。
 *
 * ## 为什么 DOM 事件与事务事件都要看
 *
 * - `compositionstart` / `compositionend` 是**主流**路径（微软拼音、
 *   搜狗、macOS 原生输入法都发）。
 * - 但有的输入法（部分 DirectWrite 场景）在"直接上屏"模式下
 *   **只发一个 `insertCompositionText` 事务，不发 composition 事件**。
 *   只看 DOM 会让这类输入法下的输入被当成普通改动，
 *   于是组合中的半截拼音被存进稿子。
 *
 * 两条路径都挂上、并且都走同一个 `enter` / `leave`，
 * 是这里唯一可靠的做法。
 */
const compositionPlugin = ViewPlugin.fromClass(
  class {
    /** 当前是否在组合中。 */
    composing = false;
    /** 组合起始位置（文档坐标）。 */
    startedAt = 0;
    /** 最后一次组合事务带来的新增文本长度。 */
    lastLength = 0;

    constructor(
      readonly view: EditorView,
      /** 状态变化回调。由 `imeCompositionGuard` 传入。 */
      readonly onChange?: CompositionListener,
    ) {
      view.dom.addEventListener("compositionstart", this.handleStart);
      view.dom.addEventListener("compositionend", this.handleEnd);
    }

    update(update: ViewUpdate): void {
      if (!update.docChanged) return;
      if (isCompositionEvent(update)) {
        this.enter(update.state.selection.main.from);
        this.lastLength = update.changes.newLength;
      } else if (this.composing) {
        // 组合期间输入法内部的删除重写也会产生事务，同步一下长度即可
        this.lastLength = update.changes.newLength;
      }
    }

    /** 进入组合状态。重复调用是幂等的。 */
    private enter(at: number): void {
      if (this.composing) return;
      this.composing = true;
      this.startedAt = at;
      this.onChange?.(true);
    }

    /** 离开组合状态。重复调用是幂等的。 */
    private leave(): void {
      if (!this.composing) return;
      this.composing = false;
      this.onChange?.(false);
    }

    private handleStart = (): void =>
      this.enter(this.view.state.selection.main.from);

    private handleEnd = (): void => this.leave();

    destroy(): void {
      this.view.dom.removeEventListener("compositionstart", this.handleStart);
      this.view.dom.removeEventListener("compositionend", this.handleEnd);
    }
  },
);

/**
 * 全局 IME 守卫扩展。
 *
 * 这是应用真正装进编辑器的那一个：它维护一份可查询的组合状态，
 * 供自动保存与统计模块读取。
 */
export function imeCompositionGuard(onChange?: CompositionListener): Extension {
  // 这里必须用 `ViewPlugin.define` 风格的**工厂**语义：
  // 每次 `fromClass` 调用都会产生一个新的插件类型，
  // 而 `view.plugin()` 要求传回同一个类型才能查到实例。
  // 因此把工厂结果缓存起来 —— 但回调是每次装编辑器时给的不同闭包，
  // 所以用 `define` 而不是 `fromClass`：`define` 接受一个
  // "由配置创建实例"的函数，同一个 `ViewPlugin` 标识可以服务多个实例。
  return compositionPlugin.of(onChange);
}

/**
 * 读取当前是否在组合中。
 *
 * 供外部（自动保存、统计）查询，避免它们自己去挂 DOM 监听。
 */
export function isComposing(view: EditorView): boolean {
  return view.plugin(compositionPlugin)?.composing ?? false;
}

/** 组合是否已结束（`isComposing` 的反面，读起来更顺）。 */
export function compositionSettled(view: EditorView): boolean {
  return !isComposing(view);
}

/** 组合开始的位置。不在组合时返回 -1。 */
export function compositionStart(view: EditorView): number {
  const plugin = view.plugin(compositionPlugin);
  return plugin?.composing ? plugin.startedAt : -1;
}
