/**
 * SVG 封面生成（T5.2）。
 *
 * ## 为什么用算法生成而不是让用户传图
 *
 * 1. **零外链**是硬约定。用户传图意味着要么存进工作区（污染"工作区
 *    只有文本"的前提），要么引入图床（不只是外链，还是隐私问题）。
 * 2. **长篇小说作者不一定会做封面**。几百本书的界面里，
 *    有封面的书与没封面的书混在一起会非常难看。
 * 3. **确定性**是关键：同一本书的书名必须永远得到同一张封面，
 *    否则每次打开书架颜色都在变，用户会觉得软件坏了。
 *
 * ## 算法
 *
 * 1. 用 FNV-1a 哈希把书名映射成一个 32 位整数（同样的输入必然同样的输出，
 *    与 JS 引擎实现无关 —— 这是不能用 `Math.random` 或对象遍历顺序的原因）
 * 2. 从哈希取出：色相、几何图案编号、装饰密度
 * 3. 用 **HSL 而不是固定色板**：8 种色板对 300 本书不够用，
 *    而 HSL 可以生成任意多协调的颜色
 *
 * ## 为什么不用 crypto / 不用完整 MD5
 *
 * 封面只是个视觉锚点，碰撞（两本书颜色相同）完全可接受，
 * 而每个书名都跑一次密码学哈希是浪费。FNV-1a 五行就够了。
 */

/** 封面的确定性参数。 */
export interface CoverDesign {
  /** 主色相（0-359）。 */
  hue: number;
  /** 副色相，与主色相邻，保证协调。 */
  accentHue: number;
  /** 几何图案编号（0-3）。 */
  pattern: 0 | 1 | 2 | 3;
  /** 装饰线条数量。 */
  density: number;
  /** 书名首字，用作封面上的字。 */
  initial: string;
  /** 背景明度。 */
  lightness: number;
}

/**
 * FNV-1a 32 位哈希。
 *
 * 选它是因为：实现极短、雪崩性够好（相近输入得到完全不同的输出）、
 * 且**与运行时无关** —— 同一段文本在任何 JS 引擎里结果都一样。
 * 用 `String.prototype.hashCode` 之类没有标准的做法会导致
 * 换浏览器封面就变了。
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 乘以 16777619，用移位与加法避免大整数精度问题
    hash =
      (hash +
        (hash << 1) +
        (hash << 4) +
        (hash << 7) +
        (hash << 8) +
        (hash << 24)) >>>
      0;
  }
  return hash >>> 0;
}

/**
 * 由书名推导封面设计。
 *
 * 纯函数：同样的书名永远得到同样的封面。测试会固定住这一点，
 * 因为"封面每次都不一样"是这类生成式设计最常见的退化。
 */
export function designCover(title: string): CoverDesign {
  const name = title.trim();
  const hash = fnv1a(name);

  // 色相取全环：小说封面用什么颜色都不奇怪，不要限制在"书卷气"的窄区间
  const hue = hash % 360;
  // 副色相在主色相基础上偏移 24-56 度：同色系渐变更自然，
  // 跨色相（比如 180 度）会得到刺眼的对撞色
  const accentHue = (hue + 24 + ((hash >>> 8) % 33)) % 360;

  const pattern = ((hash >>> 16) % 4) as CoverDesign["pattern"];
  const density = 3 + ((hash >>> 20) % 5);

  // 明度限制在深色区间：浅色封面上的书名文字会看不清，
  // 而用白字配深底是最稳的组合
  const lightness = 22 + ((hash >>> 24) % 14);

  const first = [...name][0] ?? "书";

  return { hue, accentHue, pattern, density, initial: first, lightness };
}

/** 生成封面的两个颜色。 */
export function coverColors(design: CoverDesign): {
  from: string;
  to: string;
  ink: string;
} {
  return {
    from: `hsl(${design.hue} 32% ${design.lightness}%)`,
    to: `hsl(${design.accentHue} 38% ${design.lightness + 10}%)`,
    ink: `hsl(${design.hue} 40% 96%)`,
  };
}
