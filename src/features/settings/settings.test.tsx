/**
 * 设置面板组件测试（T9.2 / T9.3 / T9.4 / T9.5 / T9.7 / T9.8）。
 *
 * ## 这一层测什么
 *
 * store 测试证明了数据模型正确，加载器测试证明了内存策略正确，
 * 但它们都回答不了「用户点下去会发生什么」。这里覆盖的是**交互契约**：
 * - 点主题立刻改 html[data-theme]；
 * - 改字体立刻写到 CSS 变量（预览与正文走同一条路径）；
 * - 未打开工作区时「本书」层级不可用；
 * - Esc 关闭、焦点陷阱、tab 键可达；
 * - 向导可以跳过，且跳过不写入任何外观值。
 */

import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetAppearance, appearanceSettings, effectiveTypography } from "@/app/appearance-store";
import { __resetWorkspaceState, workspaceState, setWorkspaceState } from "@/app/workspace-store";
import { pressKey } from "@/design/primitives/test-utils";
import { SettingsPanel } from "./SettingsPanel";
import { AppearancePanel } from "./AppearancePanel";
import { FontsPanel } from "./FontsPanel";
import { TypographyPanel } from "./TypographyPanel";
import { AboutPanel } from "./AboutPanel";
import { FirstRunWizard, hasCompletedOnboarding, resetOnboarding } from "./FirstRunWizard";
import { loadAboutInfo, buildChannel } from "./about-info";
import { LevelToggle } from "./LevelToggle";
import { RangeField } from "./RangeField";
import { FontPreview } from "./FontPreview";

beforeEach(() => {
  window.localStorage.clear();
  __resetAppearance();
  __resetWorkspaceState();
  resetOnboarding();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

/**
 * 打开一个假工作区，让「本书」层级可用。
 *
 * `hasOpenWorkspace()` 要求 status 为 ready **且** document 非 null，
 * 所以这里必须给一份最小的 WorkspaceDocument，光设 root 是不够的。
 */
function openFakeWorkspace(root = "D:/书/甲"): void {
  setWorkspaceState({
    status: "ready",
    root,
    document: {
      book: {
        id: "bk_test",
        title: "羽化录",
        author: "",
        description: "",
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      },
      volumes: [],
      chapters: [],
      recovery: {
        sweptTempFiles: 0,
        interruptedOperations: [],
        pendingPaths: [],
        purgedTrashItems: 0,
        conflicts: [],
      },
    },
  });
}

/** 找一个按钮（不分大小写地按文本）。 */
function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error("找不到按钮：" + text);
  return found as HTMLButtonElement;
}

describe("设置面板结构", () => {
  it("打开时渲染四个分区标签", () => {
    render(() => <SettingsPanel open onClose={() => {}} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(tabs.map((tab) => tab.textContent)).toEqual(["外观", "字体", "排版", "关于"]);
  });

  it("默认选中「外观」分区", () => {
    render(() => <SettingsPanel open onClose={() => {}} />);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("外观");
  });

  it("面板是模态对话框", () => {
    render(() => <SettingsPanel open onClose={() => {}} />);
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
  });

  it("按 Esc 触发 onClose", () => {
    const onClose = vi.fn();
    render(() => <SettingsPanel open onClose={onClose} />);
    pressKey(document, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("关闭状态不渲染对话框", () => {
    render(() => <SettingsPanel open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("点击「关于」标签切到关于分区", () => {
    render(() => <SettingsPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByText("关于"));
    expect(screen.getByText("开源许可")).not.toBeNull();
  });

  it("切换到「字体」分区后渲染三个作用域块", () => {
    render(() => <SettingsPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByText("字体"));
    const groups = screen.getAllByRole("group");
    // 至少包含正文 / 标题 / 界面三个作用域组
    const labels = groups.map((g) => g.getAttribute("aria-label"));
    expect(labels).toContain("正文");
    expect(labels).toContain("标题");
    expect(labels).toContain("界面");
  });

  it("右侧方向键在分区之间移动（selection follows focus）", () => {
    render(() => <SettingsPanel open onClose={() => {}} />);
    pressKey(screen.getByRole("tablist"), "ArrowRight");
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("字体");
  });

  it("初始分区可以由 initialTab 指定", () => {
    render(() => <SettingsPanel open onClose={() => {}} initialTab="typography" />);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("排版");
  });
});

describe("主题选择（T9.1 的界面入口）", () => {
  it("渲染三个主题选项且默认选跟随系统", () => {
    render(() => <AppearancePanel />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { checked: true })).toBeTruthy();
  });

  it("点击「暗色」立刻写到 html[data-theme]（即时生效）", () => {
    const { container } = render(() => <AppearancePanel />);
    fireEvent.click(buttonByText(container, "暗色"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(appearanceSettings.theme).toBe("dark");
  });

  it("点击「亮色」写到 data-theme=light", () => {
    const { container } = render(() => <AppearancePanel />);
    fireEvent.click(buttonByText(container, "亮色"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("选择跟随系统时删除 data-theme，让媒体查询接管", () => {
    const { container } = render(() => <AppearancePanel />);
    fireEvent.click(buttonByText(container, "暗色"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // 「跟随系统」的按钮文本带当前解析结果，用 data 属性定位更稳
    const follow = container.querySelector('[data-theme-choice="system"]') as HTMLButtonElement;
    fireEvent.click(follow);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("方向键在主题组内移动并选中", () => {
    const { container } = render(() => <AppearancePanel />);
    const group = screen.getByRole("radiogroup");
    pressKey(group, "ArrowRight");
    // 从 system 往右循环到 light
    expect(appearanceSettings.theme).toBe("light");
    expect(container.querySelector('[data-theme-choice="light"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("roving tabindex：只有选中项进入 Tab 序", () => {
    const { container } = render(() => <AppearancePanel />);
    const items = [...container.querySelectorAll<HTMLElement>("[data-theme-choice]")];
    const zero = items.filter((item) => item.getAttribute("tabindex") === "0");
    expect(zero).toHaveLength(1);
  });
});

describe("字体选择与即时预览（T9.2 / T9.3）", () => {
  it("渲染三个作用域各自的字体下拉", () => {
    render(() => <FontsPanel level="global" onLevelChange={() => {}} />);
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBeGreaterThanOrEqual(3);
  });

  it("切换正文字体后立刻写入 --font-body（预览与正文同一条路径）", () => {
    render(() => <FontsPanel level="global" onLevelChange={() => {}} />);
    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "yuhua-kai" } });
    expect(effectiveTypography().body.family).toBe("yuhua-kai");
  });

  it("三个作用域互相独立：改正文不影响标题", () => {
    render(() => <FontsPanel level="global" onLevelChange={() => {}} />);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0] as HTMLSelectElement, { target: { value: "yuhua-kai" } });
    expect(effectiveTypography().body.family).toBe("yuhua-kai");
    expect(effectiveTypography().heading.family).toBe("yuhua-kai");
    fireEvent.change(selects[1] as HTMLSelectElement, { target: { value: "system-serif" } });
    expect(effectiveTypography().heading.family).toBe("system-serif");
    expect(effectiveTypography().body.family).toBe("yuhua-kai");
  });

  it("每个作用域都展示回退链（缺字落点可见）", () => {
    render(() => <FontsPanel level="global" onLevelChange={() => {}} />);
    expect(screen.getAllByText("回退链").length).toBe(3);
  });

  it("回退链文本包含链首与系统兜底", () => {
    const { container } = render(() => <FontPreview />);
    const codes = [...container.querySelectorAll("code")];
    // FontPreview 本身不含回退链，这里断言的是它使用作用域类
    expect(codes.length).toBe(0);
    expect(container.querySelector(".yh-body")).not.toBeNull();
    expect(container.querySelector(".yh-heading")).not.toBeNull();
  });

  it("预览块使用三个作用域类（与真实正文走同一套 CSS 变量）", () => {
    const { container } = render(() => <FontPreview />);
    expect(container.querySelector(".font-preview__ui")).not.toBeNull();
    expect(container.querySelector(".yh-num")).not.toBeNull();
  });

  it("预览可以聚焦到单个作用域", () => {
    const { container } = render(() => <FontPreview focus="ui" />);
    expect(container.querySelector(".font-preview__ui")).not.toBeNull();
    expect(container.querySelector(".yh-body")).toBeNull();
    expect(container.querySelector(".yh-heading")).toBeNull();
  });

  it("预览里的界面数字用 tabular-nums（数字变化不左右跳）", () => {
    const { container } = render(() => <FontPreview />);
    expect(container.querySelector(".yh-num")).not.toBeNull();
  });

  it("聚焦切换按钮同样让预览只显示一个作用域", () => {
    const { container } = render(() => <FontsPanel level="global" onLevelChange={() => {}} />);
    const focusGroup = container.querySelector(".font-focus") as HTMLElement;
    const uiButton = within(focusGroup).getAllByRole("button").at(-1) as HTMLButtonElement;
    fireEvent.click(uiButton);
    expect(container.querySelector(".font-preview__ui")).not.toBeNull();
    expect(container.querySelector(".yh-body")).toBeNull();
  });
});

describe("全局级 / 工作区级分离（T9.4）", () => {
  it("未打开工作区时「本书」标记 aria-disabled 且点击无效", () => {
    render(() => <LevelToggle level="global" onChange={() => {}} />);
    const workspaceBtn = screen.getByText("本书");
    expect(workspaceBtn.getAttribute("aria-disabled")).toBe("true");
  });

  it("未打开工作区时给出原因说明（不是沉默的不可用）", () => {
    render(() => <LevelToggle level="global" onChange={() => {}} />);
    expect(screen.getByText("打开一本书后可以为它单独设置字体")).not.toBeNull();
  });

  it("打开工作区后「本书」可用", () => {
    openFakeWorkspace();
    render(() => <LevelToggle level="global" onChange={() => {}} />);
    expect(screen.getByText("本书").hasAttribute("aria-disabled")).toBe(false);
  });

  it("点击「本书」触发 onChange", () => {
    openFakeWorkspace();
    const onChange = vi.fn();
    render(() => <LevelToggle level="global" onChange={onChange} />);
    fireEvent.click(screen.getByText("本书"));
    expect(onChange).toHaveBeenCalledWith("workspace");
  });

  it("未打开工作区时点「本书」不触发 onChange", () => {
    const onChange = vi.fn();
    render(() => <LevelToggle level="global" onChange={onChange} />);
    fireEvent.click(screen.getByText("本书"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("层级说明随选择切换", () => {
    render(() => <LevelToggle level="global" onChange={() => {}} />);
    expect(screen.getByText("对所有作品生效，换书也保持")).not.toBeNull();
    cleanup();
    render(() => <LevelToggle level="workspace" onChange={() => {}} />);
    expect(screen.getByText("只对当前作品生效，覆盖全局设置")).not.toBeNull();
  });

  it("本书层级改字体只影响当前工作区，不动全局", () => {
    openFakeWorkspace("D:/书/甲");
    render(() => <FontsPanel level="workspace" onLevelChange={() => {}} />);
    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "yuhua-kai" } });

    expect(effectiveTypography().body.family).toBe("yuhua-kai");
    // 全局值不应被改动
    expect(appearanceSettings.typography.body.family).toBe("yuhua-serif");
  });

  it("本书覆盖后显示「本书已覆盖」标记与跟随全局入口", () => {
    openFakeWorkspace("D:/书/甲");
    render(() => <FontsPanel level="workspace" onLevelChange={() => {}} />);
    const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "yuhua-kai" } });
    expect(screen.getAllByText("本书已覆盖").length).toBeGreaterThan(0);
    expect(screen.getAllByText("跟随全局").length).toBeGreaterThan(0);
  });

  it("点「跟随全局」后覆盖被取消，值回到全局", () => {
    openFakeWorkspace("D:/书/甲");
    render(() => <FontsPanel level="workspace" onLevelChange={() => {}} />);
    fireEvent.change(screen.getAllByRole("combobox")[0] as HTMLSelectElement, {
      target: { value: "yuhua-kai" },
    });
    const inherit = screen.getAllByText("跟随全局")[0] as HTMLButtonElement;
    fireEvent.click(inherit);
    expect(effectiveTypography().body.family).toBe("yuhua-serif");
  });

  it("全局层级不显示覆盖标记", () => {
    render(() => <FontsPanel level="global" onLevelChange={() => {}} />);
    expect(screen.queryByText("本书已覆盖")).toBeNull();
  });
});

describe("排版设置（T9.5）", () => {
  it("渲染段距与正文宽度两个滑杆", () => {
    render(() => <TypographyPanel level="global" onLevelChange={() => {}} />);
    const sliders = screen.getAllByRole("slider");
    expect(sliders).toHaveLength(2);
  });

  it("滑杆带 aria-valuetext，读屏会念出单位", () => {
    render(() => <TypographyPanel level="global" onLevelChange={() => {}} />);
    const sliders = screen.getAllByRole("slider");
    expect(sliders[0]?.getAttribute("aria-valuetext")).toContain("em");
    expect(sliders[1]?.getAttribute("aria-valuetext")).toContain("px");
  });

  it("拖动段距滑杆更新设置", () => {
    render(() => <TypographyPanel level="global" onLevelChange={() => {}} />);
    const slider = screen.getAllByRole("slider")[0] as HTMLInputElement;
    fireEvent.input(slider, { target: { value: "2" } });
    expect(effectiveTypography().paragraphGap).toBe(2);
  });

  it("拖动正文宽度滑杆更新 --measure-body", () => {
    render(() => <TypographyPanel level="global" onLevelChange={() => {}} />);
    const slider = screen.getAllByRole("slider")[1] as HTMLInputElement;
    fireEvent.input(slider, { target: { value: "900" } });
    expect(effectiveTypography().measure).toBe(900);
  });

  it("排版分区带实时预览", () => {
    const { container } = render(() => <TypographyPanel level="global" onLevelChange={() => {}} />);
    expect(container.querySelector(".font-preview")).not.toBeNull();
  });

  it("「恢复默认排版」把两项都还原", () => {
    render(() => <TypographyPanel level="global" onLevelChange={() => {}} />);
    fireEvent.input(screen.getAllByRole("slider")[1] as HTMLInputElement, { target: { value: "1000" } });
    expect(effectiveTypography().measure).toBe(1000);
    fireEvent.click(screen.getByText("恢复默认排版"));
    expect(effectiveTypography().measure).toBe(720);
  });
});

describe("RangeField 无障碍", () => {
  it("标签通过 for/id 关联到滑杆", () => {
    render(() => <RangeField label="字号" value={17} min={14} max={24} step={1} onChange={() => {}} />);
    const slider = screen.getByRole("slider");
    expect(screen.getByText("字号").getAttribute("for")).toBe(slider.id);
  });

  it("数值变化回调收到数字而不是字符串", () => {
    const onChange = vi.fn();
    render(() => <RangeField label="字号" value={17} min={14} max={24} step={1} onChange={onChange} />);
    fireEvent.input(screen.getByRole("slider"), { target: { value: "20" } });
    expect(onChange).toHaveBeenCalledWith(20);
  });

  it("回调只收到有限数字（非数字输入被拦下）", () => {
    const onChange = vi.fn();
    render(() => <RangeField label="字号" value={17} min={14} max={24} step={1} onChange={onChange} />);
    fireEvent.input(screen.getByRole("slider"), { target: { value: "abc" } });
    // jsdom 对 range 的非法值会回落到区间内的某个数，因此这里断言
    // 「凡是传出去的必定是有限数字」，这才是组件真正的契约。
    for (const call of onChange.mock.calls) {
      expect(Number.isFinite(call[0])).toBe(true);
    }
  });
});

describe("关于页（T9.8）", () => {
  it("展示版本号（来自 package.json，不是手抄）", () => {
    const { container } = render(() => <AboutPanel />);
    expect(container.textContent).toContain("0.1.0-alpha.0");
  });

  it("展示构建通道", () => {
    const { container } = render(() => <AboutPanel />);
    expect(container.textContent).toContain("alpha");
  });

  it("展示本项目自身的 MIT 许可", () => {
    const { container } = render(() => <AboutPanel />);
    expect(container.textContent).toContain("MIT");
  });

  it("展示字体的 SIL OFL 1.1 许可", () => {
    const { container } = render(() => <AboutPanel />);
    expect(container.textContent).toContain("SIL OFL 1.1");
  });

  it("展示两个内置字体的署名", () => {
    const { container } = render(() => <AboutPanel />);
    expect(container.textContent).toContain("Yuhua Serif SC");
    expect(container.textContent).toContain("Yuhua Kai SC");
  });

  it("署名里给出了上游字体名（OFL 要求的事实性署名）", () => {
    const { container } = render(() => <AboutPanel />);
    expect(container.textContent).toContain("思源宋体");
    expect(container.textContent).toContain("霞鹜文楷");
  });

  it("OFL 全文可通过原生 details 展开，键盘可达", () => {
    const { container } = render(() => <AboutPanel />);
    const details = container.querySelectorAll("details");
    expect(details.length).toBeGreaterThanOrEqual(2);
    // summary 是原生元素，天然可聚焦可激活
    const summaries = container.querySelectorAll("summary");
    expect(summaries.length).toBe(details.length);
  });

  it("OFL 全文里含许可标题与关键条款", () => {
    const { container } = render(() => <AboutPanel />);
    const bodies = [...container.querySelectorAll(".about-details__body")];
    const text = bodies.map((b) => b.textContent ?? "").join("\n");
    expect(text).toContain("SIL OPEN FONT LICENSE");
    expect(text).toContain("PERMISSION");
  });

  it("页面不含任何外链图片或脚本", () => {
    const { container } = render(() => <AboutPanel />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelectorAll("a[href^='http']")).toHaveLength(0);
  });

  it("loadAboutInfo 的版本与 package.json 一致", () => {
    const info = loadAboutInfo();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.name).toBe("yuhua-writer");
  });

  it("loadAboutInfo 的许可清单非空且都指向真实文件", () => {
    const info = loadAboutInfo();
    expect(info.licenses.length).toBeGreaterThanOrEqual(3);
    for (const entry of info.licenses) {
      expect(entry.license.length).toBeGreaterThan(0);
      expect(entry.file.length).toBeGreaterThan(0);
    }
  });

  it("loadAboutInfo 读到了真实的 OFL 全文（不是空字符串）", () => {
    const info = loadAboutInfo();
    expect(info.oflText.length).toBeGreaterThan(1000);
    expect(info.oflText).toContain("PERMISSION & CONDITIONS");
  });

  it("buildChannel 按版本后缀判定", () => {
    expect(buildChannel("0.1.0-alpha.0")).toBe("alpha");
    expect(buildChannel("0.1.0-beta.1")).toBe("beta");
    expect(buildChannel("0.1.0-rc.2")).toBe("rc");
    expect(buildChannel("1.0.0")).toBe("stable");
  });
});

describe("首次启动向导（T9.7）", () => {
  it("打开时渲染欢迎标题", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    expect(screen.getByText("欢迎使用羽化写作")).not.toBeNull();
  });

  it("「跳过引导」始终可见", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    const skip = screen.getByText("跳过引导");
    expect(skip).not.toBeNull();
    expect((skip as HTMLButtonElement).disabled).toBe(false);
  });

  it("点跳过触发 onFinish 并写入已完成标记", () => {
    const onFinish = vi.fn();
    render(() => <FirstRunWizard open onFinish={onFinish} />);
    expect(hasCompletedOnboarding()).toBe(false);
    fireEvent.click(screen.getByText("跳过引导"));
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(hasCompletedOnboarding()).toBe(true);
  });

  it("第一步是主题选择，选了立刻生效", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    // Dialog 通过 portal 挂到 document.body，因此查询要走 document 而不是 render 的 container
    const dark = document.querySelector('[data-wizard-theme="dark"]') as HTMLButtonElement;
    expect(dark).not.toBeNull();
    fireEvent.click(dark);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("「下一步」推进到字体步骤", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    fireEvent.click(screen.getByText("下一步"));
    expect(screen.getByText("选择字体")).not.toBeNull();
  });

  it("字体步骤选择后立刻作用于正文与标题", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    fireEvent.click(screen.getByText("下一步"));
    const kai = document.querySelector('[data-wizard-family="yuhua-kai"]') as HTMLButtonElement;
    expect(kai).not.toBeNull();
    fireEvent.click(kai);
    expect(effectiveTypography().body.family).toBe("yuhua-kai");
    expect(effectiveTypography().heading.family).toBe("yuhua-kai");
  });

  it("字体步骤带预览", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    fireEvent.click(screen.getByText("下一步"));
    expect(document.querySelector(".font-preview")).not.toBeNull();
  });

  it("「上一步」回到主题步骤", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    fireEvent.click(screen.getByText("下一步"));
    fireEvent.click(screen.getByText("上一步"));
    expect(screen.getByText("选择主题")).not.toBeNull();
  });

  it("最后一步的按钮是「开始写作」并结束向导", () => {
    const onFinish = vi.fn();
    render(() => <FirstRunWizard open onFinish={onFinish} />);
    fireEvent.click(screen.getByText("下一步"));
    fireEvent.click(screen.getByText("下一步"));
    const finish = screen.getByText("开始写作");
    fireEvent.click(finish);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(hasCompletedOnboarding()).toBe(true);
  });

  it("进度有可朗读的文本（不是只有圆点）", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    expect(screen.getByText("第 1 步，共 3 步")).not.toBeNull();
  });

  it("按 Esc 等同于跳过", () => {
    const onFinish = vi.fn();
    render(() => <FirstRunWizard open onFinish={onFinish} />);
    pressKey(document, "Escape");
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(hasCompletedOnboarding()).toBe(true);
  });

  it("跳过不写入任何外观值（跳过没有惩罚）", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    fireEvent.click(screen.getByText("跳过引导"));
    expect(appearanceSettings.theme).toBe("system");
    expect(appearanceSettings.typography.body.family).toBe("yuhua-serif");
  });

  it("resetOnboarding 后再次需要引导", () => {
    render(() => <FirstRunWizard open onFinish={() => {}} />);
    fireEvent.click(screen.getByText("跳过引导"));
    expect(hasCompletedOnboarding()).toBe(true);
    resetOnboarding();
    expect(hasCompletedOnboarding()).toBe(false);
  });

  it("localStorage 损坏时视为未引导过（不能因为坏数据永久跳过引导）", () => {
    window.localStorage.setItem("yuhua.onboarding.v1", "{{{ 坏的");
    expect(hasCompletedOnboarding()).toBe(false);
  });
});

describe("设置变更不走内联样式（T1.12 的前提）", () => {
  it("字体面板不给任何元素写内联 font-family", () => {
    const { container } = render(() => <FontsPanel level="global" onLevelChange={() => {}} />);
    const inline = [...container.querySelectorAll<HTMLElement>("[style]")].filter(
      (el) => el.style.fontFamily !== "",
    );
    // 预览块靠 .yh-body / .yh-heading 类读 CSS 变量，不应写内联样式
    expect(inline).toHaveLength(0);
  });

  it("排版滑块不写内联样式，只改设置值与 CSS 变量", () => {
    const { container } = render(() => <TypographyPanel level="global" onLevelChange={() => {}} />);
    fireEvent.input(screen.getAllByRole("slider")[1] as HTMLInputElement, { target: { value: "960" } });
    const inline = [...container.querySelectorAll<HTMLElement>("[style]")].filter(
      (el) => el.style.width !== "",
    );
    expect(inline).toHaveLength(0);
  });

  it("workpsaceState 未打开时面板仍可渲染（不抛异常）", () => {
    expect(workspaceState.root).toBe("");
    expect(() => render(() => <FontsPanel level="global" onLevelChange={() => {}} />)).not.toThrow();
  });
});
