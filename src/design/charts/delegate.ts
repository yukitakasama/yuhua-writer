/**
 * 事件委托辅助（计划书 10.5）
 *
 * 年热力图有 365 格。若每格绑一个监听器，仅监听器本身就要占用
 * 数百个闭包与对应的内部对象，且每次重渲染都会重新绑定，
 * 直接违反「M8：打开统计页内存增幅 ≤ 8MB」。
 *
 * 因此这里只提供「整张 SVG 绑一个监听器」的实现：
 * 事件冒泡到容器后，通过 data-* 属性反查出真实命中的格子。
 */

/** 一次委托命中的结果。 */
export interface DelegatedHit {
  /** 被命中的元素（带 data 属性的那个）。 */
  readonly target: Element;
  /** 该元素的 data-index 值，未设置时为 null。 */
  readonly index: number | null;
  /** 该元素的 data-value 值，未设置时为 null。 */
  readonly value: number | null;
  /** 该元素的 data-date 值，未设置时为 null。 */
  readonly date: string | null;
  /** 指针相对容器左上角的坐标。 */
  readonly offsetX: number;
  readonly offsetY: number;
}

/** 委托处理函数。 */
export type DelegatedHandler = (hit: DelegatedHit) => void;

/** 需要监听的事件与对应处理器的映射。 */
export type DelegatedHandlers = Partial<
  Record<
    | "pointerover"
    | "pointerout"
    | "pointermove"
    | "click"
    | "focusin"
    | "keydown",
    DelegatedHandler
  >
>;

/**
 * 从事件目标向上找到最近的带 data-index 的元素。
 *
 * 为什么需要向上查找：命中点可能是 <rect>，也可能是它内部的
 * 其他元素（将来加盲文纹理时会插入子节点），因此不能假设 event.target 就是格子本身。
 *
 * @param start 事件目标
 * @param boundary 查找边界容器，查到它为止
 * @returns 命中的元素，找不到返回 null
 */
export function findCell(
  start: EventTarget | null,
  boundary: Element,
): Element | null {
  let node: Element | null = start instanceof Element ? start : null;
  while (node) {
    if (node === boundary) return null;
    if (node instanceof HTMLElement && node.dataset["index"] !== undefined)
      return node;
    node = node.parentElement;
  }
  return null;
}

/** 解析数值型 data 属性，缺失或非法时返回 null。 */
function toNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把处理器挂到容器上（单次绑定，覆盖全部格子）。
 *
 * @param container 网格容器（通常是一个 <svg> 或 <g>）
 * @param handlers 事件名到处理器的映射
 * @returns 解绑函数，调用后移除全部监听器
 */
export function delegateEvents(
  container: Element,
  handlers: DelegatedHandlers,
): () => void {
  const bound: { type: string; listener: EventListener }[] = [];

  for (const [type, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    const listener: EventListener = (event: Event) => {
      const cell = findCell(event.target, container);
      if (!cell) return;
      const el = cell as HTMLElement;
      const rect = container.getBoundingClientRect();
      const pointer = event as MouseEvent;
      handler({
        target: cell,
        index:
          el.dataset["index"] === undefined
            ? null
            : Number(el.dataset["index"]),
        value: toNumber(el.dataset["value"]),
        date: el.dataset["date"] ?? null,
        offsetX:
          typeof pointer.clientX === "number" ? pointer.clientX - rect.left : 0,
        offsetY:
          typeof pointer.clientY === "number" ? pointer.clientY - rect.top : 0,
      });
    };
    container.addEventListener(type, listener);
    bound.push({ type, listener });
  }

  return () => {
    for (const { type, listener } of bound) {
      container.removeEventListener(type, listener);
    }
    bound.length = 0;
  };
}

/**
 * 生成格子需要的 data 属性集合。
 *
 * 集中在一处生成，避免渲染代码里散落着拼错的属性名——
 * 属性名写错不会报错，只会静默地让浮层显示不出数据。
 *
 * @param index 格子下标
 * @param date 日期键 YYYY-MM-DD
 * @param value 当日字数
 * @returns 可直接展开到 JSX 的 data 属性对象
 */
export function cellDataAttrs(
  index: number,
  date: string,
  value: number,
): Record<string, string> {
  return {
    "data-index": String(index),
    "data-date": date,
    "data-value": String(value),
  };
}

/**
 * 找出鼠标悬停时应高亮的「同行同列」格子下标。
 *
 * 热力图上悬停单格时，十字高亮能帮助用户快速定位到星期与周次，
 * 否则 365 格里很容易看错行。
 *
 * @param index 当前格下标
 * @param weeks 周数，默认 53
 * @returns 同行与同列的格子下标数组（不含自身）
 */
export function crossHighlight(index: number, weeks = 53): number[] {
  if (index < 0 || index >= weeks * 7) return [];
  const week = Math.floor(index / 7);
  const weekday = index % 7;
  const result: number[] = [];
  for (let d = 0; d < 7; d += 1) {
    const i = week * 7 + d;
    if (i !== index) result.push(i);
  }
  for (let w = 0; w < weeks; w += 1) {
    const i = w * 7 + weekday;
    if (i !== index) result.push(i);
  }
  return result;
}
