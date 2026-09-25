/**
 * localStorage 的带类型读写。
 *
 * ## 为什么必须包一层 try/catch
 *
 * localStorage 有三种会抛异常的常态：
 *
 * 1. **隐私模式 / 禁用了本地存储**：读写都抛
 * 2. **配额写满**：写入抛 `QuotaExceededError`
 * 3. **陈旧数据**：上一次版本写进去的 JSON 结构已经改了，解析出来是错的形状
 *
 * 这三种情况都**不应该让应用崩掉**：窗口宽度记不住不是致命错误。
 * 因此读取失败一律回退到默认值，写入失败静默忽略（但留一个可控的日志钩子）。
 */

/** 键名前缀。加前缀避免与同域名下的其它页面撞车。 */
const PREFIX = "yuhua.";

/** 读取一个 JSON 值；任何失败都回退到 fallback。 */
export function readJson<T>(key: string, fallback: T, validate?: (value: unknown) => value is T): T {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    if (raw === null || raw === undefined) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (validate && !validate(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** 写入一个 JSON 值；失败静默忽略。 */
export function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 配额满或被禁用：记布局状态不是核心功能，不打扰用户
  }
}

/** 删除一个键。 */
export function removeKey(key: string): void {
  try {
    storage()?.removeItem(PREFIX + key);
  } catch {
    /* 同上 */
  }
}

/**
 * 取 localStorage。
 *
 * 返回 `null` 而不是抛异常：SSR、测试环境（jsdom 之外的纯 node 环境）
 * 都可能没有 `window`，调用方不需要为此写判断。
 */
function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    // 有些环境（Safari 隐私模式）访问 localStorage 本身就会抛
    const s = window.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/** 判定一个值是否为普通对象。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判定一个值是否为有限数字（排除 NaN / Infinity）。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
