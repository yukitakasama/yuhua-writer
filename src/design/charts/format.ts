/**
 * 数字与日期格式化（计划书 10.5）
 *
 * 「统计数字变化」是高频动效场景（字数每保存一次就跳一次）。
 * 若数字宽度不定，跳动会让整行文字左右抖动——
 * 因此这里所有输出都配合 `font-variant-numeric: tabular-nums` 使用（见 tokens.css 的 .yh-num）。
 */

/** 千分位分隔符使用半角逗号：中文排版下比空格更紧凑，也不易与字距混淆。 */
const GROUP_SEPARATOR = ",";

/**
 * 整数千分位格式化。
 *
 * 手写而不是用 Intl.NumberFormat：Intl 在首次调用时要构建 locale 数据，
 * 统计页有几十个数字，批量创建 formatter 实例的开销明显。
 *
 * @param value 数值，非有限数按 0 处理
 * @returns 带千分位的字符串
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const negative = value < 0;
  const digits = Math.abs(Math.round(value)).toString();
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += GROUP_SEPARATOR;
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

/**
 * 大数缩写：用于概览卡片这类空间有限的位置。
 *
 * @param value 数值
 * @returns 例如 1.2 万 / 35.6 万 / 120
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${trimZero(value / 100_000_000)} 亿`;
  if (abs >= 10_000) return `${trimZero(value / 10_000)} 万`;
  return formatNumber(value);
}

/** 保留一位小数，整数时不显示 .0。 */
function trimZero(n: number): string {
  const fixed = Math.round(n * 10) / 10;
  return Number.isInteger(fixed) ? String(fixed) : fixed.toFixed(1);
}

/**
 * 把分钟数格式化为「X 小时 Y 分钟」。
 *
 * 不足 1 分钟时显示「不到 1 分钟」而不是「0 分钟」，
 * 避免用户以为统计坏了。
 *
 * @param minutes 分钟数
 * @returns 中文时长描述
 */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 分钟";
  const total = Math.round(minutes);
  if (total < 1) return "不到 1 分钟";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}

/**
 * 把百分比格式化为带一位小数的字符串。
 *
 * @param progress 0..1 的进度，超出范围会被夹紧
 * @returns 例如 42.5%
 */
export function formatPercent(progress: number): string {
  const clamped = Math.min(Math.max(Number.isFinite(progress) ? progress : 0, 0), 1);
  return `${(clamped * 100).toFixed(1)}%`;
}

/**
 * ES 星期名，索引 0 为周一。
 * 手写数组而不是 Intl：与热力图的行顺序（周一开头）绑定，避免区域设置差异。
 */
const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"] as const;

/**
 * 取星期的中文短名。
 *
 * @param weekday 0..6，0 为周一
 * @returns 例如「周一」；越界返回空字符串
 */
export function weekdayLabel(weekday: number): string {
  const name = WEEKDAY_NAMES[weekday];
  return name ? `周${name}` : "";
}

/**
 * 把日期键转为「2026 年 1 月 5 日」。
 *
 * @param dateKey YYYY-MM-DD
 * @returns 中文日期；格式不符时原样返回
 */
export function formatDateLabel(dateKey: string): string {
  const parts = dateKey.split("-");
  if (parts.length !== 3) return dateKey;
  const [y, m, d] = parts;
  if (!y || !m || !d) return dateKey;
  const month = Number(m);
  const day = Number(d);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return dateKey;
  return `${Number(y)} 年 ${month} 月 ${day} 日`;
}

/**
 * 数字滚动的插值序列，供「字数变化」动效使用。
 *
 * 返回的是中间值数组而不是逐帧回调：逐帧回调会强制每帧写 DOM，
 * 而这里可以让调用方用一次 RAF 批量更新，或者干脆只显示终值。
 *
 * @param from 起始值
 * @param to 结束值
 * @param steps 分段数，默认 8
 * @returns 从 from 到 to 的整数序列（含两端）
 */
export function rollSequence(from: number, to: number, steps = 8): number[] {
  const n = Math.max(Math.floor(steps), 1);
  const out: number[] = [];
  for (let i = 0; i <= n; i += 1) {
    out.push(Math.round(from + ((to - from) * i) / n));
  }
  return out;
}
