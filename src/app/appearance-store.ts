/**
 * 外观设置：字体与排版。
 *
 * ## 为什么要有「全局级 / 工作区级」两层（T9.4）
 *
 * 同一个作者在不同作品上的排版需求并不一样：写历史小说想要楷体标题、
 * 更宽的行距与更大的字号；写悬疑想要紧一点的宋体。如果只有一套全局设置，
 * 换书就得重新调一遍，这是真实的摩擦。
 *
 * 因此这里的模型是「**全局基线 + 工作区覆盖**」：
 * - 全局设置存在 localStorage，跟着人走；
 * - 工作区设置按工作区根路径分桶存在 localStorage，跟着作品走；
 * - 读取时逐字段取值：工作区有值就用工作区的，没有就用全局的。
 *
 * **为什么工作区级也放 localStorage 而不是写进工作区目录**：写进目录意味着
 * 要改 Rust 侧的工作区格式（本任务是纯前端任务），而且设置是纯 UI 偏好，
 * 定位与 layout-store 的窗口宽度完全一致（后者也没写进工作区）。
 *
 * ## 为什么用「字段缺省即继承」而不是布尔开关
 *
 * 每个字段可选：缺省表示「这一项跟随全局」，有值表示「工作区单独指定」。
 * 好处是全局改了以后，没有单独覆盖的字段会自动跟着变 —— 这才是用户
 * 对「默认值」的直觉。如果用一个 overrideAll 布尔开关，
 * 用户就失去了「只覆盖字体、其余跟全局」的表达能力。
 */

import { createStore, produce } from "solid-js/store";

import {
  isFiniteNumber,
  isPlainObject,
  readJson,
  writeJson,
} from "./persistent";

/** 三个字体作用域，与 tokens.css 的 --font-body / --font-heading / --font-ui 一一对应。 */
export type FontScope = "body" | "heading" | "ui";

/** 全部作用域，顺序即界面展示顺序。 */
export const FONT_SCOPES: readonly FontScope[] = ["body", "heading", "ui"];

/** 主题选择。system 表示跟随系统，不写 html[data-theme]。 */
export type ThemeChoice = "light" | "dark" | "system";

/** 全部主题选项。 */
export const THEME_CHOICES: readonly ThemeChoice[] = [
  "light",
  "dark",
  "system",
];

/** 一个字体作用域的三项选择：字体族、字号、行距。 */
export interface ScopeTypography {
  /**
   * 字体族的**标识**（不是 CSS font-family 值）。
   *
   * 存标识而不是存整串 font-family 有两个理由：
   * 1. 回退链由字体目录（catalog）统一给出，改回退链不需要迁移用户数据；
   * 2. 加载器需要知道要加载哪个字族实例，标识是它唯一的入参。
   */
  family: string;
  /** 字号（px）。 */
  size: number;
  /** 行距（无单位倍数）。 */
  lineHeight: number;
}

/** 排版设置。 */
export interface TypographySettings {
  /** 正文。 */
  body: ScopeTypography;
  /** 标题。 */
  heading: ScopeTypography;
  /** 界面。 */
  ui: ScopeTypography;
  /** 段间距（em，相对于当前字号）。 */
  paragraphGap: number;
  /** 正文最大宽度（px），映射到 --measure-body。 */
  measure: number;
}

/** 外观设置。 */
export interface AppearanceSettings {
  /** 主题。 */
  theme: ThemeChoice;
  /** 排版。 */
  typography: TypographySettings;
  /** 内容语言。第一阶段只有简体中文。 */
  locale: "zh-CN";
}

// ---------------------------------------------------------------------------
// 取值范围
//
// 全部写成导出常量：设置面板的滑块上下限、store 的夹紧、
// 测试里的越界用例共用同一份定义，改一处就全局一致。
// ---------------------------------------------------------------------------

/** 正文字号范围。下限保证 14px 下中文仍可辨认，上限避免一屏放不下三行。 */
export const BODY_SIZE_MIN = 14;
export const BODY_SIZE_MAX = 24;
/** 标题字号范围。 */
export const HEADING_SIZE_MIN = 16;
export const HEADING_SIZE_MAX = 40;
/** 界面字号范围。 */
export const UI_SIZE_MIN = 12;
export const UI_SIZE_MAX = 18;
/** 行距范围。 */
export const LINE_HEIGHT_MIN = 1.2;
export const LINE_HEIGHT_MAX = 2.4;
/** 段距范围（em）。 */
export const PARAGRAPH_GAP_MIN = 0;
export const PARAGRAPH_GAP_MAX = 3;
/** 正文宽度范围。下限 480 保证不出现「一行三字」，上限 1120 避免长行丢行。 */
export const MEASURE_MIN = 480;
export const MEASURE_MAX = 1120;

/** 各作用域的取值范围查表，供界面与夹紧逻辑共用。 */
export const SIZE_RANGE: Readonly<
  Record<FontScope, { min: number; max: number }>
> = {
  body: { min: BODY_SIZE_MIN, max: BODY_SIZE_MAX },
  heading: { min: HEADING_SIZE_MIN, max: HEADING_SIZE_MAX },
  ui: { min: UI_SIZE_MIN, max: UI_SIZE_MAX },
};

/** 默认外观设置。 */
export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "system",
  locale: "zh-CN",
  typography: {
    body: { family: "yuhua-serif", size: 17, lineHeight: 1.9 },
    heading: { family: "yuhua-kai", size: 22, lineHeight: 1.4 },
    ui: { family: "system-ui", size: 15, lineHeight: 1.6 },
    paragraphGap: 1,
    measure: 720,
  },
};

/** 全局设置的 localStorage 键。 */
const GLOBAL_KEY = "appearance.v1";

/** 工作区设置的前缀，后面接工作区根路径的哈希。 */
const WORKSPACE_PREFIX = "appearance.workspace.v1.";

// ---------------------------------------------------------------------------
// 校验与归一
// ---------------------------------------------------------------------------

/** 把任意值夹到区间内；非有限数字则退回 fallback。 */
function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  digits = 2,
): number {
  if (!isFiniteNumber(value)) return fallback;
  const clamped = Math.min(max, Math.max(min, value));
  // 保留固定小数位：字号/行距用滑块调，两位已经够细，且避免浮点尾巴写进 JSON
  const factor = 10 ** digits;
  return Math.round(clamped * factor) / factor;
}

/**
 * 归一化一个作用域的排版设置。
 *
 * @param raw 读回来的原始值
 * @param scope 作用域（决定字号区间）
 * @param fallback 缺省值
 * @param allowInherit 为真时（工作区级）缺失字段归一为 undefined 表示继承全局
 */
function normalizeScope(
  raw: unknown,
  scope: FontScope,
  fallback: ScopeTypography,
  allowInherit: boolean,
): ScopeTypography {
  const source = isPlainObject(raw) ? raw : {};
  const range = SIZE_RANGE[scope];
  const family =
    typeof source.family === "string" && source.family.length > 0
      ? source.family
      : undefined;
  const size = isFiniteNumber(source.size)
    ? clampNumber(source.size, range.min, range.max, fallback.size, 1)
    : undefined;
  const lineHeight = isFiniteNumber(source.lineHeight)
    ? clampNumber(
        source.lineHeight,
        LINE_HEIGHT_MIN,
        LINE_HEIGHT_MAX,
        fallback.lineHeight,
      )
    : undefined;

  if (allowInherit) {
    const partial: ScopeTypography = {
      family: family as string,
      size: size as number,
      lineHeight: lineHeight as number,
    };
    return partial;
  }
  return {
    family: family ?? fallback.family,
    size: size ?? fallback.size,
    lineHeight: lineHeight ?? fallback.lineHeight,
  };
}

/** 工作区级的部分排版（字段可缺省表示继承）。 */
export interface PartialScopeTypography {
  family?: string;
  size?: number;
  lineHeight?: number;
}

/** 工作区级的部分排版设置。 */
export interface PartialTypography {
  body?: PartialScopeTypography;
  heading?: PartialScopeTypography;
  ui?: PartialScopeTypography;
  paragraphGap?: number;
  measure?: number;
}

/** 工作区级设置：每个字段都可缺省，缺省即继承全局。 */
export interface WorkspaceAppearance {
  /** 覆盖主题（部分作品希望固定暗色写作）。 */
  theme?: ThemeChoice;
  /** 覆盖排版。 */
  typography?: PartialTypography;
}

/** 判定一个值是否是合法的主题选择。 */
function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/** 归一化读回来的外观设置对象。 */
export function normalizeAppearance(raw: unknown): AppearanceSettings {
  const source = isPlainObject(raw) ? raw : {};
  const typo = isPlainObject(source.typography) ? source.typography : {};
  const fallback = DEFAULT_APPEARANCE.typography;

  return {
    theme: isThemeChoice(source.theme)
      ? source.theme
      : DEFAULT_APPEARANCE.theme,
    locale: "zh-CN",
    typography: {
      body: normalizeScope(typo.body, "body", fallback.body, false),
      heading: normalizeScope(typo.heading, "heading", fallback.heading, false),
      ui: normalizeScope(typo.ui, "ui", fallback.ui, false),
      paragraphGap: clampNumber(
        typo.paragraphGap,
        PARAGRAPH_GAP_MIN,
        PARAGRAPH_GAP_MAX,
        fallback.paragraphGap,
      ),
      measure: clampNumber(
        typo.measure,
        MEASURE_MIN,
        MEASURE_MAX,
        fallback.measure,
        0,
      ),
    },
  };
}

/** 归一化工作区级设置：所有字段都可缺省。 */
export function normalizeWorkspaceAppearance(
  raw: unknown,
): WorkspaceAppearance {
  if (!isPlainObject(raw)) return {};
  const result: WorkspaceAppearance = {};

  if (isThemeChoice(raw.theme)) result.theme = raw.theme;

  const typo = isPlainObject(raw.typography) ? raw.typography : null;
  if (typo) {
    const partial: PartialTypography = {};
    for (const scope of FONT_SCOPES) {
      const scopeRaw = typo[scope];
      if (!isPlainObject(scopeRaw)) continue;
      const range = SIZE_RANGE[scope];
      const entry: PartialScopeTypography = {};
      if (typeof scopeRaw.family === "string" && scopeRaw.family.length > 0)
        entry.family = scopeRaw.family;
      if (isFiniteNumber(scopeRaw.size))
        entry.size = clampNumber(
          scopeRaw.size,
          range.min,
          range.max,
          range.min,
          1,
        );
      if (isFiniteNumber(scopeRaw.lineHeight)) {
        entry.lineHeight = clampNumber(
          scopeRaw.lineHeight,
          LINE_HEIGHT_MIN,
          LINE_HEIGHT_MAX,
          LINE_HEIGHT_MIN,
        );
      }
      if (Object.keys(entry).length > 0) partial[scope] = entry;
    }
    if (isFiniteNumber(typo.paragraphGap)) {
      partial.paragraphGap = clampNumber(
        typo.paragraphGap,
        PARAGRAPH_GAP_MIN,
        PARAGRAPH_GAP_MAX,
        PARAGRAPH_GAP_MIN,
      );
    }
    if (isFiniteNumber(typo.measure)) {
      partial.measure = clampNumber(
        typo.measure,
        MEASURE_MIN,
        MEASURE_MAX,
        MEASURE_MIN,
        0,
      );
    }
    if (Object.keys(partial).length > 0) result.typography = partial;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 全局 store
// ---------------------------------------------------------------------------

/** 从 localStorage 读取全局外观设置。 */
export function loadAppearance(): AppearanceSettings {
  return normalizeAppearance(
    readJson<unknown>(GLOBAL_KEY, null, isPlainObject),
  );
}

const [appearance, setAppearanceStore] =
  createStore<AppearanceSettings>(loadAppearance());

export { appearance as appearanceSettings };

/** 写回全局设置。设置变更是低频动作，不做防抖。 */
function persistAppearance(): void {
  writeJson(GLOBAL_KEY, appearance);
}

/** 设置主题。 */
export function setTheme(theme: ThemeChoice): void {
  setAppearanceStore("theme", theme);
  persistAppearance();
}

/**
 * 设置某个字体作用域的字段。
 *
 * 用 patch 而不是三个独立函数：作用域与字段都在增长（将来可能有字重、字间距），
 * 每加一项就多三个函数是纯粹的手工业。
 *
 * @param scope 作用域
 * @param patch 要写入的字段
 */
export function setScopeTypography(
  scope: FontScope,
  patch: Partial<ScopeTypography>,
): void {
  const range = SIZE_RANGE[scope];
  const next: Partial<ScopeTypography> = {};
  if (patch.family !== undefined) next.family = patch.family;
  if (patch.size !== undefined) {
    next.size = clampNumber(
      patch.size,
      range.min,
      range.max,
      appearance.typography[scope].size,
      1,
    );
  }
  if (patch.lineHeight !== undefined) {
    next.lineHeight = clampNumber(
      patch.lineHeight,
      LINE_HEIGHT_MIN,
      LINE_HEIGHT_MAX,
      appearance.typography[scope].lineHeight,
    );
  }
  setAppearanceStore("typography", scope, next);
  persistAppearance();
}

/** 设置段距。 */
export function setParagraphGap(gap: number): void {
  setAppearanceStore(
    "typography",
    "paragraphGap",
    clampNumber(
      gap,
      PARAGRAPH_GAP_MIN,
      PARAGRAPH_GAP_MAX,
      DEFAULT_APPEARANCE.typography.paragraphGap,
    ),
  );
  persistAppearance();
}

/** 设置正文宽度。 */
export function setMeasure(measure: number): void {
  setAppearanceStore(
    "typography",
    "measure",
    clampNumber(
      measure,
      MEASURE_MIN,
      MEASURE_MAX,
      DEFAULT_APPEARANCE.typography.measure,
      0,
    ),
  );
  persistAppearance();
}

/** 恢复全局默认外观。 */
export function resetAppearance(): void {
  setAppearanceStore(structuredClone(DEFAULT_APPEARANCE));
  persistAppearance();
}

// ---------------------------------------------------------------------------
// 工作区级设置
// ---------------------------------------------------------------------------

/**
 * 把工作区根路径折成一个稳定的短键。
 *
 * 为什么不用 encodeURIComponent(root)：Windows 路径可以长到 260 字符，
 * 拼上前缀后很容易超过 localStorage 键的实用长度，而且路径里的
 * 反斜杠与冒号在键名里可读性也很差。
 * 这里用 32 位 FNV-1a —— 键短、稳定、无依赖，碰撞概率对本场景足够低
 * （同一台机器上的工作区数量级是几十，不是几十万）。
 *
 * @param root 工作区根路径
 * @returns localStorage 键名
 */
export function workspaceKey(root: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < root.length; i += 1) {
    hash ^= root.charCodeAt(i);
    // FNV 质数 16777619，用 Math.imul 保证 32 位回绕
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return WORKSPACE_PREFIX + hash.toString(16).padStart(8, "0");
}

/** 读取某个工作区的覆盖设置。 */
export function loadWorkspaceAppearance(root: string): WorkspaceAppearance {
  if (root === "") return {};
  return normalizeWorkspaceAppearance(
    readJson<unknown>(workspaceKey(root), null, isPlainObject),
  );
}

const [wsAppearance, setWsStore] = createStore<{
  root: string;
  value: WorkspaceAppearance;
}>({
  root: "",
  value: {},
});

export { wsAppearance as workspaceAppearance };

/** 写回当前工作区的覆盖设置。 */
function persistWorkspace(): void {
  if (wsAppearance.root === "") return;
  writeJson(workspaceKey(wsAppearance.root), wsAppearance.value);
}

/**
 * 切换当前工作区（打开 / 关闭工作区时调用）。
 *
 * 传空字符串表示关闭工作区，此时工作区级覆盖全部失效，
 * 生效值回落到全局 —— 这正是「关掉书回到书架」应有的行为。
 *
 * @param root 工作区根路径，空串表示没有工作区
 */
export function setAppearanceWorkspace(root: string): void {
  if (root === wsAppearance.root) return;
  setWsStore({ root, value: loadWorkspaceAppearance(root) });
}

/**
 * 确保工作区分桶已装载到给定的根路径。
 *
 * 与 {@link setAppearanceWorkspace} 的区别在于**调用时机**：那个是
 * 「工作区变了，跟着换桶」，这个是「我要改这本书的设置，先确认桶是对的」。
 *
 * 为什么需要它：设置面板可以在任何时刻被打开，而它并不保证
 * `useAppearance` 的 effect 已经跑过（例如单测里直接挂载面板、
 * 或者将来把设置做成独立窗口）。写工作区设置之前调一次
 * 幂等的 sync，可以让「本书覆盖」这个功能不依赖挂载顺序。
 *
 * @param root 当前工作区根路径
 */
export function syncAppearanceWorkspace(root: string): void {
  setAppearanceWorkspace(root);
}

/** 写入工作区级某个作用域的覆盖。字段传 undefined 表示恢复继承全局。 */
export function setWorkspaceScope(
  scope: FontScope,
  patch: PartialScopeTypography,
): void {
  if (wsAppearance.root === "") return;
  const current =
    wsAppearance.value.typography && wsAppearance.value.typography[scope];
  const merged: PartialScopeTypography = { ...(current ?? {}), ...patch };
  // 显式传 undefined 的字段视为「删除这一项覆盖」
  for (const key of ["family", "size", "lineHeight"] as const) {
    if (key in patch && patch[key] === undefined) delete merged[key];
  }

  const typography: PartialTypography = {
    ...(wsAppearance.value.typography ?? {}),
  };
  if (Object.keys(merged).length === 0) delete typography[scope];
  else typography[scope] = merged;

  // 在 produce 里整体替换 typography：见 setWorkspaceTypography 的注释 ——
  // Solid 的 store setter 忽略 undefined，逐字段写删不掉覆盖。
  setWsStore(
    "value",
    produce((value: WorkspaceAppearance) => {
      value.typography = typography;
    }),
  );
  persistWorkspace();
}

/**
 * 写入工作区级的段距 / 正文宽度覆盖。字段传 undefined 表示恢复继承全局。
 *
 * 注意这里用**整体替换** `value.typography` 而不是逐字段 set：
 * Solid 的 store setter 会**忽略值为 undefined 的写入**
 * （它把 undefined 当作「没有这个参数」），所以想删掉某个覆盖字段
 * 只能先构造出新的对象再整体替换。用逐字段写会留下删不掉的覆盖，
 * 表现为「点了跟随全局但值没变」。
 */
export function setWorkspaceTypography(
  patch: Partial<Pick<PartialTypography, "paragraphGap" | "measure">>,
): void {
  if (wsAppearance.root === "") return;
  const typography: PartialTypography = {
    ...(wsAppearance.value.typography ?? {}),
    ...patch,
  };
  for (const key of ["paragraphGap", "measure"] as const) {
    if (key in patch && patch[key] === undefined) delete typography[key];
  }
  setWsStore(
    "value",
    produce((value: WorkspaceAppearance) => {
      value.typography = typography;
    }),
  );
  persistWorkspace();
}

/**
 * 写入工作区级主题覆盖。传 undefined 表示跟随全局。
 *
 * 与 {@link setWorkspaceTypography} 同理：删一个键必须整体替换
 * `value`，逐字段写 undefined 会被 store 静默忽略。
 */
export function setWorkspaceTheme(theme: ThemeChoice | undefined): void {
  if (wsAppearance.root === "") return;
  setWsStore(
    "value",
    produce((value: WorkspaceAppearance) => {
      if (theme === undefined) delete value.theme;
      else value.theme = theme;
    }),
  );
  persistWorkspace();
}

/** 清除某个工作区的全部外观覆盖。 */
export function clearWorkspaceAppearance(
  root: string = wsAppearance.root,
): void {
  if (root === "") return;
  writeJson(workspaceKey(root), {});
  if (root === wsAppearance.root) {
    setWsStore(
      "value",
      produce((value: WorkspaceAppearance) => {
        delete value.theme;
        delete value.typography;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// 生效值（全局 + 工作区合并）
// ---------------------------------------------------------------------------

/** 生效主题：工作区覆盖优先。 */
export function effectiveTheme(): ThemeChoice {
  return wsAppearance.value.theme ?? appearance.theme;
}

/** 生效排版：逐字段取「工作区覆盖 ?? 全局」。 */
export function effectiveTypography(): TypographySettings {
  const base = appearance.typography;
  const override = wsAppearance.value.typography;
  if (!override) return base;

  const mergeScope = (scope: FontScope): ScopeTypography => {
    const part = override[scope];
    const fallback = base[scope];
    if (!part) return fallback;
    return {
      family: part.family ?? fallback.family,
      size: part.size ?? fallback.size,
      lineHeight: part.lineHeight ?? fallback.lineHeight,
    };
  };

  return {
    body: mergeScope("body"),
    heading: mergeScope("heading"),
    ui: mergeScope("ui"),
    paragraphGap: override.paragraphGap ?? base.paragraphGap,
    measure: override.measure ?? base.measure,
  };
}

/** 某个作用域是否被当前工作区单独覆盖过（界面上要显示「已覆盖」标记）。 */
export function isScopeOverridden(scope: FontScope): boolean {
  return wsAppearance.value.typography?.[scope] !== undefined;
}

/** 段距 / 宽度是否被当前工作区覆盖。 */
export function isTypographyOverridden(): boolean {
  const typo = wsAppearance.value.typography;
  return typo?.paragraphGap !== undefined || typo?.measure !== undefined;
}

/** 重置到初始状态（测试用）。 */
export function __resetAppearance(): void {
  setAppearanceStore(structuredClone(DEFAULT_APPEARANCE));
  setWsStore({ root: "", value: {} });
}
