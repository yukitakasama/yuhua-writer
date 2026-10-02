/**
 * 自动保存（T4.8）。
 *
 * ## 需求原话
 *
 * 「防抖 + 失焦 + 切章 + 关窗强制」。四个触发点缺一不可：
 *
 * | 触发 | 光靠它会怎样 |
 * | --- | --- |
 * | 防抖 | 作者一直打字就一直不保存，断电全丢 |
 * | 失焦 | 作者从不切窗口就永不保存 |
 * | 切章 | 切章时不保存会把上一章的后半截丢掉 |
 * | 关窗 | 没这最后一脚，前三个都可能来不及跑完 |
 *
 * ## 为什么这一层不做成"存进编辑器状态"
 *
 * 保存需要调后端 IPC，而编辑器内核不该知道 IPC 的存在 ——
 * 那样就没法在纯前端环境（浏览器降级模式、测试）里跑编辑器了。
 * 因此这里只产出**判断**（该不该存、存什么），
 * 真正的 IO 由上层注入的回调完成。
 */

/**
 * 自动保存的配置。
 *
 * 默认 1500ms 防抖：比一般界面输入的 300ms 长得多。理由是写小说时
 * 作者是**连续打字几十秒才停下来想**，300ms 会在每个字之间都触发一次
 * 保存排队，既浪费 IO 也让"保存中"指示点一直闪。
 */
export interface AutosaveOptions {
  /** 停止输入多久后保存（毫秒）。 */
  debounceMs?: number;
  /** 最长多久必须保存一次（毫秒），即使作者一直在打字。 */
  maxWaitMs?: number;
  /** 实际执行保存的回调。 */
  save: (body: string) => void | Promise<void>;
  /** 读取当前正文。 */
  read: () => string;
  /** 当前是否处于"不能保存"的状态（IME 组合、正在载入等）。 */
  canSave?: () => boolean;
}

/** 自动保存的默认参数。 */
export const AUTOSAVE_DEBOUNCE_MS = 1500;

/**
 * 上一次强制保存的间隔上限。
 *
 * 设成 30 秒：一个连续打字 30 秒的作者，最多只会产生 1 次
 * "不等到停顿就保存"。这个值再小就开始显得过于频繁，
 * 再大则断电时的损失窗口太长。
 */
export const AUTOSAVE_MAX_WAIT_MS = 30_000;

/** 自动保存调度器。 */
export class AutosaveScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt: number | null = null;
  private dirty = false;
  private running = false;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly options: AutosaveOptions) {
    this.debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;
  }

  /** 内容有改动。安排一次保存。 */
  markDirty(now = Date.now()): void {
    if (!this.dirty) {
      this.dirty = true;
      this.firstDirtyAt = now;
    }
    this.schedule(now);
  }

  /** 是否有未保存的改动。 */
  isDirty(): boolean {
    return this.dirty;
  }

  /** 是否正在保存。 */
  isSaving(): boolean {
    return this.running;
  }

  /**
   * 立即保存（失焦、切章、关窗时调）。
   *
   * 返回的 Promise 会等到保存回调真正完成 —— 关窗路径必须能 await 它，
   * 否则"保存还没写完窗口就关了"。
   */
  async flushNow(): Promise<boolean> {
    this.cancelTimer();
    if (!this.dirty) return false;
    await this.performSave();
    return true;
  }

  /** 丢弃待保存状态（比如切到另一章前把旧状态清掉）。 */
  reset(): void {
    this.cancelTimer();
    this.dirty = false;
    this.firstDirtyAt = null;
  }

  /** 释放定时器。组件卸载时调。 */
  dispose(): void {
    this.cancelTimer();
  }

  private schedule(now: number): void {
    this.cancelTimer();
    // 已经超过"最长等待"就直接保存，不再等防抖
    if (
      this.firstDirtyAt !== null &&
      now - this.firstDirtyAt >= this.maxWaitMs
    ) {
      void this.performSave();
      return;
    }
    this.timer = setTimeout(() => {
      void this.performSave();
    }, this.debounceMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async performSave(): Promise<void> {
    if (this.running) return;
    // 组合期间不保存：半截拼音不是稿子（见 ime.ts）
    if (this.options.canSave && !this.options.canSave()) {
      // 组合结束后还会再 markDirty 一次，这里只是跳过，不丢状态
      return;
    }
    if (!this.dirty) return;

    this.running = true;
    this.dirty = false;
    this.firstDirtyAt = null;
    this.cancelTimer();
    try {
      await this.options.save(this.options.read());
    } catch {
      // 保存失败要把 dirty 放回去，否则这次改动永远不会再被保存。
      // 具体错误由上层（命令层）统一提示，这里不重复报
      this.dirty = true;
      if (this.firstDirtyAt === null) this.firstDirtyAt = Date.now();
    } finally {
      this.running = false;
    }
  }
}

/**
 * 判断一次编辑器更新是否应该标记为"有改动"。
 *
 * ## 为什么不用 `docChanged` 就够了
 *
 * 因为**载入一章正文本身也是一次 `docChanged`**。如果直接用它判断，
 * 每次打开章节都会立刻触发一次保存 —— 把刚读下来的内容原样写回去，
 * 既无意义又会覆盖掉外部改动的时间戳。
 *
 * 因此判据是「文档变了 **且** 这次变化来自用户输入」。
 */
export function isUserEdit(
  docChanged: boolean,
  isUserEvent: (event: string) => boolean,
): boolean {
  if (!docChanged) return false;
  return (
    isUserEvent("input") ||
    isUserEvent("delete") ||
    isUserEvent("input.type") ||
    isUserEvent("input.paste") ||
    isUserEvent("input.drop")
  );
}
