/**
 * 封面生成测试。
 *
 * 核心断言是**确定性**：同一本书名必须永远得到同一张封面。
 * 这是生成式设计最容易退化的地方（一旦有人引入随机数，
 * 每次打开书架颜色都在变，用户会觉得软件坏了）。
 */

import { describe, expect, it } from "vitest";

import { coverColors, designCover, fnv1a } from "./covers";
import { formatAbsoluteTime, formatRelativeTime } from "./time";
import { sanitize } from "./NewWorkspace";

describe("fnv1a", () => {
  it("同样的输入得到同样的哈希", () => {
    expect(fnv1a("羽化录")).toBe(fnv1a("羽化录"));
  });

  it("不同的输入得到不同的哈希", () => {
    expect(fnv1a("羽化录")).not.toBe(fnv1a("惊蛰录"));
  });

  it("相近的输入也得到完全不同的哈希（雪崩性）", () => {
    expect(fnv1a("第一章")).not.toBe(fnv1a("第二章"));
  });

  it("空字符串也有稳定的哈希", () => {
    expect(fnv1a("")).toBe(fnv1a(""));
    expect(fnv1a("")).toBe(0x811c9dc5);
  });

  it("结果是无符号 32 位整数", () => {
    const hash = fnv1a("任意很长的中文书名用于测试哈希范围");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(hash)).toBe(true);
  });

  it("长文本不会产生 NaN 或溢出", () => {
    const hash = fnv1a("字".repeat(5000));
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
  });
});

describe("designCover", () => {
  it("确定性：同样的书名永远同样的封面", () => {
    expect(designCover("羽化录")).toEqual(designCover("羽化录"));
  });

  it("不同书名一般得到不同封面", () => {
    const a = designCover("羽化录");
    const b = designCover("惊蛰录");
    expect(a.hue !== b.hue || a.pattern !== b.pattern).toBe(true);
  });

  it("色相在 0..359", () => {
    for (const title of [
      "一",
      "二",
      "三",
      "很长的书名测试用例",
      "English Title",
    ]) {
      const d = designCover(title);
      expect(d.hue).toBeGreaterThanOrEqual(0);
      expect(d.hue).toBeLessThan(360);
      expect(d.accentHue).toBeGreaterThanOrEqual(0);
      expect(d.accentHue).toBeLessThan(360);
    }
  });

  it("图案编号在 0..3", () => {
    for (let i = 0; i < 50; i += 1) {
      const d = designCover(`书${i}`);
      expect([0, 1, 2, 3]).toContain(d.pattern);
    }
  });

  it("装饰密度在合理区间", () => {
    for (let i = 0; i < 50; i += 1) {
      const d = designCover(`书${i}`);
      expect(d.density).toBeGreaterThanOrEqual(3);
      expect(d.density).toBeLessThanOrEqual(7);
    }
  });

  it("明度限定在深色区间（保证白色书名可读）", () => {
    for (let i = 0; i < 50; i += 1) {
      const d = designCover(`书${i}`);
      expect(d.lightness).toBeGreaterThanOrEqual(22);
      expect(d.lightness).toBeLessThan(36);
    }
  });

  it("取书名的第一个字符作为首字", () => {
    expect(designCover("羽化录").initial).toBe("羽");
  });

  it("空书名也有可用的首字，不会渲染出空白", () => {
    expect(designCover("").initial).toBe("书");
    expect(designCover("   ").initial).toBe("书");
  });

  it("首字正确处理代理对（生僻字与扩展区字符）", () => {
    const rare = String.fromCodePoint(0x20000);
    expect(designCover(rare).initial).toBe(rare);
  });

  it("封面种类足够多（300 本书不至于大量撞色）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const d = designCover(`第${i}本书`);
      seen.add(`${d.hue}-${d.pattern}-${d.density}-${d.lightness}`);
    }
    // 组合空间是 360*4*5*14，300 本书里至少要有 200 种不同外观
    expect(seen.size).toBeGreaterThan(200);
  });
});

describe("coverColors", () => {
  it("返回三个可用的 CSS 颜色", () => {
    const colors = coverColors(designCover("羽化录"));
    for (const value of [colors.from, colors.to, colors.ink]) {
      expect(value).toMatch(/^hsl\(/);
    }
  });

  it("副色比起色更亮（形成渐变）", () => {
    const colors = coverColors({
      hue: 100,
      accentHue: 140,
      pattern: 0,
      density: 3,
      initial: "x",
      lightness: 30,
    });
    expect(colors.to).toContain("40%");
    expect(colors.from).toContain("30%");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-09-25T12:00:00+08:00");

  it("一分钟内显示刚刚", () => {
    expect(formatRelativeTime("2026-09-25T11:59:30+08:00", now)).toBe("刚刚");
  });

  it("分钟级", () => {
    expect(formatRelativeTime("2026-09-25T11:30:00+08:00", now)).toBe(
      "30 分钟前",
    );
  });

  it("小时级", () => {
    expect(formatRelativeTime("2026-09-25T09:00:00+08:00", now)).toBe(
      "3 小时前",
    );
  });

  it("天级", () => {
    expect(formatRelativeTime("2026-09-20T12:00:00+08:00", now)).toBe("5 天前");
  });

  it("未来时间显示刚刚，而不是负数", () => {
    expect(formatRelativeTime("2026-09-26T12:00:00+08:00", now)).toBe("刚刚");
  });

  it("非法时间串返回空串，不显示 NaN", () => {
    expect(formatRelativeTime("不是时间", now)).toBe("");
    expect(formatRelativeTime("", now)).toBe("");
  });

  it("中文字符不干扰解析", () => {
    // ISO 串本身是 ASCII，这里确认函数不会被外部的中文包住而误判
    expect(formatRelativeTime("2026-09-25T11:00:00+08:00", now)).toBe(
      "1 小时前",
    );
  });
});

describe("formatAbsoluteTime", () => {
  it("输出稳定的 YYYY-MM-DD HH:mm 格式", () => {
    const result = formatAbsoluteTime("2026-09-25T14:30:00+08:00");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("月份与日期补零", () => {
    const result = formatAbsoluteTime("2026-01-05T09:07:00+08:00");
    expect(result).toContain("-01-05");
    expect(result).toContain("09:07");
  });

  it("非法输入返回空串", () => {
    expect(formatAbsoluteTime("坏数据")).toBe("");
  });
});

describe("sanitize 工作区目录名", () => {
  it("过滤 Windows 保留字符", () => {
    expect(sanitize("我的<小说>:第一/卷")).toBe("我的-小说--第一-卷");
  });

  it("过滤反斜杠与竖线", () => {
    expect(sanitize("a\\b|c")).toBe("a-b-c");
  });

  it("去掉首尾空白", () => {
    expect(sanitize("  书名  ")).toBe("书名");
  });

  it("去掉结尾的点与空格（Windows 不允许）", () => {
    expect(sanitize("书名...")).toBe("书名");
  });

  it("合并连续空白", () => {
    expect(sanitize("我  的   书")).toBe("我 的 书");
  });

  it("空输入回退到默认名，不产生空目录名", () => {
    expect(sanitize("")).toBe("未命名");
    expect(sanitize("   ")).toBe("未命名");
  });

  it("超长书名被截断到 80 字符", () => {
    expect([...sanitize("字".repeat(200))].length).toBe(80);
  });

  it("普通中文书名原样通过", () => {
    expect(sanitize("羽化录")).toBe("羽化录");
  });
});
