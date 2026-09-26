/**
 * 字体目录（T9.2 的数据源）。
 *
 * ## 为什么要有「目录」这一层
 *
 * 用户在设置面板里看到的是「宋体 / 楷体 / 系统字体」这三个**人话选项**，
 * 而不是 `"Yuhua Serif SC", "Noto Serif CJK SC", …` 这一串 CSS 值。
 * 目录把这两者缝合起来：
 *
 * - **标识**（id）用于持久化与加载器入参，短且稳定；
 * - **回退链**（stack）是 CSS 值的唯一真相，将来调整顺序不动用户数据；
 * - **是否内置**（bundled）决定要不要走 FontFace 加载 —— 系统字体交给
 *   操作系统字形缓存，我们既不下载也管不着它。
 *
 * ## 回退链为什么这么排（计划书 7.5.4）
 *
 * 子集化必然丢掉表外生僻字，而小说作者在人名地名上恰恰爱用生僻字。
 * 浏览器**按字符**回退：内置字体缺哪个字，就取回退链里下一个字体的那个字。
 * 因此回退链要按「风格最接近」排序 —— 宋体的下一个仍是宋体系（Noto / 思源 / SimSun），
 * 楷体的下一个仍是楷体系（霞鹜文楷 / 系统楷体），直到最后才落到通用 `serif`。
 * 这样生僻字不会出现豆腐块，也不会突然跳成风格迥异的字体。
 */

/** 一个可选字体族。 */
export interface FontFamily {
  /** 稳定标识，用于持久化与加载器入参。 */
  id: string;
  /** 展示名（中文）。 */
  label: string;
  /** 一句话说明，设置面板的副标题。 */
  note: string;
  /** CSS font-family 完整回退链，**唯一的真相来源**。 */
  stack: string;
  /**
   * 是否为随包内置字体。
   * 内置字体的字形需要 FontFace 按需加载；系统字体不需要（也不该）。
   */
  bundled: boolean;
  /**
   * 内置字体的构建产物路径（相对站点根）。
   * 目录里字体二进制不入 git，由 scripts/fetch-fonts.mjs + subset-fonts.mjs 生成，
   * 所以这里给的是**约定路径**而不是真实文件存在性检查。
   */
  files?: readonly FontWeightFile[];
  /** 适配的作用域（界面字体适合无衬线，正文适合衬线）。用于设置面板的推荐排序。 */
  suits: readonly ("body" | "heading" | "ui")[];
}

/** 一个字重的文件描述。 */
export interface FontWeightFile {
  /** 字重。 */
  weight: 400 | 700;
  /** 相对路径。 */
  url: string;
}

/** 系统 UI 无衬线回退链。与 tokens.css 的 --font-ui 默认值一致。 */
export const UI_STACK =
  'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

/** 内置宋体（思源宋体 SC 子集，重命名为 Yuhua Serif SC）。 */
const SERIF_STACK =
  '"Yuhua Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", "Songti SC", serif';

/** 内置楷体（霞鹜文楷子集，重命名为 Yuhua Kai SC）。 */
const KAI_STACK = '"Yuhua Kai SC", "LXGW WenKai", "KaiTi", "STKaiti", serif';

/** 等宽回退链，供将来的「代码块字体」设置复用。 */
const MONO_STACK = '"Cascadia Mono", "Consolas", "Menlo", "Noto Sans Mono", monospace';

/**
 * 全部可选字体族。
 *
 * 顺序即设置面板的展示顺序：把内置字体排在前面 —— 它们是排版最一致的选择，
 * 也是离线可用的保证；系统字体排在后面作为兜底。
 */
export const FONT_CATALOG: readonly FontFamily[] = [
  {
    id: "yuhua-serif",
    label: "宋体",
    note: "衬线端正，适合长篇阅读",
    stack: SERIF_STACK,
    bundled: true,
    files: [
      { weight: 400, url: "fonts/YuhuaSerifSC-Regular.woff2" },
      { weight: 700, url: "fonts/YuhuaSerifSC-Bold.woff2" },
    ],
    suits: ["body", "heading"],
  },
  {
    id: "yuhua-kai",
    label: "楷体",
    note: "手写气质，标题与卷名常用",
    stack: KAI_STACK,
    bundled: true,
    files: [
      { weight: 400, url: "fonts/YuhuaKaiSC-Regular.woff2" },
      { weight: 700, url: "fonts/YuhuaKaiSC-Bold.woff2" },
    ],
    suits: ["heading", "body"],
  },
  {
    id: "system-ui",
    label: "系统界面字体",
    note: "由操作系统提供，最省内存",
    stack: UI_STACK,
    bundled: false,
    suits: ["ui"],
  },
  {
    id: "system-serif",
    label: "系统宋体",
    note: "使用系统已安装的宋体，不加载额外字形",
    stack: '"SimSun", "Songti SC", "Noto Serif CJK SC", serif',
    bundled: false,
    suits: ["body", "heading"],
  },
  {
    id: "system-kai",
    label: "系统楷体",
    note: "使用系统已安装的楷体，不加载额外字形",
    stack: '"KaiTi", "STKaiti", "LXGW WenKai", serif',
    bundled: false,
    suits: ["heading"],
  },
  {
    id: "system-sans",
    label: "系统黑体",
    note: "使用系统已安装的黑体",
    stack: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
    bundled: false,
    suits: ["ui", "heading"],
  },
  {
    id: "mono",
    label: "等宽",
    note: "适合代码与字数对齐",
    stack: MONO_STACK,
    bundled: false,
    suits: ["ui"],
  },
];

/** 目录索引：id -> 字体族。 */
const BY_ID: ReadonlyMap<string, FontFamily> = new Map(FONT_CATALOG.map((f) => [f.id, f]));

/** 默认字体族 id（与 tokens.css 的默认值一致）。 */
export const DEFAULT_FAMILY = "yuhua-serif";

/**
 * 按标识取字体族。
 *
 * 找不到时**返回宋体**而不是抛错：字体目录可能因为版本升级少了某个 id
 * （例如某个系统字体被合并了），这时让用户看到宋体远好过让设置页白屏。
 *
 * @param id 字体族标识
 * @returns 对应字体族，未知 id 回退到宋体
 */
export function fontFamilyById(id: string): FontFamily {
  return BY_ID.get(id) ?? (BY_ID.get(DEFAULT_FAMILY) as FontFamily);
}

/** 标识是否存在。 */
export function hasFamily(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * 取一个作用域的候选字体族，推荐的排在最前。
 *
 * @param scope 作用域
 * @returns 排序后的候选列表（不改动原数组）
 */
export function familiesFor(scope: "body" | "heading" | "ui"): FontFamily[] {
  return FONT_CATALOG.slice().sort((a, b) => {
    const rankA = a.suits.indexOf(scope);
    const rankB = b.suits.indexOf(scope);
    return (rankA < 0 ? 99 : rankA) - (rankB < 0 ? 99 : rankB);
  });
}

/**
 * 只有内置字体需要被加载器预加载。
 *
 * @param id 字体族标识
 * @returns 是否为需要 FontFace 管理的字族
 */
export function isBundled(id: string): boolean {
  return fontFamilyById(id).bundled;
}
