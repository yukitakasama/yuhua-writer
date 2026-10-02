/**
 * 每章独立记忆光标、选区与滚动位置（T4.12）。
 *
 * ## 为什么不能只靠 CodeMirror 的 EditorState 缓存
 *
 * 编辑器实例在切章时会被复用（销毁重建会让输入法状态、字体度量、
 * 滚动容器都重来一遍，切章会闪）。复用时文档被替换，
 * 旧的 EditorState 就失效了 —— 而作者期望的是
 * 「切回第 3 章，光标还在我刚才停的那个字后面」。
 *
 * 因此这里单独存一份"每章的位置记录"，切章时按章 ID 取回。
 *
 * ## 存什么、不存什么
 *
 * 存**锚点 + 头部偏移**而不是绝对位置：
 *
 * - 绝对位置在文档被外部修改（云盘同步、别的编辑器改了）后就错了，
 *   而且往往是错得离谱 —— 直接跳到文末。
 * - 锚点（位置附近的若干字符）可以在恢复时重新定位。
 *   这是 CodeMirror 自己 `StateField` 用的同一套思路，
 *   区别是我们把它持久化到"每章一个"的槽位里。
 *
 * 滚动位置存的是**行号**而不是像素：像素值在字体大小、
 * 窗口宽度变化后没有意义。
 */

/** 一章的位置记录。 */
export interface ChapterCursor {
  /** 光标位置（文档偏移）。 */
  anchor: number;
  /** 选区头部（与 anchor 相同表示没有选区）。 */
  head: number;
  /** 光标处附近的文本锚点，用于位置漂移后重新定位。 */
  textAnchor: string;
  /** 光标所在行号（1 基），滚动恢复用。 */
  line: number;
}

/** 锚点文本的长度。取 32 个字符：中文一屏一行的量级，足够唯一。 */
const ANCHOR_LENGTH = 32;

/** 从一段文本与光标偏移构造位置记录。 */
export function captureCursor(
  text: string,
  anchor: number,
  head: number,
  line: number,
): ChapterCursor {
  const from = Math.max(0, Math.min(anchor, text.length));
  const to = Math.min(text.length, from + ANCHOR_LENGTH);
  return {
    anchor,
    head,
    textAnchor: text.slice(from, to),
    line,
  };
}

/**
 * 位置记录是否还能用。
 *
 * 判据：锚点文本仍然存在于文档中。**空锚点视为可用**，
 * 因为空文档（新建的章）本来就没什么可锚的，
 * 此时恢复到位置 0 是正确行为。
 */
export function isCursorResolvable(
  text: string,
  cursor: ChapterCursor,
): boolean {
  if (cursor.textAnchor.length === 0) {
    // 锚点为空只有一个合法来源：捕获时**文档本身就是空的**
    // （见 captureCursor 的说明）。因此只有"当前文档也空"
    // 才认为这次记录仍然可用。
    //
    // 反例：文档原本为空、作者写了三千字、又全选删光后又重新写。
    // 此时旧记录（锚点空）如果被判为可用，光标会被强行拉到文首 ——
    // 而作者明明在文末。宁可放弃恢复，也不要跳到错误的位置。
    return text.length === 0;
  }
  return text.includes(cursor.textAnchor);
}

/**
 * 把记录解析回当前文档的偏移。
 *
 * ## 为什么要以锚点为准而不是以 offset 为准
 *
 * 光标在文档**后半段**时，如果前面被插入了几百字（比如作者回头
 * 补了一段），原来的 offset 指向的是完全无关的位置。
 * 锚点文本则没有这个问题：它跟着内容走。
 *
 * 只有锚点找不到时才退回 offset（并夹到合法范围）。
 */
export function resolveCursor(text: string, cursor: ChapterCursor): number {
  if (cursor.textAnchor.length > 0) {
    const at = text.indexOf(cursor.textAnchor);
    if (at >= 0) return at;
  }
  return Math.max(0, Math.min(cursor.anchor, text.length));
}

/** 每章位置记录的内存表。 */
export type CursorStore = Map<string, ChapterCursor>;

/**
 * 位置记录的容量上限。
 *
 * 一本 300 章的书如果全程切换过一遍，就会存 300 条。
 * 每条大约 100 字节，300 条才 30KB —— 完全可以全留。
 * 设上限是为了防止异常情况下（比如 ID 被不断生成的脚本）
 * 无界增长，而不是出于真实内存压力。
 */
export const CURSOR_STORE_LIMIT = 500;

/** 存入一条记录，超过上限时淘汰最旧的一条。 */
export function rememberCursor(
  store: CursorStore,
  chapterId: string,
  cursor: ChapterCursor,
): void {
  // Map 保证插入顺序：先删再插就是"移到最新"
  store.delete(chapterId);
  store.set(chapterId, cursor);
  while (store.size > CURSOR_STORE_LIMIT) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** 取一条记录。不存在返回 null。 */
export function recallCursor(
  store: CursorStore,
  chapterId: string,
): ChapterCursor | null {
  return store.get(chapterId) ?? null;
}
