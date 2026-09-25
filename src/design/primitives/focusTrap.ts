/**
 * 焦点陷阱：把 Tab 键的落点限制在某个容器内部。
 *
 * 为什么不是「Tab 到末尾就 wrap，Shift+Tab 到开头也 wrap」就够：真实的弹层里
 * 常常同时存在 disabled、\`tabindex="-1"\`、以及被 CSS 隐藏但仍留在 DOM 里的元素。
 * 直接用 \`querySelectorAll("button, a, input")\` 会把不可聚焦的节点也算进去，
 * 于是「最后一个可聚焦元素」判断错误，焦点会跑到弹层外面。
 * 这里统一用可聚焦性判定函数过滤，保证 Tab 循环与视觉顺序一致。
 */

/** 天然可聚焦的标签集合（不依赖 tabindex 就能收到焦点）。 */
const NATURALLY_FOCUSABLE = new Set([
  "A",
  "AREA",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "SUMMARY",
  "AUDIO",
  "VIDEO",
]);

/** 可聚焦元素选择器：用于快速预筛，真正的判定交给 {@link isFocusable}。 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");

/**
 * 判断元素当前是否可以被 Tab 聚焦。
 *
 * jsdom 没有布局引擎，\`getClientRects()\` 恒为空数组，所以不能用「零尺寸即隐藏」
 * 这类依赖布局的判定，否则测试环境里所有元素都会被判成不可聚焦。
 * 这里退而求其次只看属性与显式样式，真实浏览器里的隐藏元素绝大多数也带
 * \`hidden\` / \`display:none\` / \`visibility:hidden\`，判定结果一致。
 */
export function isFocusable(element: Element | null | undefined): element is HTMLElement {
  if (!element || !(element instanceof HTMLElement)) return false;

  // disabled 与 inert 是硬性屏蔽，优先判断。
  if ((element as HTMLInputElement).disabled) return false;
  if (element.closest("[inert]")) return false;
  // 祖先带 hidden 属性的（例如 <fieldset hidden> 或关闭的 <details>）同样不可聚焦。
  if (element.closest("[hidden]")) return false;

  // 显式 tabindex 的优先级最高：它既能赋予普通 div 可聚焦性，
  // 也能把原生按钮移出 Tab 序（tabindex="-1"）。
  const tabindexAttr = element.getAttribute("tabindex");
  if (tabindexAttr !== null) {
    const parsed = Number.parseInt(tabindexAttr, 10);
    // 属性值非法（例如 tabindex="abc"）时按「回到标签默认行为」处理，与浏览器一致。
    if (Number.isNaN(parsed)) return isNaturallyFocusable(element);
    return parsed >= 0;
  }

  return isNaturallyFocusable(element);
}

/** 元素是否凭标签本身就进入 Tab 序（不带 tabindex 时的默认行为）。 */
function isNaturallyFocusable(element: HTMLElement): boolean {
  if (NATURALLY_FOCUSABLE.has(element.tagName)) {
    // type="hidden" 的 input 不会被渲染，自然也不可聚焦。
    if (element.tagName === "INPUT" && element.getAttribute("type") === "hidden") return false;
    return true;
  }
  // contenteditable 是「可编辑区域」，对键盘用户等价于一个输入控件。
  return element.isContentEditable;
}

/** 取容器内按 DOM 顺序排列的所有可 Tab 聚焦元素。 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return candidates.filter((element) => isFocusable(element));
}

/** 焦点陷阱的清理函数。 */
export type FocusTrapCleanup = () => void;

/** {@link focusTrap} 的可选行为。 */
export interface FocusTrapOptions {
  /** 是否把焦点移到容器内第一个可聚焦元素。默认 true。 */
  autoFocus?: boolean;
  /** 初始聚焦的目标；返回 null 时回退到第一个可聚焦元素。 */
  initialFocus?: () => HTMLElement | null;
  /** 陷阱解除时是否把焦点还给打开前的元素。默认 true，键盘用户依赖这一点才不会丢失位置。 */
  restoreFocus?: boolean;
  /** 容器内没有可聚焦元素时，是否把焦点放在容器本身（需要容器带 tabindex="-1"）。默认 true。 */
  focusContainer?: boolean;
}

/** 判断某个节点是否在容器内（含容器自身）。 */
function isInside(container: HTMLElement, node: EventTarget | null): boolean {
  return node instanceof Node && container.contains(node);
}

/**
 * 在 \`container\` 上启用焦点陷阱。
 *
 * 实现要点：
 * - 监听的是 \`document\` 上的 \`keydown\`（捕获阶段），因为焦点可能已经跑出容器，
 *   挂在容器上就收不到那次按键了。
 * - 同时监听 \`focusin\`：鼠标点击弹层外的区域、或代码调用 \`focus()\` 时，
 *   Tab 逻辑帮不上忙，必须把焦点「拉回来」。
 * - Esc 不在这里处理：关闭弹层是组件语义，不是陷阱语义，混在一起会让
 *   「非模态但需要焦点循环」的场景被迫接受 Esc 行为。
 *
 * @returns 解除陷阱的函数；调用后监听全部移除、焦点归还。
 */
export function focusTrap(container: HTMLElement, options: FocusTrapOptions = {}): FocusTrapCleanup {
  const { autoFocus = true, initialFocus, restoreFocus = true, focusContainer = true } = options;
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  /** 把焦点移回容器内部；没有可聚焦元素时退到容器本身。 */
  const pullFocusIn = (): void => {
    const focusables = getFocusableElements(container);
    const fallback = focusables[0];
    if (fallback) {
      fallback.focus();
      return;
    }
    if (focusContainer) container.focus();
  };

  if (autoFocus) {
    const preferred = initialFocus?.() ?? null;
    if (preferred && container.contains(preferred)) {
      preferred.focus();
    } else {
      pullFocusIn();
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    const focusables = getFocusableElements(container);
    // 容器内没有可聚焦元素：把焦点扣在容器上，避免 Tab 逃逸到背景内容。
    if (focusables.length === 0) {
      event.preventDefault();
      if (focusContainer) container.focus();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;

    const active = document.activeElement;
    if (event.shiftKey) {
      // Shift+Tab：焦点在首元素（或已经跑出容器）时绕回末尾。
      if (active === first || !isInside(container, active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    // Tab：焦点在末元素（或已跑出容器）时绕回开头。
    if (active === last || !isInside(container, active)) {
      event.preventDefault();
      first.focus();
    }
  };

  const onFocusIn = (event: FocusEvent): void => {
    if (isInside(container, event.target)) return;
    // 焦点跑到容器外：立刻拉回来。用 preventScroll 避免页面被滚到弹层顶部。
    pullFocusIn();
  };

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn, true);

  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    if (restoreFocus && previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };
}
