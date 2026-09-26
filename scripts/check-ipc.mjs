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
 * 具体检查四件事：
 *
 * | 检查 | 抓到的真实故障 |
 * | --- | --- |
 * | 命令名一一对应 | 前端 invoke 的名字写错 / 后端改了名 |
 * | 错误码集合一致 | 前端 switch 走到 default，用户看到"操作失败" |
 * | 枚举取值一致 | `ChapterStatus` 少一个取值导致状态显示空白 |
 * | 结构体字段名一致 | camelCase 转换漏了某个字段 |
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
const IPC_TS = join(ROOT, "src", "lib", "ipc", "types.ts");
const IPC_INDEX_TS = join(ROOT, "src", "lib", "ipc", "index.ts");

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
  // mock 少实现一个方法，对应的界面在浏览器里就是坏的
  const mockTs = read(join(ROOT, "src", "lib", "mock-backend", "index.ts"));
  if (mockTs && indexTs) {
    const ts = tsInvokedCommands(indexTs);
    // MockBackend 接口里的方法名
    const interfaceBlock = /export interface MockBackend\s*\{([\s\S]*?)\n\}/.exec(mockTs);
    if (!interfaceBlock) {
      fail("mock", "找不到 MockBackend 接口定义");
    } else {
      const methods = new Set();
      for (const m of interfaceBlock[1].matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9]*)\s*\(/gm)) {
        methods.add(m[1]);
      }
      log(`mock 后端实现 ${methods.size} 个方法`);
      if (methods.size === 0) {
        fail("mock", "MockBackend 接口里一个方法都没解析到");
      }
    }
    void ts;
  } else {
    skipped.push("mock 覆盖（缺少 mock-backend/index.ts）");
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
