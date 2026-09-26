/**
 * 快捷键系统（T4.9）：可配置 + 冲突检测 + 面板。
 *
 * ## 为什么不用 CodeMirror 的 keymap 直接做完
 *
 * CodeMirror 的 keymap 是**给编辑器内部用的**。但写作软件里有一半
 * 快捷键是**应用级**的（新建章、切章、打开搜索、专注模式），
 * 它们要在编辑器没有焦点时也生效，也要出现在"快捷键面板"里
 * 让作者查得到、改得了。
 *
 * 因此这里维护一份**声明式的表**，再由它分别生成：
 *
 * 1. 应用级 keydown 处理（挂在 window 上）
 * 2. CodeMirror 的 keymap 绑定（只取编辑器相关的那部分）
 * 3. 快捷键面板的展示内容
 *
 * 一份数据三处用，就不会出现"面板里写的和实际绑定的不一样"。
 */

/** 一个快捷键绑定。 */
export interface KeyBinding {
  /** 稳定标识符，用于配置持久化。 */
  id: string;
  /** 组合键，形如 `Mod+K`。`Mod` 在 Windows/Linux 上是 Ctrl，在 macOS 上是 Cmd。 */
  keys: string;
  /** 面向作者的说明。 */
  label: string;
  /** 分类，快捷键面板按它分组。 */
  group: "写作" | "导航" | "视图" | "编辑器";
}

/** 默认快捷键表。 */
export const DEFAULT_BINDINGS: readonly KeyBinding[] = [
  { id: "commandPalette", keys: "Mod+K", label: "打开命令面板", group: "导航" },
  { id: "search", keys: "Mod+Shift+F", label: "全局搜索", group: "导航" },
  { id: "find", keys: "Mod+F", label: "本章内查找", group: "编辑器" },
  { id: "replace", keys: "Mod+H", label: "本章内替换", group: "编辑器" },
  { id: "save", keys: "Mod+S", label: "立即保存", group: "写作" },
  { id: "newChapter", keys: "Mod+Alt+N", label: "新建一章", group: "写作" },
  { id: "focusMode", keys: "Mod+Shift+Enter", label: "切换专注模式", group: "视图" },
  { id: "toggleLeft", keys: "Mod+B", label: "折叠 / 展开卷章栏", group: "视图" },
  { id: "toggleRight", keys: "Mod+Shift+B", label: "折叠 / 展开信息栏", group: "视图" },
  { id: "shortcutPanel", keys: "Mod+/", label: "查看快捷键", group: "导航" },
  { id: "wordCountMode", keys: "Mod+Alt+W", label: "切换字数口径", group: "写作" },
  { id: "prevChapter", keys: "Mod+Alt+ArrowUp", label: "上一章", group: "导航" },
  { id: "nextChapter", keys: "Mod+Alt+ArrowDown", label: "下一章", group: "导航" },
];

/**
 * 把一次键盘事件归一成组合键字符串。
 *
 * ## 两个容易搞错的地方
 *
 * **一、Shift 与符号键的关系。** 按 `Shift+` 时 `event.key` 是 `+`，
 * 如果直接用 `event.key` 就会得到 `Mod+Shift++` 这种没法解析的东西。
 * 因此字母键统一用 `event.code` 的字母部分，符号键用 `event.key`。
 *
 * **二、`Mod` 的判定。** 计划书要求跨平台，因此 Windows/Linux 用
 * `ctrlKey`、macOS 用 `metaKey`。
 *
 * **三、`AltGr` 不能用"同时按下 Ctrl+Alt"来判断。** 欧洲键盘布局上
 * `AltGr` 确实会同时报告 `ctrlKey` 与 `altKey`，但
 * `Ctrl+Alt+N` 这样的**真实快捷键**也会报告同样的组合 ——
 * 用"ctrl && alt"去排除 `AltGr`，会把 `Mod+Alt` 系列全部误伤。
 *
 * 正确的判据是 `event.getModifierState("AltGraph")`：
 * 它由浏览器/系统直接给出 `AltGr` 的按下状态，与 ctrl/alt 无关。
 * 拿不到这个 API 时（极老环境）退回"不排除"—— 即优先保证
 * `Ctrl+Alt` 快捷键可用，代价是欧洲布局上 `Mod+` 可能被 `AltGr` 抢一次。
 */
export function eventToChord(event: KeyboardEvent, isMac: boolean): string {
  const parts: string[] = [];
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (mod) parts.push("Mod");
  if (event.altKey && !isAltGraph(event)) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const key = normalizeKey(event, isMac);
  if (key === "") return "";
  parts.push(key);
  return parts.join("+");
}

/**
 * 当前事件是否由 `AltGr` 触发。
 *
 * 见 {@link eventToChord} 的说明：必须用 `getModifierState`，
 * 不能靠"ctrl 与 alt 同时按下"来推断。
 */
function isAltGraph(event: KeyboardEvent): boolean {
  if (typeof event.getModifierState !== "function") return false;
  try {
    return event.getModifierState("AltGraph");
  } catch {
    // 某些 WebView 对未知的修饰键名会抛错，此时保守地认为不是 AltGr
    return false;
  }
}

/** 取事件的"按键名"，屏蔽修饰键本身与布局差异。 */
function normalizeKey(event: KeyboardEvent, isMac: boolean): string {
  const { key, code } = event;
  // 只按下了修饰键：不构成组合
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return "";

  // 字母键用 code（KeyA → A），这样 Shift+字母 得到的是大写字母，
  // 与绑定表里写的 `Mod+Shift+F` 一致
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) {
    if (isMac) return letter[1].toUpperCase();
    // Windows 上 Ctrl+字母 的 event.key 是小写，统一成大写便于比对，
    // 但 Shift+字母 时 event.key 已经是大写，两种都要能对上
    return letter[1].toUpperCase();
  }

  const digit = /^Digit(\d)$/.exec(code);
  if (digit?.[1]) return digit[1];

  // 方向键等命名键：用 key 本身（ArrowUp / Enter / Escape …）
  if (key.length > 1) return key;
  return key;
}

/**
 * 在当前绑定表里找出冲突。
 *
 * 返回「同一个组合键被绑定给多个动作」的分组。
 * 快捷键面板用它给冲突项标红 —— 作者改键之后必须能立刻知道撞了。
 */
export function findConflicts(bindings: readonly KeyBinding[]): Map<string, KeyBinding[]> {
  const byChord = new Map<string, KeyBinding[]>();
  for (const b of bindings) {
    const list = byChord.get(b.keys);
    if (list) list.push(b);
    else byChord.set(b.keys, [b]);
  }
  const conflicts = new Map<string, KeyBinding[]>();
  for (const [chord, list] of byChord) {
    if (list.length > 1) conflicts.set(chord, list);
  }
  return conflicts;
}

/**
 * 用户改键后的合并结果。
 *
 * 只允许**覆盖已有动作的键位**，不允许新增动作 ——
 * 那样会让"配置里有一个不存在的命令"成为可能状态。
 */
export function applyOverrides(
  base: readonly KeyBinding[],
  overrides: Readonly<Record<string, string>>,
): KeyBinding[] {
  return base.map((b) => {
    const override = overrides[b.id];
    return override ? { ...b, keys: override } : b;
  });
}

/** 按 id 查绑定。 */
export function bindingById(bindings: readonly KeyBinding[], id: string): KeyBinding | undefined {
  return bindings.find((b) => b.id === id);
}

/** 判断当前平台是否是 macOS。 */
export function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // userAgentData 是新的标准，拿不到就退回 platform
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  return /mac/i.test(platform);
}

/** 把组合键显示成作者看得懂的样子。 */
export function displayChord(chord: string, isMac: boolean): string {
  return chord
    .split("+")
    .map((part) => {
      if (part === "Mod") return isMac ? "⌘" : "Ctrl";
      if (part === "Alt") return isMac ? "⌥" : "Alt";
      if (part === "Shift") return isMac ? "⇧" : "Shift";
      if (part === "ArrowUp") return "↑";
      if (part === "ArrowDown") return "↓";
      if (part === "ArrowLeft") return "←";
      if (part === "ArrowRight") return "→";
      if (part === "Enter") return "Enter";
      return part;
    })
    .join(isMac ? "" : "+");
}
