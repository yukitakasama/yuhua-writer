/**
 * 外观设置 store 测试（T9.2 / T9.4 / T9.5）。
 *
 * 重点与 layout-store 一致：**脏数据不能把界面搞坏**。
 * 另外这里还覆盖了本模块独有的两件事：
 * 全局级 / 工作区级的合并优先级，以及越界数值的夹紧。
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  BODY_SIZE_MAX,
  BODY_SIZE_MIN,
  DEFAULT_APPEARANCE,
  HEADING_SIZE_MAX,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  MEASURE_MAX,
  MEASURE_MIN,
  PARAGRAPH_GAP_MAX,
  UI_SIZE_MIN,
  __resetAppearance,
  appearanceSettings,
  clearWorkspaceAppearance,
  effectiveTheme,
  effectiveTypography,
  isScopeOverridden,
  loadAppearance,
  loadWorkspaceAppearance,
  normalizeAppearance,
  normalizeWorkspaceAppearance,
  resetAppearance,
  setAppearanceWorkspace,
  setMeasure,
  setParagraphGap,
  setScopeTypography,
  setTheme,
  setWorkspaceScope,
  setWorkspaceTheme,
  setWorkspaceTypography,
  workspaceAppearance,
  workspaceKey,
} from "./appearance-store";

beforeEach(() => {
  window.localStorage.clear();
  __resetAppearance();
  window.localStorage.clear();
});

describe("normalizeAppearance", () => {
  it("空输入返回默认外观", () => {
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({})).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance("乱写的")).toEqual(DEFAULT_APPEARANCE);
  });

  it("合法值被保留", () => {
    const result = normalizeAppearance({
      theme: "dark",
      typography: {
        body: { family: "yuhua-kai", size: 19, lineHeight: 2.0 },
        heading: { family: "system-kai", size: 24, lineHeight: 1.5 },
        ui: { family: "system-ui", size: 14, lineHeight: 1.5 },
        paragraphGap: 1.5,
        measure: 800,
      },
    });
    expect(result.theme).toBe("dark");
    expect(result.typography.body.family).toBe("yuhua-kai");
    expect(result.typography.body.size).toBe(19);
    expect(result.typography.measure).toBe(800);
  });

  it("非法主题回退到 system", () => {
    expect(normalizeAppearance({ theme: "紫色" }).theme).toBe("system");
  });

  it("超出的字号被夹到上限", () => {
    expect(normalizeAppearance({ typography: { body: { size: 999 } } }).typography.body.size).toBe(BODY_SIZE_MAX);
  });

  it("过小的字号被夹到下限", () => {
    expect(normalizeAppearance({ typography: { body: { size: 1 } } }).typography.body.size).toBe(BODY_SIZE_MIN);
  });

  it("标题与界面作用域用各自的区间，不共用正文的上下限", () => {
    const result = normalizeAppearance({
      typography: { heading: { size: 999 }, ui: { size: 1 } },
    });
    expect(result.typography.heading.size).toBe(HEADING_SIZE_MAX);
    expect(result.typography.ui.size).toBe(UI_SIZE_MIN);
  });

  it("行距被夹到区间内", () => {
    expect(normalizeAppearance({ typography: { body: { lineHeight: 99 } } }).typography.body.lineHeight).toBe(LINE_HEIGHT_MAX);
    expect(normalizeAppearance({ typography: { body: { lineHeight: 0.1 } } }).typography.body.lineHeight).toBe(LINE_HEIGHT_MIN);
  });

  it("正文宽度被夹到区间内", () => {
    expect(normalizeAppearance({ typography: { measure: 99999 } }).typography.measure).toBe(MEASURE_MAX);
    expect(normalizeAppearance({ typography: { measure: 10 } }).typography.measure).toBe(MEASURE_MIN);
  });

  it("段距被夹到区间内", () => {
    expect(normalizeAppearance({ typography: { paragraphGap: 99 } }).typography.paragraphGap).toBe(PARAGRAPH_GAP_MAX);
    expect(normalizeAppearance({ typography: { paragraphGap: -5 } }).typography.paragraphGap).toBe(0);
  });

  it("NaN / Infinity 回退到默认值而不是产生 NaN 字号", () => {
    expect(normalizeAppearance({ typography: { body: { size: Number.NaN } } }).typography.body.size).toBe(
      DEFAULT_APPEARANCE.typography.body.size,
    );
    expect(normalizeAppearance({ typography: { measure: Number.POSITIVE_INFINITY } }).typography.measure).toBe(
      DEFAULT_APPEARANCE.typography.measure,
    );
  });

  it("字符串数值被忽略（localStorage 可能被手改）", () => {
    expect(normalizeAppearance({ typography: { body: { size: "很大" as never } } }).typography.body.size).toBe(
      DEFAULT_APPEARANCE.typography.body.size,
    );
  });

  it("空字符串字体族被忽略", () => {
    expect(normalizeAppearance({ typography: { body: { family: "" } } }).typography.body.family).toBe(
      DEFAULT_APPEARANCE.typography.body.family,
    );
  });

  it("字号取整到一位小数（避免浮点尾巴写进 JSON）", () => {
    expect(normalizeAppearance({ typography: { body: { size: 17.28 } } }).typography.body.size).toBe(17.3);
  });
});

describe("normalizeWorkspaceAppearance", () => {
  it("空输入返回空覆盖（一切跟随全局）", () => {
    expect(normalizeWorkspaceAppearance(null)).toEqual({});
    expect(normalizeWorkspaceAppearance({})).toEqual({});
    expect(normalizeWorkspaceAppearance([])).toEqual({});
  });

  it("只保留实际给出的字段", () => {
    const result = normalizeWorkspaceAppearance({ typography: { body: { family: "yuhua-kai" } } });
    expect(result.typography?.body).toEqual({ family: "yuhua-kai" });
    // 没有给出的字段不应出现：出现即意味着「已覆盖」，会错误地打断继承
    expect(result.typography?.body && "size" in result.typography.body).toBe(false);
  });

  it("越界值被夹紧而不是丢弃", () => {
    const result = normalizeWorkspaceAppearance({ typography: { body: { size: 999 } } });
    expect(result.typography?.body?.size).toBe(BODY_SIZE_MAX);
  });

  it("主题覆盖被保留", () => {
    expect(normalizeWorkspaceAppearance({ theme: "dark" }).theme).toBe("dark");
    expect(normalizeWorkspaceAppearance({ theme: "乱写" as never }).theme).toBeUndefined();
  });
});

describe("全局设置写入", () => {
  it("设置主题并持久化", () => {
    setTheme("dark");
    expect(appearanceSettings.theme).toBe("dark");
    expect(loadAppearance().theme).toBe("dark");
  });

  it("设置字体族", () => {
    setScopeTypography("body", { family: "yuhua-kai" });
    expect(appearanceSettings.typography.body.family).toBe("yuhua-kai");
  });

  it("设置字号时自动夹紧", () => {
    setScopeTypography("body", { size: 999 });
    expect(appearanceSettings.typography.body.size).toBe(BODY_SIZE_MAX);
    setScopeTypography("body", { size: 1 });
    expect(appearanceSettings.typography.body.size).toBe(BODY_SIZE_MIN);
  });

  it("设置行距时自动夹紧", () => {
    setScopeTypography("heading", { lineHeight: 99 });
    expect(appearanceSettings.typography.heading.lineHeight).toBe(LINE_HEIGHT_MAX);
  });

  it("只写给出的字段，其余保持不变", () => {
    setScopeTypography("body", { size: 20 });
    expect(appearanceSettings.typography.body.family).toBe(DEFAULT_APPEARANCE.typography.body.family);
  });

  it("设置段距与正文宽度", () => {
    setParagraphGap(2);
    setMeasure(900);
    expect(appearanceSettings.typography.paragraphGap).toBe(2);
    expect(appearanceSettings.typography.measure).toBe(900);
  });

  it("段距与宽度越界被夹紧", () => {
    setParagraphGap(99);
    setMeasure(1);
    expect(appearanceSettings.typography.paragraphGap).toBe(PARAGRAPH_GAP_MAX);
    expect(appearanceSettings.typography.measure).toBe(MEASURE_MIN);
  });

  it("resetAppearance 恢复默认值", () => {
    setTheme("dark");
    setMeasure(1000);
    resetAppearance();
    expect(appearanceSettings.theme).toBe(DEFAULT_APPEARANCE.theme);
    expect(appearanceSettings.typography.measure).toBe(DEFAULT_APPEARANCE.typography.measure);
  });

  it("localStorage 里是坏 JSON 时回退默认而不抛异常", () => {
    window.localStorage.setItem("yuhua.appearance.v1", "{ 不是 JSON");
    expect(() => loadAppearance()).not.toThrow();
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it("localStorage 里是数组时回退默认", () => {
    window.localStorage.setItem("yuhua.appearance.v1", "[1,2,3]");
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
  });
});

describe("工作区键", () => {
  it("同一路径得到同一个键", () => {
    expect(workspaceKey("D:/书/羽化录")).toBe(workspaceKey("D:/书/羽化录"));
  });

  it("不同路径得到不同的键", () => {
    expect(workspaceKey("D:/书/甲")).not.toBe(workspaceKey("D:/书/乙"));
  });

  it("键长度固定且短（不把整条路径写进 localStorage 键名）", () => {
    const key = workspaceKey("D:/一个非常深的目录/再深一层/还是深/作品");
    expect(key.startsWith("appearance.workspace.v1.")).toBe(true);
    expect(key.length).toBe("appearance.workspace.v1.".length + 8);
  });
});

describe("全局级 / 工作区级合并（T9.4）", () => {
  it("没有工作区时生效值就是全局值", () => {
    setTheme("light");
    expect(effectiveTheme()).toBe("light");
  });

  it("工作区覆盖主题后优先用工作区的", () => {
    setTheme("light");
    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceTheme("dark");
    expect(effectiveTheme()).toBe("dark");
  });

  it("工作区没有覆盖主题时跟随全局", () => {
    setTheme("dark");
    setAppearanceWorkspace("D:/书/甲");
    expect(effectiveTheme()).toBe("dark");
  });

  it("工作区逐字段覆盖：只改字体族不影响字号", () => {
    setScopeTypography("body", { family: "yuhua-serif", size: 19 });
    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceScope("body", { family: "yuhua-kai" });

    const typo = effectiveTypography();
    expect(typo.body.family).toBe("yuhua-kai");
    // 字号没有被覆盖，应仍是全局的 19
    expect(typo.body.size).toBe(19);
  });

  it("全局改了以后，未被覆盖的字段会跟着变", () => {
    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceScope("body", { family: "yuhua-kai" });
    setScopeTypography("body", { size: 21 });
    expect(effectiveTypography().body.size).toBe(21);
  });

  it("取消覆盖后回到全局值", () => {
    setScopeTypography("heading", { family: "yuhua-serif" });
    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceScope("heading", { family: "yuhua-kai" });
    expect(effectiveTypography().heading.family).toBe("yuhua-kai");

    setWorkspaceScope("heading", { family: undefined });
    expect(effectiveTypography().heading.family).toBe("yuhua-serif");
  });

  it("切换工作区时各自的覆盖互不干扰", () => {
    setScopeTypography("body", { size: 17 });

    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceScope("body", { size: 22 });
    expect(effectiveTypography().body.size).toBe(22);

    setAppearanceWorkspace("D:/书/乙");
    expect(effectiveTypography().body.size).toBe(17);

    setAppearanceWorkspace("D:/书/甲");
    expect(effectiveTypography().body.size).toBe(22);
  });

  it("关闭工作区（空路径）后覆盖全部失效", () => {
    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceScope("body", { size: 22 });
    setAppearanceWorkspace("");
    expect(effectiveTypography().body.size).toBe(DEFAULT_APPEARANCE.typography.body.size);
  });

  it("段距与宽度也支持工作区覆盖", () => {
    setParagraphGap(1);
    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceTypography({ paragraphGap: 2, measure: 900 });
    const typo = effectiveTypography();
    expect(typo.paragraphGap).toBe(2);
    expect(typo.measure).toBe(900);
  });

  it("没有打开工作区时写入工作区设置是空操作", () => {
    setAppearanceWorkspace("");
    expect(() => setWorkspaceScope("body", { size: 20 })).not.toThrow();
    expect(workspaceAppearance.value).toEqual({});
  });

  it("isScopeOverridden 反映真实的覆盖状态", () => {
    setAppearanceWorkspace("D:/书/甲");
    expect(isScopeOverridden("body")).toBe(false);
    setWorkspaceScope("body", { size: 20 });
    expect(isScopeOverridden("body")).toBe(true);
    expect(isScopeOverridden("ui")).toBe(false);
  });

  it("清除工作区覆盖后回到全局", () => {
    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceScope("body", { size: 22 });
    clearWorkspaceAppearance("D:/书/甲");
    expect(effectiveTypography().body.size).toBe(DEFAULT_APPEARANCE.typography.body.size);
    expect(loadWorkspaceAppearance("D:/书/甲")).toEqual({});
  });

  it("工作区覆盖被持久化到 localStorage", () => {
    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceScope("body", { family: "yuhua-kai" });
    expect(loadWorkspaceAppearance("D:/书/甲").typography?.body?.family).toBe("yuhua-kai");
  });

  it("工作区设置里的脏数据被安全归一", () => {
    window.localStorage.setItem(
      "yuhua." + workspaceKey("D:/书/甲"),
      JSON.stringify({ typography: { body: { size: 9999, family: "" } } }),
    );
    const loaded = loadWorkspaceAppearance("D:/书/甲");
    // size 被夹紧后仍然是有效覆盖
    expect(loaded.typography?.body?.size).toBe(BODY_SIZE_MAX);
    // 空字体族被丢弃，表示「不覆盖这一项」
    expect(loaded.typography?.body?.family).toBeUndefined();
  });

  it("setAppearanceWorkspace 对同一路径重复调用不会重置覆盖", () => {
    setAppearanceWorkspace("D:/书/甲");
    setWorkspaceScope("body", { size: 22 });
    setAppearanceWorkspace("D:/书/甲");
    expect(effectiveTypography().body.size).toBe(22);
  });
});
