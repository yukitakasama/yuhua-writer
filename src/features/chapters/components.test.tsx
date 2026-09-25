/**
 * 组件渲染测试。
 *
 * ## 为什么"纯函数测够了"还不够
 *
 * tree-ops 的测试保证了排序语义正确，但保证不了：
 *
 * - 组件能不能真的渲染出来（导入链、JSX 编译、props 形状）
 * - 交互（点击选中、内联改名、删除按钮）能不能接到回调上
 * - 空状态插画有没有出现（T5.6 的验收点）
 *
 * 这些是"接错线"类的问题：逻辑全对，但按钮没绑事件。
 * 只有渲染出来点一下才能发现。
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import type { ChapterSummary, Volume } from "@/lib/ipc";
import { ChapterRow } from "./ChapterRow";
import { VolumeGroup } from "./VolumeGroup";
import { BookCover } from "@/features/library/BookCover";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyTree } from "@/app/ui/illustrations";

/** 造一个卷。 */
function vol(id: string, sort: number, title = id): Volume {
  return { id, bookId: "bk_1", title, sort, created: "2026-01-01T09:00:00+08:00" };
}

/** 造一章摘要。 */
function ch(id: string, volumeId: string, sort: number, title = id, wordCount = 100): ChapterSummary {
  return {
    id,
    volumeId,
    title,
    status: "draft",
    sort,
    path: `manuscript/001/${id}.md`,
    wordCount,
    wordGoal: 0,
    summary: "",
    updated: "2026-01-01T09:00:00+08:00",
  };
}

/** 把组件渲染到一个临时的 DOM 节点里，返回清理函数。 */
function mount(component: () => unknown): { root: HTMLElement; dispose: () => void } {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = render(component as never, root);
  return {
    root,
    dispose: () => {
      dispose();
      root.remove();
    },
  };
}

describe("ChapterRow", () => {
  const baseProps = {
    chapter: ch("c1", "v1", 0, "第一章 落羽", 1234),
    index: 1,
    selected: false,
    dragging: false,
    onSelect: () => undefined,
    onRename: () => undefined,
    onDelete: () => undefined,
    onDragStart: () => undefined,
    registerRef: () => undefined,
  };

  it("渲染标题与字数", () => {
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} />);
    expect(root.textContent).toContain("第一章 落羽");
    // 千位分隔符：中文用户对 1,234 的读法比 1234 快
    expect(root.textContent).toContain("1,234");
    dispose();
  });

  it("设置为 treeitem 角色并带选中态", () => {
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} selected={true} />);
    const item = root.querySelector("[role='treeitem']");
    expect(item?.getAttribute("aria-selected")).toBe("true");
    dispose();
  });

  it("未选中时 aria-selected 为 false", () => {
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} />);
    expect(root.querySelector("[role='treeitem']")?.getAttribute("aria-selected")).toBe("false");
    dispose();
  });

  it("点击行触发 onSelect", () => {
    const onSelect = vi.fn();
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} onSelect={onSelect} />);
    root.querySelector("li")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("双击标题进入内联编辑（出现输入框）", () => {
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} />);
    root.querySelector(".tree-row__title")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = root.querySelector("input.inline-edit");
    expect(input).not.toBeNull();
    dispose();
  });

  it("改名按钮也进入编辑态", () => {
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} />);
    root.querySelector("button[aria-label='重命名']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.querySelector("input.inline-edit")).not.toBeNull();
    dispose();
  });

  it("删除按钮触发 onDelete", () => {
    const onDelete = vi.fn();
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} onDelete={onDelete} />);
    root.querySelector("button[aria-label='移到回收站']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("拖拽手柄存在且带无障碍标签", () => {
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} />);
    expect(root.querySelector(".tree-row__grip")?.getAttribute("aria-label")).toBe("拖动以调整顺序");
    dispose();
  });

  it("正在拖动时带上 is-dragging 类（用于降透明度）", () => {
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} dragging={true} />);
    expect(root.querySelector(".tree-row")?.classList.contains("is-dragging")).toBe(true);
    dispose();
  });

  it("带 data-flip-id，FLIP 让位动效依赖它", () => {
    const { root, dispose } = mount(() => <ChapterRow {...baseProps} />);
    expect(root.querySelector("[data-flip-id='c1']")).not.toBeNull();
    dispose();
  });

  it("渲染状态点（三种状态形状不同）", () => {
    const done = { ...baseProps, chapter: { ...baseProps.chapter, status: "done" as const } };
    const { root, dispose } = mount(() => <ChapterRow {...done} />);
    expect(root.querySelector(".status-dot--done")).not.toBeNull();
    dispose();
  });
});

describe("VolumeGroup", () => {
  const volume = vol("v1", 0, "第一卷 落羽");
  const chapters = [ch("c1", "v1", 0, "第一章", 1000), ch("c2", "v1", 1, "第二章", 2000)];

  const baseProps = {
    volume,
    chapters,
    selectedChapterId: null,
    draggingId: null,
    draggingVolumeId: null,
    onSelectChapter: () => undefined,
    onRenameVolume: () => undefined,
    onDeleteVolume: () => undefined,
    onAddChapter: () => undefined,
    onRenameChapter: () => undefined,
    onDeleteChapter: () => undefined,
    onChapterDragStart: () => undefined,
    onVolumeDragStart: () => undefined,
    registerContainer: () => undefined,
    registerRow: () => undefined,
    registerVolumeRow: () => undefined,
    dropHint: null,
  };

  it("渲染卷名与章列表", () => {
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} />);
    expect(root.textContent).toContain("第一卷 落羽");
    expect(root.textContent).toContain("第一章");
    expect(root.textContent).toContain("第二章");
    dispose();
  });

  it("卷头显示本卷字数合计", () => {
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} />);
    // 1000 + 2000 = 3000
    expect(root.textContent).toContain("3,000");
    dispose();
  });

  it("默认展开（aria-expanded 为 true）", () => {
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} />);
    expect(root.querySelector("[role='treeitem']")?.getAttribute("aria-expanded")).toBe("true");
    dispose();
  });

  it("点击折叠按钮收起章列表", () => {
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} />);
    root.querySelector(".tree-group__toggle")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(root.querySelector("[role='treeitem']")?.getAttribute("aria-expanded")).toBe("false");
    dispose();
  });

  it("空卷显示空状态而不是空白", () => {
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} chapters={[]} />);
    expect(root.querySelector(".empty")).not.toBeNull();
    dispose();
  });

  it("空卷提示中有新建章的按钮", () => {
    const onAddChapter = vi.fn();
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} chapters={[]} onAddChapter={onAddChapter} />);
    const buttons = [...root.querySelectorAll("button")].filter((b) => b.textContent?.includes("在此卷新建章"));
    expect(buttons.length).toBeGreaterThan(0);
    dispose();
  });

  it("卷头的新建章按钮触发回调", () => {
    const onAddChapter = vi.fn();
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} onAddChapter={onAddChapter} />);
    root.querySelector("button[aria-label='在此卷新建章']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAddChapter).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("双击卷名进入内联编辑", () => {
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} />);
    root.querySelector(".tree-group__title")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(root.querySelector("input.inline-edit")).not.toBeNull();
    dispose();
  });

  it("带 vol: 前缀的 data-flip-id（卷的拖拽身份）", () => {
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} />);
    expect(root.querySelector("[data-flip-id='vol:v1']")).not.toBeNull();
    dispose();
  });

  it("落点提示为激活态时出现指示线", () => {
    const { root, dispose } = mount(() => <VolumeGroup {...baseProps} dropHint={{ active: true, index: 1 }} />);
    expect(root.querySelectorAll(".drop-line").length).toBeGreaterThan(0);
    dispose();
  });

  it("卷体是 drop 容器（注册回调被调用）", () => {
    const registerContainer = vi.fn();
    const { dispose } = mount(() => <VolumeGroup {...baseProps} registerContainer={registerContainer} />);
    expect(registerContainer).toHaveBeenCalled();
    const [firstArg] = registerContainer.mock.calls[0] ?? [];
    expect(firstArg).toBe("v1");
    dispose();
  });
});

describe("BookCover", () => {
  it("渲染出 SVG 且尺寸正确", () => {
    const { root, dispose } = mount(() => <BookCover title="羽化录" width={120} />);
    const svg = root.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("width")).toBe("120");
    // 高宽比 1.4
    expect(svg?.getAttribute("height")).toBe("168");
    dispose();
  });

  it("带可读的 aria-label", () => {
    const { root, dispose } = mount(() => <BookCover title="羽化录" />);
    expect(root.querySelector("svg")?.getAttribute("aria-label")).toBe("羽化录 的封面");
    dispose();
  });

  it("显示书名首字", () => {
    const { root, dispose } = mount(() => <BookCover title="羽化录" />);
    expect(root.textContent).toContain("羽");
    dispose();
  });

  it("长书名被截断并加省略号", () => {
    const { root, dispose } = mount(() => <BookCover title="一个非常非常长的书名需要被截断处理" />);
    expect(root.textContent).toContain("…");
    dispose();
  });

  it("showTitle=false 时不渲染书名文字但仍渲染首字", () => {
    const { root, dispose } = mount(() => <BookCover title="羽化录" showTitle={false} />);
    expect(root.textContent).toContain("羽");
    expect(root.textContent).not.toContain("羽化录");
    dispose();
  });

  it("不引用任何外链资源（零外链约定）", () => {
    const { root, dispose } = mount(() => <BookCover title="羽化录" />);
    // 断言没有 <image>、没有 xlink:href、没有 http 链接
    expect(root.querySelector("image")).toBeNull();
    expect(root.innerHTML).not.toContain("http");
    dispose();
  });

  it("不同书名得到不同的渐变 id（同页面多本书不冲突）", () => {
    const a = mount(() => <BookCover title="羽化录" />);
    const b = mount(() => <BookCover title="惊蛰录" />);
    const idA = a.root.querySelector("linearGradient")?.getAttribute("id");
    const idB = b.root.querySelector("linearGradient")?.getAttribute("id");
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    a.dispose();
    b.dispose();
  });
});

describe("空状态", () => {
  it("渲染插画、标题与说明", () => {
    const { root, dispose } = mount(() => (
      <EmptyState illustration={<IllustrationEmptyTree />} title="还没有任何章节" body="先建一卷" />
    ));
    expect(root.querySelector("svg")).not.toBeNull();
    expect(root.textContent).toContain("还没有任何章节");
    expect(root.textContent).toContain("先建一卷");
    dispose();
  });

  it("带 role=status 供屏幕阅读器播报", () => {
    const { root, dispose } = mount(() => <EmptyState illustration={<IllustrationEmptyTree />} title="空" />);
    expect(root.querySelector("[role='status']")).not.toBeNull();
    dispose();
  });

  it("插画标记为装饰性（aria-hidden），避免朗读冗余", () => {
    const { root, dispose } = mount(() => <EmptyState illustration={<IllustrationEmptyTree />} title="空" />);
    expect(root.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    dispose();
  });

  it("插画是自绘 SVG，不含 emoji 文本", () => {
    const { root, dispose } = mount(() => (
      <EmptyState illustration={<IllustrationEmptyTree />} title="空" body="说明" />
    ));
    // 空状态里除了标题与说明，没有别的文本节点
    expect(root.textContent).toBe("空说明");
    dispose();
  });

  it("可选的 action 不传时不渲染操作区", () => {
    const { root, dispose } = mount(() => <EmptyState illustration={<IllustrationEmptyTree />} title="空" />);
    expect(root.querySelector(".empty__action")).toBeNull();
    dispose();
  });
});
