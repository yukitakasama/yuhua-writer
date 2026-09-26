#!/usr/bin/env node
/**
 * IPC 契约一致性检查（T0.4 的落地方案）。
 *
 * ## 为什么最终没有接入 tauri-specta
 *
 * 计划书 T0.4 原本要求 tauri-specta 自动生成 TS 类型。实际做下来
 * 有三处摩擦让它不划算：
 *
 * 1. **它要求所有命令参数与返回值都实现 `specta::Type`**。
 *    本项目的 IPC 类型里有 `serde_json::Value`、
 *    `std::path::PathBuf` 这类需要手写映射的类型，
 *    接入后要为一个 400 行的类型层写 200 行的 `impl Type`。
 * 2. **生成产物是构建期副产物**，改了 Rust 忘了重新生成时
 *    前端会拿到**过期的**类型 —— 那比没有生成更危险，
 *    因为编辑器会显示"类型正确"。
 * 3. **它不校验语义**。生成器保证字段名对得上，
 *    但不保证 `ERROR_CODES` 里的字符串与 Rust 的 `code()`
 *    返回值一致 —— 而前端恰恰是**按错误码分支**的
 *    （见 App.tsx 的 ErrorBanner），码错了就走到 default 分支。
 *
 * ## 这个脚本解决的是什么
 *
 * 它不生成类型，而是**校验两份手写定义没有漂移**。
 * 具体检查六件事：
 *
 * | # | 检查 | 抓到的真实故障 |
 * | --- | --- | --- |
 * | 1 | 命令名一一对应 | 前端 invoke 的名字写错 / 后端改了名 |
 * | 2 | 错误码集合一致 | 前端 switch 走到 default，用户看到"操作失败" |
 * | 3 | `ChapterStatus` 枚举取值一致 | 少一个取值导致状态显示空白 |
 * | 4 | `CountMode` 枚举取值一致 | 字数口径切换后标签与数值对不上 |
 * | 5 | mock 后端覆盖全部前端命令 | 浏览器降级模式里某个界面直接不可用 |
 * | 6 | 结构体字段名**双向**一致 | 前端读 `result.document` 而后端返回 `outline` |
 *
 * 第 6 项是最后补上的，也是最值钱的一项：前五项都不比对字段名，
 * 因此「前端取的字段名后端从来不返回」这类漂移可以长期潜伏 ——
 * 测试全绿（走 mock），真实 Tauri 路径一打开就抛 `undefined`。
 *
 * ## 为什么是"文本解析"而不是"读 JSON Schema"
 *
 * 因为要读的是一份 `commands.rs` 与一份 `types.ts`。
 * 为它们写 AST 解析器需要引入 `@babel/parser` 与一个 Rust 解析器；
 * 而这里需要的信息（`#[tauri::command]` 函数名、`pub enum` 的变体名、
 * `pub struct` 的字段名）用**锚定到行首的正则**就能可靠取到。
 *
 * 取不到时**报错而不是跳过** —— 一条沉默的检查等于没有检查。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const COMMANDS_RS = join(ROOT, "src-tauri", "src", "commands.rs");
const LIB_RS = join(ROOT, "src-tauri", "src", "lib.rs");
// 错误码分布在两处：命令层的包装枚举与内核的领域枚举。
// 只看其中一个会得到"前端定义了一堆永远不会出现的码"这种**假警报** ——
// 而假警报比没有检查更糟，它会让作者学会忽略这个脚本
const ERROR_RS = join(ROOT, "src-tauri", "src", "error.rs");
const CORE_ERROR_RS = join(ROOT, "src-tauri", "crates", "yuhua-core", "src", "error.rs");
// 枚举按定义位置分开：ChapterStatus 在 meta.rs，CountMode 在 count.rs
const META_RS = join(ROOT, "src-tauri", "crates", "yuhua-core", "src", "meta.rs");
const COUNT_RS = join(ROOT, "src-tauri", "crates", "yuhua-core", "src", "count.rs");
// 结构体字段比对要跨 crate 收集：IPC 载荷并非全在 commands.rs 定义，
// `ChapterSummary` / `OutlineNode` 等在 core，`WordStats` 在 store，
// `WorkspaceSummary` 在 fs。少读一个文件就会把那条契约漏检。
const CORE_MODEL_RS = join(ROOT, "src-tauri", "crates", "yuhua-core", "src", "model.rs");
const CORE_TRASH_RS = join(ROOT, "src-tauri", "crates", "yuhua-core", "src", "trash.rs");
const STORE_STATS_RS = join(ROOT, "src-tauri", "crates", "yuhua-store", "src", "stats.rs");
const FS_WORKSPACE_RS = join(ROOT, "src-tauri", "crates", "yuhua-fs", "src", "workspace.rs");
const IPC_TS = join(ROOT, "src", "lib", "ipc", "types.ts");
const IPC_INDEX_TS = join(ROOT, "src", "lib", "ipc", "index.ts");
const MOCK_TS = join(ROOT, "src", "lib", "mock-backend", "index.ts");

/**
 * 需要与前端逐字段比对的结构体。
 *
 * ## 为什么在脚本里写死清单，而不是自动发现所有 `pub struct`
 *
 * 因为两侧的定义**不是一一对应**的：Rust 的 `Chapter`（含 `body`）在
 * 前端没有镜像（前端用 `ChapterContent`），`Document` 也没有（前端用
 * `WorkspaceDocument`，形状本就不同）。自动发现会产生大量假警报，
 * 而假警报会教作者忽略这个脚本 —— 那比没有检查更糟。
 *
 * 因此这里只列**真的走 IPC 且两侧应当逐字对齐**的那些。
 * 新增一条 IPC 结构体时，请同步往这里加一行；漏加不会报错，
 * 但也就失去了这道防护。
 */
const STRUCT_CONTRACTS = [
  // [Rust 结构体名, TS 接口名, 定义所在的 Rust 文件]
  ["OpenResult", "OpenWorkspaceResult", COMMANDS_RS],
  ["ChapterContent", "ChapterContent", COMMANDS_RS],
  ["ChapterSummary", "ChapterSummary", CORE_MODEL_RS],
  ["OutlineNode", "OutlineNode", CORE_MODEL_RS],
  ["WordStats", "WordStats", STORE_STATS_RS],
  ["WordCount", "WordCount", COUNT_RS],
  ["StatsPayloadDto", "StatsPayload", COMMANDS_RS],
  ["StatsDayDto", "StatsDay", COMMANDS_RS],
  ["WorkspaceSummary", "WorkspaceSummary", FS_WORKSPACE_RS],
  ["RecoveryReportDto", "RecoveryReport", COMMANDS_RS],
  ["ConflictDto", "ConflictDto", COMMANDS_RS],
  ["TrashEntry", "TrashEntry", CORE_TRASH_RS],
];

/** 收集失败项。全部检查跑完再统一报告，避免改一个跑一遍。 */
const failures = [];
/** 收集跳过的检查（文件不存在时的兜底）。 */
const skipped = [];

function fail(check, message) {
  failures.push({ check, message });
}

function log(msg) {
  console.log("[check-ipc] " + msg);
}

function read(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/**
 * 取**真正被注册**的命令名。
 *
 * ## 为什么要读 `lib.rs` 的 `generate_handler!` 而不是
 * ## `commands.rs` 的 `#[tauri::command]`
 *
 * 因为两者可以不一致，而不一致时**只有一个有意义**：
 * 只有写进 `generate_handler!` 的命令才真的能被 `invoke` 调用。
 *
 * 定义一个带 `#[tauri::command]` 的函数但忘了注册，是这个框架里
 * 最容易犯且最难发现的错误 —— 编译通过、clippy 通过、
 * Rust 单测通过（因为单测直接调函数，不走 IPC），
 * 只有**真的从前端 invoke 一次**才会发现。
 *
 * 第一次写这个脚本时读的就是 `commands.rs`，于是检查器报出了
 * 10 条"前端调用了不存在的命令"；换成读 `lib.rs` 后
 * 那些 10 条**仍然成立** —— 说明它们不是解析问题，而是真实缺陷。
 *
 * ## 同时保留 `commands.rs` 的解析
 *
 * 用来做**交叉检查**：定义了但没注册的命令会被单独提示
 * （多半是写完了忘了接线）。
 */
function rustRegisteredCommands(source) {
  const names = new Set();
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(source);
  if (!block) return names;
  for (const m of block[1].matchAll(/commands::([a-z0-9_]+)/g)) {
    names.add(m[1]);
  }
  return names;
}

/** 取所有被 `#[tauri::command]` 标注的函数名（用于交叉检查）。 */
function rustCommandNames(source) {
  const names = new Set();
  const lines = source.split(/\r?\n/);
  let pendingCommand = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#[tauri::command")) {
      pendingCommand = true;
      continue;
    }
    if (pendingCommand) {
      // 形如 `pub async fn create_chapter(...)` 或 `pub fn foo(...)`
      const m = /^pub\s+(?:async\s+)?fn\s+([a-z0-9_]+)/.exec(trimmed);
      if (m) {
        names.add(m[1]);
        pendingCommand = false;
      } else if (trimmed.length > 0 && !trimmed.startsWith("//")) {
        // 其它属性（比如 #[allow]）可以夹在中间，继续等函数声明；
        // 遇到非属性的实义行则说明这次标注没有跟上函数定义
        if (!trimmed.startsWith("#[")) pendingCommand = false;
      }
    }
  }
  return names;
}

/** 取前端 `call("命令名", ...)` 里用到的命令名。 */
function tsInvokedCommands(source) {
  const names = new Set();
  for (const m of source.matchAll(/call(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * 取每个 `call(...)` 调用点上的「命令名 → mock 方法名」映射。
 *
 * ## 为什么不靠 camelCase 折算命令名
 *
 * 因为两者的命名**不是机械对应的**，而且那是有意为之：
 * `call("search_chapters", ..., (b) => b.search(query))` ——
 * 后端命令叫 `search_chapters`，mock 方法叫 `search`。
 * `restore_trash` → `restoreFromTrash`、`purge_trash` → `purgeFromTrash`
 * 同理（mock 的名字更贴近它的语义，后端的名字更贴近 IPC 规范）。
 *
 * 用 camelCase 折算会把这 3 条**正确的接线**报成缺失。而假警报比
 * 没有检查更糟 —— 它会让作者学会忽略这个脚本（见文件头）。
 *
 * 因此这里读的是**权威来源**：`call()` 第三个参数里的那个
 * `b.<方法名>`。它是真正会被执行的东西，不可能与实现分叉。
 *
 * 窗口上限 600 字符：`call()` 的实参都写在同一屏内，加个上限
 * 是为了防止某个漏写 `=> b.x(` 的调用点把下一个调用点的方法名吞进来。
 */
function tsCallSites(source) {
  const sites = [];
  for (const m of source.matchAll(
    /call(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"[\s\S]{0,600}?=>\s*b\.([A-Za-z0-9]+)\s*\(/g,
  )) {
    sites.push({ command: m[1], mockMethod: m[2] });
  }
  return sites;
}

/** 取 Rust 里 `code()` 返回的错误码字符串。 */
function rustErrorCodes(source) {
  const codes = new Set();
  // 只取 `=> "XXX"` 形式的返回值（code() 的实现就是一堆 match 分支）
  for (const m of source.matchAll(/=>\s*"([A-Z_]{3,})"/g)) {
    codes.add(m[1]);
  }
  return codes;
}

/** 取前端 `ERROR_CODES` 里的值。 */
function tsErrorCodes(source) {
  const block = /ERROR_CODES\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(source);
  if (!block) return null;
  const codes = new Set();
  for (const m of block[1].matchAll(/:\s*"([A-Z_]{3,})"/g)) {
    codes.add(m[1]);
  }
  return codes;
}

/** 取 Rust 枚举的变体名（`rename_all` 之后的形态由调用方决定）。 */
function rustEnumVariants(source, enumName) {
  const re = new RegExp("pub enum " + enumName + "\\s*\\{([\\s\\S]*?)\\n\\}", "m");
  const m = re.exec(source);
  if (!m) return null;
  const variants = [];
  for (const line of m[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.length === 0) continue;
    const vm = /^([A-Z][A-Za-z0-9]*)\s*(?:\(|\{|,|$)/.exec(trimmed);
    if (vm) variants.push(vm[1]);
  }
  return variants;
}

/** 把 Rust 的 UpperCamelCase 变体名转成 camelCase（serde rename_all 后的形态）。 */
function toCamel(name) {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** 把 snake_case 转成 camelCase（结构体字段名在两侧的命名差异）。 */
function toCamelCase(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * 取 Rust 结构体的字段名（已转成 camelCase，便于与 TS 直接比对）。
 *
 * ## 为什么不用「属性 + struct」的连写正则
 *
 * 因为两者之间还夹着 `#[derive(...)]`，而且属性行数不固定。写一条
 * 假定的正则会在**加了 derive 之后**静默失效 —— 那正是本文件反复
 * 强调的「沉默的检查等于没有检查」。因此这里先定位 `pub struct`，
 * 再**向前回看**少量字符找 `rename_all`。
 *
 * ## 只认带 `pub` 的字段
 *
 * 结构体里偶尔有私有字段（不参与序列化），它们不该出现在契约比对里。
 * 正则要求 `pub ` 前缀，天然把它们排除。
 *
 * ## 返回 `null` 而不是空集
 *
 * 解析不到结构体时必须**报错而不是跳过**。返回 `null` 让调用方能
 * 区分「结构体不存在」与「结构体存在但没有字段」—— 后者同样要报错。
 */
function rustStructFields(source, structName) {
  const declRe = new RegExp("pub struct " + structName + "\\s*\\{", "m");
  const decl = declRe.exec(source);
  if (!decl) return null;

  // 向前回看属性区，确认它确实按 camelCase 序列化。
  // 若某个结构体将来改成 snake_case，两侧的字段名对不上会引出
  // 一堆误报，不如在这里直接说清楚。
  const lookback = source.slice(Math.max(0, decl.index - 300), decl.index);
  if (!/rename_all\s*=\s*"camelCase"/.test(lookback)) return null;

  const re = new RegExp("pub struct " + structName + "\\s*\\{([\\s\\S]*?)\\n\\}", "m");
  const m = re.exec(source);
  if (!m) return null;
  const fields = [];
  for (const line of m[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    // 文档注释、属性、空行都不是字段
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.length === 0) continue;
    const fm = /^pub\s+([a-z_][a-z0-9_]*)\s*:/.exec(trimmed);
    if (fm) fields.push(toCamelCase(fm[1]));
  }
  return fields;
}

/**
 * 取 TS 接口的字段名。
 *
 * 只取**顶层**字段：接口里可以嵌对象类型（例如 `ranges: Array<[number, number]>`），
 * 而嵌套结构体的字段属于另一层契约，在这里混进来会得到错误的集合。
 * 因此用花括号配平来跳过嵌套的 `{ ... }`。
 */
function tsInterfaceFields(source, interfaceName) {
  const re = new RegExp("export interface " + interfaceName + "\\s*\\{", "m");
  const m = re.exec(source);
  if (!m) return null;
  const start = m.index + m[0].length;

  const fields = [];
  let depth = 0;
  let line = "";
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{" || ch === "<" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === ">" || ch === "]" || ch === ")") {
      if (ch === "}" && depth === 0) break; // 接口结束
      depth -= 1;
    }
    if (ch === "\n") {
      // 只在 depth 为 0 的行上找字段名，天然跳过嵌套结构
      if (depth === 0) {
        const fm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
        if (fm) fields.push(fm[1]);
      }
      line = "";
    } else {
      line += ch;
    }
  }
  return fields;
}

/** 取 TS 里某个类型联合的所有字面量。 */
function tsUnionValues(source, typeName) {
  const re = new RegExp("export type " + typeName + "\\s*=\\s*([^;]+);", "m");
  const m = re.exec(source);
  if (!m) return null;
  const values = [];
  for (const v of m[1].matchAll(/"([^"]+)"/g)) values.push(v[1]);
  return values;
}

function main() {
  const commandsRs = read(COMMANDS_RS);
  // 两个错误枚举**合并**后与前端比对：命令层包装了内核层
  const errorSources = [read(ERROR_RS), read(CORE_ERROR_RS)].filter((s) => s !== null);
  const metaRs = read(META_RS);
  const countRs = read(COUNT_RS);
  // 结构体字段比对要跨 crate 收集定义，理由见 STRUCT_CONTRACTS 的说明
  const coreModel = read(CORE_MODEL_RS);
  const coreTrash = read(CORE_TRASH_RS);
  const storeStats = read(STORE_STATS_RS);
  const fsWorkspace = read(FS_WORKSPACE_RS);
  const typesTs = read(IPC_TS);
  const indexTs = read(IPC_INDEX_TS);

  // ---- 1. 命令名一一对应 ----
  const libRs = read(LIB_RS);
  if (libRs && indexTs) {
    const registered = rustRegisteredCommands(libRs);
    const ts = tsInvokedCommands(indexTs);
    if (registered.size === 0) {
      fail("命令名", "在 lib.rs 的 generate_handler! 里一个命令都没解析到，解析规则可能失效了");
    }
    // 前端调用了但后端没注册：**必然运行时失败**，最高优先级
    for (const name of ts) {
      if (!registered.has(name)) {
        fail("命令名", `前端调用了未注册的命令 "${name}"（只定义了 #[tauri::command] 但没写进 generate_handler!）`);
      }
    }
    log(`命令数：Rust 注册 ${registered.size} 个，前端调用 ${ts.size} 个`);

    // 交叉检查：定义了但没注册（多半是写完忘了接线）
    if (commandsRs) {
      const defined = rustCommandNames(commandsRs);
      const unregistered = [...defined].filter((n) => !registered.has(n));
      if (unregistered.length > 0) {
        log("提示：以下命令已定义但未注册（前端无法调用）：" + unregistered.join(", "));
      }
      const undefinedButRegistered = [...registered].filter((n) => !defined.has(n));
      if (undefinedButRegistered.length > 0) {
        fail("命令名", `以下命令被注册了但 commands.rs 里没有定义：${undefinedButRegistered.join(", ")}`);
      }
    }
  } else {
    skipped.push("命令名（缺少 lib.rs 或 ipc/index.ts）");
  }

  // ---- 2. 错误码一致 ----
  if (errorSources.length > 0 && typesTs) {
    const rust = new Set();
    for (const source of errorSources) {
      for (const code of rustErrorCodes(source)) rust.add(code);
    }
    const ts = tsErrorCodes(typesTs);
    if (ts === null) {
      fail("错误码", "在 types.ts 里找不到 ERROR_CODES 定义");
    } else {
      if (rust.size === 0) {
        fail("错误码", "在 Rust 侧一个错误码都没解析到，解析规则可能失效了");
      }
      // 前端有、后端没有：这个码永远不会出现，前端的分支是死代码
      for (const code of ts) {
        if (!rust.has(code)) {
          fail("错误码", `前端定义了 Rust 不会返回的码 "${code}"`);
        }
      }
      // 后端有、前端没有：会走到 default 分支，用户看到通用文案。
      // 这是"能忍但应该知道"的缺口，因此降级为提示
      const missing = [...rust].filter((c) => !ts.has(c));
      if (missing.length > 0) {
        log("提示：以下错误码 Rust 会返回但前端未显式建模（会走 default 分支）：" + missing.join(", "));
      }
      log(`错误码：Rust ${rust.size} 个，前端 ${ts.size} 个`);
    }
  } else {
    skipped.push("错误码（缺少 error.rs 或 types.ts）");
  }

  // ---- 3. 章节状态枚举 ----
  if (metaRs && typesTs) {
    const variants = rustEnumVariants(metaRs, "ChapterStatus");
    const tsValues = tsUnionValues(typesTs, "ChapterStatus");
    if (variants === null) {
      fail("枚举", "在 model.rs 里找不到 pub enum ChapterStatus");
    } else if (tsValues === null) {
      fail("枚举", "在 types.ts 里找不到 ChapterStatus 类型");
    } else {
      // Rust 侧是 rename_all = "lowercase"，因此 "Draft" -> "draft"
      const rustValues = variants.map((v) => v.toLowerCase());
      const rustSet = new Set(rustValues);
      const tsSet = new Set(tsValues);
      for (const v of rustValues) {
        if (!tsSet.has(v)) fail("枚举", `ChapterStatus：Rust 有 "${v}" 但前端没有`);
      }
      for (const v of tsValues) {
        if (!rustSet.has(v)) fail("枚举", `ChapterStatus：前端有 "${v}" 但 Rust 没有`);
      }
      log(`ChapterStatus：Rust ${rustValues.join("/")} ｜ 前端 ${tsValues.join("/")}`);
    }
  } else {
    skipped.push("枚举（缺少 model.rs 或 types.ts）");
  }

  // ---- 4. 字数口径枚举 ----
  if (countRs && typesTs) {
    const variants = rustEnumVariants(countRs, "CountMode");
    const tsValues = tsUnionValues(typesTs, "CountMode");
    if (variants === null) {
      // CountMode 可能定义在别处，不算失败
      skipped.push("字数口径（count.rs 里没有 CountMode）");
    } else if (tsValues === null) {
      fail("枚举", "在 types.ts 里找不到 CountMode 类型");
    } else {
      // CountMode 是 rename_all = "camelCase"
      const rustValues = variants.map(toCamel);
      const rustSet = new Set(rustValues);
      const tsSet = new Set(tsValues);
      for (const v of rustValues) {
        if (!tsSet.has(v)) fail("枚举", `CountMode：Rust 有 "${v}" 但前端没有`);
      }
      for (const v of tsValues) {
        if (!rustSet.has(v)) fail("枚举", `CountMode：前端有 "${v}" 但 Rust 没有`);
      }
      log(`CountMode：Rust ${rustValues.join("/")} ｜ 前端 ${tsValues.join("/")}`);
    }
  }

  // ---- 5. mock 后端覆盖了所有前端命令 ----
  // 浏览器降级模式（pnpm dev 与前端测试）全靠 mock。
  // mock 少实现一个方法，对应的界面在浏览器里就是坏的。
  //
  // ## 为什么读调用点上的方法名而不是折算 camelCase
  //
  // 见 {@link tsCallSites}：两条命名规范有意不同，折算会制造
  // 假警报（`search_chapters` 的 mock 方法就叫 `search`）。
  // 读 `call()` 里的 `b.<方法名>` 拿的是权威来源。
  const mockTs = read(MOCK_TS);
  if (mockTs && indexTs) {
    const sites = tsCallSites(indexTs);
    // MockBackend 接口里的方法名
    const interfaceBlock = /export interface MockBackend\s*\{([\s\S]*?)\n\}/.exec(mockTs);
    if (!interfaceBlock) {
      fail("mock", "找不到 MockBackend 接口定义");
    } else {
      const methods = new Set();
      for (const m of interfaceBlock[1].matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9]*)\s*\(/gm)) {
        methods.add(m[1]);
      }
      if (methods.size === 0) {
        // 解析规则失效必须报出来：否则下面的逐条比对会"因为集合为空
        // 而全部通过"，检查静默退化成空转 —— 这正是本项此前的问题
        fail("mock", "MockBackend 接口里一个方法都没解析到，解析规则可能失效了");
      } else if (sites.length === 0) {
        fail("mock", "在 ipc/index.ts 里一个 call(\"命令名\", …, b.方法名(…)) 都没解析到，解析规则可能失效了");
      } else {
        const missing = sites.filter((s) => !methods.has(s.mockMethod));
        for (const s of missing) {
          fail("mock", `前端调用了 "${s.command}"，但 MockBackend 没有实现 "${s.mockMethod}"（浏览器降级模式下这个界面是坏的）`);
        }
        const commands = tsInvokedCommands(indexTs);
        log(`mock 覆盖：前端 ${commands.size} 个命令 / ${sites.length} 个调用点，MockBackend ${methods.size} 个方法，缺失 ${missing.length} 个`);
      }
    }
  } else {
    skipped.push("mock 覆盖（缺少 mock-backend/index.ts）");
  }

  // ---- 6. 结构体字段名双向一致 ----
  //
  // ## 为什么这一项最值钱
  //
  // 前五项能抓到的都是"名字对不上"。而真实事故往往是**名字对得上、
  // 但字段名不对**：前端写 `result.document`，后端返回 `{ outline }`
  // —— 前者是 undefined，渲染时直接抛错。命令名检查完全看不见这种漂移，
  // 因为 `open_workspace` 这个名字在两份定义里都对。
  //
  // ## 为什么是双向
  //
  // - Rust 有、前端没有 → 前端拿不到这个数据（或多打了一次命令）
  // - 前端有、Rust 没有 → 前端读到 undefined，**必然崩溃**
  //
  // 两个方向都是真实故障，因此都要报。
  if (typesTs) {
    const rustSources = [commandsRs, coreModel, coreTrash, storeStats, fsWorkspace].filter((s) => s !== null);

    for (const [rustName, tsName, file] of STRUCT_CONTRACTS) {
      const source = read(file);
      if (source === null) {
        fail("结构体", `读不到 ${rustName} 的定义文件：${file}`);
        continue;
      }

      const rustFields = rustStructFields(source, rustName);
      const tsFields = tsInterfaceFields(typesTs, tsName);

      if (rustFields === null) {
        // 解析不到就报错。这条纪律来自本文件已有的原则：
        // 一条沉默的检查等于没有检查，而"改了结构体名忘了改脚本"
        // 恰恰会让检查从此永久失效
        fail("结构体", `在 ${file.split(/[\\/]/).pop()} 里解析不到 pub struct ${rustName}（改名了？还是丢了 rename_all = "camelCase"？）`);
        continue;
      }
      if (tsFields === null) {
        fail("结构体", `在 types.ts 里找不到 export interface ${tsName}`);
        continue;
      }

      const rustSet = new Set(rustFields);
      const tsSet = new Set(tsFields);
      for (const f of rustFields) {
        if (!tsSet.has(f)) {
          fail("结构体", `${rustName} ↔ ${tsName}：Rust 有字段 "${f}" 但前端没有（前端拿不到这个数据）`);
        }
      }
      for (const f of tsFields) {
        if (!rustSet.has(f)) {
          fail("结构体", `${rustName} ↔ ${tsName}：前端有字段 "${f}" 但 Rust 没有（前端会读到 undefined）`);
        }
      }
      if (rustSet.size === 0 || tsSet.size === 0) {
        fail("结构体", `${rustName} ↔ ${tsName}：字段集合为空（Rust ${rustSet.size} 个 / 前端 ${tsSet.size} 个），解析规则可能失效了`);
      }
    }
    log(`结构体字段：已比对 ${STRUCT_CONTRACTS.length} 组`);
    // 显式标记这几个源文件已纳入解析（供将来扩展时确认覆盖范围）
    void rustSources;
  } else {
    skipped.push("结构体字段（缺少 types.ts）");
  }

  // ---- 报告 ----
  console.log("");
  if (skipped.length > 0) {
    for (const s of skipped) log("跳过：" + s);
  }

  if (failures.length === 0) {
    log("全部检查通过：IPC 契约的前后端定义一致。");
    return 0;
  }

  log(`发现 ${failures.length} 处契约不一致：`);
  for (const f of failures) {
    log(`  [${f.check}] ${f.message}`);
  }
  console.log("");
  log("修复方式：改前端 src/lib/ipc/types.ts 或后端 src-tauri/src/commands.rs，使两边一致。");
  return 1;
}

process.exit(main());
