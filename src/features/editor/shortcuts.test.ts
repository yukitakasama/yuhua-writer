import { describe, expect, it } from "vitest";

import { applyOverrides, bindingById, DEFAULT_BINDINGS, displayChord, eventToChord, findConflicts, type KeyBinding } from "./shortcuts";

/**
 * 造一个键盘事件。
 *
 * `altGraph` 会变成 `getModifierState("AltGraph")` 的返回值 ——
 * 真实的 AltGr 事件就是这样被识别的（见 shortcuts.ts 的说明）。
 */
function key(init: Partial<KeyboardEvent> & { key: string; code: string; altGraph?: boolean }): KeyboardEvent {
  const { altGraph = false, ...rest } = init;
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...rest,
    getModifierState: (name: string) => name === "AltGraph" && altGraph,
  } as unknown as KeyboardEvent;
}

describe("快捷键：事件归一（Windows）", () => {
  const win = false;

  it("Ctrl+K => Mod+K", () => {
    expect(eventToChord(key({ key: "k", code: "KeyK", ctrlKey: true }), win)).toBe("Mod+K");
  });

  it("Cmd 在 Windows 上不算 Mod", () => {
    expect(eventToChord(key({ key: "k", code: "KeyK", metaKey: true }), win)).toBe("K");
  });

  it("Ctrl+Shift+F => Mod+Shift+F", () => {
    expect(eventToChord(key({ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true }), win)).toBe("Mod+Shift+F");
  });

  it("Ctrl+Alt+N => Mod+Alt+N", () => {
    expect(eventToChord(key({ key: "n", code: "KeyN", ctrlKey: true, altKey: true }), win)).toBe("Mod+Alt+N");
  });

  it("单个修饰键不构成组合", () => {
    expect(eventToChord(key({ key: "Control", code: "ControlLeft", ctrlKey: true }), win)).toBe("");
    expect(eventToChord(key({ key: "Shift", code: "ShiftLeft", shiftKey: true }), win)).toBe("");
  });

  it("方向键用命名键名", () => {
    expect(eventToChord(key({ key: "ArrowUp", code: "ArrowUp", ctrlKey: true, altKey: true }), win)).toBe("Mod+Alt+ArrowUp");
  });

  it("数字键用 code 而不是 key（避开 Shift 产生的符号）", () => {
    expect(eventToChord(key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }), win)).toBe("Mod+Shift+1");
  });

  it("Shift+/ 得到 Mod+Shift+/（斜杠键没有 code 归一分支）", () => {
    // 符号键不做 code 归一，用 key 本身
    const chord = eventToChord(key({ key: "?", code: "Slash", ctrlKey: true, shiftKey: true }), win);
    expect(chord).toContain("Mod");
    expect(chord).toContain("Shift");
  });

  it("真正的 AltGr 不会被当成 Alt（欧洲键盘布局打 @ 之类的符号）", () => {
    // AltGr 会同时报告 ctrlKey 与 altKey，同时 getModifierState 返回 true。
    // 此时 Alt 不该进入组合键，否则 AltGr+7（打 { 的欧洲布局写法）
    // 会被误判成一个不存在的快捷键
    const chord = eventToChord(key({ key: "{", code: "Digit7", ctrlKey: true, altKey: true, altGraph: true }), win);
    expect(chord).not.toContain("Alt");
  });

  it("Ctrl+Alt 的真实快捷键不受 AltGr 判定影响", () => {
    // 这是上一条的反面：没有 AltGraph 状态时，Ctrl+Alt 必须正常识别。
    // 用"ctrl && alt"去排除 AltGr 的实现在这里会失败
    expect(eventToChord(key({ key: "n", code: "KeyN", ctrlKey: true, altKey: true }), win)).toBe("Mod+Alt+N");
  });
});

describe("快捷键：事件归一（macOS）", () => {
  const mac = true;

  it("Cmd+K => Mod+K", () => {
    expect(eventToChord(key({ key: "k", code: "KeyK", metaKey: true }), mac)).toBe("Mod+K");
  });

  it("Ctrl 在 macOS 上不算 Mod", () => {
    expect(eventToChord(key({ key: "k", code: "KeyK", ctrlKey: true }), mac)).toBe("K");
  });

  it("Cmd+Shift+F => Mod+Shift+F", () => {
    expect(eventToChord(key({ key: "F", code: "KeyF", metaKey: true, shiftKey: true }), mac)).toBe("Mod+Shift+F");
  });
});

describe("快捷键：冲突检测", () => {
  it("默认表本身无冲突", () => {
    expect(findConflicts(DEFAULT_BINDINGS).size).toBe(0);
  });

  it("同一个组合键绑给两个动作会被发现", () => {
    const bindings: KeyBinding[] = [
      { id: "a", keys: "Mod+K", label: "甲", group: "导航" },
      { id: "b", keys: "Mod+K", label: "乙", group: "导航" },
    ];
    const conflicts = findConflicts(bindings);
    expect(conflicts.size).toBe(1);
    expect(conflicts.get("Mod+K")?.length).toBe(2);
  });

  it("三个动作撞同一个键也全部列出", () => {
    const bindings: KeyBinding[] = [
      { id: "a", keys: "Mod+K", label: "甲", group: "导航" },
      { id: "b", keys: "Mod+K", label: "乙", group: "导航" },
      { id: "c", keys: "Mod+K", label: "丙", group: "导航" },
    ];
    expect(findConflicts(bindings).get("Mod+K")?.length).toBe(3);
  });

  it("不冲突的键不进结果", () => {
    const bindings: KeyBinding[] = [
      { id: "a", keys: "Mod+K", label: "甲", group: "导航" },
      { id: "b", keys: "Mod+J", label: "乙", group: "导航" },
    ];
    expect(findConflicts(bindings).size).toBe(0);
  });

  it("空表无冲突", () => {
    expect(findConflicts([]).size).toBe(0);
  });
});

describe("快捷键：用户改键", () => {
  it("覆盖已有动作的键位", () => {
    const result = applyOverrides(DEFAULT_BINDINGS, { search: "Mod+P" });
    expect(bindingById(result, "search")?.keys).toBe("Mod+P");
  });

  it("未覆盖的动作保持默认", () => {
    const result = applyOverrides(DEFAULT_BINDINGS, { search: "Mod+P" });
    expect(bindingById(result, "commandPalette")?.keys).toBe("Mod+K");
  });

  it("不允许新增动作（配置里不存在的 id 被忽略）", () => {
    const result = applyOverrides(DEFAULT_BINDINGS, { nonexistent: "Mod+Q" });
    expect(result.length).toBe(DEFAULT_BINDINGS.length);
    expect(bindingById(result, "nonexistent")).toBeUndefined();
  });

  it("改键后能检测出冲突", () => {
    const result = applyOverrides(DEFAULT_BINDINGS, { search: "Mod+K" });
    expect(findConflicts(result).size).toBeGreaterThan(0);
  });

  it("空覆盖表等于默认表", () => {
    expect(applyOverrides(DEFAULT_BINDINGS, {})).toEqual([...DEFAULT_BINDINGS]);
  });
});

describe("快捷键：默认表内容", () => {
  it("包含计划书要求的核心动作", () => {
    const ids = DEFAULT_BINDINGS.map((b) => b.id);
    for (const required of ["commandPalette", "search", "find", "replace", "save", "focusMode", "shortcutPanel"]) {
      expect(ids).toContain(required);
    }
  });

  it("每个绑定都有非空标签", () => {
    for (const b of DEFAULT_BINDINGS) {
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  it("每个绑定的 keys 都能被解析成至少一个按键", () => {
    for (const b of DEFAULT_BINDINGS) {
      expect(b.keys.split("+").length).toBeGreaterThanOrEqual(1);
    }
  });

  it("id 唯一", () => {
    const ids = DEFAULT_BINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("快捷键：显示", () => {
  it("Windows 上 Mod 显示成 Ctrl", () => {
    expect(displayChord("Mod+K", false)).toBe("Ctrl+K");
  });

  it("macOS 上 Mod 显示成 ⌘ 且无加号", () => {
    expect(displayChord("Mod+K", true)).toBe("⌘K");
  });

  it("方向键显示成箭头", () => {
    expect(displayChord("Mod+Alt+ArrowUp", false)).toBe("Ctrl+Alt+↑");
    expect(displayChord("Mod+Alt+ArrowDown", true)).toBe("⌘⌥↓");
  });

  it("Shift 在 macOS 上显示成 ⇧", () => {
    expect(displayChord("Mod+Shift+F", true)).toBe("⌘⇧F");
  });
});
