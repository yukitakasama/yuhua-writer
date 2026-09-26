import { describe, expect, it } from "vitest";

import { hiddenRangesForLine } from "./instant-render";

/** 辅助：把一行按隐藏区间"渲染"出来（用于看最终可见文本）。 */
function rendered(line: string): string {
  const ranges = hiddenRangesForLine(line);
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += line.slice(cursor, start);
    cursor = end;
  }
  out += line.slice(cursor);
  return out;
}

describe("即时渲染：标记折叠", () => {
  it("标题折叠井号与空格", () => {
    expect(rendered("## 第一章")).toBe("第一章");
  });

  it("引用折叠 >", () => {
    expect(rendered("> 他说，走了。")).toBe("他说，走了。");
  });

  it("无序列表折叠标记", () => {
    expect(rendered("- 第一项")).toBe("第一项");
    expect(rendered("* 星号列表")).toBe("星号列表");
    expect(rendered("+ 加号列表")).toBe("加号列表");
  });

  it("有序列表折叠序号", () => {
    expect(rendered("1. 第一项")).toBe("第一项");
    expect(rendered("12) 第十二项")).toBe("第十二项");
  });

  it("缩进列表保留缩进，只折叠标记", () => {
    expect(rendered("  - 子项")).toBe("  子项");
  });

  it("粗体折叠两侧星号", () => {
    expect(rendered("这是 **重点** 内容")).toBe("这是 重点 内容");
  });

  it("双下划线粗体", () => {
    expect(rendered("这是 __重点__ 内容")).toBe("这是 重点 内容");
  });

  it("斜体折叠单个星号", () => {
    expect(rendered("这是 *强调* 内容")).toBe("这是 强调 内容");
  });

  it("删除线折叠波浪线", () => {
    expect(rendered("这是 ~~划掉~~ 内容")).toBe("这是 划掉 内容");
  });

  it("行内代码折叠反引号", () => {
    expect(rendered("调用 \`fn()\` 即可")).toBe("调用 fn() 即可");
  });

  it("链接折叠方括号与圆括号", () => {
    expect(rendered("见 [文档](https://a.b) 说明")).toBe("见 文档https://a.b 说明");
  });

  it("图片折叠感叹号与括号", () => {
    expect(rendered("![插图](img/a.png)")).toBe("插图img/a.png");
  });

  it("一行里多个粗体都能折叠", () => {
    expect(rendered("**甲** 与 **乙**")).toBe("甲 与 乙");
  });

  it("粗体不会被误判成两个斜体", () => {
    // 如果单星号规则先匹配，\`**重点**\` 会被折成 \`*重点*\`（星号各剩一个）
    expect(rendered("**重点**")).toBe("重点");
  });

  it("嵌套：粗体里的斜体", () => {
    expect(rendered("**很*强调*的**")).toBe("很强调的");
  });
});

describe("即时渲染：不折叠的情况", () => {
  it("普通段落原样保留", () => {
    expect(hiddenRangesForLine("他只是走过去，什么也没说。")).toEqual([]);
  });

  it("单个星号不是标记", () => {
    expect(rendered("3 * 4 = 12")).toBe("3 * 4 = 12");
  });

  it("行尾未闭合的粗体不折叠", () => {
    expect(rendered("这是 **未闭合")).toBe("这是 **未闭合");
  });

  it("分隔线不在行内规则里（由块级装饰处理）", () => {
    // --- 不应被当作无序列表标记折叠掉
    expect(rendered("---")).toBe("---");
  });

  it("空行不产生区间", () => {
    expect(hiddenRangesForLine("")).toEqual([]);
  });

  it("正文里的井号不是标题", () => {
    expect(rendered("话题 #标签")).toBe("话题 #标签");
  });
});

describe("即时渲染：区间不重叠且有序", () => {
  const samples = [
    "## 标题 **粗** 与 *斜*",
    "> 引用里的 [链接](http://a) 与 \`代码\`",
    "- 列表 **项** ~~删~~",
    "1. 有序 [x](y) 嵌套 **a *b* c**",
  ];

  for (const sample of samples) {
    it(`区间有序不重叠：${sample}`, () => {
      const ranges = hiddenRangesForLine(sample);
      for (let i = 1; i < ranges.length; i += 1) {
        const prev = ranges[i - 1];
        const cur = ranges[i];
        if (!prev || !cur) throw new Error("区间缺失");
        expect(cur[0]).toBeGreaterThanOrEqual(prev[1]);
      }
      for (const [s, e] of ranges) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(e).toBeLessThanOrEqual(sample.length);
        expect(e).toBeGreaterThan(s);
      }
    });
  }
});
