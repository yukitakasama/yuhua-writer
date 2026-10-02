/**
 * 粘贴处理（T4.13）。
 *
 * ## 要解决什么
 *
 * 从网页、Word、微信里复制一段文字粘进编辑器，会出现三类脏数据：
 *
 * 1. **富文本 HTML**。浏览器默认会带 `text/html`，里面常有
 *    内联样式、`<span style="font-family:宋体">`、Word 特有的
 *    `<!--StartFragment-->` 与 `mso-*` 样式。直接插入会把编辑器
 *    变成"样式垃圾场"，而且这些样式**导出时全都不认**（R17 的变体）。
 * 2. **零宽字符与全角空格**。网页里广泛使用 `\u200b`（零宽空格）、
 *    `\u00a0`（不换行空格）、`\ufeff`（BOM）。它们看不见，
 *    但会算进字数、会让检索匹配不上、会让导出的排版出现莫名的空位。
 * 3. **Windows / 旧 Mac 换行**。`\r\n` 与 `\r` 要归一成 `\n`,
 *    否则导出的 TXT 会出现多余空行。
 *
 * ## 为什么不用"粘贴时全部转成纯文本"一刀切
 *
 * 因为作者**经常真的要粘 Markdown**：从别的 Markdown 编辑器、
 * 从笔记软件、从自己的旧稿里复制。那些文本里的 `**`、`#`
 * 是有意义的，清掉就等于毁掉作者的格式。
 *
 * 因此策略是：**只清理"不可能是作者本意"的东西**
 * （零宽字符、富文本样式、换行符），保留所有可见的文本字符与
 * Markdown 标记。
 */

/** 需要剔除的不可见字符。 */
const INVISIBLE_CHARS = /[\u200b\u200c\u200d\u2060\ufeff]/g;

/**
 * 不换行空格 `\u00a0` 与应用内空格 `\u2003` 等。
 *
 * 转成普通空格而不是删掉：它们在原文里是**有意义的分隔**
 * （中文里常被排版软件用来对齐），删掉会把两个词粘在一起。
 */
const WIDE_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/**
 * 归一化粘贴进来的**纯文本**。
 *
 * 顺序有讲究：
 * 1. 先归一换行（`\r\n` → `\n`，`\r` → `\n`）
 * 2. 再削不可见字符
 * 3. 最后把宽空格换成普通空格
 *
 * 反过来做的话，第 2 步删掉 `\ufeff` 之后可能把原本分开的
 * `\r` 和 `\n` 拼成 `\r\n`，第 1 步就漏掉了。
 */
export function normalizePastedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_CHARS, "")
    .replace(WIDE_SPACES, " ")
    .replace(/[ \t]+$/gm, "");
}

/**
 * 全角数字与字母要不要转半角？
 *
 * **不转**。中文写作里全角是作者的排版选择（尤其是对话里的
 * "ＡＢＣ"），自动转换是非常粗暴的越权行为。
 */

/**
 * 把粘贴的 HTML 降级成 Markdown 片段。
 *
 * ## 为什么只处理这几种标签
 *
 * 完整的 HTML → Markdown 转换器（turndown 之类）有几百 KB，
 * 而且会引入它自己的一套方言。写作软件需要的只是
 * **把常见的粗体/斜体/标题/列表/链接保留下来**，
 * 其余一律当纯文本。这样既保住了作者最在意的几类格式，
 * 又不会引入无法预期的标记。
 *
 * ## 为什么最后一定要过一次 normalizePastedText
 *
 * 因为取文本节点时会把 HTML 里的 `&nbsp;` 解成 `\u00a0`，
 * 而那是第 2 类脏数据。
 */
export function htmlToMarkdown(html: string): string {
  let out = html;

  // 先干掉注释、脚本、样式这些"一定不是正文"的整块内容
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");

  // ## 顺序很关键：**先转语义标签，再处理块级标签**
  //
  // 反过来的话（先把 `<h1>` 换成换行、再想找 `<h1>` 定层级）
  // 标题的层级信息已经丢了。同理 `<li>` 必须在 `<ul>`/`<ol>` 的
  // 块级规则之前处理，否则会先被换成空行。

  // 保留语义的标签转成 Markdown 标记
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  out = out.replace(/<(code)[^>]*>([\s\S]*?)<\/\1>/gi, "`$2`");
  // 标题的 `\n` 收在标记内部会产生多余空行，因此两侧都加、
  // 最后统一靠 `\n{3,}` 压缩
  out = out.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, level: string, text: string) =>
      `\n${"#".repeat(Number(level))} ${text.trim()}\n`,
  );
  out = out.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) =>
      isSafeHref(href) ? `[${text}](${href})` : text,
  );
  out = out.replace(
    /<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>/gi,
    (_m, alt: string, src: string) =>
      isSafeSrc(src) ? `![${alt}](${src})` : `［图片：${alt}］`,
  );
  out = out.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (_m, text: string) => `- ${text.trim()}\n`,
  );

  // 剩下的块级标签换算行。`li`/`h[1-6]` 已被上面处理掉，
  // 这里再出现只会是它们的**闭合**标签，换成换行即可
  out = out.replace(
    /<\/?(p|div|section|article|ul|ol|tr|blockquote)[^>]*>/gi,
    "\n",
  );
  out = out.replace(/<br\s*\/?>/gi, "\n");

  // 剩下的标签一律剥掉（包括它们的属性 —— 属性是最脏的部分）
  out = out.replace(/<[^>]+>/g, "");

  // HTML 实体：只解最常见的那几个，其余交给浏览器语义
  out = decodeBasicEntities(out);

  return normalizePastedText(out)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 解基本 HTML 实体。 */
function decodeBasicEntities(text: string): string {
  const map: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };
  return text.replace(
    /&(?:nbsp|amp|lt|gt|quot|apos|#39);/g,
    (m) => map[m] ?? m,
  );
}

/**
 * 链接地址白名单。
 *
 * 与导出器的 `is_safe_url` 同源：只放行 `http`/`https`/`mailto`
 * 与**相对路径**。`javascript:` 与 `data:` 一律拒绝 ——
 * 它们是 XSS 通道，而粘贴进来的内容恰恰是最不可信的。
 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:")
  )
    return true;
  // 相对路径：不含协议分隔符，也不是协议相对地址
  return !trimmed.includes(":") && !trimmed.startsWith("//");
}

/**
 * 图片地址白名单。
 *
 * 比链接更严：**只放行位图 data URL 与相对路径**，
 * `data:image/svg+xml` 被明确拒绝（SVG 可以内嵌脚本）。
 * 这条规则与 `html.rs` 里的实现一致，此处复述是为了让前端
 * 也在粘贴阶段就拦掉，而不是等导出时才发现。
 */
export function isSafeSrc(src: string): boolean {
  const trimmed = src.trim().toLowerCase();
  if (/^data:image\/(png|jpeg|jpg|gif|webp|bmp);/i.test(trimmed)) return true;
  if (trimmed.startsWith("data:")) return false;
  return !trimmed.includes(":") && !trimmed.startsWith("//");
}

/** 从剪贴板事件里取出该用的文本。 */
export function pickPastedText(data: DataTransfer): {
  text: string;
  wasHtml: boolean;
} {
  const html = data.getData("text/html");
  if (html && html.trim().length > 0) {
    const converted = htmlToMarkdown(html);
    // HTML 转换后没剩下东西（比如整块都是样式）就退回纯文本
    if (converted.length > 0) return { text: converted, wasHtml: true };
  }
  return {
    text: normalizePastedText(data.getData("text/plain")),
    wasHtml: false,
  };
}
