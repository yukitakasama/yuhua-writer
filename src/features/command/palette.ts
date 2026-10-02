/**
 * 命令面板的模糊匹配（T5.7）。
 *
 * ## 为什么自己写而不是引 fuzzysort
 *
 * 需求只有两条：**子序列匹配**（"xj" 能匹配"新建章节"的拼音首字母不现实，
 * 但 "新建" 要能匹配 "新建章"）和**结果按匹配质量排序**。
 * 这两条加起来不到 60 行，而任何一个模糊搜索库都会带来一个额外的
 * 依赖、一份额外的类型声明，以及一个我们无法控制的分值公式。
 *
 * 计划书第 15 章明确要求「前端零运行时依赖优先」。
 *
 * ## 分值怎么算
 *
 * 三条经验规则，按权重从高到低：
 *
 * 1. **连续匹配**比散落匹配好：命中「新建章」中的"新建章"，
 *    比命中"新建章"里的"新"和"章"要相关得多
 * 2. **越早匹配越好**：命令名以关键词开头时最相关
 * 3. **越短越好**：在同样命中的情况下，短的命令名更贴近用户想找的
 *
 * 全部匹配不上时返回 null，而不是给一个低分 —— 「没找到」和
 * 「有个很差的匹配」在界面上应当是不同的东西。
 */

/** 一条命令的匹配结果。 */
export interface Match {
  /** 总分，越大越相关。 */
  score: number;
  /** 命中的字符下标（升序），用于把关键词部分加粗。 */
  positions: number[];
}

/**
 * 子序列匹配。
 *
 * 关键词的每个字符必须按顺序出现在文本里（不要求相邻），
 * 例如 "xzc" 能匹配 "新建章"。大小写不敏感。
 *
 * @param text 被搜索的文本
 * @param query 关键词
 * @returns 匹配结果；不匹配时返回 null
 */
export function fuzzyMatch(text: string, query: string): Match | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { score: 0, positions: [] };
  if (needle.length > text.length) return null;

  const haystack = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let cursor = 0;
  let previous = -2;

  for (const ch of needle) {
    const at = haystack.indexOf(ch, cursor);
    // 找不到就说明不是子序列，直接判负
    if (at < 0) return null;
    positions.push(at);
    // 连续命中给额外奖励：这是"相关性"里权重最高的一条
    if (at === previous + 1) score += 6;
    else score += 2;
    // 越靠前越好
    score += Math.max(0, 4 - at);
    previous = at;
    cursor = at + 1;
  }

  // 完全前缀命中额外加分
  if (haystack.startsWith(needle)) score += 12;
  // 短的命令名更贴近用户想找的（按长度扣分，但不至于扣成负数）
  score -= Math.floor(text.length / 4);

  return { score, positions };
}

/**
 * 在一组命令里按相关度排序。
 *
 * 空关键词时**原样返回**（保持命令的分组顺序）——
 * 刚打开面板就按分值重排会让列表看起来在乱跳。
 */
export function rankCommands<T extends { label: string }>(
  items: readonly T[],
  query: string,
): Array<{ item: T; match: Match }> {
  if (query.trim().length === 0) {
    return items.map((item) => ({ item, match: { score: 0, positions: [] } }));
  }
  const scored: Array<{ item: T; match: Match }> = [];
  for (const item of items) {
    const match = fuzzyMatch(item.label, query);
    if (match) scored.push({ item, match });
  }
  // 同分时按标签字典序，保证顺序稳定（否则每次渲染结果可能不一样）
  scored.sort(
    (a, b) =>
      b.match.score - a.match.score || a.item.label.localeCompare(b.item.label),
  );
  return scored;
}
