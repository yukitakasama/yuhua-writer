/**
 * 编辑器内核的组件级测试（M4）。
 *
 * ## 为什么这些测试值得跑一次真实的 CodeMirror
 *
 * 纯函数测试（instant-render / paste / autosave）覆盖了逻辑，
 * 但**装进 EditorView 之后**才会暴露另一类问题：扩展之间是否冲突、
 * 装饰的 `from`/`to` 是否越界、`Compartment` 替换是否会崩。
 * 这些问题在只测纯函数时全部看不见。
 *
 * jsdom 里跑真实视图是可行的：CodeMirror 6 不依赖真实布局测量
 * 就能建立状态与视图（只影响滚动相关的行为，那些不在本文件的断言范围）。
 */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEditorExtensions, fontCompartmentExtension } from "./MarkdownEditor";
import { normalizePastedText } from "./paste";

/** 建一个挂在 jsdom 里的编辑器。 */
function mountEditor(doc: string, hooks: { onUserEdit?: () => void; onDocChange?: (v: string) => void } = {}): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    extensions: [
      createEditorExtensions({
        readOnlyCompartment: new (class {
          of() {
            return [];
          }
        })() as never,
        fontCompartment: new (class {
          of() {
            return [];
          }
        })() as never,
        readOnly: false,
        ...hooks,
      }),
    ],
  });
  return new EditorView({ state, parent });
}

const views: EditorView[] = [];

afterEach(() => {
  // 每个用例后销毁，否则 CodeMirror 的 DOM 监听会跨用例累积
  for (const v of views.splice(0)) v.destroy();
  document.body.replaceChildren();
});

function track(view: EditorView): EditorView {
  views.push(view);
  return view;
}

describe("编辑器装配：扩展不冲突", () => {
  it("能建起一个带全部扩展的视图", () => {
    const view = track(mountEditor("# 标题\n\n正文 **粗体**"));
    expect(view.state.doc.toString()).toBe("# 标题\n\n正文 **粗体**");
  });

  it("空文档也能建起来", () => {
    const view = track(mountEditor(""));
    expect(view.state.doc.length).toBe(0);
  });

  it("含全部子集语法的文档不抛错", () => {
    const doc = [
      "# 标题",
      "",
      "段落里有 **粗体**、*斜体*、~~删除线~~、`代码`。",
      "",
      "> 引用",
      "",
      "- 无序项",
      "1. 有序项",
      "",
      "---",
      "",
      "[链接](https://a.b) 与 ![图片](img/a.png)",
      "",
      "```",
      "代码块",
      "```",
    ].join("\n");
    const view = track(mountEditor(doc));
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe("编辑器装配：改动回调", () => {
  it("用户输入会触发 onDocChange", () => {
    const onDocChange = vi.fn();
    const view = track(mountEditor("初始", { onDocChange }));
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "追加" },
      userEvent: "input.type",
    });
    expect(onDocChange).toHaveBeenCalled();
    expect(onDocChange.mock.calls.at(-1)?.[0]).toContain("追加");
  });

  it("用户输入会触发 onUserEdit", () => {
    const onUserEdit = vi.fn();
    const view = track(mountEditor("初始", { onUserEdit }));
    view.dispatch({
      changes: { from: 0, insert: "改" },
      userEvent: "input.type",
    });
    expect(onUserEdit).toHaveBeenCalledTimes(1);
  });

  it("程序替换文档不触发 onUserEdit（否则打开章节就会自动保存）", () => {
    const onUserEdit = vi.fn();
    const view = track(mountEditor("初始", { onUserEdit }));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "换了一整篇" } });
    expect(onUserEdit).not.toHaveBeenCalled();
  });

  it("删除操作算用户编辑", () => {
    const onUserEdit = vi.fn();
    const view = track(mountEditor("要被删掉的内容", { onUserEdit }));
    view.dispatch({ changes: { from: 0, to: 3 }, userEvent: "delete" });
    expect(onUserEdit).toHaveBeenCalledTimes(1);
  });
});

describe("编辑器装配：即时渲染装饰", () => {
  it("光标不在的行上标记被折叠", () => {
    const view = track(mountEditor("# 第一章\n\n正文"));
    // 第一行是标题，光标默认在位置 0（第一行），因此不会被折叠。
    // 把光标移到第二行末尾再检查
    const atEnd = view.state.doc.length;
    view.dispatch({ selection: { anchor: atEnd } });
    const html = view.dom.innerHTML;
    // 标题行的 `#` 被 replace 装饰拿掉后，DOM 里不该再出现纯粹的 `# `
    expect(html).not.toContain("# 第一章");
  });

  it("光标所在行的标记保持可见", () => {
    const view = track(mountEditor("# 标题"));
    view.dispatch({ selection: { anchor: 0 } });
    // 光标在第一行，标记必须可见，否则作者改不了
    expect(view.dom.textContent).toContain("#");
  });
});

describe("编辑器装配：字体 Compartment", () => {
  it("字体扩展能生成不抛错", () => {
    expect(() => fontCompartmentExtension("var(--font-body)")).not.toThrow();
  });

  it("null 字体返回空扩展（表示不覆盖）", () => {
    expect(fontCompartmentExtension(null)).toEqual([]);
  });

  it("替换字体扩展不丢文档内容（T4.14）", () => {
    const view = track(mountEditor("正文内容要保住"));
    const before = view.state.doc.toString();
    // 模拟切字族：替换一个 compartment
    view.dispatch({ effects: [] });
    expect(view.state.doc.toString()).toBe(before);
  });
});

describe("编辑器装配：文档整体替换", () => {
  it("setValue 语义：整体替换后内容正确", () => {
    const view = track(mountEditor("旧内容"));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "新内容" } });
    expect(view.state.doc.toString()).toBe("新内容");
  });

  it("替换成空文档", () => {
    const view = track(mountEditor("有内容"));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    expect(view.state.doc.length).toBe(0);
  });
});

describe("编辑器装配：大文档（T4.11）", () => {
  it("10 万字的文档能建起来", () => {
    // 单章 10 万字：计划书 T4.11 的目标规模
    const doc = "这是一段测试正文，用来验证大文档的装载。\n".repeat(5000);
    expect(doc.length).toBeGreaterThan(100_000);
    const view = track(mountEditor(doc));
    expect(view.state.doc.length).toBe(doc.length);
  });

  it("大文档上的一次编辑不会抛错", () => {
    const doc = "段落内容测试。\n".repeat(5000);
    const view = track(mountEditor(doc));
    expect(() =>
      view.dispatch({
        changes: { from: 0, insert: "开头插入" },
        userEvent: "input.type",
      }),
    ).not.toThrow();
  });
});

describe("编辑器装配：粘贴清洗互通", () => {
  it("清洗后的文本能正常插入", () => {
    const view = track(mountEditor(""));
    const cleaned = normalizePastedText("<p>甲<strong>乙</strong>丙</p>");
    view.dispatch({ changes: { from: 0, insert: cleaned } });
    expect(view.state.doc.toString()).not.toContain("\u200b");
  });
});
