# 修复计划 —— P0 缺陷与 CI 守卫接线

> 来源：2026-02 代码质量评估（只读审查）。
> 本文档是**执行用**的工作单，不是讨论稿。每一项都给出证据、验收标准与明确的改法。
> 执行者请遵循第 0 节的不变量；违反它们比不修更糟。

---

## 执行结果（已由复核者独立验证）

四项任务 **A/B/C/D 全部完成**，改动留在工作树、**未提交 commit**。
范围：13 个修改文件 + 2 个未跟踪文件（`docs/fix-plan-p0.md`、`src/lib/ipc/contract.test.ts`）。

**复核者独立重跑的命令与结果**（不是执行者的自述）：

| 命令                                                    | 结果                                             |
| ------------------------------------------------------- | ------------------------------------------------ |
| `cargo test --workspace`                                | **937 passed, 0 failed**                         |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过，零警告                                     |
| `cargo fmt --all -- --check`                            | 通过                                             |
| `pnpm typecheck` / `pnpm lint`                          | 通过                                             |
| `pnpm test`                                             | **35 files / 1971 passed**                       |
| `node scripts/check-ipc.mjs`                            | 通过（6 项全跑，含「结构体字段：已比对 12 组」） |
| `pnpm check:kit`                                        | 通过                                             |

**修复有效性已用探针独立实测**（把 `isTauri()` 骗成 true + 拦截 `invoke`）：

| 命令               | 修复前                    | 修复后                            |
| ------------------ | ------------------------- | --------------------------------- |
| `open_workspace`   | `{"root":…}` ❌           | `{"path":…}` ✅                   |
| `create_workspace` | `{"root":…,"title":…}` ❌ | `{"path":…,"title":…}` ✅         |
| `get_word_stats`   | `{"chapterId":…}` ❌      | `{"volumeId":…,"chapterId":…}` ✅ |

**`check-ipc` 的检查确实有效**：把 `patternLabel` 故意改成 `patternLabelX` →
`EXIT=1` 并报出双向缺失；恢复后 `EXIT=0`。

### 执行中发现的新问题（**未修**，需另开待办）

1. **`pnpm format:check` 在 HEAD 上就是失败的。** 复核者在**未改动任何文件**的
   干净 HEAD 上实测：`Code style issues found in 218 files`，`EXIT=1`。
   根因：仓库**没有 `.prettierrc`**（`git ls-files` 确认无 prettier 配置），
   Prettier 默认值与既有代码风格不一致。
   而 `ci.yml:39` 把 `pnpm format:check` 作为前端 job 的**第一步** ——
   也就是说 **CI 的前端 job 从来不可能绿**。
   建议：加 `.prettierrc`，或全量 `prettier --write` 后单独提交。
   **本次刻意未修**（会波及 218 个无关文件、掩盖真正的 diff）。
2. **`book` 元数据在 open 路径上不可得** —— 已确认。`OpenResult` 只给
   `WorkspaceSummary{title}` 与 `outline`，没有作者 / 简介 / 书级更新时间。
   现用最小占位并有测试钉死「不伪造」。要真正填上需后端新增命令或扩 `OpenResult`。

### 执行者的两处合理偏离（复核者认可）

- **计划 4.2 让用 `toCamelCase` 折算命令名**：实测会产生 3 条假警报
  （`search_chapters` 的 mock 方法叫 `search` 等）。改用 `call()` 第三参里的
  `b.<方法名>` 作为权威映射 —— 符合计划原文「在 `call()` 的调用处建立映射」。
  **假警报比没有检查更糟**，此取舍正确。
- **把 5 个 `#[tauri::command]` 的函数体抽成 `*_impl(&AppState, …)`**：
  因为 `tauri::State<'_, T>` 没有公开构造方式，不抽就**测不了**（这正是
  任务 C 原缺陷零覆盖的原因）。符合仓库「命令层是薄壳」的既有约定。

### 文档同步轮（修复之后）

代码修完但文档没跟上，等于把错误信息留给下一个人。本轮同步了：

| 文件                       | 改了什么                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`             | 新增「修复」「构建」两节，记录四个 P0 缺陷、CI 守卫接线、`check-ipc` 的两处修正，以及两条已知问题                                                                                               |
| `docs/workspace-format.md` | 新增「卷名存在哪里」一节（`volumes` 字段示例、旧格式自动回填、手工改目录名的后果）；数据安全表补「保存前冲突检查」；**修正「防抖 800ms」→ 实际 1500ms / 最长 30s**                              |
| `docs/done-list.md`        | 总览的**里程碑状态修正**（M4/M5/M6/M7/M8/M9 此前标 `[~]` 或「未开始」，实际已在 `e3b3354` 落地并接进 `App.tsx`）；新增「P0 缺陷修复轮」一节与「本轮新发现的既有问题」                           |
| `docs/更新报告.md`         | 顶部加过时提示；末尾新增「后续轮次进展」，补记 `e3b3354`（M0–M4 未竟项）与本轮 P0 修复；并说明「上一轮的 `check:ipc` 为何没拦住本轮漂移」                                                       |
| `CONTRIBUTING.md`          | 提交前命令加 `check:ipc` / `check:kit`；`format:check` 已知坏损的警告与「不要跑 `pnpm format`」；Rust 约定加两条踩坑规则（`dirName` 不得现算、加字段必须 `serde(default)`）；完成定义补两条教训 |
| `README.md`                | 测试命令补两个守卫脚本；工作区格式一节补卷名持久化的说明                                                                                                                                        |

**顺带查实的既有文档缺陷**（不是本轮引入）：

- `docs/workspace-format.md` 写「防抖保存 800ms」，实现是
  `AUTOSAVE_DEBOUNCE_MS = 1500`（`src/features/editor/autosave.ts:44`，
  生产代码从不覆盖）。已按实现修正为 1.5 秒 / 最长 30 秒。
- `docs/done-list.md` 与 `docs/更新报告.md` 停留在两轮之前的状态：
  提交 `e3b3354` 改了 126 个文件（编辑器内核、PDF 导出、CI 守卫），
  **却一个文档都没更新**（`git show --name-only e3b3354` 确认）。
  于是文档说 M4「未开始」，而代码里 M4 已完成、CodeMirror 已接入、
  `StatsView` / `SearchPanel` / `SettingsPanel` / `CommandPalette` 都已在
  `App.tsx` 里接线。本轮按**代码与接线实况**修正了状态，未采信自述。

---

## 0. 执行前必读

### 0.1 仓库纪律（必须遵守）

- Rust：`edition 2021`、`rust-version 1.77`。workspace 开启
  `unsafe_code = "forbid"`、`missing_debug_implementations = "warn"`、
  clippy `all = deny`。**新增的 public 类型必须有 `Debug` 与文档注释**
  （`src-tauri/src/lib.rs:30` 有 `#![warn(missing_docs)]`）。
- 代码注释与文档注释一律**中文**，并且解释「**为什么**」而不是「是什么」。
  这是本仓库最鲜明的风格，请勿写 `// 设置标题` 这类复述型注释。
- 前端：SolidJS 1.9 + TypeScript 5.7。ESLint 以 `--max-warnings 0` 运行。
  **注意 `pnpm format:check` 目前是坏的**（见「执行结果」一节：仓库无
  `.prettierrc`，218 个文件在未改动时就不过）。因此**不要跑 `pnpm format`**
  —— 它会重排全仓 200+ 个无关文件、淹没真正的 diff。要检查格式请只针对
  自己改过的文件：`pnpm exec prettier --check <文件>`。
- 不要引入新依赖。不要重构与本次任务无关的代码。

### 0.2 完成定义（DoD）

每项任务的 DoD 都包含这四条：

1. `cargo test --workspace` 全绿。
2. `cargo clippy --workspace --all-targets -- -D warnings` 零警告。
3. `cargo fmt --all` 已执行（`cargo fmt --all -- --check` 通过）。
4. 若改了 `src/**`：`pnpm typecheck && pnpm lint && pnpm test` 全绿，
   且 `pnpm format:check` 通过。

### 0.2.1 已建立的环境与基线（在本机实测过）

**命令可用**：`node v24.15.0`、`pnpm 11.21.0`、`cargo 1.97.0`。
`node_modules/` 与 `dist/` 均已就绪。先前「PowerShell 被沙箱阻断」的情况
**已解除** —— 请**真的去跑**验证命令，不要只是列举。

**改动前的基线（全绿，可作为回归对照）**：

| 命令                                                                 | 结果                     |
| -------------------------------------------------------------------- | ------------------------ |
| `pnpm exec tsc --noEmit`                                             | 通过（exit 0）           |
| `pnpm exec vitest run src/lib/ipc/ipc.test.ts`                       | 31 passed                |
| `cargo test -p yuhua-core -p yuhua-fs -p yuhua-store -p yuhua-stats` | **578 passed, 0 failed** |

> 注意：`cargo test` 首次编译约 45 秒，`yuhua-fs` 的集成测试里有一个
> 大工作区用例耗时约 54 秒。给命令留足超时（建议 ≥ 10 分钟），
> 或后台运行后收结果。

**常用命令**（按仓库既有脚本）：

```powershell
pnpm typecheck            # tsc --noEmit
pnpm lint                 # eslint . --max-warnings 0
pnpm test                 # vitest run
pnpm check:ipc            # node scripts/check-ipc.mjs
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

---

## 1. 任务 A：修正 IPC 契约漂移（最高优先级）

### 1.1 问题

前端 mock 后端让全部测试变绿，但**真实 Tauri 路径是坏的**，且零测试覆盖。
三个已核实的漂移：

| #   | 前端                                 | Rust 实际                                      | 证据                                                                                                     |
| --- | ------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A1  | `invoke("open_workspace", { root })` | 参数名是 `path`                                | `src/lib/ipc/index.ts:127` vs `src-tauri/src/commands.rs:152`                                            |
| A2  | 期望返回 `{ root, document }`        | 返回 `{ workspace, outline, words, recovery }` | `src/lib/ipc/types.ts:389`、`src/lib/mock-backend/index.ts:300,308` vs `src-tauri/src/commands.rs:79-90` |
| A3  | `get_word_stats` 只传 `chapterId`    | 需要 `volume_id` + `chapter_id`                | `src/lib/ipc/index.ts:300` vs `src-tauri/src/commands.rs:219-223`                                        |

A2 是**必然崩溃**：`src/app/workspace-store.ts:122` 写
`document: result.document`，而 Rust 返回的对象里没有 `document` 字段 →
`state.document` 为 `undefined` → 渲染卷章树时抛错。
`src/lib/ipc/index.ts:425-426` 的 `result.document.recovery` 同样会崩。

**为什么没被测出来**：jsdom 下 `isTauri()` 恒为 false
（`src/lib/ipc/index.ts:59-63`），所有测试都走 mock 分支（`:92-98`）。

### 1.1.1 已实测的证据（不是推断）

我用一个临时探针（把 `isTauri()` 骗成 true 并替换 `@tauri-apps/api/core` 的
`invoke`）抓到了前端**实际发出**的参数，确认如下 —— 形态为 `[命令名, 参数]`：

```text
["open_workspace",   {"root":"D:/ws"}]                  ← Rust 要 `path`
["create_workspace", {"root":"D:/ws","title":"书"}]      ← Rust 要 `path`
["get_word_stats",   {"chapterId":"ch_1"}]              ← Rust 要 `volume_id` + `chapter_id`
```

因此**第 4 处漂移**：`create_workspace` 同样把 `root` 传成了 `path`
（Rust 签名见 `commands.rs:135-139`）。计划 1.2 第 1 条已覆盖，这里记明
它是**实测确认**而非推测。

> 复现方式（若你想自己再跑一次）：写一个临时 `*.test.ts`，
> `vi.mock("@tauri-apps/api/core", ...)` 记录 `invoke` 的调用参数，
> 再 `vi.stubGlobal("__TAURI_INTERNALS__", {})`。**跑完请删除该临时文件。**
> 任务 A 完成后，同一手法应当抓到 `{"path": ...}`。

### 1.2 改法（必须按此方向，不要自创）

**统一到 Rust 侧的真实形状**（Rust 是服务端，且它的形状更合理）。

1. **A1**：`src/lib/ipc/index.ts:127` 改为
   `call("open_workspace", { path: root }, ...)`。
   同时检查 `create_workspace`（`:122`）：Rust 签名是
   `create_workspace(state, path: String, title: String)`（`commands.rs:135-139`），
   前端传的是 `{ root, title }` —— **同样要改成 `{ path: root, title }`**。

2. **A2**：改写 `src/lib/ipc/types.ts` 的 `OpenWorkspaceResult`，使其精确镜像
   `commands.rs:79-90` 的 `OpenResult`：

   ```ts
   /** 工作区打开结果，对应 Rust `commands::OpenResult`。 */
   export interface OpenWorkspaceResult {
     workspace: WorkspaceSummary;
     outline: OutlineNode[];
     words: WordStats;
     recovery: RecoveryReport;
   }
   ```

   然后修改所有消费点：`src/app/workspace-store.ts:121-127`（`openWorkspace`）、
   `:134-135`（`createWorkspace`）、`:385-386`（`reloadDocument`）。
   **这三个函数原本用 `result.document`，现在必须从 `result.outline` 重建
   `WorkspaceDocument`**。

   > 关键设计决定：`WorkspaceDocument` 形状是
   > `{ book, volumes, chapters, recovery }`（`types.ts:377-386`），
   > 而 `OpenResult` 给的是 `{ workspace, outline, words, recovery }`。
   > 两者缺 `book` 与 `volumes`。**不要为此给 Rust 加字段或加命令** ——
   > `book` 可从 `workspace`（有 `title`）与 `outline` 无法完整还原。
   > 正确做法见下一条。

3. **A2 的收口方案（重要）**：前端已有 `get_outline` 命令
   （`commands.rs:213`，返回 `Vec<OutlineNode>`）。让 store 在打开工作区后
   **额外调用一次 `getOutline()`** 来拿 `outline`，并用
   `ipc.openWorkspace` 返回的 `workspace` / `recovery` 补其余字段。
   具体地，在 `workspace-store.ts` 内新增一个纯函数（便于单测）：

   ```ts
   /**
    * 把 `open_workspace` 的返回折成前端内部使用的文稿形状。
    *
    * ## 为什么需要这一次折算
    *
    * Rust 的 `OpenResult` 给的是「工作区摘要 + 大纲 + 全书字数 + 恢复报告」，
    * 而界面需要的是「书 + 卷 + 章摘要」。两边的形状本就不同 ——
    * 折算是契约的一部分，不是临时补丁。
    *
    * 卷列表从大纲里取：`OutlineNode` 已经带了 `volumeId/title/sort`，
    * 不额外发 `get_volumes` 之类的命令（那种命令不存在，也不该为它存在）。
    */
   ```

   `book` 字段：`WorkspaceSummary` 只有 `title`，没有作者/简介/时间。
   **这是真实的信息缺口** —— 请在 `types.ts` 的注释里明确写出这一点，
   并在实现里用一个最小的 `Book` 占位（`id` 用 `workspace.workspaceId`，
   `title` 用 `workspace.title`，其余空串），
   同时**在计划落地的最终报告里把「book 元数据在 open 路径上不可得」
   列为一条新的待办**。不要为了凑字段而伪造数据。

4. **A3**：`src/lib/ipc/index.ts:299-301` 的 `getWordStats`。
   Rust 是 `get_word_stats(state, volume_id: Option<String>, chapter_id: Option<String>)`。
   前端当前只传 `chapterId`。改为同时支持两者：

   ```ts
   export function getWordStats(
     volumeId?: string,
     chapterId?: string,
   ): Promise<WordStats>;
   ```

   **先 grep 所有调用点**（`grep "getWordStats" src/`）再改签名，
   同步更新调用方与 `src/lib/mock-backend/index.ts:91` 的接口。
   mock 的 `getWordStats(chapterId?)` 也要跟着改成双参数，否则
   `check:ipc` 与类型检查会不一致。

### 1.3 A 的验收标准

- 新增一个**真实契约**测试（不经过 mock）：`src/lib/ipc/contract.test.ts`，
  用 `vi.stubGlobal("__TAURI_INTERNALS__", {})` 让 `isTauri()` 为 true，
  然后 mock `@tauri-apps/api/core` 的 `invoke`，断言：
  1. `openWorkspace("/x")` 调用的**第一个参数是 `"open_workspace"`**，
     且**第二个参数恰好是 `{ path: "/x" }`**（不是 `{ root: ... }`）。
  2. `createWorkspace("/x", "书")` 传的是 `{ path: "/x", title: "书" }`。
  3. 给 `invoke` 喂一份**照着 Rust `OpenResult` 写的** JSON
     （`{ workspace, outline, words, recovery }`），断言
     `workspace-store` 能正确装出 `document`，**不抛异常且 `document !== null`**。
  4. `getWordStats` 传出的参数里同时含 `volumeId` 与 `chapterId`。

  > 第 3 条是本次修复的核心回归测试：它用「Rust 的形状」而不是
  > 「mock 的形状」验证前端，这正是当初漏掉的判据。

---

## 2. 任务 B：卷名持久化（消除「重命名被静默丢弃」）

### 2.1 问题（已核实）

`src-tauri/src/scan.rs:79-82` 每次扫描都**从目录名重建卷**，`sort` 用枚举下标，
标题用 `strip_sort_prefix` 从 `001-第一卷 风起` 里切出：

```rust
for (i, (dir_name, _path)) in volume_dirs.iter().enumerate() {
    let vol_title = strip_sort_prefix(dir_name);
    volumes.push(Volume::new(&book.id, &vol_title, i as i32, now));
}
```

`volume_dir_name()`（`src-tauri/crates/yuhua-fs/src/layout.rs:245-247`）把
sort 与标题**都烤进目录名**，磁盘上没有别处存卷名。

于是 `rename_volume`（`src-tauri/src/commands.rs:293-309`）只改内存、
不碰磁盘，紧接着的 `reload_and_sync`（`:1025-1048`）用扫描结果
`replace_document(fresh)` **整体覆盖内存** → **重命名当场丢失**。

连锁后果：

- `create_chapter`（`:389-396`）用内存里的 `vol.sort/vol.title` 拼路径，
  重命名后会指向**旧目录名** → 建出孤儿目录，或撞进**另一个卷**的目录。
- `delete_volume`（`:331-337`）的 `exists()` 判断失败时**跳过回收站**（`:338`），
  随后把章节从内存与索引删除（`:341-349`）→ 界面报成功、磁盘文件还在、
  下次扫描又复活。

### 2.2 改法（用户已选定方案：存进 `workspace.json`）

`WorkspaceConfig` 已经是一个带 `formatVersion` 与迁移纪律的、原子写入的
JSON（`src-tauri/crates/yuhua-fs/src/workspace.rs:36-51`，写函数
`write_config` 在 `:306-315`）。**卷清单就放这里。**

1. **新增结构**（`workspace.rs`，靠近 `WorkspaceConfig`）：

   ```rust
   /// 一个卷在配置文件里的持久化形态。
   ///
   /// ## 为什么卷名要进 workspace.json
   ///
   /// 卷名此前只存在于目录名（`001-第一卷 风起`），而目录名一旦改动，
   /// 云盘与 Git 会看到「删除 + 新增」两个事件。把标题与排序持久化到
   /// 配置里，重命名就只是一次配置写入 —— 磁盘目录名退化为**纯哈希键**，
   /// 不再承载语义。
   #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
   #[serde(rename_all = "camelCase")]
   pub struct VolumeRecord {
       /// 卷 ID。
       pub id: String,
       /// 卷名。
       pub title: String,
       /// 排序序号。
       pub sort: i32,
       /// 对应的磁盘目录名（相对 `manuscript/`）。
       pub dir_name: String,
   }
   ```

2. **`WorkspaceConfig` 加字段**，必须带 `#[serde(default)]` 以兼容旧文件：

   ```rust
   /// 卷清单。空表示这是一个尚未记录卷信息的旧工作区，
   /// 由扫描流程从目录名回填（见 `scan` 模块）。
   #[serde(default)]
   pub volumes: Vec<VolumeRecord>,
   ```

   `WorkspaceConfig::new`（`:55-64`）里初始化为 `volumes: Vec::new()`。

3. **`scan.rs` 改为「配置优先、目录名兜底」**。这是本任务的核心。
   修改 `scan_workspace`（`scan.rs:64-82` 一带）：
   - 先按目录名收集 `volume_dirs`（**保持现有逻辑，它是对的**）。
   - 若 `workspace.config.volumes` 非空：对每个目录，用 `dir_name`
     去配置里查 `VolumeRecord`；命中则用它的 `id`/`title`/`sort`，
     未命中（用户手工新建的目录）则退回 `strip_sort_prefix` + 递增 sort。
   - 若配置为空（旧工作区首次以新版本打开）：**按现有逻辑从目录名推导，
     并把结果回填进配置**（写入 `workspace.json`）。
     回填动作放在扫描的调用方（`AppState::open`）而不是 `scan_workspace` 内部，
     以保持 `scan_workspace` 是纯读函数。

   > **注意 `scan.rs:84-95` 的 `volume_by_dir` 映射**：它用
   > `volumes.iter().filter(|v| v.sort >= 0).nth(i)` 把目录名映射到卷 ID。
   > 一旦 sort 不再等于枚举下标，这个 `nth(i)` 就会错位 ——
   > **必须改为按 `dir_name` 直接查表**，而不是靠位置对齐。
   > 这是本次改动最容易引入新 bug 的地方，请重点写测试。

4. **`rename_volume` / `reorder_volumes` / `create_volume` / `delete_volume`
   改为写配置**：
   - 新增一个 `WorkspaceSession` 方法或 `yuhua-fs` 侧函数来持久化卷清单，
     例如 `Workspace::save_volumes(&self, volumes: &[VolumeRecord]) -> Result<()>`，
     内部用 `write_config`（**复用原子写**，不要自己 `fs::write`）。
   - `rename_volume`（`commands.rs:293-310`）：改内存 → 写配置 → `reload_and_sync`。
     注意顺序：**先落盘再重扫**，否则重扫又会把改动冲掉。
   - `reorder_volumes`（`:509-529`）同样。
   - `create_volume`（`:237-275`）：建目录后把新卷写进配置。
   - `delete_volume`（`:314-351`）：**先按配置里的 `dir_name` 定位目录**
     （不要再用内存里的 `volume_dir_name(vol.sort, &vol.title)` 现拼），
     移入回收站成功后，从配置移除该卷。
     `exists()` 为假时**不要静默跳过** —— 仍然要把卷从配置与内存移除，
     但要在返回里能反映出来（至少加一条 `tracing`/`eprintln!` 级别的说明，
     或让 `RepairResult` 之类带出信息）。**绝不能出现「UI 说删了、其实没删且没人知道」。**

5. **`strip_sort_prefix` 保持不动**（`scan.rs:222-233`）：它仍是兜底路径，
   且已有测试。

### 2.3 B 的验收标准

必须新增 Rust 测试（放在 `src-tauri/src/` 或对应的集成测试里）：

1. `rename_volume` 之后立刻 `get_outline`，卷名是**新名字**（当前会失败）。
2. `rename_volume` 之后 `create_chapter`，新章节文件落在
   **该卷真实的目录**里，且 `manuscript/` 下**没有新建多余目录**。
3. `reorder_volumes` 之后重开工作区（`AppState::open` 两次），
   顺序保持。
4. **旧格式兼容**：手工写一个不含 `volumes` 字段的 `workspace.json`，
   断言能正常打开、卷从目录名推导、且回填后再次打开得到相同结果。
5. `delete_volume` 在目录不存在时，卷确实从大纲里消失。

---

## 3. 任务 C：`save_chapter` 的覆盖防护不得「读失败即放行」

### 3.1 问题（已核实）

`src-tauri/src/commands.rs:627-639`：

```rust
let current = yuhua_fs::chapter_io::read_chapter(&abs)
    .map(|cf| yuhua_store::index::content_hash(&cf.body))
    .unwrap_or_default();                       // 读失败 → ""
if current != expected && !current.is_empty() { // "" 被判为「无冲突」
    return Err(...);
}
```

`.unwrap_or_default()` 把任何读取失败塌成 `""`，`!current.is_empty()`
又把 `""` 判为无冲突。**恰好在文件被云盘锁住 / 被删 / IO 出错时防护失效**，
代码继续走到 `:659` 的原子写，覆盖磁盘版本 —— 违反注释 `:595-599`
承诺的「绝不静默覆盖」。

### 3.2 改法

读失败必须**中止保存**并给出可读错误，而不是放行。参考实现：

```rust
if let Some(expected) = expected_hash.as_deref() {
    if !expected.is_empty() {
        // 读不出来时**不能**当作「没有冲突」—— 那正好会在文件被云盘
        // 锁住或误删时放行一次覆盖，把用户的稿子冲掉。
        // 「不知道磁盘上是什么」与「磁盘上和我读到的一样」是两回事，
        // 前者必须中止。
        let cf = yuhua_fs::chapter_io::read_chapter(&abs).map_err(|e| {
            CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(format!(
                "无法读取磁盘上的章节内容，为安全起见本次保存已取消：{e}"
            )))
        })?;
        let current = yuhua_store::index::content_hash(&cf.body);
        if current != expected {
            return Err(CommandError::Domain(yuhua_core::YuhuaError::InvalidInput(
                "该章节已被外部修改（可能来自云盘同步或其它编辑器），为避免覆盖你的改动，本次保存已取消。请重新打开该章查看最新内容。".into(),
            )));
        }
    }
}
```

要点：

- **删掉 `!current.is_empty()` 这个短路**。改成读失败即 `Err` 之后，
  `current` 一定是真实哈希，可以直接比较。
- **顺手修掉 `:634` 的文案 bug**：原字符串里嵌了 **21 个连续空格**
  （字面量折行时把源码缩进带进去了），会原样显示给用户。
  上面已写成单行字符串。**同类问题还有一处**：
  `src-tauri/crates/yuhua-fs/src/workspace.rs:180` 的版本过高提示里
  也有 `，                     以免` —— 一并修掉。
- 不要动这个检查的位置与语义方向（仍然是「拒绝覆盖」）。

### 3.3 C 的验收标准

新增 Rust 测试（`commands.rs` 的 `mod tests`，或更合适的集成测试）：

1. `expected_hash` 非空 + 文件**不存在** → `save_chapter` 返回 `Err`，
   且**磁盘上没有被创建出文件**。
2. `expected_hash` 非空 + 文件内容与哈希**不符** → 返回 `Err`，
   且**磁盘内容保持原样**（这条是核心回归）。
3. 哈希相符 → 保存成功。
4. `expected_hash` 为 `None` 或 `""` → 保持现有的「无条件保存」行为
   （向后兼容，不要改变这个分支）。

---

## 4. 任务 D：把守卫脚本接进 CI，并补齐 `check-ipc` 的空转检查

### 4.1 问题（已核实）

1. `package.json:36-37` 定义了 `check:ipc` 与 `check:kit`，
   但 `.github/workflows/ci.yml` **从未调用它们**
   （CI 只跑 `format:check / lint / typecheck / test / build`，`ci.yml:39-51`）。
   `scripts/check-devkit-excluded.mjs:13` 自己写着「挂进 CI 的 build 之后即可」，
   一直没挂。
2. `scripts/check-ipc.mjs` 的第 5 项检查是**空转**的：

   ```js
   // check-ipc.mjs:327-343
   const ts = tsInvokedCommands(indexTs);
   ...
     log(`mock 后端实现 ${methods.size} 个方法`);
     if (methods.size === 0) { fail("mock", "..."); }
   }
   void ts;   // ← :343 收集完即丢弃，从未与 methods 比对
   ```

   文件头 `:27-32` 的表格自称四项检查，实际第三/四项之外的第 5 项是 no-op。

3. `check-ipc.mjs` **完全不比对结构体字段名** —— 这正是任务 A 的漂移
   能长期潜伏的原因。

### 4.2 改法

1. **`ci.yml`**：在 `frontend` job 的 `build` 之后加两步
   （`check:kit` 依赖 `dist/`，所以必须在 `pnpm build` 之后）：

   ```yaml
   - name: IPC 契约检查
     run: pnpm check:ipc

   - name: 预览页未泄漏进产物
     run: pnpm check:kit
   ```

   注意 `check-ipc.mjs` 失败时 `process.exit(1)`（`:368`），
   `check-devkit-excluded.mjs` 用 `process.exitCode = 1`（`:72`）——
   两者都能让 CI 失败，无需改动即可接线。

2. **修 `check-ipc.mjs` 第 5 项**：真正做集合比对。
   `MockBackend` 的**方法名**与前端 `call("<命令名>")` 的命令名**不是同一套命名**
   （一个是 `openWorkspace`，一个是 `open_workspace`），
   所以不能直接比字符串。请在 `call()` 的调用处建立映射，或用
   camelCase↔snake_case 转换后比对：

   ```js
   /** snake_case → camelCase，用于把命令名对齐到 mock 方法名。 */
   function toCamelCase(name) { ... }
   ```

   然后对每个前端命令名断言 `methods.has(toCamelCase(name))`，
   缺失则 `fail("mock", ...)`。**删掉 `void ts;`。**
   同时更新文件头 `:27-32` 的表格，让它与实际实现的检查一一对应。

3. **给 `check-ipc.mjs` 增加结构体字段比对**（这是本次最有价值的一项）。
   在脚本里新增一条检查：解析 `commands.rs` 里
   `#[serde(rename_all = "camelCase")] pub struct X { ... }` 的字段名，
   与 `src/lib/ipc/types.ts` 里 `export interface X { ... }` 的字段名做**双向**
   集合比对（Rust 有前端没有 → fail；前端有 Rust 没有 → fail）。

   需要覆盖的关键结构体（至少）：
   `OpenResult`、`ChapterContent`、`ChapterSummary`、`OutlineNode`、
   `WordStats`、`WordCount`、`StatsPayloadDto`、`StatsDayDto`、
   `WorkspaceSummary`、`RecoveryReportDto`、`ConflictDto`、`TrashEntry`。

   Rust 侧字段是 `snake_case`、TS 侧是 `camelCase`，转换后再比。
   **解析不到结构体时要 fail 而不是 skip**（`check-ipc.mjs:41` 已经确立了
   这个「沉默的检查等于没有检查」的原则，请遵守它）。

   > 注意 `TrashEntry`、`WordStats`、`WorkspaceSummary` 定义在
   > `yuhua-core` / `yuhua-fs` / `yuhua-store` 里，不在 `commands.rs`。
   > 需要把对应的源文件也加入解析列表（照 `check-ipc.mjs:53-60`
   > 已有的 `ERROR_RS` / `CORE_ERROR_RS` 模式，多文件合并解析）。

### 4.3 D 的验收标准

1. 本地跑 `node scripts/check-ipc.mjs` → **必须报出任务 A 修复前的那些漂移**
   （先在 A 之前跑一次留证，再在 A 之后跑一次应为通过）。
   这个「先红后绿」是检验新检查真的有效的唯一方式。
2. 故意把 `types.ts` 里某个字段名改错一个字母 → 脚本必须 `exit 1`。
3. `ci.yml` 的改动能被 `actionlint` 之类的 YAML 语法检查通过
   （若无法运行，至少人工核对缩进层级为 8 空格，与同 job 其它 step 一致）。

---

## 5. 明确**不要**做的事（本次范围外）

以下问题已在评估中确认存在，但**本次不修**，以免扩大回归面：

- 自动保存的丢失更新（`src/app/EditorPane.tsx:225-236` 的
  `void scheduler?.flushNow(); scheduler?.reset();`）。
- `reload_and_sync` 持锁做全盘扫描（`commands.rs:1025-1034`）。
- `Index::rebuild` 缺少事务（`index.rs:365-367`）。
- `trash.rs:173-187` 的跨盘判据过粗。
- 前端 `Resizer` 泄漏监听器、`undo`/`redo` 未派发命令、
  `setCurrentRoot` 零调用点、`ChapterTree` 无障碍缺口。

请**不要顺手改**这些。若在实现过程中发现它们与本次改动强耦合
（例如 B 必须动 `delete_volume`，而那里也有 `.ok()` 吞错），
可以修**同一函数内**的相关行，但要在最终报告里单独列出。

---

## 6. 交付物

1. 代码改动（任务 A–D）。
2. 新增测试（A: 前端契约测试；B: 卷持久化与旧格式兼容；C: 并发覆盖防护）。
3. 最终报告，必须包含：
   - 每个任务的**状态**（完成 / 部分完成 / 未做）与**改动文件清单**。
   - **实际运行的验证命令与结果**；若因沙箱无法运行，明确说明并列出期望命令。
   - 任务 A 第 3 步发现的「`book` 元数据在 open 路径上不可得」这条新待办的确认。
   - 第 5 节里若因耦合而顺带修改的行，逐条列出。
   - 任何你**无法确定**的地方 —— 不要猜，标出来。

---

## 附：证据索引（供执行者复核）

| 结论                             | 证据位置                                                 |
| -------------------------------- | -------------------------------------------------------- |
| `open_workspace` 参数名是 `path` | `src-tauri/src/commands.rs:152`                          |
| `OpenResult` 真实字段            | `src-tauri/src/commands.rs:79-90`                        |
| 前端期望 `{root, document}`      | `src/lib/ipc/types.ts:389-394`                           |
| mock 返回 `{root, document}`     | `src/lib/mock-backend/index.ts:300,308`                  |
| store 消费 `.document`           | `src/app/workspace-store.ts:122,135,386`                 |
| 测试恒走 mock                    | `src/lib/ipc/index.ts:59-63,92-98`                       |
| `get_word_stats` 双参数          | `src-tauri/src/commands.rs:219-223`                      |
| scan 从目录名重建卷              | `src-tauri/src/scan.rs:79-82,222-233`                    |
| 卷目录名烤进标题                 | `src-tauri/crates/yuhua-fs/src/layout.rs:245-247`        |
| `reload_and_sync` 覆盖内存       | `src-tauri/src/commands.rs:1025-1048`                    |
| `volume_by_dir` 靠下标对齐       | `src-tauri/src/scan.rs:84-95`                            |
| 覆盖防护读失败即放行             | `src-tauri/src/commands.rs:627-639`                      |
| 文案内嵌 21 空格                 | `src-tauri/src/commands.rs:634`                          |
| 同型文案 bug                     | `src-tauri/crates/yuhua-fs/src/workspace.rs:180`         |
| 守卫脚本未接 CI                  | `.github/workflows/ci.yml:39-51` vs `package.json:36-37` |
| `check-ipc` 第 5 项空转          | `scripts/check-ipc.mjs:327-343`                          |
| 配置原子写                       | `src-tauri/crates/yuhua-fs/src/workspace.rs:306-315`     |
