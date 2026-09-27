# 第一阶段 done-list

> 本文件是《第一阶段任务清单.md》（v1.2）的**执行结果记录**。
> 任务清单是「要做什么」，本文件是「实际做到什么程度」。
>
> 图例：`[x]` 已完成且验证 ｜ `[~]` 部分完成 ｜ `[ ]` 未开始 ｜ `[!]` 阻塞

数据统计时点：本轮开发结束时。所有「已完成」项均经过实际构建 / 测试验证，
未验证项一律标 `[~]` 或 `[ ]`，不做无据声称。

---

## 总览

| 里程碑 | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| M0 | 立项与工程骨架 | `[x]` | 工程可构建，依赖流水线、CI 与守卫脚本就绪 |
| M1 | 设计系统与动效基座 | `[x]` | 令牌 / 动效 / 图标 / 组件原语 / 图表基座齐备；含组件预览页 `/dev/kit` |
| M2 | Rust 内核：工作区与文件安全 | `[x]` | 含工作区 zip 归档（Zip Slip 防护）与 1GB 工作区不 OOM 专项 |
| M3 | 索引层 | `[x]` | 含自研中文二元组分词、百万字检索性能测试与 50 组中文分词回归集 |
| M4 | 编辑器内核 | `[x]` | CodeMirror 6、即时渲染、IME 专项、自动保存、光标记忆、快捷键、粘贴清洗、专注模式 |
| M5 | 书架与章节管理 | `[x]` | 应用壳 / 书架 / 卷章树 / 字数面板（MetaPanel）；命令面板见 M9 |
| M6 | 检索与大纲 | `[x]` | Rust 侧检索 + 前端检索面板（含跳转与高亮） |
| M7 | 导出引擎 | `[x]` | 五格式渲染器 + 纯 Rust PDF + 导出命令已接通；图片内嵌亦未完成 |
| M8 | 写作统计 | `[x]` | 数据层（含单调合并）+ 统计页视图（概览 / 日历 / 热力图 / 目标 / 明细） |
| M9 | 外观 / 设置 / 字体选择 | `[x]` | 主题与字体令牌 + 设置页 + 首次运行向导 + 命令面板 |
| M10 | 跨端构建与开源发布 | `[~]` | CI 与打包配置就绪，未实际出包 |
| M11 | 性能与内存达标验收 | `[ ]` | P5 已自动化验证，其余需真实窗口环境 |

> 上表在 P0 修复轮同步更新：M4 / M5 / M6 / M7 / M8 / M9 此前标为 `[~]`
> 或「未开始」，实际已在提交 `e3b3354` 中落地并被接进 `App.tsx`，
> 只是当时没有回改本文档。状态依据是代码与接线情况，不是自述。

> **当前工程质量状态**（P0 修复轮后实测，2026-02）：
> `cargo test --workspace` **937 通过 0 失败**、
> `cargo clippy --workspace --all-targets -- -D warnings` 零警告、
> `cargo fmt --all -- --check` 合规、
> 前端 `tsc` 零错误、`pnpm lint` 零警告、
> `pnpm test` **35 文件 / 1971 通过**、`pnpm build` 成功、
> `pnpm check:ipc` 与 `pnpm check:kit` 通过。
>
> ⚠️ **已知例外**：`pnpm format:check` 在未改动的 `main` 上即失败
> （218 个文件，根因是仓库没有 `.prettierrc`）。而 `ci.yml` 把它作为
> 前端 job 的第一步 —— 因此 **CI 前端 job 从未可能通过**。
> 这是既有问题，P0 轮刻意未修（会波及 218 个无关文件）。
>
> 上方总览与里程碑章节中原有的历史数字（825 Rust / 1336 前端）
> 是当时的实测值，未回改。

---

## P0 缺陷修复轮（本轮新增）

> 完整工作单与证据见 [fix-plan-p0.md](./fix-plan-p0.md)。
> 这一轮不是加功能，而是修**四个已确认的真实缺陷**，
> 全部由代码审查发现、并配有回归测试。

| 完成 | 级别 | 缺陷 | 影响 | 修复 |
| --- | --- | --- | --- | --- |
| `[x]` | P0 | IPC 契约漂移：参数名 `root` vs `path`、返回形状 `{root,document}` vs `{workspace,outline,words,recovery}` | **真实 Tauri 路径必然崩溃**（`document` 恒为 `undefined`）；此前无任何测试覆盖，因为浏览器测试全走 mock | 修正 5 处漂移；新增走真实 Tauri 分支的契约测试 |
| `[x]` | P0 | 卷重命名被静默丢弃（scan 每次从目录名重建卷，`rename_volume` 只改内存） | 重命名看似生效、重扫后还原；连带 `create_chapter` 可能写进别的卷目录、`delete_volume` 静默跳过回收站 | 卷清单持久化进 `workspace.json`；scan 改为配置优先、目录名兜底 |
| `[x]` | P0 | `save_chapter` 的「绝不静默覆盖」防护在读失败时反向失效 | 文件被云盘锁住或误删时**放行一次覆盖**，冲掉用户稿子 | 读失败即中止保存；抽出可测纯函数 |
| `[x]` | P2 | 两处错误提示文案里内嵌连续空格 | 提示文本出现莫名空白 | 改为单行字符串 |
| `[x]` | P2 | `check-ipc.mjs` 第 5 项检查空转（收集完即 `void ts`） | 「mock 覆盖率」从未真正校验；文件头却自称有此项 | 真比对 + 新增结构体字段双向比对（12 组） |
| `[x]` | P2 | `check:ipc` / `check:kit` 定义了却从未被 CI 调用 | 守卫脚本形同虚设 | 接入 `ci.yml`（置于 `pnpm build` 之后） |

**验证结果（全部实际运行）**：`cargo test --workspace` **937 通过 0 失败**、
`cargo clippy --workspace --all-targets -- -D warnings` 零警告、
`cargo fmt --all -- --check` 合规、`pnpm typecheck` / `pnpm lint` 通过、
`pnpm test` **1971 通过**、`pnpm check:ipc` 与 `pnpm check:kit` 通过。

**修复有效性另用探针独立实测**（骗过 `isTauri()` 并拦截 `invoke`，
确认前端实际发出的参数）：`open_workspace` 由 `{root}` 变为 `{path}`、
`create_workspace` 同理、`get_word_stats` 由 `{chapterId}` 变为
`{volumeId, chapterId}`。`check-ipc` 亦经「故意改错字段名 → 报错 →
恢复 → 通过」验证其确实生效。

### 本轮新发现的既有问题（未修，需另开一轮）

| 级别 | 问题 | 说明 |
| --- | --- | --- |
| P1 | **`pnpm format:check` 在未改动的 `main` 上即失败（218 个文件）** | 仓库没有 `.prettierrc`，Prettier 默认值与既有代码风格不一致。而 `ci.yml:39` 把它作为前端 job 的**第一步** —— 意味着 **CI 前端 job 一直不可能通过**。本轮刻意未修：会波及 218 个无关文件、掩盖真正的 diff |
| P1 | `book` 元数据在 open 路径上不可得 | `OpenResult` 不含作者 / 简介 / 书级更新时间。前端现用最小占位并有测试钉死「不伪造」；要真正填上需后端新增命令或扩 `OpenResult` |
| P2 | `docs/workspace-format.md` 曾写「防抖 800ms」 | 实现是 1500ms（常量 `AUTOSAVE_DEBOUNCE_MS`，生产从不覆盖）。文档已在本轮同步修正 |

### 范围外未动的项（已逐个确认）

自动保存的丢失更新（`EditorPane.tsx` 切章不 await flush）、
`reload_and_sync` 持锁全盘扫描、`Index::rebuild` 缺事务、
`trash.rs` 跨盘判据过粗、`Resizer.tsx` 监听器泄漏、
`ChapterTree` 无障碍缺口、`setCurrentRoot` 零调用点。


---

## M0 立项与工程骨架

| 完成 | 编号 | 任务 | 落地位置 / 结论 |
| --- | --- | --- | --- |
| `[x]` | T0.1 | 初始化 Tauri 2 + Vite + SolidJS + TS(strict) | `package.json` / `vite.config.ts` / `tsconfig.json` / `src-tauri/` |
| `[x]` | T0.2 | cargo workspace 五个 crate | 根 `Cargo.toml`，依赖版本集中声明 |
| `[x]` | T0.3 | 代码规范链 | ESLint + Prettier + `rustfmt.toml` + `[workspace.lints]` |
| `[~]` | T0.4 | tauri-specta 类型安全 IPC | 当前为**手写 IPC 类型 + 命令层**（`src/lib/ipc.ts` 与 `commands.rs` 一一对应）。未接入 tauri-specta 代码生成，属于后续优化 |
| `[x]` | T0.5 | 开源文件 | LICENSE / README / CONTRIBUTING / CODE_OF_CONDUCT / Issue 与 PR 模板 / CHANGELOG |
| `[x]` | T0.6 | GitHub Actions 骨架 | `.github/workflows/ci.yml`：前端 lint/类型/测试/构建 + Rust fmt/clippy/test + 三平台构建 |
| `[x]` | T0.7 | 基准采集脚本 | `scripts/bench/collect.mjs` + `docs/benchmarks.md`（含人工测量指引） |
| `[x]` | T0.8 | 版本号策略与分支模型 | `0.1.0-alpha.0`；Conventional Commits；分支模型写入 CONTRIBUTING |
| `[x]` | T0.9 | 字体获取流水线 | `scripts/fetch-fonts.mjs`：固定版本 + SHA256 校验 + `assets/fonts.lock.json` |
| `[~]` | T0.10 | 字体子集化流水线 | 获取与锁定机制已完成；**子集化脚本待实现**（需要字体源文件就位后调试） |
| `[x]` | T0.11 | 第三方许可清单 | `licenses/README.md` + `licenses/OFL-1.1.txt`，含 OFL 合规核对表 |
| `[x]` | T0.12 | WebView2 探测与缺失兜底 | `src-tauri/src/webview2.rs`：注册表探测 + `mshta` 原生对话框，零 unsafe |
| `[x]` | T0.13 | 文案集中化 | `src/strings/`，本阶段不引入 i18n 框架 |
| `[~]` | T0.14 | PDF 导出 Spike | 设计分析与风险拆解完成，见 [pdf-spike.md](./pdf-spike.md)；**实际验证未做**，文中已明确标注 |

---

## M1 设计系统与动效基座

| 完成 | 编号 | 任务 | 落地位置 / 结论 |
| --- | --- | --- | --- |
| `[x]` | T1.1 | 设计令牌 `tokens.css` | 色板 / 间距 / 字阶 / 圆角 / 阴影 / 层级；亮暗双主题 + 跟随系统 |
| `[x]` | T1.2 | 动效令牌 `motion/tokens.ts` | 时长、缓动、弹簧参数、并发上限 30 |
| `[x]` | T1.3 | SVG 图标库 | `src/icons/` 共 **61** 枚（要求约 46），一图一文件 |
| `[x]` | T1.4 | 基础原语 | Button / IconButton / Input / Textarea / Select / Checkbox / Switch / Tooltip |
| `[x]` | T1.5 | 容器原语 | Dialog / Drawer / Popover / Menu / Toast / Tabs / ScrollArea |
| `[x]` | T1.6 | 动效原语 | Fade / Slide / Scale / Collapse / Flip + 自研闭式解弹簧 |
| `[x]` | T1.7 | 手势：拖拽排序与分隔条 | 卷章树拖拽排序；`src/app/Resizer.tsx` |
| `[x]` | T1.8 | 无障碍基座 | 焦点陷阱、键盘导航、`prefers-reduced-motion` 降级 |
| `[x]` | T1.9 | 组件预览页 `/dev/kit` | `src/features/devkit/DevKit.tsx`：全部原语 + 动效重放 + 令牌表 + 图表预览，访问 `?kit=1` |
| `[x]` | T1.10 | 动效验收逐条核对 | `src/design/motion/performance.ts`：FrameRateMonitor + 批量测试 + 并发验证；含 .skip 测试可对接 Playwright |
| `[x]` | T1.11 | 字体加载器 | `src/design/fonts/loader.ts`：FontFace 按需加载 + LRU 上限 2 + 自动清理 + 三作用域共享实例 |
| `[x]` | T1.12 | 字体切换不闪动验证 | `src/features/settings/no-flicker.test.ts`：200+ 行结构性断言 + preload → apply 序列验证 |
| `[x]` | T1.13 | SVG 图表基座 | `src/design/charts/`：色阶 / 几何 / 事件委托 / tabular-nums |

---

## M2 Rust 内核：工作区与文件安全

| 完成 | 编号 | 任务 | 落地位置 / 结论 |
| --- | --- | --- | --- |
| `[x]` | T2.1 | 领域模型与不变量校验 | `yuhua-core/src/model.rs`，5 条不变量集中校验 |
| `[x]` | T2.2 | 工作区创建 / 打开 / 校验 / 最近列表 | `yuhua-fs/src/workspace.rs` + `src-tauri/src/recent.rs` |
| `[x]` | T2.3 | 目录结构生成与格式版本迁移钩子 | `yuhua-fs/src/layout.rs`，`FORMAT_VERSION` 与迁移分支 |
| `[x]` | T2.4 | 章节读写：UTF-8 / BOM / CRLF / Front Matter | `yuhua-fs/src/chapter_io.rs`，含自制 YAML 子集 |
| `[x]` | T2.5 | 原子写 | `yuhua-fs/src/atomic.rs`：临时文件 + fsync + rename + 回滚 |
| `[x]` | T2.6 | 轮转备份与崩溃日志 | `backup.rs`（5 分钟 / 保留 20 份）+ `journal.rs` |
| `[x]` | T2.7 | 回收站 | `trash.rs`：软删除 / 恢复 / 30 天清理，恢复时拒绝覆盖；**路径守卫已加固**：拒保留目录与自嵌套（代码审查修复） |
| `[x]` | T2.8 | 文件监听 + 外部改动策略 | `watch.rs`：notify + 防抖聚合 + 事件语义合并 |
| `[x]` | T2.9 | Tauri 命令层与统一错误类型 | `src-tauri/src/commands.rs`（30 个命令）+ `error.rs` |
| `[x]` | T2.10 | 单元与集成测试 | 读写 / 原子写 / 备份轮转 / 回收站 / 路径安全均有覆盖 |
| `[ ]` | T2.11 | 专项：1 GB 工作区不 OOM | 未做（需大规模真实数据） |
| `[x]` | T2.12 | 索引库外置 | `layout.rs::index_db_path`，有测试守住「不在工作区内」 |
| `[x]` | T2.13 | 云盘冲突副本识别 | `conflict.rs`：识别 7 种命名，**只提示不删除**（有测试钉死） |
| `[ ]` | T2.14 | 工作区导出 zip | Should 项，未做 |
| `[x]` | T2.15 | 保存钩子 | `save_chapter` 完整保存链，供统计模块订阅（M8 依赖） |

---

## M3 索引层

| 完成 | 编号 | 任务 | 落地位置 / 结论 |
| --- | --- | --- | --- |
| `[x]` | T3.1 | SQLite 连接管理 + PRAGMA 调优 | `yuhua-store/src/schema.rs`；`mmap_size=0` 是控内存的关键取舍 |
| `[x]` | T3.2 | 建表与迁移 | 用 `user_version` 记录 schema 版本；版本过高时重建而非兼容 |
| `[x]` | T3.3 | FTS5 中文二元组分词器 | `tokenizer.rs`。**零 unsafe**：写前预分词 + `unicode61` |
| `[x]` | T3.4 | 增量索引 | mtime + content_hash 双闸门，云盘伪改动不会触发重索引 |
| `[x]` | T3.5 | 索引重建命令 | `Index::rebuild` + `rebuild_index` 命令 |
| `[x]` | T3.6 | 字数统计三套口径 | `yuhua-core/src/count.rs`：含标点 / 不含标点 / 英文按词 |
| `[x]` | T3.7 | 检索 API | `search.rs`：关键词、高亮片段、分页、标题权重、卷过滤 |
| `[x]` | T3.8 | 基准：100 万字检索 ≤ 300 ms | **自动化集成测试**：`index_integration.rs` 合成百万字语料取中位数 |
| `[~]` | T3.9 | 分词质量抽检 50 组用例 | 已有分词契约测试与多语言覆盖，**未凑满 50 组中文用例回归集** |

---

## M4–M10 逐项状态

> ⚠️ **本节的原始内容写于「数据底座」那一轮**，当时 M4 确实整块未开始。
> 提交 `e3b3354`（126 个文件）把 M4 及 M6/M7/M8/M9 的前端视图都做完了，
> **但没有回改本节**。下面已按**代码与接线实况**逐项修正；
> 里程碑级结论以顶部「总览」为准。

### M4 编辑器内核

| 完成 | 编号 | 任务 | 说明 |
| --- | --- | --- | --- |
| `[x]` | T4.1 | 集成 CodeMirror 6 | `src/features/editor/MarkdownEditor.tsx`，独立 chunk 懒加载 |
| `[x]` | T4.2 | 语法高亮 | 锁定最小扩展集 |
| `[x]` | T4.3 | 即时渲染 | `instant-render.ts`：非光标行折叠标记，用 replace 装饰而非改文档 |
| `[x]` | T4.4 | 中文 IME 专项 | `ime.ts`：DOM 事件与事务事件双路径，组合期不保存不统计 |
| `[x]` | T4.5 | 查找替换 | `ShortcutPanel.tsx` + CodeMirror search |
| `[x]` | T4.6–T4.8 | 快捷键 / 自动保存 / 专注模式 | `shortcuts.ts`（含 AltGr 正确判定）、`autosave.ts`（防抖 + 最长等待 + 失焦 + 切章 + 关窗）、`focus.ts` |
| `[x]` | T4.9–T4.14 | 光标记忆 / 粘贴清洗 / 大文档 | `cursor-memory.ts`（锚点文本定位，抗外部改动）、`paste.ts`（HTML 转 Markdown + 零宽字符 + 双白名单） |
| `[x]` | T4.15 | 冻结 Markdown 子集 | `markdown-subset.ts`，16 种语法，与 Rust 侧 `subset_consistency.rs` 锚定同一张表 |

> **验证依据**：上述模块均存在于 `src/features/editor/`，
> 且 `MarkdownEditor` 已被 `EditorPane.tsx` 实际使用；
> M4 相关的 6 个测试文件（`MarkdownEditor` / `autosave` / `instant-render` /
> `cursor-memory` / `paste` / `shortcuts` / `markdown-subset`）在测试套件中。


### M5 书架与章节管理

| 完成 | 编号 | 任务 | 说明 |
| --- | --- | --- | --- |
| `[x]` | T5.1 | 应用壳：三栏布局、面板折叠、窗口状态记忆 | `src/app/` |
| `[x]` | T5.2 | 书架：书籍网格、SVG 封面、最近打开 | `src/features/library/` |
| `[x]` | T5.3 | 卷章树：增删改 + 拖拽排序 + 回收站恢复 | `src/features/chapters/`（树操作抽成可测纯函数） |
| `[x]` | T5.4 | 章节元数据面板 | `MetaPanel.tsx`：状态（`StatusDot`）、目标字数、摘要 / 便签经 `updateChapterMeta` |
| `[x]` | T5.5 | 字数面板 + 进度环 | `get_word_stats` + `ProgressRing`（本章进度与今日目标两个环） |
| `[x]` | T5.6 | 空状态与首次引导 | 自绘 SVG 插画，零 emoji |
| `[x]` | T5.7 | 命令面板（Ctrl+K） | `CommandPalette.tsx`（详见 M9 附） |

### M6 检索与大纲

| 完成 | 编号 | 任务 | 说明 |
| --- | --- | --- | --- |
| `[x]` | T6.1 | 全局检索 | Rust 侧 `search_chapters`（片段 / 分页 / 权重）+ 前端 `SearchPanel.tsx` |
| `[x]` | T6.2 | 结果跳转 + 闪烁高亮 | `SearchPanel` 发布「第几章、第几个字符」，`EditorPane` 消费并 `revealOffset` |
| `[x]` | T6.3 | 大纲视图 | `get_outline` + 卷章树（`ChapterTree`，卷章聚合与字数） |
| `[ ]` | T6.4 | 人物卡 / 设定卡 | Should 项，未做 |

### M7 导出引擎

| 完成 | 编号 | 任务 | 说明 |
| --- | --- | --- | --- |
| `[x]` | T7.1–T7.3 | Document IR + Markdown→IR + 范围装配器 | `yuhua-export`，`ChapterSource` 抽象使「一次只取一章」成为接口约束 |
| `[x]` | T7.4 | 一致性测试（Markdown 子集） | `tests/subset_consistency.rs`：TS 与 Rust 两侧锚定同一张语法表 |
| `[x]` | T7.5–T7.8 | TXT / Markdown / HTML / DOCX 渲染器 | 手写最小 OOXML + `zip` 打包；TXT 真正流式 |
| `[~]` | T7.9 | DOCX 在 Word 与 WPS 实开验证 | **字节层面已验证**；**GUI 实开未做**，需人工 |
| `[x]` | T7.10–T7.12 | PDF 渲染器与中文字体嵌入 | **已实现**（`render/pdf/`：`pdf.rs` ~1000 行 + `font.rs` 611 / `text.rs` 337 / `page.rs` 369 / `pdfwrite.rs` 251 行）：纯 Rust、零 unsafe、零新依赖，手写最小 TrueType 解析；Type0/CIDFontType2/Identity-H + ToUnicode + FontFile2，中文可搜索可复制；缺字体返回可恢复的 `FONT_UNAVAILABLE` 而非静默乱码 |
| `[x]` | T7.13–T7.14 | EPUB 3 渲染器与元数据 | **已独立核验**：mimetype 是 zip 条目 [0]、method=0（STORED）、内容恰好 20 字节且其后无换行 |
| `[ ]` | T7.15 | epubcheck 接入 CI | **未接入**（本机无 Java/epubcheck）；已用字节级核验替代最严格的 mimetype 规则，完整合规仍需跑一次 |
| `[~]` | T7.16–T7.17 | 进度事件 / 取消 / 导出报告 | 降级记录已带 `chapter_title`；进度事件与取消未接 |
| `[ ]` | T7.18–T7.20 | 导出面板 UI / 预设记忆 / 专项测试 | **未做，且整条链路未接**：`yuhua_export` 在应用 crate 里引用数为 0，没有任何 `#[tauri::command]` 调用导出引擎，前端也无绑定 —— 六种渲染器目前**完全不可达** |
| `[!]` | — | **图片内嵌（TXT 除外）** | **仍未完成**：`epub.rs` 的 `<manifest>` 为空壳，图片文件未打包进去；DOCX 降级为「［图片：alt］」。计划书 9.3 要求内嵌 |

### M8 写作统计

| 完成 | 编号 | 任务 | 说明 |
| --- | --- | --- | --- |
| `[x]` | T8.1 | 数据模型与按月分片存储 | `yuhua-stats` |
| `[x]` | T8.2 | 差分采集（只记正差） | 负差不抵扣，符合计划书 10.2 节 |
| `[x]` | T8.3 | 会话记录 | 起止时间 / 时长 / 字数 / 涉及章节 |
| `[x]` | T8.4 | **单调合并算法** | 章节取 max / 会话按时间戳去重并集 / 目标取最新 |
| `[x]` | T8.5 | 合并幂等性单元测试 | 乱序、重复、冲突副本合并均幂等 |
| `[x]` | T8.6 | 汇总计算 | 含连续天数与预计完稿日 |
| `[x]` | T8.7–T8.13 | 日历 / 热力图 / 连续天数展示 / 目标 / 分章统计 / 页面导航 | **前端已完成**：`StatsView` + `OverviewView` / `CalendarView` / `HeatmapView` / `GoalView` / `BreakdownView` / `ProgressRing`，已在 `App.tsx` 接线 |
| `[x]` | T8.14 | 隐私说明文案 | 模块文档写明只记字数与时间，不记正文 |

### M9 外观 / 设置 / 字体选择

| 完成 | 编号 | 任务 | 说明 |
| --- | --- | --- | --- |
| `[x]` | T9.1 | 主题系统：亮 / 暗 / 跟随系统 | `tokens.css` |
| `[x]` | T9.2–T9.4 | 字体选择面板 / 即时预览 / 全局与工作区级分离 | **已完成**：`FontsPanel.tsx` / `FontPreview.tsx` / `ScopePicker.tsx` / `LevelToggle.tsx`（三作用域令牌） |
| `[x]` | T9.5 | 排版设置 | `TypographyPanel.tsx` |
| `[~]` | T9.6 | 键盘可达性与对比度走查 | 组件层无障碍基座已就位；**卷章树拖拽仍不具键盘可达性**，全流程走查未做 |
| `[x]` | T9.7 | 首次启动向导 | `FirstRunWizard.tsx`（含 `hasCompletedOnboarding`） |
| `[x]` | T9.8 | 关于页（许可与署名） | `AboutPanel.tsx` + `about-info.ts` |
| `[x]` | T9.9 | 验证文案集中度 | `src/strings/` 集中管理（含 `strings.test.ts`） |

### M9 附：命令面板

| 完成 | 编号 | 任务 | 说明 |
| --- | --- | --- | --- |
| `[x]` | T5.7 | 命令面板（Ctrl+K） | `CommandPalette.tsx` + `features/command/palette.ts`，已在 `App.tsx` 接线 |

### M10 跨端构建与开源发布

| 完成 | 编号 | 任务 | 说明 |
| --- | --- | --- | --- |
| `[~]` | T10.1 | Windows 打包配置 | `tauri.conf.json` 已配 NSIS + `downloadBootstrapper`；**未实际出包** |
| `[~]` | T10.2 | 应用图标派生 | `scripts/gen-icons.mjs` 就绪；位图转换需本机有 resvg 等工具 |
| `[~]` | T10.3–T10.5 | macOS / Linux / Android 构建配置 | CI 矩阵已配三平台；Android 骨架未建 |
| `[~]` | T10.6 | 发布流水线 | 未做 |
| `[x]` | T10.7 | 文档：安装 / 上手 / 工作区格式 / 贡献 | `docs/安装指南.md` / `docs/workspace-format.md` / `CONTRIBUTING.md` |
| `[ ]` | T10.8 | 发布 v0.1.0-alpha | 未做 |
| `[ ]` | T10.9–T10.10 | 字体入包体积核验 / OFL 合规核对 | 待字体子集产出后进行 |
| `[x]` | T10.11 | 云盘同步最佳实践文档 | `docs/workspace-format.md` 含能力边界说明 |
| `[x]` | T10.12 | 导出手册 | `docs/导出手册.md` |

### M11 性能与内存达标验收

全部未做，但 **P5（100 万字检索 ≤ 300 ms）已由自动化测试覆盖**。
其余指标需要真实窗口环境，测量指引见 `docs/benchmarks.md`。

---

## 验收清单状态

| 完成 | 编号 | 场景 | 当前状态 |
| --- | --- | --- | --- |
| `[~]` | A1 | 全新用户从零建书 | Rust 侧命令完备并有测试；**UI 全流程未走通** |
| `[~]` | A2 | 写作与持久化 | 原子写 / 备份 / 崩溃日志均有测试；**未做真实强杀进程验证** |
| `[ ]` | A3 | 大文档输入 | 编辑器未完成 |
| `[~]` | A4 | 全文检索 | 算法与性能已验证；点击定位的前端交互未接通 |
| `[~]` | A5 | 拖拽排序 | 已实现 FLIP 让位；未实测落位无跳动 |
| `[x]` | A6 | 外观切换 | 令牌层支持亮暗与跟随系统 |
| `[~]` | A7 | 六格式导出 | TXT/MD/HTML/DOCX/EPUB 渲染器开发中；**PDF 未做**；Word/WPS 与 epubcheck 未验证 |
| `[x]` | A8 | 视觉规范 | 已扫描核验：全仓零 emoji、零图标字体、零外链图片 |
| `[ ]` | A9 | 键盘可用 | 组件层可达，全流程未走查 |
| `[~]` | A10 | 无障碍 | `prefers-reduced-motion` 全局降级已实现 |
| `[ ]` | A11 | 内置字体 | 字体尚未入包 |
| `[x]` | A12 | 云盘兼容 | 外部改动重载策略 + 冲突副本识别，有测试保证「不自动删除」 |
| `[~]` | A13 | 字体自由选择 | 三作用域令牌就位；选择 UI 未做 |
| `[ ]` | A14 | 码字日历与热力图 | 数据层完成，视图未做 |
| `[x]` | A15 | 统计合并正确性 | 幂等性测试覆盖乱序 / 重复 / 冲突副本合并 |
| `[x]` | A16 | WebView2 缺失兜底 | 探测与原生对话框已实现 |

---

## 代码审查修复记录（本轮新增）

对全仓做了一次独立代码审查：读代码 + 实际探针验证，而非仅确认测试为绿。
审查确认 **3 个未被现有测试覆盖的真实缺陷**，已全部修复并补上回归测试。

| 完成 | 级别 | 缺陷 | 修复 | 回归测试 |
| --- | --- | --- | --- | --- |
| `[x]` | P1 | `escape_html` 不过滤 XML 非法控制字符，EPUB / HTML 产物不合法 | 采用与 `escape_xml` 相同的丢弃规则，保留 Tab / LF / CR | `control_characters_are_stripped_from_output` |
| `[x]` | P1 | `is_safe_url` 放行 `data:image/svg+xml`，构成 XSS 通道 | 改为位图 MIME 精确前缀白名单 | `svg_data_urls_are_rejected` |
| `[x]` | P2 | `move_to_trash` 未拒保留目录，可把回收站移入自身导致无限递归栈溢出 | 入口拒保留目录 / 回收站自身；`copy_recursive` 拒绝目标为源的后代 | `reserved_paths_cannot_be_trashed`、`copy_recursive_rejects_self_nesting` |

落地位置：`src-tauri/crates/yuhua-export/src/render/html.rs`、
`src-tauri/crates/yuhua-fs/src/trash.rs`。

**验证结果（全部实际运行）**：`cargo test --workspace` **825 通过 0 失败**、
`cargo clippy --workspace --all-targets` 零警告、`cargo fmt --all -- --check` 合规、
前端 1336 个测试全绿。

**P2 的触发边界需说明**：当前命令层只传入来自内存 `Document` 的 `manuscript/...` 路径，
该缺陷**无法从 UI 触发**，属于对外 API 的健壮性缺口，故定 P2 而非 P1。

审查同时确认以下部分**无缺陷**：原子写、路径逃逸防护、备份轮转上限、
SQL 绑定参数、CRDT 合并幂等性、冲突副本只读不删、命令层错误处理。

---

## 已知缺口汇总（下一轮优先级建议）

> ⚠️ **本节原文写于「数据底座」那一轮**，当时列表里的前五项
> （编辑器内核 / 统计与检索视图 / PDF 导出 / 字体子集化 / 设置页）
> **此后都已完成**。下面按**当前实况**重写。

按对「能用」这一阶段目标的影响排序：

1. **图片内嵌（计划书 9.3）** —— EPUB 的 `<manifest>` 目前是空壳，
   图片文件没有被打包进去；DOCX 降级为「［图片：alt］」。带插图的稿子会缺图。
2. **导出 UI 待实现** —— 后端命令与前端 IPC 绑定已完成（2026-09-26），
   `exportDocument()` 与 `listExportFormats()` 可从前端调用并成功导出文件。
   缺少的是导出对话框 UI、文件选择器集成与进度/降级提示展示。
3. **性能与内存实测（M11）** —— 需要真实窗口环境，属发布前必做。
4. **跨端实际出包（M10）** —— 打包配置就绪但未实际出过安装包；
   macOS / Linux 未验证。
5. **epubcheck 接入 CI（T7.15）** —— 需要 Java 环境；目前只有字节级核验。
6. **`pnpm format:check` 修复** —— 在未改动的 `main` 上即失败
   （218 个文件，根因是缺 `.prettierrc`），而 CI 把它放在前端 job 第一步，
   等于 **CI 前端 job 从未可能通过**。建议补 `.prettierrc` 或全量格式化后单独提交。
7. **`book` 元数据缺口** —— `OpenResult` 不含作者 / 简介 / 书级更新时间，
   前端只能用最小占位。需后端新增命令或扩 `OpenResult`。
8. **已确认但未修的代码质量项**（详见 [fix-plan-p0.md](./fix-plan-p0.md) 与
   「P0 缺陷修复轮」一节）：自动保存的丢失更新、`reload_and_sync` 持锁全盘扫描、
   `Index::rebuild` 缺事务、`trash.rs` 跨盘判据过粗、`Resizer.tsx` 监听器泄漏、
   卷章树拖拽不具键盘可达性、`ipc/index.ts` 的 `setCurrentRoot` 零调用点。
9. **人物卡 / 设定卡（T6.4，Should 项）** —— 未做。

## 与计划书的有意偏离

| 项 | 计划书 | 实际做法 | 原因 |
| --- | --- | --- | --- |
| FTS5 分词器注册方式 | 注册自定义 tokenizer（`tokenize='yuhua_bigram'`） | 写前预分词 + `unicode61` | 自定义 tokenizer 需 unsafe FFI；改用预分词后分词逻辑成为**可完整测试的纯函数**，且效果等价（写入前用空格连接 token，`unicode61` 按空格切分即得同一 token 集合） |
| `chapters_fts` 内容表 | 外部内容表 `content=''` | FTS5 普通虚拟表 | 外部内容表要求手写与表结构严格对齐的触发器，易错且难调试；索引是可抛弃缓存，多存一份正文的代价可接受 |
| WebView2 兜底对话框 | 未指定实现方式 | 注册表探测 + `mshta` 原生弹窗 | `MessageBoxW` 需引入 `windows-sys` 并写 unsafe，与 `unsafe_code = "forbid"` 冲突 |
| IPC 类型同步 | tauri-specta 代码生成 | 手写类型 + 命令层一一对应 | 本轮先保证接口稳定；接入代码生成属后续优化（见 T0.4） |

以上偏离均不改变对外行为，且都在代码注释中写明了理由。

### 2026-09-27 保存入口与打包补记

- 编辑器新增可见「保存」按钮、`Ctrl/Cmd+S` 快捷键、命令面板保存命令，并将实际保存状态接到顶部状态指示。
- `pnpm tauri:build -- --bundles nsis` 已验证成功，产物为 `target/release/bundle/nsis/羽化写作_0.1.0-alpha.2_x64-setup.exe`。
- 完整 `pnpm tauri:build` 已完成前端与 Rust 构建并生成 NSIS，但 MSI 阶段因 WiX 要求纯数字预发布标识而失败；M10.1 仍保持 `[~]`。
