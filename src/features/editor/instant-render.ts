/**
 * 即时渲染（T4.3，防 R17）。
 *
 * ## 需求原话
 *
 * 计划书 5.4 节：「**非光标行折叠标记**」。也就是像 Typora 那样：
 * 光标不在的那一行，`**粗体**` 显示成**粗体**（两个星号消失），
 * 光标一移过去，星号立刻回来 —— 作者随时能改语法，不会被藏起来的
 * 标记困住。
 *
 * ## 为什么不用 Typora 的做法（渲染成 HTML）
 *
 * Typora 的非光标行是**真 HTML**（`<strong>`）。这样做有两个代价：
 *
 * 1. 文档结构在编辑过程中改变，光标位置需要重新映射，
 *    中文 IME 组合期间尤其容易错位（正是 T4.4 要防的）
 * 2. 从 HTML 反推 Markdown 会丢失作者的原始写法
 *    （`*` 还是 `_`、列表用 `-` 还是 `*`）
 *
 * 因此这里用 CodeMirror 的 `Decoration.replace`：**只隐藏标记字符**，
 * 文档内容一个字都不动。等价的视觉效果，零结构风险。
 *
 * ## 光标行的判定为什么用"选中范围"而不是"光标位置"
 *
 * 因为选区也是"作者正在操作的地方"。如果只按光标判断，
 * 拖选一整段时被选中的行标记会被隐藏，作者看不到自己选了什么。
 */

import {
  EditorView,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  RangeSetBuilder,
  type EditorState,
  type Extension,
} from "@codemirror/state";

/** 隐藏标记的装饰（把字符从 DOM 里去掉，但文档不变）。 */
const HIDE = Decoration.replace({});

/**
 * 需要折叠的行内标记。
 *
 * 每条规则给出「整段匹配」与「要隐藏的捕获组编号」。
 * `global` 决定要不要在一行里多次匹配（行内标记需要，标题不需要）。
 */
interface MarkerRule {
  /** 正则。 */
  pattern: RegExp;
  /** 要隐藏的捕获组下标。 */
  groups: number[];
  /**
   * 闭合标记是否由反向引用匹配。
   *
   * 打开时为真：正则只有一个捕获组（开标记），闭合标记的位置由
   * 「整段匹配末尾往回数开标记的长度」得出。这样写正则不用把标记
   * 重复写两遍，但需要在取区间时补一次计算。
   */
  mirror?: boolean;
  /** 是否在整行内重复匹配。 */
  global: boolean;
}

/**
 * 规则表。
 *
 * ## 顺序很重要
 *
 * 行内的 `**` 必须在单个 `*` 之前匹配，否则 `**粗体**` 会被拆成
 * 两个斜体标记。这里按"长的先"排列，与 CommonMark 的分隔符处理一致。
 */
const RULES: readonly MarkerRule[] = [
  // 行首块级标记：## 标题、> 引用、- 列表、1. 有序列表
  { pattern: /^(#{1,6}\s+)/, groups: [1], global: false },
  { pattern: /^(\s{0,3}>\s?)/, groups: [1], global: false },
  { pattern: /^(\s*)([-*+]\s+)/, groups: [2], global: false },
  { pattern: /^(\s*)(\d{1,9}[.)]\s+)/, groups: [2], global: false },
  // 行内标记。
  //
  // 内容部分一律用**非捕获组**（`(?:…)`），把所有捕获组的编号
  // 留给"要折叠的标记"本身。否则 `\S(?:.*?\S)?` 里只要多一个括号，
  // 后面所有 `groups` 下标就会整体错位 —— 这种错误在界面上表现为
  // "标记没折干净"，很难看出是编号问题。
  //
  // ## 内容部分为什么用"温度点"写法 `(?:(?!X)[\s\S])+?`
  //
  // 朴素写法 `\S(?:.*?\S)?` 会**跨过同类标记**：在
  // `**甲** 与 **乙**` 上，它从第一个 `**` 一直匹配到最后一个 `**`，
  // 于是整行被当成一段粗体，两处的标记一个都折不干净。
  //
  // `(?:(?!\*\*|__)[\s\S])+?` 的含义是"每吃一个字符前先确认它不是
  // 闭合标记的开头"，配合懒惰量词就停在**第一个**合法的闭合标记处。
  // 这是正则里表达"不要在标记内部跨越"的标准做法。
  //
  // 每个正则只产生**一个**捕获组（开标记），闭合标记靠反向引用 `\1`
  // 匹配，位置由 `mirror` 分支算出（见下面的取区间代码）。
  {
    pattern: /(\*\*|__)(?:(?!\*\*|__)[\s\S])+?\1/g,
    groups: [1],
    mirror: true,
    global: true,
  },
  // 斜体：同样用温度点排除同类标记，另外用前后查断避免吃掉粗体的星号
  {
    pattern: /(?<!\*)(\*|_)(?!\1)(?:(?!\1)[\s\S])+?\1(?![*_])/g,
    groups: [1],
    mirror: true,
    global: true,
  },
  {
    pattern: /(~~)(?:(?!~~)[\s\S])+?\1/g,
    groups: [1],
    mirror: true,
    global: true,
  },
  {
    pattern: /(`+)(?:(?!\1)[\s\S])+?\1/g,
    groups: [1],
    mirror: true,
    global: true,
  },
  // 链接与图片：折叠 `[`（含前导 `!`）、`]`、`(`、`)`，保留文字与地址。
  // 这一条没有反向引用，四组标记各自独立捕获
  {
    pattern: /(!?\[)(?:[^\]]*)(\])(\()(?:[^)\s]*)(\))/g,
    groups: [1, 2, 3, 4],
    global: true,
  },
];

/**
 * 一行里要隐藏的字符区间。
 *
 * 导出出来是为了能单独测（见 subset.test.ts）：
 * 正则加装饰这种代码不写测试就等于没写 —— 一个差一错误
 * 会让光标跳到别的地方。
 */
export function hiddenRangesForLine(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const rule of RULES) {
    // 每条规则都重新构造正则实例：带 g 标志的正则持有 lastIndex 状态，
    // 复用同一个实例会让下一次调用从上次停下的位置开始搜索
    const re = new RegExp(rule.pattern.source, dFlagged(rule.pattern));
    const matches = rule.global ? text.matchAll(re) : singleMatch(text, re);
    for (const m of matches) {
      if (m.index === undefined) continue;
      // 用 `d` 标志给出的精确组区间，而不是靠字符串搜索猜偏移。
      // 猜的做法在 `**a** 与 **a**` 这种"同一行出现两次相同内容"
      // 的场景下会定位到错误的那一处
      const indices = m.indices;
      if (!indices) continue;
      for (const g of rule.groups) {
        // `m.indices[g]` 给的是**整行内的绝对区间**（不是相对 m.index 的），
        // 因此这里不能再加 m.index —— 加了会整体偏移一次匹配的长度
        const span = indices[g];
        if (!span) continue;
        const [start, end] = span;
        if (end > start) out.push([start, end]);
      }
      // 反向引用的闭合标记：它没有被单独捕获，位置就是整段匹配的末尾
      // 往前数「开标记的长度」。开标记一定是 groups[0] 对应的那一组
      if (rule.mirror && indices[0]) {
        const matchStart = indices[0][0];
        const matchEnd = indices[0][1];
        const openLength =
          (indices[rule.groups[0] ?? 1]?.[1] ?? matchStart) - matchStart;
        if (
          openLength > 0 &&
          matchEnd - openLength >= matchStart + openLength
        ) {
          out.push([matchEnd - openLength, matchEnd]);
        }
      }
    }
  }
  return mergeRanges(out);
}

/** 给正则补上 `d` 标志（拿不到组下标就没法正确折叠）。 */
function dFlagged(pattern: RegExp): string {
  return pattern.flags.includes("d") ? pattern.flags : pattern.flags + "d";
}

/**
 * 非全局规则的匹配迭代器。
 *
 * 用 `matchAll` 必须带 `g` 标志，但行首规则加了 `g` 就会在一行里
 * 反复匹配同一个位置。这里手工包装成"最多一次"的迭代器，
 * 让两条分支共用同一段取组下标的代码。
 */
function* singleMatch(text: string, re: RegExp): Generator<RegExpExecArray> {
  const m = re.exec(text);
  if (m !== null) yield m;
}

/** 把可能重叠的区间合并，避免给同一个位置加两次 replace 装饰而报错。 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length <= 1) return ranges;
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/** 光标/选区覆盖到的行号集合（1 基）。 */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    lines.add(state.doc.lineAt(range.from).number);
    lines.add(state.doc.lineAt(range.to).number);
  }
  return lines;
}

/** 构造即时渲染装饰。 */
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const active = activeLines(view.state);

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      // 光标所在行不折叠：作者就是要改这一行
      if (!active.has(line.number)) {
        for (const [start, end] of hiddenRangesForLine(line.text)) {
          // replace 装饰的 from 必须严格小于 to，且必须落在行内
          if (end > start && start >= 0 && end <= line.text.length) {
            builder.add(line.from + start, line.from + end, HIDE);
          }
        }
      }
      if (line.to >= view.state.doc.length) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/**
 * 即时渲染插件。
 *
 * ## 为什么在 `update` 里对选区变化也重算
 *
 * 光标移动 = 上一行要"显示标记"、新一行要"折叠标记"，
 * 两行的装饰都要变。因此 `selectionSet` 必须触发重算。
 * 这也是这个插件唯一的性能敏感点：**只在视口内算**，
 * 并且一次 `update` 只算一次。
 */
/** 插件实例的形状。显式声明是为了让 `provide` 能引用到它自己。 */
interface InstantRenderValue {
  decorations: DecorationSet;
}

const instantRenderPlugin = ViewPlugin.fromClass(
  class implements InstantRenderValue {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate): void {
      // 文档变了、光标动了、视口滚了，三件事都会改变"哪些标记该折叠"。
      // 其余更新（比如主题变化）与装饰无关，重算纯属浪费
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (value): DecorationSet => value.decorations,
    /**
     * 把折叠区间声明为**原子区间**。
     *
     * 不加这一条的话，光标可以用方向键"走进"被隐藏的标记内部 ——
     * 屏幕上什么都看不到，但按退格会删掉一个星号。原子化之后
     * 光标会整体跨过这段区间，与"看不见但还在"的直觉一致。
     */
    provide: (plugin) =>
      EditorView.atomicRanges.of((view): DecorationSet => {
        const value = view.plugin(plugin) as InstantRenderValue | undefined;
        return value?.decorations ?? Decoration.none;
      }),
  },
);

/** 即时渲染扩展。 */
export function instantRender(): Extension {
  return [instantRenderPlugin];
}
