/**
 * 树拖拽排序的指针逻辑。
 *
 * ## 为什么用 Pointer Events 而不是 HTML5 drag
 *
 * HTML5 的 `draggable` 有几处硬伤：
 *
 * - **落点指示只能靠 `dragover` 的节流**，在 WebView2 里响应明显滞后
 * - **拖拽影像不可定制**，系统默认的半透明截图与控制感很差
 * - **无法拿到精确坐标语义**，实现"上半插入 / 下半插入"要自己做几何判断
 * - 在 Windows 的 WebView2 里与文本选择、滚动条有已知冲突
 *
 * Pointer Events 用 `setPointerCapture` 拿到连续的指针流，
 * 落点指示可以每帧更新，且不会与原生 drag 机制打架。
 *
 * ## 状态机
 *
 * `idle → armed（按下但未超过阈值）→ dragging → idle`
 *
 * 中间那个 `armed` 状态很重要：如果一按下就进入拖拽，
 * 用户在行上点击选中/展开时只要手抖几个像素就会被当成拖拽。
 * 因此设一个 4px 的启动阈值，超过才真正开始拖。
 */

import { createSignal, onCleanup, type Accessor } from "solid-js";

import { clampIndex, resolveDropIndex } from "./tree-ops";

/** 一行在拖拽计算中需要的几何信息。 */
export interface DragRow {
  /** 行对应的实体 ID。 */
  id: string;
  /** 该行所属的容器（卷）。跨容器拖拽靠它判断落点。 */
  containerId: string;
  /** 元素的视口矩形。 */
  rect: DOMRect;
}

/** 当前拖拽状态。 */
export interface DragState {
  /** 正在被拖动的实体 ID；未拖拽时为 null。 */
  draggedId: string | null;
  /** 指针当前悬停的容器 ID。 */
  overContainerId: string | null;
  /** 将会落入的索引（**移除被拖项之后**的语义，与 tree-ops 一致）。 */
  dropIndex: number;
  /** 指针相对视口的位置，用于绘制跟随元素。 */
  pointer: { x: number; y: number };
  /** 被拖元素的尺寸，用于绘制跟随元素。 */
  size: { width: number; height: number };
}

/** 初始（空闲）状态。 */
const IDLE: DragState = {
  draggedId: null,
  overContainerId: null,
  dropIndex: 0,
  pointer: { x: 0, y: 0 },
  size: { width: 0, height: 0 },
};

/** 启动拖拽所需的位移阈值（px）。 */
const DRAG_THRESHOLD_PX = 4;

/** 拖拽钩子的返回值。 */
export interface DragController {
  /** 当前拖拽状态。 */
  state: Accessor<DragState>;
  /** 是否正在拖拽。 */
  isDragging: Accessor<boolean>;
  /** 在某一行的抓取手柄上按下指针，开始"预备拖拽"。 */
  begin: (event: PointerEvent, row: DragRow) => void;
  /** 供容器注册自身的元素，落点计算需要它的矩形。 */
  registerContainer: (containerId: string, element: HTMLElement | undefined) => void;
  /** 供行注册自身的元素。 */
  registerRow: (rowId: string, containerId: string, element: HTMLElement | undefined) => void;
}

/**
 * 创建一个拖拽控制器。
 *
 * `onDrop` 在用户松手且确实发生了位置变化时调用；
 * 若只是点了一下没拖动，不会触发。
 */
export function createDragController(onDrop: (draggedId: string, containerId: string, index: number) => void): DragController {
  const [state, setState] = createSignal<DragState>(IDLE);

  // 行与容器的元素注册表。用 Map 而不是遍历 DOM 查询：
  // 每帧都要算落点，querySelector 会很贵
  const rows = new Map<string, { containerId: string; el: HTMLElement }>();
  const containers = new Map<string, HTMLElement>();

  /** 预备状态：记录了按下位置，等指针移动超过阈值才真正开始。 */
  let pending: { id: string; startX: number; startY: number; row: DragRow } | null = null;

  /** 采集当前某个容器下的所有行几何。 */
  function collectRows(containerId: string): DragRow[] {
    const out: DragRow[] = [];
    rows.forEach((entry, id) => {
      if (entry.containerId !== containerId) return;
      out.push({ id, containerId, rect: entry.el.getBoundingClientRect() });
    });
    // 按视口纵向位置排序，保证顺序与视觉一致
    out.sort((a, b) => a.rect.top - b.rect.top);
    return out;
  }

  /** 找出指针落在哪一个容器上。 */
  function containerAt(x: number, y: number): string | null {
    let best: string | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    containers.forEach((el, id) => {
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
      // 嵌套容器时取面积最小的那个，也就是最内层的
      const area = r.width * r.height;
      if (area < bestArea) {
        bestArea = area;
        best = id;
      }
    });
    return best;
  }

  /** 根据指针位置重算落点。 */
  function updateDropTarget(x: number, y: number, draggedId: string): void {
    const containerId = containerAt(x, y);
    if (containerId === null) return;
    const list = collectRows(containerId);
    const index = resolveDropIndex(
      list.map((r) => ({ id: r.id, top: r.rect.top, height: r.rect.height })),
      y,
      draggedId,
    );
    setState((prev) => ({
      ...prev,
      overContainerId: containerId,
      // 夹紧一次：最后一行下半部会算出等于行数的值，那是合法的"放到末尾"
      dropIndex: clampIndex(index, list.length),
    }));
  }

  /** 强制采集所有注册元素的位置，触发一次同步布局。 */
  function snapshotRoot(): void {
    document.body.classList.add("is-dragging");
  }

  const onPointerMove = (event: PointerEvent): void => {
    // 预备阶段：先判断是否超过阈值
    if (pending !== null && state().draggedId === null) {
      const dx = event.clientX - pending.startX;
      const dy = event.clientY - pending.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

      const { row } = pending;
      snapshotRoot();
      setState({
        draggedId: row.id,
        overContainerId: row.containerId,
        dropIndex: 0,
        pointer: { x: event.clientX, y: event.clientY },
        size: { width: row.rect.width, height: row.rect.height },
      });
      pending = null;
    }

    const current = state();
    if (current.draggedId === null) return;

    setState((prev) => ({ ...prev, pointer: { x: event.clientX, y: event.clientY } }));
    updateDropTarget(event.clientX, event.clientY, current.draggedId);
  };

  const onPointerUp = (event: PointerEvent): void => {
    const current = state();
    pending = null;

    // 没真的开始拖：什么都不做，让点击事件正常走
    if (current.draggedId === null) return;

    const containerId = current.overContainerId;
    document.body.classList.remove("is-dragging");
    setState(IDLE);

    if (containerId !== null) {
      // 用松手时的实际位置再算一次落点，避免最后一帧移动没被捕捉
      const list = collectRows(containerId);
      const index = clampIndex(
        resolveDropIndex(
          list.map((r) => ({ id: r.id, top: r.rect.top, height: r.rect.height })),
          event.clientY,
          current.draggedId,
        ),
        list.length,
      );
      onDrop(current.draggedId, containerId, index);
    }
  };

  const onPointerCancel = (): void => {
    pending = null;
    document.body.classList.remove("is-dragging");
    setState(IDLE);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && state().draggedId !== null) {
      pending = null;
      document.body.classList.remove("is-dragging");
      setState(IDLE);
    }
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onKeyDown);

  onCleanup(() => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown);
    document.body.classList.remove("is-dragging");
  });

  return {
    state,
    isDragging: () => state().draggedId !== null,
    begin(event, row) {
      // 只响应主键：右键是上下文菜单，中键是滚动
      if (event.button !== 0) return;
      // 阻止默认行为，避免拖动时选中文本
      event.preventDefault();
      pending = { id: row.id, startX: event.clientX, startY: event.clientY, row };
    },
    registerContainer(containerId, element) {
      if (element) containers.set(containerId, element);
      else containers.delete(containerId);
    },
    registerRow(rowId, containerId, element) {
      if (element) rows.set(rowId, { containerId, el: element });
      else rows.delete(rowId);
    },
  };
}
