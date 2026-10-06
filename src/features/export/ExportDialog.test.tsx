/**
 * 导出对话框测试。
 *
 * 覆盖 NEXT-STEPS 里列的验收项：格式列表渲染、不可用格式（PDF）的
 * 显式标注、范围选择的退化、保存位置缺失时的拦截、降级记录展示、
 * 以及导出失败的错误呈现。
 *
 * ## 为什么打桩 `@/lib/ipc` 而不是用 mock 后端
 *
 * mock 后端的 `exportDocument` 恒定返回空的 `degradations`，
 * 而「降级记录必须展示」恰恰是这个对话框最不能省的行为 ——
 * 导出成功但内容被悄悄改写，比失败更难发现。要打这条就得能
 * 指定返回值，所以直接打桩 IPC 层。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

const { listFormatsMock, exportMock, chapterMock } = vi.hoisted(() => ({
  listFormatsMock: vi.fn(),
  exportMock: vi.fn(),
  chapterMock: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  listExportFormats: () => listFormatsMock(),
  exportDocument: (format: unknown, scope: unknown, path: unknown) =>
    exportMock(format, scope, path),
  // 浏览器降级模式：不弹原生对话框，路径靠手输
  isTauri: () => false,
  toFailure: (err: unknown) => ({
    error: {
      code: "TEST",
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
      detail: null,
    },
  }),
}));

vi.mock("@/app/workspace-store", () => ({
  hasOpenWorkspace: () => true,
  selectedChapter: () => chapterMock(),
  currentBook: () => ({ title: "测试书" }),
}));

import { ExportDialog } from "./ExportDialog";

const FORMATS = [
  { id: "txt", displayName: "纯文本", extension: "txt", available: true },
  { id: "markdown", displayName: "Markdown", extension: "md", available: true },
  { id: "docx", displayName: "Word 文档", extension: "docx", available: true },
  { id: "epub", displayName: "EPUB", extension: "epub", available: true },
  // 故意把 PDF 标成不可用：验证「禁用 + 标注」这条路径确实生效
  // （后端 today 六种格式全可用，禁用逻辑只能靠夹具驱动）
  { id: "pdf", displayName: "PDF", extension: "pdf", available: false },
];

const CHAPTER = { id: "ch_a", volumeId: "vol_1", title: "第一章 落羽" };

let dispose: (() => void) | null = null;

/** Dialog 会 Portal 到 body，所以查询根必须是 document.body。 */
function mountDialog(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => <ExportDialog open={true} onClose={() => undefined} />,
    host,
  );
  return document.body;
}

/** 等一次微任务队列排空，让 createEffect 里的 IPC 往返落地。 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function textOf(root: HTMLElement): string {
  return root.textContent ?? "";
}

beforeEach(() => {
  listFormatsMock.mockReset();
  exportMock.mockReset();
  chapterMock.mockReset();
  listFormatsMock.mockResolvedValue(FORMATS);
  chapterMock.mockReturnValue(CHAPTER);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
});

describe("导出对话框：格式", () => {
  it("打开时列出后端给的格式", async () => {
    const root = mountDialog();
    await settle();
    const text = textOf(root);
    expect(text).toContain("纯文本");
    expect(text).toContain("Markdown");
    expect(text).toContain("EPUB");
  });

  it("不可用的格式被禁用并标注原因，不会被默认选中", async () => {
    const root = mountDialog();
    await settle();
    const radios = Array.from(
      root.querySelectorAll<HTMLInputElement>("input[name='export-format']"),
    );
    const pdf = radios.find((r) => r.value === "pdf");
    expect(pdf).toBeDefined();
    expect(pdf?.disabled).toBe(true);
    expect(pdf?.checked).toBe(false);
    expect(textOf(root)).toContain("当前构建不支持");
    // 默认落在第一个可用格式上
    expect(radios.find((r) => r.checked)?.value).toBe("txt");
  });
});

describe("导出对话框：范围", () => {
  it("有选中章时三种范围都可选", async () => {
    const root = mountDialog();
    await settle();
    const radios = Array.from(
      root.querySelectorAll<HTMLInputElement>("input[name='export-scope']"),
    );
    expect(radios).toHaveLength(3);
    expect(radios.every((r) => !r.disabled)).toBe(true);
  });

  it("没有选中章时，「当前卷 / 当前章」被禁用而不是让人选完再报错", async () => {
    chapterMock.mockReturnValue(null);
    const root = mountDialog();
    await settle();
    const radios = Array.from(
      root.querySelectorAll<HTMLInputElement>("input[name='export-scope']"),
    );
    const byValue = (v: string) => radios.find((r) => r.value === v);
    expect(byValue("whole")?.disabled).toBe(false);
    expect(byValue("volume")?.disabled).toBe(true);
    expect(byValue("single")?.disabled).toBe(true);
  });
});

describe("导出对话框：提交", () => {
  /** 在路径框里填值（Solid 监听 input 事件）。 */
  function fillPath(root: HTMLElement, value: string): void {
    const input = root.querySelector<HTMLInputElement>("#export-path");
    expect(input).not.toBeNull();
    input!.value = value;
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function clickSubmit(root: HTMLElement): void {
    const buttons = Array.from(root.querySelectorAll("button"));
    const submit = buttons.find((b) => b.textContent?.includes("导出"));
    expect(submit).toBeDefined();
    submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  it("没填保存位置时拦住提交，不发请求", async () => {
    const root = mountDialog();
    await settle();
    clickSubmit(root);
    await settle();
    expect(exportMock).not.toHaveBeenCalled();
    expect(textOf(root)).toContain("请先选择保存位置");
  });

  it("按所选格式与范围调用后端，并展示结果路径", async () => {
    exportMock.mockResolvedValue({
      path: "D:/out/测试书.epub",
      bytes: 2048,
      degradations: [],
    });
    const root = mountDialog();
    await settle();

    // 选 EPUB + 当前章
    const formatRadio = Array.from(
      root.querySelectorAll<HTMLInputElement>("input[name='export-format']"),
    ).find((r) => r.value === "epub");
    formatRadio!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const scopeRadio = Array.from(
      root.querySelectorAll<HTMLInputElement>("input[name='export-scope']"),
    ).find((r) => r.value === "single");
    scopeRadio!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    fillPath(root, "D:/out/测试书.epub");
    clickSubmit(root);
    await settle();

    expect(exportMock).toHaveBeenCalledWith(
      "epub",
      { type: "single", chapterId: "ch_a" },
      "D:/out/测试书.epub",
    );
    expect(textOf(root)).toContain("导出完成");
    expect(textOf(root)).toContain("D:/out/测试书.epub");
    expect(textOf(root)).toContain("2.0 KB");
    expect(textOf(root)).toContain("全部内容原样导出");
  });

  it("「当前卷」把选中章所属的卷 ID 发给后端", async () => {
    exportMock.mockResolvedValue({ path: "p", bytes: 10, degradations: [] });
    const root = mountDialog();
    await settle();
    const scopeRadio = Array.from(
      root.querySelectorAll<HTMLInputElement>("input[name='export-scope']"),
    ).find((r) => r.value === "volume");
    scopeRadio!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    fillPath(root, "p");
    clickSubmit(root);
    await settle();
    expect(exportMock).toHaveBeenCalledWith(
      "txt",
      { type: "volume", volumeId: "vol_1" },
      "p",
    );
  });

  it("降级记录逐条展示，附章标题", async () => {
    exportMock.mockResolvedValue({
      path: "D:/out/测试书.docx",
      bytes: 30720,
      degradations: [
        {
          chapterTitle: "第一章 落羽",
          kind: "table",
          detail: "表格已转为纯文本",
        },
        {
          chapterTitle: "第二章 风起",
          kind: "image",
          detail: "［图片：封面］",
        },
      ],
    });
    const root = mountDialog();
    await settle();
    fillPath(root, "D:/out/测试书.docx");
    clickSubmit(root);
    await settle();

    const text = textOf(root);
    expect(text).toContain("有 2 处内容被降级");
    expect(text).toContain("第一章 落羽：表格已转为纯文本");
    expect(text).toContain("第二章 风起：［图片：封面］");
    // 成功了也要说清有降级，不能只报喜
    expect(text).toContain("导出完成");
  });

  it("后端报错时把消息呈现出来，不停在成功态", async () => {
    exportMock.mockRejectedValue(new Error("PDF 渲染器未实现"));
    const root = mountDialog();
    await settle();
    fillPath(root, "D:/out/x.pdf");
    clickSubmit(root);
    await settle();

    expect(textOf(root)).toContain("PDF 渲染器未实现");
    expect(textOf(root)).not.toContain("导出完成");
  });
});
