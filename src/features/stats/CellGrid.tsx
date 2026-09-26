/**
 * 「一次插入、逐格不动画」的 SVG 格子网格。
 *
 * ## 为什么抽出来
 *
 * 码字日历（T8.7）与年热力图（T8.8）画的是同一样东西：一堆矩形，
 * 每格一个日期、一个字数、一个色阶档位。它们只在**网格参数**上不同
 * （7×6 对 53×7）以及是否画周次标签。让两个视图各写一遍渲染循环，
 * 就会出现「日历改了、热力图忘了改」这类漂移。
 *
 * ## 三条硬约束（都来自 T8.9）
 *
 * 1. **一次插入**：<For> 在同一帧里产出全部格子，不做分批渲染。
 * 2. **逐格不动画**：格子上的 class 不挂任何 transition；
 *    动画只允许发生在**整张 SVG** 上（见 app.css 的注释）。
 * 3. **一个监听器**：用 design/charts 的 `delegateEvents` 做事件委托，
 *    371 个格子不会产生 371 个闭包。
 *
 * ## 悬停浮层为什么跟着指针
 *
 * 格子只有 13px 见方，固定位置的浮层在边缘格子上会被容器裁掉。
 * 跟随指针时只改 `transform`，符合「只动画 transform 与 opacity」。
 */

import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";

import { delegateEvents, type DelegatedHit } from "@/design/charts";
import { colorForLevel } from "./heat";
import type { GridCell } from "./model";

/** 网格几何。 */
export interface GridSpec {
  /** 列数。 */
  columns: number;
  /** 行数。 */
  rows: number;
  /** 单格边长。 */
  cellSize: number;
  /** 格间距。 */
  gap: number;
  /** 顶部留给表头的高度。 */
  headHeight: number;
  /** 左侧留给行标签的宽度（热力图的周次标签用）。 */
  headWidth: number;
}

export interface CellGridProps {
  /** 全部格子（列优先或行优先由调用方决定，这里只按 column/row 摆放）。 */
  cells: readonly GridCell[];
  /** 网格几何。 */
  spec: GridSpec;
  /** 网格的无障碍标签。 */
  label: string;
  /** 每格的悬浮提示内容生成函数。 */
  tooltip: (cell: GridCell) => JSX.Element;
  /** 是否画日期数字（只有月历画：13px 的热力图格里放不下）。 */
  showDayNumbers?: boolean;
  /** 计算网格尺寸（含表头留白）。 */
  width: number;
  height: number;
}

/** 一次插入的 SVG 格子网格。 */
export function CellGrid(props: CellGridProps): JSX.Element {
  const [hover, setHover] = createSignal<{ cell: GridCell; x: number; y: number } | null>(null);
  let svg: SVGSVGElement | undefined;

  // 委托：整张 SVG 只挂一个监听器
  onMount(() => {
    const element = svg;
    if (!element) return;
    const off = delegateEvents(element as unknown as Element, {
      pointerover: (hit) => show(hit),
      pointermove: (hit) => show(hit),
      pointerout: () => setHover(null),
    });
    onCleanup(off);
  });

  /** 由一次委托命中构造悬浮态。 */
  const show = (hit: DelegatedHit): void => {
    if (hit.index === null) return;
    const cell = props.cells[hit.index];
    if (!cell) return;
    setHover({ cell, x: hit.offsetX, y: hit.offsetY });
  };

  const xOf = (column: number): number => props.spec.headWidth + column * (props.spec.cellSize + props.spec.gap);
  const yOf = (row: number): number => props.spec.headHeight + row * (props.spec.cellSize + props.spec.gap);

  return (
    <div class="stats-grid">
      <svg
        ref={svg}
        class="stats-grid__svg"
        width={props.width}
        height={props.height}
        viewBox={`0 0 ${props.width} ${props.height}`}
        role="img"
        aria-label={props.label}
      >
        {/* 全部格子一次插入。逐格不做动画（T8.9） */}
        <For each={props.cells}>
          {(cell, index) => (
            <rect
              class="stats-cell"
              classList={{ "is-outside": !cell.inRange }}
              x={xOf(cell.column)}
              y={yOf(cell.row)}
              width={props.spec.cellSize}
              height={props.spec.cellSize}
              rx={props.spec.cellSize >= 18 ? 4 : 2}
              fill={colorForLevel(cell.level)}
              data-index={index()}
              data-date={cell.date}
              data-value={cell.words}
            />
          )}
        </For>

        <Show when={props.showDayNumbers === true}>
          <For each={props.cells}>
            {(cell) => (
              <text
                class="stats-cell__num"
                classList={{ "is-outside": !cell.inRange }}
                x={xOf(cell.column) + props.spec.cellSize / 2}
                y={yOf(cell.row) + props.spec.cellSize / 2 + 4}
                text-anchor="middle"
                aria-hidden="true"
              >
                {Number(cell.date.slice(8))}
              </text>
            )}
          </For>
        </Show>
      </svg>

      <Show when={hover()}>
        {(state) => (
          <div
            class="stats-pop"
            role="tooltip"
            style={{ transform: `translate3d(${state().x + 12}px, ${state().y + 10}px, 0)` }}
          >
            {props.tooltip(state().cell)}
          </div>
        )}
      </Show>
    </div>
  );
}
