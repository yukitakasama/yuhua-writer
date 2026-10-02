/**
 * 侧边抽屉。
 *
 * 与 Dialog 的分工：Dialog 用于「需要用户先回答才能继续」的打断式交互，
 * Drawer 用于「并行的、可以随时忽略」的辅助面板（章节目录、检索结果、设置）。
 * 因此 Drawer 的定位是 fixed 贴边而不是居中，宽度固定不随内容变化，
 * 遮罩点击默认关闭（用户随时可以回到正文）。
 *
 * 动效：整体 translateX(100% 到 0)、240ms。比 Dialog 慢，因为位移距离长；
 * 用同样的 180ms 会显得很急。只动 transform，符合 5.4。
 */

import {
  createEffect,
  createSignal,
  createUniqueId,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js";
import { ModalShell } from "./Modal";
import { cx } from "./styles";

/** 抽屉从哪一侧滑出。 */
export type DrawerSide = "left" | "right";

/** {@link Drawer} 的 props。 */
export interface DrawerProps {
  /** 是否打开。 */
  open: boolean;
  /** 关闭请求。 */
  onClose: () => void;
  /** 滑出侧，默认 right。 */
  side?: DrawerSide;
  /** 标题。 */
  title?: JSX.Element;
  /** 宽度（像素），默认 320。 */
  width?: number;
  /** 是否允许 Esc 关闭，默认 true。 */
  closeOnEscape?: boolean;
  /** 是否允许点击遮罩关闭，默认 true。 */
  closeOnOverlayClick?: boolean;
  /** 顶栏右侧的额外操作（例如「全部展开」图标按钮）。 */
  actions?: JSX.Element;
  /** 调用方自定义类名，透传到面板。 */
  class?: string;
  /** 抽屉内容。 */
  children?: JSX.Element;
}

/**
 * 侧边抽屉。
 *
 * @example
 * <Drawer open={open()} onClose={close} title="章节目录">…</Drawer>
 */
export const Drawer: Component<DrawerProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "open",
    "onClose",
    "side",
    "title",
    "width",
    "closeOnEscape",
    "closeOnOverlayClick",
    "actions",
    "class",
    "children",
  ]);

  const titleId = createUniqueId();
  const [mounted, setMounted] = createSignal(local.open);

  createEffect(() => {
    if (local.open) {
      setMounted(true);
      return undefined;
    }
    if (!mounted()) return undefined;
    // 与 CSS 的 --d-slow(240ms) 对齐；若改为读令牌，需保证 CSS 与 TS 同源。
    const timer = window.setTimeout(() => setMounted(false), 240);
    return () => window.clearTimeout(timer);
  });

  const side = (): DrawerSide => local.side ?? "right";

  return (
    <Show when={mounted()}>
      <ModalShell
        {...rest}
        open={local.open}
        onClose={local.onClose}
        closeOnEscape={local.closeOnEscape}
        closeOnOverlayClick={local.closeOnOverlayClick}
        role="dialog"
        labelledBy={local.title ? titleId : undefined}
        panelClass={cx("yh-drawer", "yh-drawer--" + side(), local.class)}
        panelStyle={{ "--yh-drawer-size": (local.width ?? 320) + "px" }}
      >
        <Show when={local.title || local.actions}>
          <header class="yh-drawer__header">
            <Show when={local.title}>
              <h2 class="yh-drawer__title" id={titleId}>
                {local.title}
              </h2>
            </Show>
            <Show when={local.actions}>
              <div style={{ display: "inline-flex", gap: "var(--sp-1, 4px)" }}>
                {local.actions}
              </div>
            </Show>
          </header>
        </Show>
        <div class="yh-drawer__body">{local.children}</div>
      </ModalShell>
    </Show>
  );
};
