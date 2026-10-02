/**
 * Markdown 子集冻结（T4.15，防 R17）。
 *
 * ## 为什么必须冻结
 *
 * 风险 R17 说的是：**编辑器允许写的语法，导出器解析不了**。
 * 一旦作者用了编辑器里能打出来的某个扩展语法（比如 `~~删除线~~`、
 * 表格里的合并单元格、脚注），而 `pulldown-cmark` 侧没有开对应的
 * 选项，导出就会静默降级成纯文本 —— 作者在成稿里才发现。
 *
 * 因此这里把「本作支持的 Markdown 语法」写成**一张显式的表**，
 * 三个地方共用它：
 *
 * 1. 编辑器（`markdownLanguages()` 的依据，决定要不要高亮）
 * 2. 导出器（`pulldown-cmark` 的 `Options` 位）
 * 3. 测试（子集一致性测试，见 `subset.test.ts`）
 *
 * ## 为什么是"冻结"而不是"跟随 CommonMark"
 *
 * CommonMark 本身很稳定，但**方言**不稳定：GFM 每年加东西，
 * 各家编辑器又各有各的扩展。写作软件的数据要活十年，
 * 所以这里选一个**子集**并把它钉死，宁可少支持，不可不确定。
 *
 * ## 与计划书 9.3 节的对应
 *
 * 计划书 9.3 列出的语法就是下面 `MARKDOWN_SUBSET` 的 `core` 组；
 * `optional` 组是「解析但降级」的语法：作者写了不会被吃掉，
 * 但导出时会转成等价的基础写法（比如任务列表转成普通列表项，
 * 前面加一个 ✓ / 空方框的文本前缀）。
 */

/** 一条子集规则的说明。 */
export interface SubsetRule {
  /** 语法的名字（中文，用于文档与报错）。 */
  name: string;
  /** 触发它的写法示例。 */
  syntax: string;
  /** 是否在本作中"一等公民"地支持（false 表示会降级）。 */
  firstClass: boolean;
  /** 降级时的行为说明。 */
  degradation?: string;
}

/** 本作支持的 Markdown 语法全集。**新增条目必须同时改 Rust 侧解析选项。** */
export const MARKDOWN_SUBSET: readonly SubsetRule[] = [
  { name: "标题", syntax: "# 一级 / ## 二级 / ### 三级", firstClass: true },
  { name: "段落", syntax: "空行分隔", firstClass: true },
  { name: "粗体", syntax: "**文字**", firstClass: true },
  { name: "斜体", syntax: "*文字*", firstClass: true },
  { name: "引用", syntax: "> 文字", firstClass: true },
  { name: "无序列表", syntax: "- 条目", firstClass: true },
  { name: "有序列表", syntax: "1. 条目", firstClass: true },
  { name: "分隔线", syntax: "---", firstClass: true },
  { name: "链接", syntax: "[文字](地址)", firstClass: true },
  { name: "图片", syntax: "![说明](地址)", firstClass: true },
  { name: "行内代码", syntax: "`代码`", firstClass: true },
  { name: "代码块", syntax: "``` 围栏", firstClass: true },
  {
    name: "删除线",
    syntax: "~~文字~~",
    firstClass: false,
    degradation: "去掉删除线标记，保留文字",
  },
  {
    name: "任务列表",
    syntax: "- [x] 已完成",
    firstClass: false,
    degradation: "转成普通列表项，方框用 \u2611 / \u2610 字符表示",
  },
  {
    name: "表格",
    syntax: "| 表头 | 表头 |",
    firstClass: false,
    degradation: "DOCX / PDF 转成真表格；TXT / Markdown 保留原样",
  },
  {
    name: "脚注",
    syntax: "[^1]",
    firstClass: false,
    degradation: "转成行内括号注释",
  },
];

/** 缩写：一等公民语法名集合，供高亮与测试使用。 */
export const FIRST_CLASS_SYNTAXES: readonly string[] = MARKDOWN_SUBSET.filter(
  (r) => r.firstClass,
).map((r) => r.name);

/** 缩写：会降级的语法名集合。 */
export const DEGRADED_SYNTAXES: readonly string[] = MARKDOWN_SUBSET.filter(
  (r) => !r.firstClass,
).map((r) => r.name);

/**
 * 编辑器允许的标记字符。
 *
 * 即时渲染（T4.3）在非光标行上折叠标记，需要知道"哪些字符是标记"。
 * 集中在这里，而不是在渲染插件里散着写正则。
 */
export const MARKDOWN_MARKERS = [
  "#",
  "*",
  "_",
  ">",
  "-",
  "+",
  "~",
  "`",
  "[",
  "]",
  "(",
  ")",
  "!",
  "|",
] as const;

/**
 * 判断一个字符是不是 Markdown 标记。
 *
 * 用于即时渲染插件决定"这一段的这个字符要不要隐藏"。
 */
export function isMarkdownMarker(ch: string): boolean {
  return (MARKDOWN_MARKERS as readonly string[]).includes(ch);
}
