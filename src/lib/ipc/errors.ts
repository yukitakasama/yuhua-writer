/**
 * 错误归一化。
 *
 * ## 为什么必须做归一化
 *
 * Tauri 的 `invoke` 在命令返回 `Err` 时会 **reject 一个普通值**，
 * 而不是抛 `Error` 实例。这个值的形状取决于命令层怎么写 Serialize：
 *
 * - 我们的命令层返回 `{ code, message, recoverable, detail }` 对象
 * - 但如果参数反序列化就失败了，Tauri 会 reject 一个**字符串**
 * - 网络/桥接层出错时还可能 reject `Error` 实例
 *
 * 调用方如果直接 `catch (e) { e.message }` 就会拿到 `undefined`，
 * 于是界面上出现空白的错误提示。所以统一在边界处转成 {@link IpcError}。
 */

import { ERROR_CODES, type IpcError } from "./types";

/** 把任意 reject 值转成统一的 {@link IpcError}。 */
export function normalizeError(raw: unknown): IpcError {
  if (isIpcError(raw)) return raw;

  // 带结构化 error 字段的 Error 子类（例如 mock 后端的 MockError）：
  // 它跨越了"抛出"这个边界，因此和 Tauri 的 reject 值一样需要被识别。
  // 如果不先检查这里，mock 的错误码就会全部退化成 INTERNAL，
  // 界面上就无法按 code 分支给出针对性的提示。
  if (raw instanceof Error && "error" in raw && isIpcError((raw as { error: unknown }).error)) {
    return (raw as unknown as { error: IpcError }).error;
  }

  // Tauri 桥接层自己抛的错误是 Error 实例
  if (raw instanceof Error) {
    return {
      code: ERROR_CODES.internal,
      message: raw.message || "未知错误",
      recoverable: false,
      detail: raw.stack ?? null,
    };
  }

  // 参数反序列化失败时，Tauri 直接 reject 一个人类可读字符串
  if (typeof raw === "string") {
    return {
      code: ERROR_CODES.internal,
      message: raw,
      recoverable: false,
      detail: null,
    };
  }

  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const code = typeof obj["code"] === "string" ? obj["code"] : ERROR_CODES.internal;
    const message = typeof obj["message"] === "string" ? obj["message"] : "未知错误";
    const recoverable = obj["recoverable"] === true;
    const detail = typeof obj["detail"] === "string" ? obj["detail"] : null;
    return { code, message, recoverable, detail };
  }

  return {
    code: ERROR_CODES.internal,
    message: "未知错误",
    recoverable: false,
    detail: null,
  };
}

/** 判定一个值是否已经是完整的 {@link IpcError} 形状。 */
export function isIpcError(value: unknown): value is IpcError {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v["code"] === "string" && typeof v["message"] === "string" && typeof v["recoverable"] === "boolean";
}

/**
 * 承载 {@link IpcError} 的异常类型。
 *
 * 为什么要包一层 `Error`：`try/catch` 里 `throw` 非 Error 值会让
 * 调试器断点与堆栈丢失。保留 `error` 字段给调用方按 code 分支。
 */
export class IpcFailure extends Error {
  /** 结构化的错误信息。 */
  readonly error: IpcError;

  constructor(error: IpcError) {
    super(error.message);
    this.name = "IpcFailure";
    this.error = error;
  }

  /** 稳定的机器可读错误码。 */
  get code(): string {
    return this.error.code;
  }

  /** 用户是否可以重试。 */
  get recoverable(): boolean {
    return this.error.recoverable;
  }
}

/** 把任意异常包装成 {@link IpcFailure}。 */
export function toFailure(raw: unknown): IpcFailure {
  return raw instanceof IpcFailure ? raw : new IpcFailure(normalizeError(raw));
}
