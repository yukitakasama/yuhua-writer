/**
 * 卷章树的界面态（哪个卷是展开的）。
 *
 * ## 为什么不放在 `VolumeGroup` 里
 *
 * `reloadDocument()` 每次增删卷章后都会用后端返回的大纲**重建整个 document**，
 * 于是 `<For each={storeVolumes()}>` 拿到的是全新的对象 —— 按引用比对的 `<For>`
 * 会把每一个 `VolumeGroup` 销毁重建。组件本地的 `createSignal(true)` 因此归零：
 * 作者刚刚加了一章，五个卷全部收起，得逐个再点开。
 *
 * 这不是性能问题而是**状态丢失**，而且组件测试照不出来：单个
 * `VolumeGroup` 里展开是好的，只有「父级数据被整体替换」时才会露出来。
 * 所以把它按**卷 ID** 存在组件外面 —— 视图可以重建，作者的选择不是视图。
 *
 * ## 刻意不管重命名的输入草稿
 *
 * `InlineEdit` 是非受控输入（受控输入在 WebView 里会吃掉中文拼音的 composing
 * 过程，见该文件的说明），草稿存在 DOM 里。重建时它仍会丢，这一条没修，
 * 已记入待办；要修就得让「重读文稿」按 ID 复用已有对象而不是整体替换。
 */

import { createSignal } from "solid-js";

/** 卷 ID → 是否展开。没有记录即视为展开（卷默认是开的）。 */
const [expanded, setExpanded] = createSignal<ReadonlyMap<string, boolean>>(
  new Map(),
);

/** 该卷是否展开。 */
export function isVolumeExpanded(volumeId: string): boolean {
  return expanded().get(volumeId) ?? true;
}

/** 切换展开态。 */
export function toggleVolumeExpanded(volumeId: string): void {
  setExpanded((current) => {
    const next = new Map(current);
    next.set(volumeId, !(current.get(volumeId) ?? true));
    return next;
  });
}

/** 显式展开 / 折叠（新建章节时要保证看得见）。 */
export function setVolumeExpanded(volumeId: string, open: boolean): void {
  setExpanded((current) => {
    const next = new Map(current);
    next.set(volumeId, open);
    return next;
  });
}

/** 忘记所有卷的选择（关闭 / 换工作区，以及测试重置）。 */
export function __resetTreeUi(): void {
  setExpanded(new Map());
}

/** 供测试读取。 */
export function __expandedMap(): ReadonlyMap<string, boolean> {
  return expanded();
}
