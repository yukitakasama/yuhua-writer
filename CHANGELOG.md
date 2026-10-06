# 变更日志

本文件记录羽化写作的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 打包

- 使用本机 Inno Setup 6.7.3 生成多文件安装包，安装后保留应用目录与 extensions/ 扩展目录。

- Windows 默认目标改为 NSIS，多文件安装包不再默认生成 MSI。
- 新增 pnpm package:windows，使用本机 7-Zip 生成包含独立应用目录和 xtensions/ 目录的 .7z / .zip 便携包；不生成单文件自解压 EXE。

### 新增

- 工程骨架：Cargo 工作区（5 个领域 crate）+ Vite/SolidJS/TypeScript(strict) 前端
- **yuhua-core** 领域层：书 / 卷 / 章模型与不变量校验、类型化 ID、
  章节元数据、字数统计三套口径、回收站模型
- **yuhua-fs** 文件系统层：原子写、工作区目录布局与路径安全校验、
  章节读写（BOM/CRLF 归一、Front Matter 解析）、轮转备份、崩溃恢复日志、
  回收站、云盘冲突副本识别、文件监听
- **yuhua-store** 索引层：SQLite + PRAGMA 调优、FTS5 自研中文二元组分词、
  增量索引、全文检索（高亮片段 / 分页 / 权重排序）、字数聚合
- **yuhua-export** 导出引擎：Document IR、Markdown→IR（含 9 种降级记录）、
  四种范围装配、TXT / Markdown / HTML / DOCX（手写最小 OOXML）/ EPUB 3
  五个渲染器。PDF 明确返回「未实现」而非静默降级
- **yuhua-stats** 写作统计：按月分片存储、只记正差的差分采集、会话记录、
  **单调可交换可重复的合并算法**（防重复计数）、汇总与连续天数、热力图数据
- **Tauri 命令层**：工作区管理、卷章增删改排序、章节读写与保存、
  全局检索、数据安全命令（重建索引 / 回收站 / 冲突列表）
- WebView2 运行时探测与缺失时的原生提示对话框
- **设计系统**：设计令牌（含亮/暗双主题与跟随系统）、动效令牌与 8 个动效原语
  （自研闭式解弹簧，零依赖）、54 枚手写 SVG 图标、SVG 图表基座
- **UI 组件原语**：Button / IconButton / Input / Textarea / Select / Checkbox /
  Switch / Tooltip / Dialog / Drawer / Popover / Menu / Toast / Tabs / ScrollArea
- **前端界面**：应用壳（三栏布局与面板折叠）、书架（SVG 生成封面）、
  卷章树（增删改 + 拖拽排序）、文案集中管理
- **IPC 绑定层**：类型安全封装 + 浏览器降级（无 Tauri 环境可用 mock 数据开发）
- **EPUB / DOCX 图片内嵌**（计划书 9.3）：新增 `yuhua-export::assets`，
  按工作区根把正文里的 `![](相对路径)` 读成字节（魔数嗅探真实格式与像素
  尺寸，不信扩展名），EPUB 写进 `OEBPS/images/` 并登记 `<manifest>` 的
  `media-type`，DOCX 写进 `word/media/` 并补关系表与 `[Content_Types].xml`
  的 `Default Extension`。同一张图被多章引用只打包一份；超过版心宽度的图
  等比缩小。**读不到 / 越界 / `https:` / `data:` 一律退回降级**（EPUB 保留
  原始 src、DOCX 输出「［图片：alt］」），导出绝不因缺图而失败。
  TXT / Markdown / HTML / PDF 不受影响，传了解析器也逐字节一致。
- 构建期脚本：图标派生、字体获取流水线
- 开源工程文件：MIT 许可证、README、贡献指南、行为准则、Issue / PR 模板

### 修复

P0 缺陷修复轮（详见 [docs/fix-plan-p0.md](./docs/fix-plan-p0.md)）。

- **IPC 契约漂移导致真实 Tauri 路径必然崩溃**：前端 `open_workspace` /
  `create_workspace` 把参数名传成 `root`（后端要 `path`），且把返回形状
  当成 `{ root, document }`（后端实际是
  `{ workspace, outline, words, recovery }`），于是 `document` 恒为
  `undefined`。此前无任何测试发现，因为浏览器测试全都走 mock 后端，
  **真实 IPC 路径零覆盖**。现已修正 5 处漂移（含 `get_word_stats` 双参数
  与 `ConflictDto` 字段名），并新增走真实 Tauri 分支的契约测试。
- **卷重命名被静默丢弃**：`scan_workspace` 每次从目录名重建卷，而
  `rename_volume` 只改内存，紧接着的重扫把改动整体覆盖；连带使
  `create_chapter` 可能写进别的卷的目录（或建出孤儿目录）、
  `delete_volume` 静默跳过回收站。现在卷清单持久化进
  `.yuhua/workspace.json` 的 `volumes` 字段，扫描改为「配置优先、
  目录名兜底」，且旧格式工作区可无感升级。
- **`save_chapter` 的「绝不静默覆盖」防护在读失败时反向失效**：实现用
  `.unwrap_or_default()` 把读失败塌成空串，再用 `!current.is_empty()`
  把它判为「无冲突」，恰好会在文件被云盘锁住或误删时放行一次覆盖。
  现在读失败即中止保存。该逻辑已抽成可测纯函数（此前因
  `tauri::State` 无法在单测中构造而**一行测试都没有**）。
- 修正两处错误提示文案里内嵌的连续空格（`commands.rs`、`workspace.rs`）。

数据安全与代码质量修复轮（2026-10-06，依据
[docs/done-list.md](./docs/done-list.md) 「已知缺口汇总」第 8 项）。

- **自动保存存在静默覆盖稿件的路径**：三处缺陷叠加 ——
  ① `saveChapterBody` 从实时的 `editing()` 取乐观并发基线，切章后
  `editing()` 已指向新章，旧章保存拿到的 `expected` 变成 `undefined`，
  而后端把 `undefined` 理解为「调用方不做并发控制」并**无条件放行**，
  于是「绝不静默覆盖」这道防护被绕过；② 切章 effect 里
  `void flushNow()` 之后紧跟同步的 `reset()`，flush 尚未读到的 dirty
  被清掉，那次改动再没人保存；③ `AutosaveScheduler.performSave` 遇到
  在途保存直接返回，「保存途中又打了几句、随即切章」这段会丢。
  现在改为：哈希基线存进按章 ID 索引的账本（切章不丢）、切章时同步
  捕获旧章快照后再保存、`flushNow` 等在途请求落地后补存、正文在发起
  那一刻就固定。9 条回归测试钉死，且已验证「移除修复即失败」。
- **`reload_and_sync` 抱着会话锁做全盘扫描**：扫描要读全部章节文件
  （1GB 工作区可达数秒），期间所有命令都被阻塞，界面点什么都没反应；
  而函数文档却声称「放在锁外执行」，与代码自相矛盾。现在持锁只克隆
  布局（廉价），扫描在锁外做，写回前比对根路径 —— 若扫描期间换了
  工作区就丢弃结果，避免把旧书的章节写进新书的索引。
- **`Index::rebuild` 无事务**：重建第一步就是清空，中途失败（磁盘满、
  进程被杀）会留下「旧数据已删、新数据只写了一半」的索引，而索引是
  检索的唯一依据，半残状态下搜出来的结果会静默缺章。现在整段包在
  一个事务里，`?` 提前返回即回滚；顺带也快了（不再逐行 fsync）。
- **回收站的跨盘判据过粗**：判据是 `e.raw_os_error().is_some()`，
  而在 Windows 与几乎所有 Unix 上任何真实 IO 失败都带 OS 错误码
  （权限拒绝、文件被云盘占用……），于是每次 `rename` 失败都会走进
  「复制 + 删除」分支，可能复制出半份内容、再用 `let _ =` 静默吞掉
  删除失败，最后源与回收站各有一份而用户看到「删除成功」。
  现在只在真正的跨卷错误（Unix `EXDEV` / Windows
  `ERROR_NOT_SAME_DEVICE`）时才退化，且删除失败必须报错。
  `restore` 的同型缺陷一并修掉。
- **`Resizer` 拖到一半被卸载会泄漏全局监听**：`pointermove` /
  `pointerup` 只在正常松手时摘除，而切到书架、关工作区会让分隔条在
  拖拽中途消失。泄漏的不只是监听器 —— `body` 上的 `is-resizing`
  会一直挂着，把全局文本选择永久禁掉。现在抽出 `detach()` 并注册
  `onCleanup`。
- **卷章树拖拽不具键盘可达性**：排序只有指针路径，键盘用户无法重排
  章节（T9.6）。`tree-ops` 里的演算逻辑本来就为「拖拽 / 键盘 / 右键
  菜单三者共用」而设计，现在补上 `Alt+↑` / `Alt+↓`，走与拖拽落位
  **同一条**演算与落盘路径，两种交互不会分叉。裸方向键刻意不占用 ——
  它在 tree 模式里属于「在项之间移动焦点」。
- **`ipc` 的 `setCurrentRoot` 零调用点**：`knownRoot` 恒为空串，
  导致 `getRecoveryReport()` 实际在执行 `openWorkspace("")`。
  这类「隐式全局 + 没人负责填」的状态编译期完全看不出来。
  现在删掉 `knownRoot` / `setCurrentRoot` / `currentRoot` 整条链，
  `getRecoveryReport(root)` 改为显式传参 —— 漏传即编译错误。
- **一条恒真断言让 FTS5 守卫形同虚设**：`schema.rs` 的
  `fts5_is_available_in_bundled_sqlite` 写成
  `assert!(opts.contains("FTS5") || true, …)`，无论 FTS5 是否可用都通过。
  改为直接建 FTS5 探针表、写入、再用 `MATCH` 查回 —— 真正的能力验证。
  它能长期存在是因为 CI 用浮动 `@stable`（见下）。
- **一个装饰动画让空闲状态下的应用持续吃掉 44% 的单个 CPU 核心**（M4）：
  书架空状态的 `.empty__art` 带 `animation: breathe 9s … infinite`，关键帧
  改的是 `transform: scale()`。无限循环的 `scale` 强制那张内联 SVG 每帧
  重新栅格化，WebView2 的 **GPU 进程**因此常年空转 —— 主进程自己是 0.00 s，
  所以从「应用有没有卡」完全看不出来，只有按进程拆 CPU 才能定位。
  现在呼吸只在刚看到空状态时播 3 轮、且只改 `opacity`。实测同一口径
  （静置 180 秒 / 采样 300 秒）：单核 **44.11% → 0.100%**。
  顺手把这类回归钉死：新增 `src/design/motion/no-perpetual-animation.test.ts`，
  扫描全部样式源文件，无限循环的动画必须进白名单（判据是「用户闲置时
  这个元素还在不在页面上」），且无限循环的关键帧不许改几何属性。
  详见 [docs/benchmarks.md](./docs/benchmarks.md) 偏差 2。
- **采集脚本自身的两个错误让 M4 数字不可信**：`measure-coldstart.ps1` 把
  每轮的**标称**间隔累加成窗口长度，而每轮采样实际要花 1～几秒，分母被压短
  → 同样的 CPU 增量算出几倍百分比（首测因此记成 7.51%，真实值 44.11%）。
  改用 `Stopwatch` 的真实流逝时间，并新增按进程分解的 `M4_PER_PROCESS` 输出。
  另外三个 `measure-*.ps1` 之前是**无 BOM 的 UTF-8**，Windows PowerShell 5.1
  按 GBK 解码中文注释时会把脚本结构改坏，报出与根因无关的错（pwsh 7 看不出），
  已补 BOM 并把这条坑写进脚本头注释与采集文档。
- **工具栏折叠按钮的提示语在两个状态下是同一句**：左右两个按钮写成
  `label={collapsed ? t(k) : t(k)}`，两个分支返回同一个键 —— 面板已经收起了，
  悬停提示仍然写「折叠左侧栏」。改成 `collapseLeft` / `expandLeft`（右栏同理）
  四个键，并新增 `src/app/no-dead-ternary.test.ts`：扫 `src/` 下所有源码，
  不许再出现 `cond ? t(k) : t(k)`，同时把这两个按钮的标签与状态钉住。
  恒真三元是门禁盲区 —— 类型检查、lint、渲染全都正常，只有鼠标停在恰好的
  那个状态下才看得出来，所以必须变成可执行的规则。

### 构建

- CI 接入此前**定义了却从未被调用**的两道守卫脚本：`pnpm check:ipc`
  与 `pnpm check:kit`（放在 `pnpm build` 之后，后者需检查构建产物）。
- `scripts/check-ipc.mjs`：修掉第 5 项「mock 覆盖率」检查的空转
  （原先收集完命令名就丢弃，从未比对），并新增**结构体字段双向比对**
  （12 组）。命令名↔mock 方法的映射改从 `call()` 的调用处提取，
  避免 camelCase 折算带来的假警报。
- **Rust 工具链钉死到 1.95.0**：新增 `rust-toolchain.toml`，CI 的两处
  `dtolnay/rust-toolchain@stable` 改为 `@1.95.0`。浮动 `@stable` 的后果
  已经实测到 —— 同一次 CI 运行里两个 job 分别拿到 rustc 1.98.1 与
  1.99.0，而开发机是 1.95.0，于是出现「本地 clippy 报 error、CI 放行」，
  上面那条恒真断言就是这样长期隐身的。前端侧此前已吃过同类亏
  （pnpm 版本漂移导致安装失败）。

### 说明

- **M11 性能与内存基准首次完整采集**（`docs/benchmarks.md`）。可自动化的指标
  全部拿到实测值：**达标** M7（100 万字 / 300 章导出峰值 67.79 MB，含 PDF）、
  P5（百万字检索中位 184–303 µs）、P8（30 万字 DOCX 8 ms）、P10（导出的 PDF
  经外部 `pdftotext` 反证，902 页里提出 1,020,727 个中文字符）、P3 代理
  （冷启动到窗口出现 285 ms）。**未达标** M1（应用组私有内存 207.61 MB，
  预算 150 MB）与 M1b（Rust 主进程 45.22 MB，预算 30 MB）—— 超出的八成来自
  系统 WebView2 的六个子进程（约 162 MB 基线），因此先要决定预算口径，
  再谈优化；细节与后续计划见该文件的「偏差记录」。
  另 11 项需要 GUI 人工操作或 DevTools 录制，**逐项写明原因与最小采集步骤**，
  不当作已验证。
- **P5 那条测试此前并不存在**：`docs/benchmarks.md`、`docs/done-list.md` 与
  `docs/更新报告.md` 都写着「P5 已由自动化集成测试覆盖」，并给出文件
  `yuhua-store/tests/index_integration.rs` 与三个测试名 —— 那个文件从未被写进
  仓库。M11 里只有 P5 能在 CI 自动证明，所以它既是唯一的自动化性能门禁，
  也是最容易被「文档说有」糊过去的一条。现已补成 `tests/search_scale.rs`
  （含一条用召回数反证语料规模没退化的测试），并在各处文档纠正为真实指向。
- **导出基准夹具**：新增 `yuhua-export/examples/export_peak.rs`（100 万字 / 300 章
  规模、正文按 `ChapterSource` 按需生成、每种格式重复 20 次取中位数）。
  它是 example 而不是 test：规模测试放进常规 `cargo test` 会拖慢全仓，
  且 debug profile 的内存数字与发布形态不可比。
- **基准采集工具入库**：`scripts/bench/measure-coldstart.ps1`（M1 / M1b / M4，
  按进程树采样并只用**窗口内的 CPU 增量**）、`measure-peak.ps1`
  （M7 / P8 / P9 / P10，配合 `export_peak` 夹具）、`measure-startup.ps1`
  （P3 代理）。此前 `docs/benchmarks.md` 只能写「用任务管理器看」，
  而同一个文件里已经出现过「引用了不存在的测试」这种事 ——
  测量方法不落进仓库就等于不可复现，所以三个脚本一并入库并在文档里给出命令。
- **`pnpm bench` 的输出不再被 Prettier 管**：`docs/benchmarks-generated.md`
  加入 `.prettierignore`。此前跑一次采集就会让 `pnpm format:check` 变红
  ——生成器不产出对齐表格，而 CI 要求所有 md 都对齐，两者自相矛盾。
  顺带修掉采集脚本一个长期误报：Windows 上 pnpm 是 `#!/bin/sh` 垫片，
  `execFileSync` 不做 PATHEXT 解析，于是环境记录里 pnpm 永远写「未安装」，
  而那份记录本身就是用 pnpm 跑出来的。
- **「当前时间」从 9 处收成 1 处**：新增 `yuhua-core::clock`
  （`local_offset` / `now_local`），fs 层 5 个文件、索引层 1 个、命令层 3 个
  里逐字重复的实现全部改为引用它。这类复制的风险不是行数而是**口径**：
  改一处忘一处不会报错，只会让不同文件写出的时间戳差出一个时区。
  同时把唯一的 UTC 例外写进模块文档 —— `.yuhua/backup/` 的快照文件名
  刻意归一到 UTC（写入与解析两侧必须同时区，否则工作区跨时区复制后
  间隔判断被偏移量污染、该备份的快照被整批跳过），看见它「没跟本地时区
  一致」不是 bug。`yuhua-fs::backup::now_local`（`pub` 但零调用方）与
  `recent.rs` 里被 `#[allow(dead_code)]` 掩盖的 `to_domain` 一并删除。
- **删掉 `src/app/placeholders.ts`**：它唯一的导出 `SETTINGS_HINT`
  写着「设置将在 M9 里程碑提供」，而 M9 早就落地（主题、字体、排版、
  首次运行向导全在）—— 文件零引用，且这句话会误导人以为功能没做。
  这个文件自己的文档就写着「留着已实现功能的占位说明比缺少说明更糟」，
  它却没按自己说的清理。同类的还有导出层公开类型 `PuertoPath`
  （与本项目无关的错名），它装的是「产物路径 + 实际写出的字节数」，
  已改名 `ExportArtifact`。
- **`tree-ops.ts` 的 `moveChapter` 不再内联重算插入锚点**：它自己复制了一份
  与 `provisionalSort` 等价的四分支「半整数」逻辑，而被复用函数自己的注释
  就写着「两处行为必须一致」。改成直接调用，让一致性由代码结构保证。

- 内置字体（思源宋体、霞鹜文楷）流水线已就绪，字体二进制不入 git
- **导出对话框已上线**：`src/features/export/ExportDialog.tsx`，
  从命令面板「导出文稿」进入（`Ctrl/Cmd+K`）。格式表来自后端
  `list_export_formats`（不在前端硬编码），**不可用的格式显式标注并禁用**
  （PDF 就是这一类）；范围支持整本书 / 当前卷 / 当前章，没有选中章时
  后两者禁用而不是让人选完再报错；导出成功后列出每一条降级记录
  （附章标题），因为「导出成功但内容被悄悄改写」比失败更难发现。
  保存位置走 `plugin-dialog` 的原生保存框，结果页可一键定位到文件。
  此前后端命令、前端绑定与 mock 全都就绪、`pnpm check:ipc` 也全绿，
  但界面上一个入口都没有 —— 契约一致性与「功能可用」之间隔着的就是这一层。
- **`pnpm check:ipc` 新增第 7 项「界面入口反查」**：对每个后端命令，
  在界面层（`src/` 去掉 `src/lib/` 与测试）反查它的绑定函数有没有调用点。
  前六项查的都是「前后端定义是否一致」，而**一致不等于可用** ——
  导出功能正是这样漏过去的。这一项上线即抓出另外 7 个零调用点命令
  （回收站的列出 / 恢复 / 彻底删除 / 清空、重建索引、字数统计、
  `has_workspace`），它们暂时列入脚本里的 `KNOWN_UNREACHABLE`
  显式豁免清单（带原因），修好一项删一行。
  清单里若有条目其实已经接上线，脚本会反过来报错提醒缩短清单。
- 写作统计的数据层与前端视图（概览 / 日历 / 热力图 / 目标 / 明细）均已完成
- 检索结果点击跳转已接通（`EditorPane` 消费 `pendingJump` 并在正文里
  重新定位），字体与排版选择 UI 也已挂进设置页
  （外观 / 字体 / 排版三块）—— 这两项在 `docs/done-list.md` 里曾被
  记为「未接通」「未做」，是文档滞后于代码。
- **已知缺口**：`book` 的作者 / 简介 / 书级更新时间在「打开工作区」这条
  路径上不可得（`OpenResult` 不含）。前端现用最小占位并有测试钉死
  「不伪造」，要真正填上需后端新增命令或扩 `OpenResult`。
- **已知缺口**：回收站没有界面。后端 `list_trash` / `restore_trash` /
  `purge_trash` / `empty_trash` 四个命令都已实现并有测试，前端绑定与 mock
  也齐备，但界面上没有任何入口 —— 删除的文件目前只能手工从工作区的
  `.trash/` 目录取回。`README.md` 把回收站列为「零丢失」的一环，
  因此这是导出之后最该补的一块。
- **已知缺口**：设置页缺「数据安全」区域，`rebuild_index`（从 Markdown
  重建索引）同样点不到。`docs/done-list.md` 描述过这个区域，属文档超前于实现。- **已修复（本轮）**：EPUB 的 `<manifest>` 空壳与 DOCX 图片降级 ——
  见上「EPUB / DOCX 图片内嵌」。**遗留边界**：图片路径按**工作区根**解析，
  不是按所在章文件的目录，所以 `![](images/a.png)` 指
  `<工作区根>/images/a.png`；若作者习惯写相对当前章的 `../images/a.png`，
  含 `..` 的路径会被安全规则拒绝而退回降级表现（不报错、也不内嵌）。
- **已知缺口**：M11 的性能与内存实测尚未采集，`docs/benchmarks.md`
  全表为「待采集」（仅 P5「100 万字检索 ≤ 300 ms」有自动化测试覆盖）。
  这些指标依赖真实窗口环境，属发布前必做。
- **本地构建注意**：Rust 请用 `rust-toolchain.toml` 钉住的 1.95.0。
  实测 1.97.0 会在 `schemars 0.8.22` 上编译失败 —— 它声明
  `indexmap = "1.2"` 却在 `preserve_order` 分支里写
  `IndexMap<K, V>`（两参数），而 `Cargo.lock` 给它解析到的是
  `indexmap 1.9.3`（`IndexMap<K, V, S>`，三参数）。这是上游的
  版本约束问题，与本项目代码无关，换用 1.95.0 即可绕开。

[未发布]: https://github.com/yukitakasama/yuhua-writer/commits/main
