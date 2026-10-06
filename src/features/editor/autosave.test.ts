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

describe("自动保存：在途保存与切章竞态", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("在途保存期间又打的字，flushNow 会等它落地后补存", async () => {
    // 旧实现在 performSave 开头写 `if (this.running) return`，
    // 于是这条路径会静默丢掉第二句：防抖到点开始存 → 等待期间作者
    // 又打了一句 → 切章 flush → flush 看见在途请求就空转返回。
    const releases: Array<() => void> = [];
    const saved: string[] = [];
    const save = vi.fn().mockImplementation(async (body: string) => {
      saved.push(body);
      await new Promise<void>((r) => {
        releases.push(r);
      });
    });
    let body = "第一句";
    const s = new AutosaveScheduler({ save, read: () => body });

    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    expect(saved).toEqual(["第一句"]);

    // 第一次保存还没回来，作者又打了字
    body = "第一句第二句";
    s.markDirty();

    const flushed = s.flushNow();
    await vi.advanceTimersByTimeAsync(0);
    // 仍在等在途请求，此刻还没有第二次保存
    expect(saved).toEqual(["第一句"]);

    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual(["第一句", "第一句第二句"]);

    releases[1]?.();
    await vi.advanceTimersByTimeAsync(0);
    await flushed;
    expect(s.isDirty()).toBe(false);
  });

  it("正文在发起那一刻就固定，之后 read() 变了也不会串章", async () => {
    // 保存是异步的。若等到回调真正执行时才 read()，切章后读到的
    // 会是**新章**正文，然后被写进旧章的文件里。
    const saved: string[] = [];
    let release: (() => void) | undefined;
    const save = vi.fn().mockImplementation(async (body: string) => {
      saved.push(body);
      await new Promise<void>((r) => {
        release = r;
      });
    });
    let body = "第三章的正文";
    const s = new AutosaveScheduler({ save, read: () => body });

    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    // 保存已在途，此时用户切到了第七章
    body = "第七章的正文";

    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual(["第三章的正文"]);
  });

  it("在途保存不会被并发的防抖触发重复发起", async () => {
    const releases: Array<() => void> = [];
    const save = vi.fn().mockImplementation(async () => {
      await new Promise<void>((r) => {
        releases.push(r);
      });
    });
    const s = new AutosaveScheduler({ save, read: () => "正文" });

    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    expect(save).toHaveBeenCalledTimes(1);

    // 在途期间继续打字：只排队，不并发发起第二次
    s.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    expect(save).toHaveBeenCalledTimes(1);

    // 在途落地后必须自动补上那一次，否则 dirty 会永远挂着没人存
    releases[0]?.();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1);
    expect(save).toHaveBeenCalledTimes(2);
    releases[1]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isDirty()).toBe(false);
  });

  it("保存失败后 flushNow 仍能重试（不被在途状态卡死）", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("云盘占用"))
      .mockResolvedValue(undefined);
    const s = new AutosaveScheduler({ save, read: () => "正文" });

    s.markDirty();
    await expect(s.flushNow()).resolves.toBe(true);
    expect(s.isDirty()).toBe(true);

    await expect(s.flushNow()).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(s.isDirty()).toBe(false);
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
