import { describe, expect, it } from "vitest";

import {
  normalizePastedText,
  htmlToMarkdown,
  isSafeHref,
  isSafeSrc,
} from "./paste";

describe("粘贴清洗：换行归一", () => {
  it("CRLF 归一成 LF", () => {
    expect(normalizePastedText("第一行\r\n第二行")).toBe("第一行\n第二行");
  });

  it("单独 CR 归一成 LF", () => {
    expect(normalizePastedText("第一行\r第二行")).toBe("第一行\n第二行");
  });

  it("连续 CRLF 不会多出空行", () => {
    expect(normalizePastedText("甲\r\n\r\n乙")).toBe("甲\n\n乙");
  });
});

describe("粘贴清洗：不可见字符", () => {
  it("零宽空格被剔除", () => {
    expect(normalizePastedText("这\u200b是\u200b正文")).toBe("这是正文");
  });

  it("零宽连接符与不连字符被剔除", () => {
    expect(normalizePastedText("a\u200cb\u200dc\u2060d")).toBe("abcd");
  });

  it("BOM 被剔除", () => {
    expect(normalizePastedText("\ufeff开头")).toBe("开头");
  });

  it("不换行空格转成普通空格而不是删掉", () => {
    expect(normalizePastedText("甲\u00a0乙")).toBe("甲 乙");
  });

  it("全角空格转成普通空格", () => {
    expect(normalizePastedText("甲\u3000乙")).toBe("甲 乙");
  });

  it("各种窄空格都转成普通空格", () => {
    expect(normalizePastedText("a\u2009b\u202fc")).toBe("a b c");
  });

  it("行尾空白被清掉", () => {
    expect(normalizePastedText("正文   \n下一行  ")).toBe("正文\n下一行");
  });
});

describe("粘贴清洗：保留作者本意", () => {
  it("Markdown 标记原样保留", () => {
    const md = "# 标题\n\n**粗体** 与 *斜体*\n\n- 列表项";
    expect(normalizePastedText(md)).toBe(md);
  });

  it("全角字母数字不做转换", () => {
    expect(normalizePastedText("ＡＢＣ １２３")).toBe("ＡＢＣ １２３");
  });

  it("中文标点原样保留", () => {
    expect(normalizePastedText("他说：「走。」")).toBe("他说：「走。」");
  });
});

describe("HTML 转 Markdown", () => {
  it("粗体与斜体", () => {
    expect(htmlToMarkdown("<p>这是 <strong>重点</strong></p>")).toBe(
      "这是 **重点**",
    );
    expect(htmlToMarkdown("<p>这是 <em>强调</em></p>")).toBe("这是 *强调*");
  });

  it("b / i 标签等价处理", () => {
    expect(htmlToMarkdown("<b>粗</b>")).toBe("**粗**");
    expect(htmlToMarkdown("<i>斜</i>")).toBe("*斜*");
  });

  it("标题按层级转换", () => {
    expect(htmlToMarkdown("<h2>小标题</h2>")).toBe("## 小标题");
  });

  it("列表项转换", () => {
    expect(htmlToMarkdown("<ul><li>甲</li><li>乙</li></ul>")).toBe(
      "- 甲\n- 乙",
    );
  });

  it("行内代码", () => {
    expect(htmlToMarkdown("<code>fn()</code>")).toBe("`fn()`");
  });

  it("链接转换", () => {
    expect(htmlToMarkdown('<a href="https://a.b">文档</a>')).toBe(
      "[文档](https://a.b)",
    );
  });

  it("行内样式被剥掉但文字保留", () => {
    const html = '<span style="font-family:宋体;color:#000">正文</span>';
    expect(htmlToMarkdown(html)).toBe("正文");
  });

  it("script 与 style 整块丢弃", () => {
    expect(htmlToMarkdown("<style>p{color:red}</style><p>正文</p>")).toBe(
      "正文",
    );
    expect(htmlToMarkdown("<script>alert(1)</script><p>正文</p>")).toBe("正文");
  });

  it("HTML 注释丢弃", () => {
    expect(
      htmlToMarkdown("<!--StartFragment--><p>正文</p><!--EndFragment-->"),
    ).toBe("正文");
  });

  it("nbsp 转成普通空格", () => {
    expect(htmlToMarkdown("<p>甲&nbsp;乙</p>")).toBe("甲 乙");
  });

  it("危险链接降级为纯文本", () => {
    expect(htmlToMarkdown('<a href="javascript:alert(1)">点我</a>')).toBe(
      "点我",
    );
  });

  it("危险图片降级为占位文字", () => {
    const out = htmlToMarkdown('<img alt="图" src="javascript:alert(1)">');
    expect(out).toContain("图片");
    expect(out).not.toContain("javascript");
  });

  it("多于两个连续空行被压缩", () => {
    expect(htmlToMarkdown("<p>甲</p><p></p><p></p><p>乙</p>")).toBe("甲\n\n乙");
  });

  it("Word 特有的 mso 样式被剥掉", () => {
    const html =
      '<p style="mso-margin-top-alt:auto"><span style="mso-bidi-font-size:10.5pt">正文</span></p>';
    expect(htmlToMarkdown(html)).toBe("正文");
  });
});

describe("URL 白名单", () => {
  it("放行 http / https / mailto", () => {
    expect(isSafeHref("https://a.b")).toBe(true);
    expect(isSafeHref("http://a.b")).toBe(true);
    expect(isSafeHref("mailto:a@b.c")).toBe(true);
  });

  it("拒绝 javascript", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("JavaScript:alert(1)")).toBe(false);
    expect(isSafeHref("  javascript:alert(1)")).toBe(false);
  });

  it("拒绝 data URL", () => {
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
  });

  it("拒绝协议相对地址", () => {
    expect(isSafeHref("//evil.example/x")).toBe(false);
  });

  it("放行相对路径", () => {
    expect(isSafeHref("manuscript/001-第一卷/001-开头.md")).toBe(true);
    expect(isSafeHref("./a.md")).toBe(true);
  });

  it("图片放行位图 data URL", () => {
    expect(isSafeSrc("data:image/png;base64,iVBOR")).toBe(true);
    expect(isSafeSrc("data:image/jpeg;base64,/9j/")).toBe(true);
    expect(isSafeSrc("data:image/webp;base64,UklG")).toBe(true);
  });

  it("图片拒绝 SVG data URL（可内嵌脚本）", () => {
    expect(isSafeSrc("data:image/svg+xml;base64,PHN2Zw")).toBe(false);
    expect(isSafeSrc("data:image/svg+xml,<svg/>")).toBe(false);
  });

  it("图片拒绝其它 data 类型", () => {
    expect(isSafeSrc("data:text/html,<b>")).toBe(false);
  });
});
