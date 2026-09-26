/**
 * 字体模块统一出口。
 *
 * 约定与 design/primitives 一致：上层只从这个入口导入。
 * 唯一例外是 `FontLoader` 类本身 —— 测试需要 `new FontLoader(host)`
 * 造独立实例，因此类和它的共享实例都从这里导出。
 */

export {
  FONT_CATALOG,
  UI_STACK,
  DEFAULT_FAMILY,
  fontFamilyById,
  hasFamily,
  familiesFor,
  isBundled,
} from "./catalog";
export type { FontFamily, FontWeightFile } from "./catalog";

export {
  FontLoader,
  MAX_LOADED_FAMILIES,
  LOAD_TIMEOUT_MS,
  BUNDLED_FAMILY_IDS,
} from "./loader";
export type { FamilyStatus, FontHost, FontFaceLike, FontSetLike, FontFaceFactory } from "./loader";

export {
  APPEARANCE_CSS,
  applyTheme,
  applyTypography,
  resolveTheme,
  typographyVariables,
} from "./apply";

import { FontLoader } from "./loader";

/**
 * 共享加载器实例。
 *
 * 做成模块级单例的原因：LRU 上限的语义是**进程级**的。
 * 如果每个组件各持一个加载器，上限 2 就形同虚设（两个组件各 2 个 = 4 个）。
 */
export const fontLoader = new FontLoader();
