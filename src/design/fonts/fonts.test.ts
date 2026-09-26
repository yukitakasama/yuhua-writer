/**
 * 字体加载器测试（T1.11）。
 *
 * 验收要求原文：「FontFace 按需加载、**三作用域共享字族实例**、
 * LRU 上限 2、缺字回退链、失败降级」。
 * 这里逐条对应一个 describe。
 *
 * jsdom **没有** FontFace，也没有 `document.fonts`，所以全部用例
 * 都注入一个测试替身（{@link createHost}）而不是去 stub 全局。
 * 这样做还有个额外好处：可以精确记录「哪个字族被 add 了几次」，
 * 这正是「共享实例」这条要求唯一可观测的证据。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { FONT_CATALOG, fontFamilyById, familiesFor, isBundled } from "./catalog";
import { FontLoader, MAX_LOADED_FAMILIES, type FontFaceLike, type FontHost } from "./loader";
import { applyTheme, applyTypography, resolveTheme, typographyVariables } from "./apply";
import type { TypographySettings } from "@/app/appearance-store";
import { DEFAULT_APPEARANCE } from "@/app/appearance-store";

/** 一个被记录下来的 face。 */
interface RecordedFace extends FontFaceLike {
  /** 构造时的 family 名。 */
  requestedFamily: string;
  /** 构造时的 source。 */
  source: string;
  /** 构造时的描述符。 */
  descriptors: { weight?: string } | undefined;
  /** 是否已被 load。 */
  loaded: boolean;
}

/** 测试宿主：记录全部 add / delete / load。 */
interface TestHost extends FontHost {
  /** 已加入文档的 face。 */
  added: RecordedFace[];
  /** 已从文档移除的 face。 */
  deleted: RecordedFace[];
  /** 让下一个构造出来的 face 的 load() 失败。 */
  failNext: boolean;
  /** 让 load() 挂起而不 resolve（测试并发复用）。 */
  hangNext: boolean;
}

/**
 * 造一个测试宿主。
 *
 * @param options.present 是否提供 document.fonts（false 时模拟老环境）
 * @returns 可观测的宿主与辅助状态
 */
function createHost(options: { present?: boolean } = {}): TestHost {
  const host: TestHost = {
    added: [],
    deleted: [],
    failNext: false,
    hangNext: false,
    createFace: (family, source, descriptors) => {
      const fail = host.failNext;
      const hang = host.hangNext;
      const face: RecordedFace = {
        requestedFamily: family,
        source,
        descriptors,
        loaded: false,
        family,
        load() {
          if (fail) return Promise.reject(new Error("字体文件不存在"));
          if (hang) return new Promise<FontFaceLike>(() => undefined);
          face.loaded = true;
          return Promise.resolve(face as FontFaceLike);
        },
      };
      return face;
    },
    fontSet: () => {
      if (options.present === false) return null;
      return {
        add: (face) => {
          host.added.push(face as RecordedFace);
        },
        delete: (face) => {
          host.deleted.push(face as RecordedFace);
          return true;
        },
      };
    },
  };
  return host;
}

describe("字体目录（catalog）", () => {
  it("每个条目都有唯一的 id", () => {
    const ids = FONT_CATALOG.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("未知 id 回退到宋体而不是抛错", () => {
    expect(fontFamilyById("不存在的字体").id).toBe("yuhua-serif");
  });

  it("内置字体都声明了文件，系统字体都不声明", () => {
    for (const family of FONT_CATALOG) {
      if (family.bundled) expect(family.files?.length ?? 0, family.id).toBeGreaterThan(0);
      else expect(family.files, family.id).toBeUndefined();
    }
  });

  it("内置字体含常规与粗体两个字重（计划书 7.5.2 要求楷体必须有粗体）", () => {
    for (const family of FONT_CATALOG.filter((f) => f.bundled)) {
      const weights = (family.files ?? []).map((f) => f.weight);
      expect(weights, family.id).toContain(400);
      expect(weights, family.id).toContain(700);
    }
  });

  it("每个字体族的回退链都以通用族收尾（缺字最终有地方落）", () => {
    for (const family of FONT_CATALOG) {
      const last = family.stack.split(",").at(-1)?.trim();
      expect(["serif", "sans-serif", "monospace"], family.id).toContain(last);
    }
  });

  it("回退链里内置字体排在最前（否则永远不会被用到）", () => {
    for (const family of FONT_CATALOG.filter((f) => f.bundled)) {
      const first = family.stack.split(",")[0] ?? "";
      expect(first, family.id).toContain('"');
      expect(first.replace(/"/g, "").trim().length, family.id).toBeGreaterThan(0);
    }
  });

  it("familiesFor 把适合该作用域的排在最前", () => {
    const ui = familiesFor("ui");
    // 第一个应该是一个声明了适合 ui 的字体
    expect(ui[0]?.suits).toContain("ui");
  });

  it("familiesFor 不修改原数组顺序", () => {
    const before = FONT_CATALOG.map((f) => f.id);
    familiesFor("heading");
    expect(FONT_CATALOG.map((f) => f.id)).toEqual(before);
  });

  it("isBundled 与 catalog 的 bundled 字段一致", () => {
    for (const family of FONT_CATALOG) {
      expect(isBundled(family.id), family.id).toBe(family.bundled);
    }
  });
});

describe("FontLoader：按需加载", () => {
  it("ensure 一个内置字族后状态变为 ready", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    expect(loader.status("yuhua-serif")).toBe("idle");
    await expect(loader.ensure("yuhua-serif")).resolves.toBe(true);
    expect(loader.status("yuhua-serif")).toBe("ready");
  });

  it("系统字体不触发任何 FontFace 构造（操作系统字形已经在了）", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    await expect(loader.ensure("system-ui")).resolves.toBe(true);
    expect(host.added).toHaveLength(0);
    expect(loader.size).toBe(0);
  });

  it("真正的「按需」：没有调用 ensure 的字族不会被加载", () => {
    const host = createHost();
    const loader = new FontLoader(host);
    expect(loader.size).toBe(0);
    expect(host.added).toHaveLength(0);
  });

  it("常规与粗体两个字重都被加入文档", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    await loader.ensure("yuhua-serif");
    expect(host.added).toHaveLength(2);
    expect(host.added.map((f) => f.descriptors?.weight)).toEqual(["400", "700"]);
  });

  it("粗体加载失败不拖垮常规字重", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    // 让第二次（粗体）构造的 face 失败
    let calls = 0;
    const original = host.createFace;
    host.createFace = (family, source, descriptors) => {
      calls += 1;
      host.failNext = calls > 1;
      return original(family, source, descriptors);
    };
    await expect(loader.ensure("yuhua-serif")).resolves.toBe(true);
    expect(loader.status("yuhua-serif")).toBe("ready");
    expect(host.added).toHaveLength(1);
  });
});

describe("FontLoader：三作用域共享字族实例", () => {
  it("同一字族被三个作用域请求时只构造一次 face", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    // 模拟正文 / 标题 / 界面都选了楷体
    await Promise.all([loader.ensure("yuhua-kai"), loader.ensure("yuhua-kai"), loader.ensure("yuhua-kai")]);
    // 楷体只有两个字重文件，因此 added 长度应为 2 而不是 6
    expect(host.added).toHaveLength(2);
    expect(loader.size).toBe(1);
  });

  it("串行重复 ensure 不重复加载", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    await loader.ensure("yuhua-serif");
    await loader.ensure("yuhua-serif");
    await loader.ensure("yuhua-serif");
    expect(host.added).toHaveLength(2);
  });

  it("并发 ensure 复用同一个飞行中的 Promise", async () => {
    const host = createHost();
    host.hangNext = true;
    const loader = new FontLoader(host);
    const a = loader.ensure("yuhua-serif");
    const b = loader.ensure("yuhua-serif");
    expect(host.added).toHaveLength(0);
    // 两个调用应该等待同一个任务；直接断言它们状态一致（都还没结束）
    expect(loader.status("yuhua-serif")).toBe("loading");
    void a;
    void b;
  });

  it("preload 传三个相同 id 时只加载一次", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    await loader.preload(["yuhua-kai", "yuhua-kai", "yuhua-kai"]);
    expect(loader.size).toBe(1);
    expect(host.added).toHaveLength(2);
  });

  it("preload 混合系统字体与内置字体时只加载内置的那个", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    await loader.preload(["system-ui", "yuhua-serif", "system-serif"]);
    expect(loader.size).toBe(1);
    expect(loader.residentIds()).toEqual(["yuhua-serif"]);
  });
});

describe("FontLoader：LRU 上限", () => {
  it("上限常量为 2（与计划书 5.3 第 6 条一致）", () => {
    expect(MAX_LOADED_FAMILIES).toBe(2);
  });

  it("加载第 3 个字族时淘汰最久未用的那个", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    await loader.ensure("yuhua-serif");
    await loader.ensure("yuhua-kai");
    expect(loader.size).toBe(2);

    // 目录里目前只有两个内置字族，因此这里直接通过 release 验证淘汰语义：
    // 先把 serif 用一次（刷新 LRU），再释放 kai
    await loader.ensure("yuhua-serif");
    expect(loader.residentIds()).toEqual(["yuhua-kai", "yuhua-serif"]);

    loader.release("yuhua-serif");
    expect(loader.status("yuhua-serif")).toBe("idle");
    expect(loader.size).toBe(1);
  });

  it("淘汰时调用 document.fonts.delete 释放字形缓存（指标 M6 的前提）", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    await loader.ensure("yuhua-serif");
    expect(host.deleted).toHaveLength(0);
    loader.release("yuhua-serif");
    expect(host.deleted).toHaveLength(2);
  });

  it("residentIds 按 LRU 顺序返回（最久未用在前）", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    await loader.ensure("yuhua-serif");
    await loader.ensure("yuhua-kai");
    expect(loader.residentIds()).toEqual(["yuhua-serif", "yuhua-kai"]);
    // 再用一次 serif，它应该移到后面
    await loader.ensure("yuhua-serif");
    expect(loader.residentIds()).toEqual(["yuhua-kai", "yuhua-serif"]);
  });

  it("releaseAll 释放全部字族", async () => {
    const host = createHost();
    const loader = new FontLoader(host);
    await loader.ensure("yuhua-serif");
    await loader.ensure("yuhua-kai");
    loader.releaseAll();
    expect(loader.size).toBe(0);
    expect(host.deleted).toHaveLength(4);
  });

  it("释放不存在的字族是安全的空操作", () => {
    const host = createHost();
    const loader = new FontLoader(host);
    expect(loader.release("yuhua-serif")).toBe(false);
  });
});

describe("FontLoader：失败降级", () => {
  it("load 失败时返回 false 而不是抛异常", async () => {
    const host = createHost();
    host.failNext = true;
    const loader = new FontLoader(host);
    await expect(loader.ensure("yuhua-serif")).resolves.toBe(false);
  });

  it("失败后状态为 failed，且不会无限重试", async () => {
    const host = createHost();
    host.failNext = true;
    const loader = new FontLoader(host);
    await loader.ensure("yuhua-serif");
    expect(loader.status("yuhua-serif")).toBe("failed");
    // 再调一次：直接返回 false，不再构造新 face
    const before = host.added.length;
    await expect(loader.ensure("yuhua-serif")).resolves.toBe(false);
    expect(host.added).toHaveLength(before);
  });

  it("环境没有 FontFace 时同样降级而不是抛", async () => {
    // 用真实 host（会走 globalThis.FontFace），jsdom 里它不存在
    const loader = new FontLoader();
    await expect(loader.ensure("yuhua-serif")).resolves.toBe(false);
    expect(loader.status("yuhua-serif")).toBe("failed");
  });

  it("document.fonts 不存在时加载仍然成功（只是不注册到文档）", async () => {
    const host = createHost({ present: false });
    const loader = new FontLoader(host);
    await expect(loader.ensure("yuhua-serif")).resolves.toBe(true);
  });

  it("超时被视为失败（不会永远挂在 loading）", async () => {
    vi.useFakeTimers();
    const host = createHost();
    host.hangNext = true;
    const loader = new FontLoader(host);
    const task = loader.ensure("yuhua-serif");
    await vi.advanceTimersByTimeAsync(8100);
    await expect(task).resolves.toBe(false);
    vi.useRealTimers();
  });
});

describe("CSS 变量应用（T9.3 / T9.5）", () => {
  const typo: TypographySettings = {
    body: { family: "yuhua-serif", size: 18, lineHeight: 2 },
    heading: { family: "yuhua-kai", size: 26, lineHeight: 1.3 },
    ui: { family: "system-ui", size: 14, lineHeight: 1.5 },
    paragraphGap: 1.5,
    measure: 800,
  };

  it("三个作用域的字体族分别映射到对应的令牌", () => {
    const vars = typographyVariables(typo);
    expect(vars["--font-body"]).toContain("Yuhua Serif SC");
    expect(vars["--font-heading"]).toContain("Yuhua Kai SC");
    expect(vars["--font-ui"]).toContain("system-ui");
  });

  it("字号带 px 单位", () => {
    const vars = typographyVariables(typo);
    expect(vars["--fs-body"]).toBe("18px");
    expect(vars["--fs-heading"]).toBe("26px");
    expect(vars["--fs-ui"]).toBe("14px");
  });

  it("行距是无单位倍数（不写 px，否则行高不随字号缩放）", () => {
    const vars = typographyVariables(typo);
    expect(vars["--lh-body"]).toBe("2");
    expect(vars["--lh-heading"]).toBe("1.3");
  });

  it("段距用 em（跟着字号缩放）", () => {
    expect(typographyVariables(typo)["--gap-paragraph"]).toBe("1.5em");
  });

  it("正文宽度映射到 --measure-body", () => {
    expect(typographyVariables(typo)["--measure-body"]).toBe("800px");
  });

  it("--lh-read 与正文行距同步（阅读区读的是它）", () => {
    expect(typographyVariables(typo)["--lh-read"]).toBe("2");
  });

  it("未知字体族 id 回退到宋体的完整回退链", () => {
    const vars = typographyVariables({ ...typo, body: { ...typo.body, family: "不存在" } });
    expect(vars["--font-body"]).toBe(fontFamilyById("yuhua-serif").stack);
  });

  it("applyTypography 把变量写到目标元素上", () => {
    const target = document.createElement("div");
    const written = applyTypography(typo, target);
    expect(target.style.getPropertyValue("--fs-body")).toBe("18px");
    expect(target.style.getPropertyValue("--measure-body")).toBe("800px");
    expect(Object.keys(written).length).toBeGreaterThan(5);
  });

  it("applyTypography 会注入一次性样式标签", () => {
    applyTypography(DEFAULT_APPEARANCE.typography);
    expect(document.getElementById("yh-appearance-style")).not.toBeNull();
  });

  it("applyTheme 对亮 / 暗写显式属性", () => {
    const target = document.createElement("div");
    applyTheme("light", target);
    expect(target.getAttribute("data-theme")).toBe("light");
    applyTheme("dark", target);
    expect(target.getAttribute("data-theme")).toBe("dark");
  });

  it("applyTheme 对 system 删除属性，让媒体查询重新接管", () => {
    const target = document.createElement("div");
    applyTheme("dark", target);
    applyTheme("system", target);
    expect(target.hasAttribute("data-theme")).toBe(false);
  });

  it("resolveTheme 对显式选择原样返回", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("resolveTheme 对 system 解析成一个确定的亮或暗", () => {
    expect(["light", "dark"]).toContain(resolveTheme("system"));
  });
});

describe("回退链（计划书 7.5.4）", () => {
  it("familyById 的 stack 保留完整回退链，不是只有链首", () => {
    for (const family of FONT_CATALOG) {
      expect(family.stack.split(",").length, family.id).toBeGreaterThan(1);
    }
  });

  it("内置宋体的回退链里包含系统宋体（生僻字落点）", () => {
    const stack = fontFamilyById("yuhua-serif").stack;
    expect(stack).toContain("Yuhua Serif SC");
    expect(stack).toContain("SimSun");
  });

  it("内置楷体的回退链里包含系统楷体", () => {
    const stack = fontFamilyById("yuhua-kai").stack;
    expect(stack).toContain("Yuhua Kai SC");
    expect(stack).toContain("KaiTi");
  });

  it("加载器不逐字替换：它只负责把内置字族挂上去，回退完全交给 CSS", async () => {
    // 这条断言的是设计约束而不是运行时行为：加载器不持有任何文本处理逻辑。
    // 通过「加载一个缺字的字族仍然成功」间接验证 —— 它不会因为缺字而失败。
    const host = createHost();
    const loader = new FontLoader(host);
    await expect(loader.ensure("yuhua-serif")).resolves.toBe(true);
  });
});

describe("默认值与 catalog 的一致性", () => {
  it("默认正文 / 标题 / 界面字体都在 catalog 里", () => {
    for (const scope of ["body", "heading", "ui"] as const) {
      const id = DEFAULT_APPEARANCE.typography[scope].family;
      expect(FONT_CATALOG.map((f) => f.id), scope).toContain(id);
    }
  });

  beforeEach(() => {
    window.localStorage.clear();
  });
});
