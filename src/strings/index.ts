/**
 * 文案访问器。
 *
 * ## 为什么用点号路径而不是 `t.chapters.emptyTitle`
 *
 * 直接导出对象当然更短，但那样就失去了两件事：
 *
 * 1. **插值**。`t("library.chapterCount", { count: 12 })` 比手写模板字符串
 *    更容易在未来换成 ICU MessageFormat。
 * 2. **可遍历**。测试要遍历「所有键」来检查有没有空值、有没有漏配，
 *    字符串路径让这件事变得自然（见 ./strings.test.ts）。
 *
 * 顺带的好处：调用点出现的是字符串而不是标识符，将来做「文案热替换」
 * （不改代码换 locale）时不需要动组件。
 */

import zhCN, { type StringDict } from "./zh-CN";

/** 支持的界面语言。第一阶段只有简体中文，类型上预留扩展位。 */
export type Locale = "zh-CN";

/** 当前语言。将来由设置项驱动，本阶段固定。 */
export const DEFAULT_LOCALE: Locale = "zh-CN";

/** 插值参数：把 `{name}` 替换成给定文本。 */
export type Interpolation = Record<string, string | number>;

/** 所有语言的字典表。加语言时在类型层面就会被要求补全键。 */
const DICTS: Record<Locale, StringDict> = {
  "zh-CN": zhCN,
};

/** 取某个语言的字典。 */
export function dictionary(locale: Locale = DEFAULT_LOCALE): StringDict {
  return DICTS[locale];
}

/**
 * 文案键的点号路径。
 *
 * 用模板字面量类型从字典本身推导出来，因此**拼错键名是编译错误**，
 * 而不是运行时的 `undefined` —— 这是把文案集中化之后才拿得到的收益。
 */
export type StringKey = DeepKeys<StringDict>;

/** 递归展开嵌套对象的所有叶子路径。 */
type DeepKeys<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${DeepKeys<T[K]>}`;
}[keyof T & string];

/** 按键路径取值；路径不存在返回 undefined。 */
export function lookup(
  key: string,
  locale: Locale = DEFAULT_LOCALE,
): string | undefined {
  let node: unknown = DICTS[locale];
  for (const part of key.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * 取一条文案，并做 {name} 插值。
 *
 * 找不到键时**返回键名本身**而不是抛错：界面上一处文案缺失
 * 不值得让整个应用崩掉，而把键名显示出来还能让测试立刻抓到它。
 */
export function t(
  key: StringKey,
  params?: Interpolation,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const raw = lookup(key, locale);
  if (raw === undefined) return key;
  return params ? interpolate(raw, params) : raw;
}

/** 把 `{name}` 占位符替换掉。未知占位符原样保留，便于定位漏传的参数。 */
export function interpolate(template: string, params: Interpolation): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** 当前语言下的字数口径标签。 */
export function countModeLabel(
  mode: "withPunctuation" | "withoutPunctuation" | "wordsForEnglish",
): string {
  return t(`wordCount.${mode}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
