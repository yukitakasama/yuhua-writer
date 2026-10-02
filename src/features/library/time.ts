/**
 * 相对时间格式化。
 *
 * ## 为什么自己写而不是用 Intl.RelativeTimeFormat
 *
 * Intl.RelativeTimeFormat 输出的是「3 天前」这种形式，但**中文的
 * 复数规则与量词搭配它处理得并不好**（会输出「3 天前」没问题，
 * 但「1 天前」在某些引擎上会退化）。更重要的是我们需要
 * 「刚刚」这个区间，而 Intl 没有。
 *
 * 实现只有十几行，且完全可控、可测试。
 */

import { t } from "@/strings";

/** 一分钟的毫秒数。 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 把时间戳格式化成相对时间。
 *
 * `now` 参数可注入：测试需要固定"现在"才能断言结果，
 * 否则用例会在不同时间点跑出不同答案。
 */
export function formatRelativeTime(
  iso: string,
  now: number = Date.now(),
): string {
  const at = Date.parse(iso);
  // 解析失败（后端给了非法时间串）时不要显示 NaN，退回空串
  if (!Number.isFinite(at)) return "";

  const diff = now - at;

  // 未来时间：时钟不同步或云盘改了时间戳。显示"刚刚"比"-3 天前"合理
  if (diff < MINUTE) return t("time.justNow");
  if (diff < HOUR)
    return t("time.minutesAgo", { count: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t("time.hoursAgo", { count: Math.floor(diff / HOUR) });
  return t("time.daysAgo", { count: Math.floor(diff / DAY) });
}

/**
 * 格式化成绝对时间，用于 title 提示。
 *
 * 手写而不是用 `toLocaleString`：不同平台/地区的输出差异很大
 * （有的给「2026/9/22 14:30:00」有的给「22/09/2026」），
 * 而写作软件的时间显示应当稳定可预期。
 *
 * ## 时区语义
 *
 * 刻意使用 getHours() / getMonth() 等**本地时区** getter，输出的是
 * 「用户所在时区的时刻」。理由：这是文件修改时间一类的信息，用户预期
 * 与系统状态栏、文件管理器显示的一致；转成 UTC 反而会让用户怀疑。
 *
 * 代价是输出随运行环境时区变化，因此调用方与测试都不应硬编码某一时区
 * 的时刻 —— 传入带偏移量的 ISO 串时，不要期望原样回显其中的时分。
 */
export function formatAbsoluteTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
