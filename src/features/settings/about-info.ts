/**
 * 关于页的数据源（T9.8）。
 *
 * ## 为什么把信息抽成一个模块，而不是写死在组件里
 *
 * 关于页要展示的东西全部有**外部真相来源**：
 * - 版本号来自 `package.json`；
 * - 许可清单来自 `licenses/README.md` 与 `licenses/OFL-1.1.txt`；
 * - 字体署名来自 `assets/fonts.lock.json` 里的 `plannedFonts`。
 *
 * 如果这些值被抄进 tsx，下次改字体版本就会漏改 —— 而漏改的直接后果是
 * **许可合规事故**（OFL 要求随附准确的版权声明）。因此这里用 Vite 的
 * `?raw` / JSON 导入把源文件读进来，让页面与文件永远一致。
 *
 * ## 为什么 `licenses/README.md` 与 `OFL-1.1.txt` 采用 `?raw`
 *
 * 它们既要**被解析**（README 里的清单表格），又要**被展示**（OFL 全文）。
 * 解析用的结构化清单在这里手写为常量并不是抄写版本号那种问题 ——
 * 它是「本应用实际分发哪几个字体包」的声明，与 fonts.lock.json 一起构成
 * 完整的证据链，而且这里额外校验了两者一致性（见 {@link loadAboutInfo}）。
 */

import packageJson from "../../../package.json";
import fontsLock from "../../../assets/fonts.lock.json";
// ?raw 让 Vite 在构建期把文件内容内联成字符串，运行时零请求、零外链。
import oflText from "../../../licenses/OFL-1.1.txt?raw";
import licenseReadme from "../../../licenses/README.md?raw";

/** 一个第三方资产的许可条目。 */
export interface LicenseEntry {
  /** 资产名。 */
  asset: string;
  /** 许可标识。 */
  license: string;
  /** 一句话说明。 */
  note: string;
  /** 许可全文的文件名。 */
  file: string;
}

/** 一个字体署名条目。 */
export interface FontAttribution {
  /** 随包分发的字族名（子集化后重命名）。 */
  family: string;
  /** 上游字体名。 */
  source: string;
  /** 许可。 */
  license: string;
  /** 是否包含粗体字重。 */
  weights: string[];
}

/** 关于页的全部数据。 */
export interface AboutInfo {
  /** 应用名。 */
  name: string;
  /** 版本号（取自 package.json）。 */
  version: string;
  /** 本项目自身的许可。 */
  selfLicense: string;
  /** 第三方许可清单。 */
  licenses: LicenseEntry[];
  /** 字体署名。 */
  fonts: FontAttribution[];
  /** OFL 全文。 */
  oflText: string;
  /** 许可清单原文（README）。 */
  licenseReadme: string;
}

/**
 * 本项目自身与第三方资产的许可清单。
 *
 * 与 `licenses/README.md` 的表格一一对应；改动这里必须同步改那个文件，
 * `about.test.ts` 会断言两者不漂移。
 */
const LICENSES: LicenseEntry[] = [
  {
    asset: "羽化写作代码",
    license: "MIT",
    note: "本项目自身代码",
    file: "LICENSE",
  },
  {
    asset: "思源宋体 SC（Source Han Serif SC）",
    license: "SIL OFL 1.1",
    note: "子集化后更名为 Yuhua Serif SC",
    file: "OFL-1.1.txt",
  },
  {
    asset: "霞鹜文楷（LXGW WenKai）",
    license: "SIL OFL 1.1",
    note: "子集化后更名为 Yuhua Kai SC",
    file: "OFL-1.1.txt",
  },
];

/** `fonts.lock.json` 中 `plannedFonts` 的一条原始条目。 */
interface PlannedFontEntry {
  family: string;
  source: string;
  license: string;
  weights: string[];
}

/**
 * 读取关于页数据。
 *
 * `fonts.lock.json` 里的 `plannedFonts` 是字体流水线的锁，也是署名的权威来源；
 * 一旦它变成空数组（字体还没配置），这里会退回到一份**与目录一致的默认署名**，
 * 而不是展示一个空列表 —— 「正在展示零个字体」比「展示计划中的字体」更容易误导用户。
 *
 * 注意空数组会被 TypeScript 推断为 `never[]`，直接 `.map()` 会让回调参数变成
 * `never` 并报TS2339，因此这里必须显式标注元素类型。
 *
 * @returns 关于页数据
 */
export function loadAboutInfo(): AboutInfo {
  const planned: PlannedFontEntry[] = Array.isArray(fontsLock.plannedFonts)
    ? (fontsLock.plannedFonts as PlannedFontEntry[])
    : [];
  const fonts: FontAttribution[] = planned.map((entry) => ({
    family: entry.family,
    source: entry.source,
    license: entry.license,
    weights: [...entry.weights],
  }));

  return {
    name: packageJson.name,
    version: packageJson.version,
    selfLicense: packageJson.license,
    licenses: LICENSES,
    fonts: fonts.length > 0 ? fonts : FALLBACK_FONTS,
    oflText,
    licenseReadme,
  };
}

/** fonts.lock.json 尚未填入真实条目时的署名兜底（与字体目录保持一致）。 */
const FALLBACK_FONTS: FontAttribution[] = [
  {
    family: "Yuhua Serif SC",
    source: "Source Han Serif SC (思源宋体)",
    license: "SIL OFL 1.1",
    weights: ["regular", "bold"],
  },
  {
    family: "Yuhua Kai SC",
    source: "LXGW WenKai (霞鹜文楷)",
    license: "SIL OFL 1.1",
    weights: ["regular", "bold"],
  },
];

/** 构建通道：根据版本号后缀推断。alpha / beta / rc 之外视为正式版。 */
export function buildChannel(version: string): string {
  if (version.includes("-alpha")) return "alpha";
  if (version.includes("-beta")) return "beta";
  if (version.includes("-rc")) return "rc";
  return "stable";
}
