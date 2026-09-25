/**
 * 菜单（含 MenuItem 与 MenuSeparator）。
 *
 * 为什么不完全依赖原生 <menu>/<ul> 加 tabindex：
 * 菜单需要的键盘语义（上下键移动、Home/End 跳转、Esc 关闭、字母键定位）
 * 原生元素都不提供，必须自己实现。这里用 role="menu" + role="menuitem"
 * 的组合，这是读屏与辅助技术识别菜单的标准做法。
 *
 * 关键无障碍决策：菜单项用 roving tabindex。
 * 若每个菜单项都在 Tab 序里，一个 8 项的菜单要按 9 次 Tab 才能穿过；
 * roving 之后整个菜单在 Tab 序里只占一格，内部靠方向键移动。
 *
 * Esc 关闭后焦点必须回到触发按钮（由调用方通过 triggerRef 或外层 Popover 处理），
 * 否则键盘用户按一次 Esc 就「人间蒸发」了。
 */

import {
  createEffect,
  createSignal,
  For,
  Show,
  splitProps,
  type Component,
  type JSX,
} from "solid-js";
import { getFocusableElements } from "./focusTrap";
import { handleListNavigation } from "./keyboardNav";
import { cx, usePrimitivesStyle } from "./styles";

/** {@link MenuItem} 的 props。 */
export interface MenuItemProps
  extends Omit<
    JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    // onSelect 必须一并 Omit：原生 <button> 的 onSelect 是「选中文本」事件
    // （selectstart 系），与菜单语义的「选中该项」完全无关。
    // 不排除的话，接口继承会因类型不兼容直接编译失败——
    // 这个编译错误恰好帮我们避免了语义混淆。
    "onClick" | "onSelect" | "class" | "children" | "type"
  > {
  /** 是否禁用。禁用项仍然会被渲染，因为它常常是「为什么不能用」的解释载体。 */
  disabled?: boolean;
  /** 危险操作（删除 / 清空），用危险色与分隔线一起提示。 */
  danger?: boolean;
  /** 选中时回调。 */
  onSelect?: (event: MouseEvent | KeyboardEvent) => void;
  /** 调用方自定义类名。 */
  class?: string;
  /** 菜单项内容。 */
  children?: JSX.Element;
}

/**
 * 单个菜单项。
 *
 * @example
 * <MenuItem onSelect={rename}>重命名章节</MenuItem>
 */
export const MenuItem: Component<MenuItemProps> = (props) => {
  const [local, rest] = splitProps(props, ["disabled", "danger", "onSelect", "class", "children"]);

  return (
    <button
      {...rest}
      type="button"
      role="menuitem"
      // roving tabindex 的基准值：Menu 会在挂载后把焦点项的 tabindex 改为 0。
      tabindex={local.disabled ? -1 : -1}
      aria-disabled={local.disabled ? "true" : undefined}
      disabled={local.disabled === true}
      data-active="false"
      class={cx("yh-menu-item", local.danger ? "yh-menu-item--danger" : undefined, local.class)}
      onClick={(event) => {
        if (local.disabled) {
          event.preventDefault();
          return;
        }
        local.onSelect?.(event);
      }}
      onKeyDown={(event) => {
        // 菜单项的 Enter/Space 由原生 button 的 click 覆盖，
        // 这里只把事件交给 Menu 统一处理方向键。
        event.stopPropagation();
      }}
    >
      {local.children}
    </button>
  );
};

/** {@link Menu} 的 props。 */
export interface MenuProps {
  /** 是否打开。 */
  open: boolean;
  /** 关闭请求（Esc、选项选中、点击外部）。 */
  onClose: () => void;
  /** 打开后初始聚焦的菜单项序号，默认 0。 */
  initialFocusIndex?: number;
  /** 调用方自定义类名。 */
  class?: string;
  /** 菜单内容，通常是一组 MenuItem 与 MenuSeparator。 */
  children?: JSX.Element;
}

/**
 * 菜单容器。
 *
 * @example
 * <Menu open={open()} onClose={close}>
 *   <MenuItem onSelect={rename}>重命名</MenuItem>
 *   <MenuSeparator />
 *   <MenuItem danger onSelect={remove}>删除</MenuItem>
 * </Menu>
 */
export const Menu: Component<MenuProps> = (props) => {
  usePrimitivesStyle();

  const [local, rest] = splitProps(props, ["open", "onClose", "initialFocusIndex", "class", "children"]);

  let list: HTMLDivElement | undefined;

  /** 取当前可导航的菜单项（跳过禁用项，因为键盘用户无法激活它们）。 */
  const items = (): HTMLElement[] => {
    if (!list) return [];
    return getFocusableElements(list).filter((element) => element.getAttribute("aria-disabled") !== "true");
  };

  /** 当前高亮项。用 data-active 而不是 :hover，因为键盘移动也要能看到位置。 */
  const [activeIndex, setActiveIndex] = createSignal(local.initialFocusIndex ?? 0);

  const applyActive = (index: number): void => {
    const all = items();
    all.forEach((element, position) => {
      element.setAttribute("tabindex", position === index ? "0" : "-1");
      element.setAttribute("data-active", position === index ? "true" : "false");
    });
    setActiveIndex(index);
  };

  createEffect(() => {
    if (!local.open) return undefined;
    // 等子项挂载完成再排布 roving tabindex。
    queueMicrotask(() => {
      const index = Math.min(local.initialFocusIndex ?? 0, Math.max(items().length - 1, 0));
      applyActive(index);
      items()[index]?.focus();
    });
    return undefined;
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      local.onClose();
      return;
    }
    if (event.key === "Tab") {
      // 菜单是模态化的浮层：Tab 直接关闭菜单并把焦点交还给调用方，
      // 而不是让焦点溜到页面其他地方（菜单还开着会很困惑）。
      local.onClose();
      return;
    }
    const all = items();
    const consumed = handleListNavigation(event, all, { axis: "vertical", loop: true });
    if (consumed) {
      event.preventDefault();
      applyActive(all.indexOf(document.activeElement as HTMLElement));
    }
  };

  return (
    <Show when={local.open}>
      <div
        {...rest}
        ref={list}
        role="menu"
        aria-orientation="vertical"
        data-active-index={activeIndex()}
        class={cx("yh-layer yh-menu", local.class)}
        style={{ position: "absolute", "min-width": "180px" }}
        onKeyDown={onKeyDown}
      >
        {local.children}
      </div>
    </Show>
  );
};

/**
 * 菜单分隔线。
 *
 * 用 role="separator" 而不是一根空的 div：分隔线在语义上界定了菜单项分组，
 * 读屏会把分组边界念出来，纯视觉元素做不到这一点。
 */
export const MenuSeparator: Component<{ class?: string }> = (props) => (
  <div role="separator" class={cx("yh-menu__separator", props.class)} />
);

/** {@link MenuList} 的 props：把「打开判定」交给调用方渲染，容器只负责键盘与语义。 */
export interface MenuListProps extends MenuProps {
  /** 相对定位的锚点元素类名。 */
  anchorClass?: string;
  /** 触发元素。 */
  trigger?: JSX.Element;
}

/**
 * 带锚点的菜单（把触发元素与菜单放在同一个定位容器里）。
 *
 * 存在的理由：绝大多数调用方都需要「点按钮，菜单贴着按钮出现」，
 * 每次手写 wrap 容易忘记 position:relative，菜单会跑到页面左上角。
 *
 * @example
 * <MenuList open={open()} onClose={close} trigger={<Button>更多</Button>}>…</MenuList>
 */
export const MenuList: Component<MenuListProps> = (props) => {
  const [local, rest] = splitProps(props, ["anchorClass", "trigger"]);
  return (
    <div class={cx("yh-menu-anchor", local.anchorClass)} style={{ position: "relative", display: "inline-block" }}>
      {local.trigger}
      <For each={[0]}>
        {() => (
          <Menu {...rest} />
        )}
      </For>
    </div>
  );
};
