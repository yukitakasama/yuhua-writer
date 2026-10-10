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

const { listFormatsMock, exportMock, chapterMock, flushMock, saveMetaMock } =
  vi.hoisted(() => ({
    listFormatsMock: vi.fn(),
    exportMock: vi.fn(),
    chapterMock: vi.fn(),
    // 导出前的刷盘句柄（App 传进来的那个），默认成功
    flushMock: vi.fn(async () => undefined),
    // 书级元数据的写回（store 的那个动作），默认成功（见 beforeEach）
    saveMetaMock: vi.fn(),
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
  currentBook: () => ({
    title: "测试书",
    author: "旧署名",
    description: "旧简介",
  }),
  saveBookMeta: (author: string, description: string) =>
    saveMetaMock(author, description),
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
    () => (
      <ExportDialog
        open={true}
        onClose={() => undefined}
        flushEditor={flushMock}
      />
    ),
    host,
  );
  return document.body;
}

/**
 * 等微任务队列排空：一次是 createEffect 里的 IPC 往返，
 * 提交那条路还要多排几跳（刷盘 → 导出 → setResult），
 * 少排一跳就会得到「断言时结果还没落地」的假失败。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function textOf(root: HTMLElement): string {
  return root.textContent ?? "";
}

/** 往某个 id 的输入框里填值（Solid 监听的是 input 事件）。 */
function fill(root: HTMLElement, id: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(`#${id}`);
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

beforeEach(() => {
  listFormatsMock.mockReset();
  exportMock.mockReset();
  chapterMock.mockReset();
  flushMock.mockReset();
  saveMetaMock.mockReset();
  flushMock.mockResolvedValue(undefined);
  saveMetaMock.mockResolvedValue(true);
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
    fill(root, "export-path", value);
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

  /**
   * 导出前必须先落盘。
   *
   * 后端装配时按章读**磁盘**上的正文，而自动保存有 1.5 秒防抖：
   * 少了这一步，作者刚敲的那一段不在导出里，而界面上写着「导出完成」。
   */
  it("提交时先刷盘，再发导出请求", async () => {
    const order: string[] = [];
    flushMock.mockImplementation(async () => {
      // 微任务而不是定时器：settle() 只排微任务，
      // 而这里要证的是「没等到刷盘就发请求」这种顺序错乱
      await Promise.resolve();
      order.push("flushed");
    });
    exportMock.mockImplementation(async () => {
      order.push("exported");
      return { path: "D:/out/稿.txt", bytes: 10, degradations: [] };
    });
    const root = mountDialog();
    await settle();
    fillPath(root, "D:/out/稿.txt");
    clickSubmit(root);
    await settle();
    expect(order).toEqual(["flushed", "exported"]);
  });

  it("刷盘失败时不发导出请求，并说明交出去的会是旧稿", async () => {
    flushMock.mockRejectedValue(new Error("这一章没能存到磁盘上"));
    const root = mountDialog();
    await settle();
    fillPath(root, "D:/out/稿.txt");
    clickSubmit(root);
    await settle();
    expect(exportMock).not.toHaveBeenCalled();
    expect(textOf(root)).toContain("没能存到磁盘上");
    expect(textOf(root)).not.toContain("导出完成");
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

/**
 * 导出面板里的书级元数据（作者 / 简介）。
 *
 * ## 为什么入口放在这里
 *
 * 作者是**这本书**的属性：填一次要记住（存进 workspace.json），
 * 且每一次导出都会用到它。导出对话框是作者唯一会想到「署名要对」的时刻，
 * 所以入口与用它的那一步放在一起，而不是散到设置页里去。
 */
describe("导出对话框：本书信息", () => {
  it("作者与简介预填当前书里存着的值", async () => {
    const root = mountDialog();
    await settle();
    expect(root.querySelector<HTMLInputElement>("#export-author")?.value).toBe(
      "旧署名",
    );
    expect(
      root.querySelector<HTMLTextAreaElement>("#export-description")?.value,
    ).toBe("旧简介");
  });

  /**
   * 顺序很重要：刷盘 → 写回署名 → 导出。
   *
   * 后端装配导出内容时读的是**内存文稿里的署名**，而内存只在写回成功之后
   * 才更新；先导出后写回等于交出一份署着旧名的稿子，界面上还写着「导出完成」。
   */
  it("改了作者时按「刷盘 → 写回署名 → 导出」的顺序走", async () => {
    const order: string[] = [];
    exportMock.mockImplementation(async () => {
      order.push("exported");
      return { path: "D:/out/稿.txt", bytes: 10, degradations: [] };
    });
    flushMock.mockImplementation(async () => {
      await Promise.resolve();
      order.push("flushed");
    });
    saveMetaMock.mockImplementation(async () => {
      await Promise.resolve();
      order.push("meta");
      return true;
    });

    const root = mountDialog();
    await settle();
    fill(root, "export-author", "四月");
    fill(root, "export-path", "D:/out/稿.txt");
    clickSubmit(root);
    await settle();

    expect(order).toEqual(["flushed", "meta", "exported"]);
    expect(saveMetaMock).toHaveBeenCalledWith("四月", "旧简介");
  });

  it("署名写不回工作区时不发导出请求，并说清交出去的是旧署名", async () => {
    saveMetaMock.mockResolvedValue(false);
    const root = mountDialog();
    await settle();
    fill(root, "export-author", "四月");
    fill(root, "export-path", "D:/out/稿.txt");
    clickSubmit(root);
    await settle();

    expect(exportMock).not.toHaveBeenCalled();
    expect(textOf(root)).toContain("导出已取消");
    expect(textOf(root)).not.toContain("导出完成");
  });

  it("一个字都没改时不重写工作区配置", async () => {
    exportMock.mockResolvedValue({
      path: "D:/out/稿.txt",
      bytes: 10,
      degradations: [],
    });
    const root = mountDialog();
    await settle();
    fill(root, "export-path", "D:/out/稿.txt");
    clickSubmit(root);
    await settle();

    expect(saveMetaMock).not.toHaveBeenCalled();
    expect(exportMock).toHaveBeenCalled();
  });
});
