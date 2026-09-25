/**
 * 面板分隔条。
 *
 * ## 为什么用指针事件 + 直接改 CSS 变量
 *
 * 拖动过程中**每帧都在改宽度**。如果走 Solid 的响应式更新，
 * 每次移动都会触发一次 store 写入与组件重算；虽然 Solid 很便宜，
 * 但这里的更新频率是 120Hz，没必要。
 *
 * 做法：拖动中直接写 `--left-w` / `--right-w` 这两个 CSS 变量，
 * 松手时才把最终值提交进 store（从而触发持久化）。
 * 布局完全由 CSS 变量驱动，中间过程不经过 JS 响应式系统。
 */

import { type JSX } from "solid-js";

import { t } from "@/strings";

/** 分隔条属性。 */
export interface ResizerProps {
  /** 方向：左侧栏的分隔条在右边缘，右栏的在左边缘。 */
  side: "left" | "right";
  /** 取当前宽度。 */
  getWidth: () => number;
  /** 提交新宽度。 */
  setWidth: (width: number) => void;
  /** 宽度上下限。 */
  min: number;
  max: number;
}

/** 一条可拖动的分隔条。 */
export function Resizer(props: ResizerProps): JSX.Element {
  let active = false;
  let startX = 0;
  let startWidth = 0;

  const onMove = (event: PointerEvent): void => {
    if (!active) return;
    // 左侧栏向右拖是变宽，右侧栏向右拖是变窄，方向相反
    const delta = props.side === "left" ? event.clientX - startX : startX - event.clientX;
    const next = Math.round(Math.min(props.max, Math.max(props.min, startWidth + delta)));
    document.documentElement.style.setProperty(props.side === "left" ? "--left-w" : "--right-w", `${next}px`);
  };

  const onUp = (): void => {
    if (!active) return;
    active = false;
    document.body.classList.remove("is-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);

    const raw = document.documentElement.style.getPropertyValue(props.side === "left" ? "--left-w" : "--right-w");
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) props.setWidth(value);
  };

  return (
    <div
      class={`resizer resizer--${props.side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("a11y.resizer")}
      title={t("a11y.resizer")}
      tabindex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        active = true;
        startX = event.clientX;
        startWidth = props.getWidth();
        // 拖动中禁掉全局文本选择与指针光标跳变
        document.body.classList.add("is-resizing");
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }}
      onKeyDown={(event) => {
        // 键盘可达：方向键微调 16px，Shift 加速到 48px
        const step = event.shiftKey ? 48 : 16;
        const direction = props.side === "left" ? 1 : -1;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          props.setWidth(props.getWidth() - step * direction);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          props.setWidth(props.getWidth() + step * direction);
        }
      }}
    />
  );
}
