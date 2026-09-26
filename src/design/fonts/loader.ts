/**
 * 字体加载器（T1.11）。
 *
 * ## 要解决的四件事
 *
 * 1. **按需加载**：字体二进制 2.5–3 MB / 字重，首屏全量加载会直接违反
 *    「冷启动 ≤ 150 MB」与「首屏可读 ≤ 120 ms」。只有某个字族真的要被渲染时，
 *    才用 `FontFace` + `document.fonts.add` 把它挂进文档。
 * 2. **三作用域共享字族实例**：正文、标题、界面三个作用域可能都选了楷体。
 *    字族实例必须按 **fontFamily.id** 去重 —— 同一个字族加载两次不仅浪费
 *    6 MB 内存，还会让 `document.fonts.delete()` 的引用计数错乱。
 * 3. **LRU 上限 2 个字族**（计划书 5.3 第 6 条 / 指标 M5）：
 *    同时常驻的字族超过 2 个就不再是「按需」，而是「全量」了。
 *    超出时释放最久未用的，并调用 `document.fonts.delete()` 让字形缓存可被回收。
 * 4. **缺字回退链**：这里**不做**任何逐字替换 —— 逐字替换要遍历全部文本、
 *    查询 `FontFace` 的字符覆盖表，既慢又容易出错。正确做法是交给 CSS：
 *    `font-family` 里写完整回退链，浏览器按字符回退（计划书 7.5.4）。
 *    加载器只负责把**链首那个内置字族**挂上去，链尾始终是通用族。
 *
 * ## 为什么加载失败要静默降级而不是报错
 *
 * 字体文件缺失（用户只跑了 `pnpm dev` 没跑 `pnpm fonts:fetch`）时，
 * CSS 回退链会自动落到系统宋体 —— 界面依然可读，只是排版没那么好看。
 * 这时弹一个错误对话框只会吓到用户。因此失败路径只做三件事：
 * 记录状态供设置页显示、把字族标记为不可用、让 CSS 回退接管。
 */

import { FONT_CATALOG, fontFamilyById, type FontFamily, type FontWeightFile } from "./catalog";

/** 同时常驻的字族上限（计划书 5.3 第 6 条）。 */
export const MAX_LOADED_FAMILIES = 2;

/** 单次加载请求的默认超时（毫秒）。超时视为失败，走 CSS 回退。 */
export const LOAD_TIMEOUT_MS = 8000;

/** 一个字族的加载状态。 */
export type FamilyStatus = "idle" | "loading" | "ready" | "failed";

/** 注入文档所需的最小 FontFace 接口（便于测试替身）。 */
export interface FontFaceLike {
  load(): Promise<FontFaceLike>;
  family: string;
}

/** FontFace 构造签名。 */
export type FontFaceFactory = (
  family: string,
  source: string,
  descriptors?: { weight?: string; style?: string; display?: string },
) => FontFaceLike;

/** 本模块用到的 `document.fonts` 子集。 */
export interface FontSetLike {
  add(face: FontFaceLike): void;
  delete(face: FontFaceLike): boolean;
  has?(face: FontFaceLike): boolean;
}

/** 加载器依赖的宿主能力。注入是为了在 jsdom 里可测 —— jsdom 没有 FontFace。 */
export interface FontHost {
  /** 构造一个 FontFace。 */
  createFace: FontFaceFactory;
  /** 取 `document.fonts`；不存在时返回 null（老环境或测试环境）。 */
  fontSet(): FontSetLike | null;
}

/** 一个字族的常驻记录。 */
interface LoadedFamily {
  /** 字体族定义。 */
  family: FontFamily;
  /** 已加入 document.fonts 的 face（常规 + 可能的粗体）。 */
  faces: FontFaceLike[];
  /** 最近一次被使用的时间戳，LRU 排序依据。 */
  lastUsed: number;
  /** 加载状态。 */
  status: FamilyStatus;
  /** 失败原因（仅 failed 时有值）。 */
  error?: string;
}

/**
 * 默认宿主：真实浏览器实现。
 *
 * `FontFace` 不存在时 `createFace` 会抛 —— 由调用方捕获并降级，
 * 而不是在这里返回一个假对象，因为假对象会让 `document.fonts.add` 抛得更晚更远。
 */
const browserHost: FontHost = {
  createFace: (family, source, descriptors) => {
    const Ctor = (globalThis as { FontFace?: new (...args: unknown[]) => FontFaceLike }).FontFace;
    if (!Ctor) throw new Error("当前环境不支持 FontFace API");
    return new Ctor(family, source, descriptors);
  },
  fontSet: () => {
    const fonts = (globalThis as { document?: Document }).document?.fonts as FontSetLike | undefined;
    return fonts ?? null;
  },
};

/** 调试用的 __DEV__ 判定（不依赖 vite 的 import.meta.env，保持模块可在 node 下直接跑）。 */
function isDev(): boolean {
  return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== "production";
}

/**
 * 字体加载器。
 *
 * 有意做成**类**而不是模块级单例：测试需要多个互不干扰的实例，
 * 而单例会让「上一个用例留下的缓存」污染下一个用例。生产代码在
 * {@link ./index.ts} 里导出一个共享实例即可。
 */
export class FontLoader {
  /** 常驻字族（按 family.id 去重，这正是「三作用域共享字族实例」的落点）。 */
  private readonly loaded = new Map<string, LoadedFamily>();

  private readonly inflight = new Map<string, Promise<boolean>>();

  private readonly host: FontHost;

  /** 单调递增的时钟，避免依赖 Date.now 在测试里被 mock。 */
  private tick = 0;

  constructor(host: FontHost = browserHost) {
    this.host = host;
  }

  /** 当前常驻的字族数量。 */
  get size(): number {
    return this.loaded.size;
  }

  /** 当前常驻的字族 id（按 LRU 顺序，最久未用在前）。 */
  residentIds(): string[] {
    return [...this.loaded.values()].sort((a, b) => a.lastUsed - b.lastUsed).map((entry) => entry.family.id);
  }

  /** 查询某个字族的状态。未加载过返回 idle。 */
  status(id: string): FamilyStatus {
    return this.loaded.get(id)?.status ?? "idle";
  }

  /**
   * 确保某个字族可用，并把它标记为「最近使用」。
   *
   * 三种情况：
   * - 已在常驻表里：只刷新 LRU 时间戳，**不重复加载**（这是内存指标 M5 的关键）；
   * - 已有同 id 的加载在飞行中：复用同一个 Promise，避免并发重复下载；
   * - 其余：真正发起加载。
   *
   * @param id 字体族标识
   * @returns 是否加载成功（失败不抛，调用方据返回值决定是否提示）
   */
  async ensure(id: string): Promise<boolean> {
    const family = fontFamilyById(id);

    // 系统字体无需加载，直接算作可用。
    if (!family.bundled) return true;

    const existing = this.loaded.get(id);
    if (existing) {
      existing.lastUsed = ++this.tick;
      if (existing.status === "ready") {
        // 已就绪：仍然是「最近使用」，但不必重载
        return true;
      }
      if (existing.status === "failed") return false;
    }

    const pending = this.inflight.get(id);
    if (pending) return pending;

    const task = this.loadFamily(family).finally(() => {
      this.inflight.delete(id);
    });
    this.inflight.set(id, task);
    return task;
  }

  /**
   * 真正把字族挂进文档。
   *
   * 先占位再加载：占位记录让「同一字族的并发请求」能立刻命中 inflight，
   * 也保证 LRU 淘汰在加载过程中就已经把它算进去，不会出现「刚加载完就被别人挤掉」。
   */
  private async loadFamily(family: FontFamily): Promise<boolean> {
    this.evictIfNeeded();

    const entry: LoadedFamily = {
      family,
      faces: [],
      lastUsed: ++this.tick,
      status: "loading",
    };
    this.loaded.set(family.id, entry);

    const files = family.files ?? [];
    if (files.length === 0) {
      // 声明为内置却没有文件：这不是运行时环境问题，是配置错误，但同样不该炸
      entry.status = "failed";
      entry.error = "字体目录没有声明文件";
      return false;
    }

    try {
      const fontSet = this.host.fontSet();
      // 常规字重必加载；粗体按计划书 7.5.5「粗体延迟」——它随常规一起下，
      // 但失败不影响常规可用（很多子集只有一个字重）。
      const regular = files.find((f) => f.weight === 400) ?? files[0];
      if (!regular) throw new Error("字体目录缺少常规字重");

      const primary = await this.loadWeight(family, regular);
      entry.faces.push(primary);
      fontSet?.add(primary);

      const bold = files.find((f) => f.weight === 700);
      if (bold) {
        try {
          const boldFace = await this.loadWeight(family, bold);
          entry.faces.push(boldFace);
          fontSet?.add(boldFace);
        } catch {
          // 粗体缺失可以接受：浏览器会合成伪粗体，排版不完美但可读
        }
      }

      entry.status = "ready";
      return true;
    } catch (err) {
      entry.status = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
      if (isDev()) {
        // 开发期把原因说清楚：多半是没跑 pnpm fonts:fetch
        console.warn(`[字体] ${family.label}(${family.id}) 加载失败，已回退系统字体：${entry.error}`);
      }
      return false;
    }
  }

  /** 加载单个字重文件。 */
  private async loadWeight(family: FontFamily, file: FontWeightFile): Promise<FontFaceLike> {
    const face = this.host.createFace(family.stack.split(",")[0]?.trim().replace(/^"|"$/g, "") ?? family.id, `url("${file.url}")`, {
      weight: String(file.weight),
      style: "normal",
      display: "swap",
    });
    return withTimeout(face.load(), LOAD_TIMEOUT_MS);
  }

  /**
   * 超出上限时淘汰最久未用的字族。
   *
   * 淘汰做两件事：从常驻表移除 + `document.fonts.delete()`。
   * 只做前者的话 FontFace 还挂在文档上，字形缓存不会被回收，
   * 指标 M6 的「切换字族后 60 秒内存回落」就无从谈起。
   */
  private evictIfNeeded(): void {
    while (this.loaded.size >= MAX_LOADED_FAMILIES) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.loaded) {
        if (entry.lastUsed < oldestAt) {
          oldestAt = entry.lastUsed;
          oldestId = id;
        }
      }
      if (oldestId === null) break;
      this.release(oldestId);
    }
  }

  /** 释放一个字族：从文档移除所有 face 并清掉常驻记录。 */
  release(id: string): boolean {
    const entry = this.loaded.get(id);
    if (!entry) return false;
    const fontSet = this.host.fontSet();
    for (const face of entry.faces) {
      try {
        fontSet?.delete(face);
      } catch {
        // delete 在部分实现里对未加入的 face 会抛，忽略即可
      }
    }
    this.loaded.delete(id);
    return true;
  }

  /** 释放全部字族（关闭工作区、测试清理时用）。 */
  releaseAll(): void {
    for (const id of [...this.loaded.keys()]) this.release(id);
    this.inflight.clear();
  }

  /**
   * 按一组作用域当前在用到的字族做一遍「预加载 + 标记最近使用」。
   *
   * 必须在**应用 CSS 变量之前**调用：先有字形，再有排版，
   * 否则首帧会用回退字体渲染一次再跳成内置字体（这就是 T1.12 要消除的闪动）。
   *
   * @param ids 当前生效的三个作用域字体标识
   */
  async preload(ids: readonly string[]): Promise<void> {
    // 按出现顺序依次 ensure：三个作用域选中同一字族时只会加载一次
    for (const id of ids) {
      await this.ensure(id);
    }
  }
}

/** 给一个 Promise 加超时；超时视为失败。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`字体加载超时（${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** 全部需要被加载器管理的字族 id（供「完整字形模式」之类功能使用）。 */
export const BUNDLED_FAMILY_IDS: readonly string[] = FONT_CATALOG.filter((f) => f.bundled).map((f) => f.id);
