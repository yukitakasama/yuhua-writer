import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AutosaveScheduler,
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  isUserEdit,
} from "./autosave";

describe("自动保存：防抖", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("连续改动只在最后一次之后保存一次", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = new AutosaveScheduler({ save, read: () => "正文" });
    for (let i = 0; i < 5; i += 1) s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("默认防抖是 1500ms", () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(1500);
  });

  it("没有改动时不保存", async () => {
    const save = vi.fn();
    new AutosaveScheduler({ save, read: () => "" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 3);
    expect(save).not.toHaveBeenCalled();
  });

  it("保存的是最近一次的正文", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let body = "第一次";
    const s = new AutosaveScheduler({ save, read: () => body });
    s.markDirty();
    body = "第二次";
    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    expect(save).toHaveBeenCalledWith("第二次");
  });
});

describe("自动保存：最长等待", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("一直打字也会在 maxWait 后强制保存", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = new AutosaveScheduler({
      save,
      read: () => "正文",
      debounceMs: 1000,
      maxWaitMs: 3000,
    });
    let now = 0;
    s.markDirty(now);
    // 每 500ms 打一次字，防抖永远触发不了
    for (now = 500; now <= 3500; now += 500) {
      s.markDirty(now);
      // 每次都用真实定时器推进对应的时间
      await vi.advanceTimersByTimeAsync(0);
    }
    // 超过 maxWait 后 markDirty 会直接保存，绕过防抖
    expect(save).toHaveBeenCalled();
  });

  it("maxWait 默认 30 秒", () => {
    expect(AUTOSAVE_MAX_WAIT_MS).toBe(30_000);
  });
});

describe("自动保存：flushNow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("立即保存待写内容", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = new AutosaveScheduler({ save, read: () => "正文" });
    s.markDirty();
    expect(save).not.toHaveBeenCalled();
    await s.flushNow();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("没有改动时 flush 不保存", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = new AutosaveScheduler({ save, read: () => "正文" });
    expect(await s.flushNow()).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("flush 会取消已排队的防抖保存（不重复存）", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const s = new AutosaveScheduler({ save, read: () => "正文" });
    s.markDirty();
    await s.flushNow();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 3);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("等得到保存回调真正完成（关窗路径依赖这一点）", async () => {
    let resolved = false;
    const save = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      resolved = true;
    });
    const s = new AutosaveScheduler({ save, read: () => "正文" });
    s.markDirty();
    const flushed = s.flushNow();
    await vi.advanceTimersByTimeAsync(200);
    await flushed;
    expect(resolved).toBe(true);
  });
});

describe("自动保存：IME 门控", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("组合期间不保存", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let composing = true;
    const s = new AutosaveScheduler({
      save,
      read: () => "拼音",
      canSave: () => !composing,
    });
    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(save).not.toHaveBeenCalled();
    // 组合结束后仍处于 dirty，下一次 markDirty 会正常保存
    expect(s.isDirty()).toBe(true);
  });

  it("组合结束后能正常保存", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let composing = true;
    const s = new AutosaveScheduler({
      save,
      read: () => "你好",
      canSave: () => !composing,
    });
    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    composing = false;
    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    expect(save).toHaveBeenCalledWith("你好");
  });
});

describe("自动保存：失败处理", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("保存失败后仍保持 dirty", async () => {
    const save = vi.fn().mockRejectedValue(new Error("磁盘满"));
    const s = new AutosaveScheduler({ save, read: () => "正文" });
    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    expect(s.isDirty()).toBe(true);
  });

  it("失败后再次 markDirty 会重试", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("临时失败"))
      .mockResolvedValue(undefined);
    const s = new AutosaveScheduler({ save, read: () => "正文" });
    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    expect(s.isDirty()).toBe(true);
    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(s.isDirty()).toBe(false);
  });
});

describe("自动保存：状态查询与重置", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("markDirty 之后 isDirty 为真", () => {
    const s = new AutosaveScheduler({ save: vi.fn(), read: () => "" });
    expect(s.isDirty()).toBe(false);
    s.markDirty();
    expect(s.isDirty()).toBe(true);
  });

  it("reset 丢弃待保存状态（切章时用）", async () => {
    const save = vi.fn();
    const s = new AutosaveScheduler({ save, read: () => "上一章" });
    s.markDirty();
    s.reset();
    expect(s.isDirty()).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(save).not.toHaveBeenCalled();
  });

  it("dispose 之后不再触发保存", async () => {
    const save = vi.fn();
    const s = new AutosaveScheduler({ save, read: () => "正文" });
    s.markDirty();
    s.dispose();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("isUserEdit：区分用户编辑与程序替换", () => {
  const yes = () => true;
  const no = () => false;

  it("文档没变就不是编辑", () => {
    expect(isUserEdit(false, yes)).toBe(false);
  });

  it("input 事件算编辑", () => {
    expect(isUserEdit(true, (e) => e === "input")).toBe(true);
  });

  it("delete 事件算编辑", () => {
    expect(isUserEdit(true, (e) => e === "delete")).toBe(true);
  });

  it("粘贴算编辑", () => {
    expect(isUserEdit(true, (e) => e === "input.paste")).toBe(true);
  });

  it("程序整体替换不算编辑（否则打开章节就会触发保存）", () => {
    expect(isUserEdit(true, no)).toBe(false);
  });

  it("载入文档不算编辑", () => {
    expect(isUserEdit(true, (e) => e === "setDoc")).toBe(false);
  });
});
