/**
 * 轻提示（含队列与全局 store）。
 *
 * 为什么自带一个模块级 store 而不是强制调用方自己传数组：
 * 「保存成功」「已复制」这类提示会从代码的任何角落触发（保存逻辑、快捷键处理、
 * 剪贴板工具），让每个调用点都拿得到 Provider 的 context 是很大的负担。
 * 这里提供一个模块级 store，配合 <ToastRegion> 挂在应用根部即可。
 * 组件本身仍然可以完全受控使用（直接传 items），便于测试与嵌进独立面板。
 *
 * 队列规则：
 * - 最多同时展示 3 条。超过时丢掉最旧的一条；提示是「顺带看一眼」的信息，
 *   堆满屏幕会挡住正文，反而违背写作软件「内容优先」的原则。
 * - 相同 id 重复 push 视为更新而不是新增，避免「保存中」和「已保存」叠成两条。
 *
 * 动效遵循 5.5：translateY 加 opacity，180ms 弹簧曲线。
 * 降级环境下只保留透明度变化（5.6）。
 */

import { createSignal, For, Show, splitProps, type Component } from "solid-js";
import { motionPolicy } from "./reducedMotion";
import { cx, usePrimitivesStyle } from "./styles";

/** 提示的语气。 */
export type ToastTone = "info" | "success" | "warning" | "error";

/** 一条提示。 */
export interface ToastItem {
  /** 唯一 id。重复 id 视为更新已有提示。 */
  id: string;
  /** 主文案。 */
  title: string;
  /** 补充说明，可选。 */
  description?: string;
  /** 语气，默认 info。 */
  tone?: ToastTone;
  /** 自动关闭毫秒数。传 0 表示不自动关闭。默认 4000。 */
  duration?: number;
  /** 操作按钮文案，例如「撤销」。 */
  actionLabel?: string;
  /** 操作回调。点击后提示立即关闭。 */
  onAction?: () => void;
}

/** 队列上限。超过时丢弃最旧的一条。 */
const MAX_VISIBLE = 3;

/** 默认停留时长。4 秒足够读完一行中文，又不至于挡住视线太久。 */
const DEFAULT_DURATION = 4000;

// ---- 模块级 store ----

const [items, setItems] = createSignal<ToastItem[]>([]);
const timers = new Map<string, number>();

/** 清理某个提示的自动关闭定时器。 */
function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
}

/** 立即移除一条提示。 */
export function dismissToast(id: string): void {
  clearTimer(id);
  setItems((current) => current.filter((item) => item.id !== id));
}

/** 移除全部提示（例如切换书籍时清理上一本的残留）。 */
export function clearToasts(): void {
  for (const id of timers.keys()) window.clearTimeout(timers.get(id));
  timers.clear();
  setItems([]);
}

/** 当前队列（只读）。 */
export function toasts(): readonly ToastItem[] {
  return items();
}

/** 推送或更新一条提示，返回 id。 */
export function pushToast(item: ToastItem): string {
  const duration = item.duration ?? DEFAULT_DURATION;
  setItems((current) => {
    const withoutSame = current.filter((existing) => existing.id !== item.id);
    const next = [...withoutSame, item];
    // 超限时丢弃最旧的几条，并一并清掉它们的定时器，否则定时器仍会触发一次无意义的 setState。
    if (next.length > MAX_VISIBLE) {
      const dropped = next.slice(0, next.length - MAX_VISIBLE);
      for (const toast of dropped) clearTimer(toast.id);
      return next.slice(next.length - MAX_VISIBLE);
    }
    return next;
  });

  clearTimer(item.id);
  if (duration > 0) {
    // 用 window.setTimeout 而不是 Solid 的 createEffect + 清理：
    // 提示的生命周期与任何组件实例都无关，跟着组件走会在中途卸载时被误杀。
    timers.set(
      item.id,
      window.setTimeout(() => dismissToast(item.id), duration),
    );
  }
  return item.id;
}

/** 快捷方法集合，覆盖最常见四种场景。 */
export const toast = {
  info: (title: string, description?: string): string =>
    pushToast({ id: cryptoId(), title, description, tone: "info" }),
  success: (title: string, description?: string): string =>
    pushToast({ id: cryptoId(), title, description, tone: "success" }),
  warning: (title: string, description?: string): string =>
    pushToast({ id: cryptoId(), title, description, tone: "warning" }),
  error: (title: string, description?: string): string =>
    pushToast({ id: cryptoId(), title, description, tone: "error" }),
};

/** 生成提示 id。优先用 crypto.randomUUID，测试环境没有则退化为计数器。 */
let fallbackCounter = 0;
function cryptoId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  fallbackCounter += 1;
  return "toast-" + fallbackCounter;
}

// ---- 组件 ----

/** 提示锚点位置。默认右下角，远离正文主要视觉动线。 */
export type ToastPlacement = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** {@link Toast} 的 props。 */
export interface ToastProps {
  /** 提示数据。 */
  item: ToastItem;
  /** 关闭回调。 */
  onClose: (id: string) => void;
  /** 调用方自定义类名。 */
  class?: string;
}

/** 单条提示。 */
export const Toast: Component<ToastProps> = (props) => {
  const [local] = splitProps(props, ["item", "onClose", "class"]);

  return (
    <div
      class={cx("yh-toast", "yh-toast--" + (local.item.tone ?? "info"), local.class)}
      data-state="open"
      data-toast-id={local.item.id}
      style={{
        "transition-duration": motionPolicy({ duration: 180 }).duration + "ms",
      }}
      role="status"
      aria-live="polite"
    >
      <div class="yh-toast__body">
        <div class="yh-toast__title">{local.item.title}</div>
        <Show when={local.item.description}>
          <div class="yh-toast__desc">{local.item.description}</div>
        </Show>
      </div>
      <Show when={local.item.actionLabel}>
        <button
          type="button"
          class="yh-toast__action"
          onClick={() => {
            local.item.onAction?.();
            local.onClose(local.item.id);
          }}
        >
          {local.item.actionLabel}
        </button>
      </Show>
      {/* 关闭按钮用文本「关闭」而不是叉形图标：托盘里的极小按钮不适合再塞图标，
          且中文界面上文字比图形更快被识别。 */}
      <button
        type="button"
        class="yh-toast__action"
        aria-label="关闭提示"
        onClick={() => local.onClose(local.item.id)}
      >
        关闭
      </button>
    </div>
  );
};

/** {@link ToastRegion} 的 props。 */
export interface ToastRegionProps {
  /** 位置，默认 bottom-right。 */
  placement?: ToastPlacement;
  /** 受控数据源。不传则使用模块级 store。 */
  items?: readonly ToastItem[];
  /** 关闭回调。不传则调用模块级的 dismissToast。 */
  onClose?: (id: string) => void;
  /** 调用方自定义类名。 */
  class?: string;
}

/**
 * 提示托盘。挂在应用根部一次即可。
 *
 * aria-live 放在托盘而不是每条提示上：托盘作为稳定的容器常驻 DOM，
 * 读屏对「容器内容变化」的播报比「容器本身被插入」更可靠。
 *
 * @example
 * // 应用根部
 * <ToastRegion />
 * // 任意位置
 * toast.success("已保存");
 */
export const ToastRegion: Component<ToastRegionProps> = (props) => {
  usePrimitivesStyle();

  const [local] = splitProps(props, ["placement", "items", "onClose", "class"]);

  // 受控与自持两种模式：local.items 为 undefined 时读模块级 store。
  const source = (): readonly ToastItem[] => local.items ?? toasts();

  return (
    <div
      class={cx("yh-toast-region", "yh-toast-region--" + (local.placement ?? "bottom-right"), local.class)}
      aria-live="polite"
      aria-label="通知"
    >
      <For each={source().slice()}>{(item) => <Toast item={item} onClose={local.onClose ?? dismissToast} />}</For>
    </div>
  );
};

/** 供测试与调试使用：重置模块级队列和定时器。 */
export function resetToastStore(): void {
  clearToasts();
  fallbackCounter = 0;
}
