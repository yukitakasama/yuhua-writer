/**
 * 检索面板的状态（T6.1 / T6.2 / T6.3）。
 *
 * ## 为什么把跳转也放进 store
 *
 * 「点结果 → 选中章节 → 关闭面板 → 编辑器滚到并闪烁高亮」是一个
 * **跨三个组件**的动作：面板、workspace-store、编辑器。若把这些步骤
 * 写在面板的点击回调里，编辑器就不得不暴露一个全局可变句柄给面板 ——
 * 那是比 store 更难测试也更难追踪的耦合。
 *
 * 因此这里只发布一个「待跳转目标」，编辑器在自己认为合适的时机
 * （章节正文已载入、视图已就绪）消费并清除它。
 *
 * ## 为什么要去重
 *
 * 编辑器可能在正文还没读回来时就看到目标，此时它必须**不消费**
 * 而是等下一次渲染。因此清除动作只能由真正完成跳转的一方执行，
 * 且目标带一个自增序号，保证「跳同一个位置两次」也会触发两次。
 */

import { createSignal } from "solid-js";

/** 一次待执行的跳转。 */
export interface JumpTarget {
  /** 目标章 ID。 */
  chapterId: string;
  /** 正文里的字符偏移。 */
  offset: number;
  /** 自增序号：同一个位置连续跳两次也要能被识别成"新的一次"。 */
  token: number;
}

const [pending, setPending] = createSignal<JumpTarget | null>(null);

/** 当前待执行的跳转目标（只读）。 */
export { pending as pendingJump };

/** 自增序号，保证 token 单调。 */
let counter = 0;

/**
 * 发布一次跳转请求。
 *
 * 调用方（检索面板）只做这一件事：它不需要知道编辑器在哪、
 * 正文有没有载入、高亮怎么画。
 */
export function requestJump(chapterId: string, offset: number): void {
  counter += 1;
  setPending({
    chapterId,
    offset: Math.max(0, Math.floor(offset)),
    token: counter,
  });
}

/**
 * 消费跳转目标。
 *
 * **只能由真正完成了跳转的一方调用**。编辑器在正文未就绪时看到目标，
 * 应当原样留着（不调用本函数），等下一次渲染再来。
 */
export function consumeJump(token: number): void {
  const current = pending();
  if (current !== null && current.token === token) setPending(null);
}

/** 清空跳转（测试用，以及关闭工作区时）。 */
export function clearJump(): void {
  setPending(null);
}
