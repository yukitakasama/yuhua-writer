# 变更日志

本文件记录羽化写作的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 打包

- 使用本机 Inno Setup 6.7.3 生成多文件安装包，安装后保留应用目录与 extensions/ 扩展目录。

- Windows 默认目标改为 NSIS，多文件安装包不再默认生成 MSI。
- 新增 pnpm package:windows，使用本机 7-Zip 生成包含独立应用目录和 xtensions/ 目录的 .7z / .zip 便携包；不生成单文件自解压 EXE。
- **2026-10-07 首次端到端跑通 `pnpm exec tauri build` 并产出可安装的 NSIS 包**：
  `bundle/nsis/羽化写作_0.1.0-alpha.2_x64-setup.exe` 12,232,587 B = **11.67 MiB**，
  P6（≤ 25 MB）达标。这条打包链路此前从未在本机完整跑通过，所以这一步本身就是
  一次验证（结果是好的：一次就过，未改任何配置）。
  仍未做的一件事：**没有真正安装并运行过这个包**（不在用户机器上装软件），
  且 `webviewInstallMode = downloadBootstrapper` 意味着安装时需要联网取 WebView2 运行时。

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
- **设置页新增「数据安全」分区**（`DataSafetyPanel` + `TrashSection`）：
  崩溃恢复报告、云盘冲突副本、重建全文索引、**回收站**。此前
  `list_trash` / `restore_trash` / `purge_trash` / `empty_trash` /
  `rebuild_index` 五个命令后端、绑定与 mock 全齐，界面上却一个入口都没有，
  于是 README 里「回收站」这条零丢失承诺实际要求用户自己去翻 `.trash/`。
  命令面板加「打开回收站」一步直达（`SettingsPanel` 的 `initialTab` 深链，
  关闭时清掉，避免上一次深链劫持下一次普通打开）。
  三个刻意的取舍：① 破坏性动作用**两步内联确认**而不是再套一层模态
  （设置页本身就是 Dialog，嵌套模态会让 Esc 与读屏层次变含混），
  且同一时刻只允许一行处于确认态；② **读列表失败显示错误，不显示空态**
  —— 把「我没读到」画成「没有备份」，会让人去做真正毁数据的操作；
  ③ 冲突副本只报告、界面上**不给删除按钮**（程序没有判断哪份该留的依据）。
  恢复报告读 store 里已存的那份，**不调用** `getRecoveryReport()`：
  那个函数的实现是重新 `openWorkspace`，在设置页点一次「检查」就会把
  用户未保存的稿子丢掉。`pnpm check:ipc` 的 `KNOWN_UNREACHABLE` 由 7 条降到 2 条。
- **应用内性能埋点（P3 应用内段 / P4）与设置 → 关于 → 「运行诊断」**：
  新增 `src/app/perf.ts`。P3 此前只有「窗口句柄出现」的代理值，P4 干脆列在
  未采集项里 —— 外部探针看不到「编辑器能打字了」「正文渲染完了」这类事件。
  埋点分三处接线：`markEditorReady()` 在 CodeMirror 视图建好时记下
  模块求值 → 可输入，`startChapterOpen()` 在发起读章前、`finishChapterOpen()`
  在正文灌入编辑器视图后。**终点不是 IPC 返回处**：返回处只覆盖后端读盘，
  渲染那半才是作者感到的卡。P4 两端同在 `performance.now()` 这个应用内时钟里，
  所以它是可以被完整测量的；P3 的应用内段与窗口代理值**不可相加**
  （文档 timeOrigin 与进程启动没有共同原点），报告时分两段写。
  样本只留最近 20 次并展示**中位数**（一次 GC 就能拉歪均值）。不落 localStorage：
  读者是跑基准的人和报 bug 的用户，都在本次运行内。
- **读章失败的可恢复路径**：写作台在「正文没读回来」时不再显示一个能打字的
  空文档，而是只读 + 一行说明 + **「重新读取」**按钮（`editor.readFailed` /
  `editor.retry`）。同时新增 `editor.loading` 文案替换掉借用自启动期的
  `app.booting`。
- **专注模式收起工具栏**（计划书 5.4 的第 2 件事）：折叠态留一条可悬停的缝，
  鼠标碰到或 Tab 进入即恢复，键盘与鼠标用户都不会被锁在专注模式里。
- **设置里的排版项从此对写作台生效**：正文宽度与段间距的滑块拖动后，
  真正写字的那一栏会跟着变（此前只有设置页的预览块在变）。
- **书级元数据（作者 / 简介）：填得进来、存得下来、导出用得上**
  （计划书 附录「仍待确认」第 4 项的落地）。此前 `dc:creator` 这一路是空的：
  `WorkspaceSummary` 不带作者 / 简介，`OpenResult` 也不带，前端只能填最小占位，
  于是「这本书署谁的名」在应用里**没有任何地方能填**，EPUB 与 DOCX 的署名
  永远落在回退值上。现在：
  ① 后端 `.yuhua/workspace.json` 新增 `author` / `description` 两个
  `#[serde(default)]` 字段（**必须带 default**，否则旧工作区解析失败、
  用户的书直接打不开），`WorkspaceSummary` 与 `scan_workspace` 把它读回来，
  新增 `update_book_meta` 命令（先写盘、成功后才改内存文稿，
  所以「填完立刻导出」拿到的就是新署名）；
  ② 界面入口在**导出面板**（`ExportDialog`）：预填已存的值，改了就在导出前
  写回，写回失败**取消这次导出** —— 带着没写回的署名继续导，交出去的文件署的
  还是旧名字而界面上填的是新的，这种不一致比一次明确的失败更难发现；
  一个字没改时不发请求，避免每次导出都重写配置文件；
  ③ 展示在右侧「本书信息」（`MetaPanel`），空值显示「未填写」而不是编一个名字。
  测试分两层钉：Rust 侧 `book_meta_reaches_the_export_ir`（署名真的进了导出 IR）、
  `book_meta_survives_reopen`（重开还在）、`opens_config_without_book_meta_fields`
  （旧配置照样打得开）；前端 `saveBookMeta` 的「以后端返回值刷新内存」与
  导出面板的「刷盘 → 写回 → 导出」顺序各钉一条，均验证过摘掉即变红。
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
- **换章时根本不发起读章，编辑器停在上一章的内容上**（恶性）：
  `loadChapterBody` 的唯一生产调用点在 `EditorPane` 的 `onMount` 里，而
  `EditorPane` 组件本身**不随换章重建**（只有里面 `<Show when={chapter()}>`
  会挂载/卸载编辑器）。于是「工作区已经开着、再点卷章树里某一章」这条
  最主要的路径一次读章都不会发生：作者看到第 6 章的文字、以为自己开着
  第 7 章，敲进去的字进了第 6 章的草稿。快捷键换章（`stepChapter`）、
  检索跳转、新建章节后开始写，走的都是同一条 `selectChapter`，全都受影响。
  现在读章改为跟随选中状态的 `createEffect`（仍在首帧之后运行，不阻塞首次
  渲染），并给 `loadChapterBody` 加了**响应顺序守卫**：连点两章时两个请求
  同时在途，磁盘 IO 不保证返回顺序，后到的旧结果过去会把上一章的正文
  写成「当前正文」，现在只认最新一次请求。
  发现方式是这条链路的**第一个自动化信号**：P4 埋点接完之后冒烟测试里
  一条样本都没产生 —— 门禁全绿（类型、lint、两千项测试）从来没说过
  「这个功能真的能跑」。现在钉了两条测试：`app-smoke` 断言切章后编辑器里
  是那章的正文而不是上一章的，`workspace-store.test` 断言过期响应不落盘。
  两条都验证过「去掉修复即变红」，不是恒绿。

装配层接线审查轮（2026-10-07，提交 `0fa1196`）。上一轮的教训直接变成方法：
按「**信号被写了，但消费侧没有接住**」这个形状系统排查 `src/`，
逐条回代码复核后修掉下面六条 —— 每条都验证过「摘掉修复就变红」。

- **正文没读回来时，打字会写进上一章的文件**（恶性）：读失败后 `editing`
  变成 `null`，而灌正文的 effect 遇到 `null` 直接 return，`mountedChapterId`
  还留着上一章 —— 标题已经换成新章、编辑器里却是上一章的字，此时打的字
  经自动保存落到**上一章**的文件上。测试里能直接看到丢稿现场：摘掉守卫后
  `saveChapter` 收到的正是 `["ch_a", "甲章的正文不该被存进任何文件的字"]`。
  现在 `editing` 为空就把 `mountedChapterId` 清掉（`persist` 于是写不到任何
  文件），并把编辑器置为**只读**，同时给出「重新读取」入口 —— 重新点同一章
  不会触发 effect（选中状态没变），没有这个入口的话作者只能切走再切回来。
- **换章不再靠「卸载编辑器」表达正在读**：`<Show when={!loading()}>` 会在
  切章流程的**中间**销毁 CodeMirror 视图，而光标记忆与上一章的保存都还要读它
  （`handle.view` 在未挂载时是抛异常的 getter）；每次换章重建整个视图也直接
  落在 P4 要量的耗时上。现在编辑器一直挂着，只读由 `Compartment` 重配表达，
  换章走新增的 `resetDocument`（重建状态：撤销历史归零，视图与焦点还在）。
  顺带修掉一条「注释写了但没做」：`setValue` 的注释声称整体替换不进撤销历史，
  实际 `annotations` 是空数组 —— 换章后按一次 Ctrl+Z 就会把上一章灌进这一章，
  紧接着自动保存把它写进这一章的文件。现在真的关掉历史写入。
- **读章失败会引发无退避的重试风暴**（上一条的副作用）：失败让 `editing`
  归零，effect 立刻又判定「这章没读」再发一次请求；瞬时失败（文件被锁、
  路径不存在）等于对着磁盘打死循环，界面上还永远停在「正在打开」。
  现在记住「这一章试过」，重试由作者按下按钮发起。
- **专注模式从未真的折叠两侧栏**：它写的是 `layout.leftCollapsed = true`
  这种对 store 代理的**直接赋值**，实测写入根本不生效（写一次读一次就是旧值），
  而且绕过了 setter 附带的 `persist()`。改走 `layout-store` 新增的显式 setter。
- **「正文宽度」「段间距」两个滑块此前只影响设置页的预览块**：写作台的栏宽
  钉死 `720px`、段落间距钉死 `--sp-3`，那两个令牌只有 `.yh-body` 消费。
  现在写作台读 `--measure-body` 与 `--gap-paragraph`；专注模式的加宽与放松
  行距改用 `max()`，不再压低用户自己选的更宽栏宽与更大行距。
- **回收站恢复后卷章树里没有出现那一章**：`TrashSection` 只刷自己的列表。
  备份确实回到了稿子里，界面上却没有，用户只能再恢复一次或在原地新建同名章。
  现在恢复后重读文稿。为此还补了 **mock 后端的恢复语义** —— 它原先只把条目
  从回收站数组里抹掉，恢复完大纲依旧为空，等于这条链路在任何环境都测不出来
  （`mock-backend.test.ts` 现在钉住「恢复的是稿子，不是回收站的显示」）。
- 回书架**先保存再关工作区**：原顺序反着，`closeWorkspace()` 跑完后
  EditorPane 才在 `onCleanup` 里补那次保存，此时工作区已关、必然失败 ——
  自动保存 1500 ms 防抖窗口内的字每次必丢。同时清掉未消费的检索跳转
  （`search-store` 的注释早就写了「关闭工作区时清」，但生产代码里没人清），
  并不再留下陈旧的 `saveEditor` 闭卡与卡在 `saving` 的保存状态。
- **重读文稿会把卷章树打回原形**：`reloadDocument()` 每次增删卷章后都用后端
  大纲整体替换 document，`<For>` 按引用比对项，于是每个 `VolumeGroup` 被销毁
  重建 —— 而卷的展开态当时是组件本地的 `createSignal(true)`，作者刚加完一章，
  五个卷全部收起。展开选择外提成按卷 ID 索引的 `tree-ui-store`（换书时随
  编辑基线一起清掉），新建章节时顺带展开目标卷，免得章建在折叠的卷里看不见。
  **重命名的输入草稿仍会丢**：`InlineEdit` 刻意是非受控输入（受控输入在
  WebView 里会吃掉中文拼音的 composing 过程），草稿存在 DOM 里；要连草稿一起
  保住，得让重读文稿按 ID 复用已有对象而不是整体替换，这一条记在待办里。
- 新增两条护栏测试：`src/app/editor-pane.test.tsx`（真实 CodeMirror 视图 +
  公开 API `EditorView.findFromDOM`，钉「正文没到位时打不进字、落不进文件」）
  与 `src/features/editor/writing-surface-settings.test.ts`（扫样式源文件，
  确认写作台真的消费了排版令牌、工具栏真的读了 `data-focus-mode`）。
  后者刻意**断言源码里存在这条规则**而不是量计算样式：jsdom 不做 CSS 级联，
  `getComputedStyle` 在这类规则上只会给出恒真或恒假的读数。

数据路径修复轮（2026-10-07）。三条都会**真的丢稿或交出错的稿子**，
且全都躲在「mock 后端与真实后端同源」这个盲区里 —— 前端测试结构上照不出来，
所以每条都在 **Rust 层**钉了测试，并逐一验证过「先红后绿 + 摘掉修复就变红」。

- **外部改动之后，这一章永久存不下去**（恶性）：`read_chapter` 交回的
  `content_hash` 取自**内存文稿**里那份正文，而 `body` 取自**磁盘**，
  两边不同源。保存时乐观并发检查拿这个哈希去比对磁盘当前内容，于是只要
  云盘同步或另一台设备改过一次，基线就**永久不等**：作者每次保存都被
  自己的基线判成冲突，而界面上只有一行通用错误、没有任何出路。
  现在 `read_chapter_impl` 按返回的那份正文算哈希（`content_hash(&cf.body)`）；
  冲突单独成码 `CONFLICT`（`YuhuaError::Conflict`，detail 带绝对路径）；
  前端按**章**记 `conflictedChapterId`（不能靠全局的 `state.error`：作者点个
  新建卷它就被换掉，而这一章依然存不下去），编辑区据此给出两条出路 ——
  「以我的稿子为准」走 `force`：**后端先把磁盘那份存进备份再覆盖**，
  且绕过 5 分钟的备份节流；「改用磁盘版本」重读一次并重建基线。
  钉测试：`external_edit_leaves_the_chapter_saveable`、
  `read_payload_hash_describes_the_body_it_returns`、
  `forced_save_preserves_the_external_version_in_backup`。
- **关窗丢掉最后一段**：`beforeunload` 里的 `void flush()` 没人 await
  （浏览器不等），而 Rust 侧 `CloseRequested` **一个处理器都没接**，窗口直接关。
  新增 `src-tauri/src/closing.rs` 的关闭屏障（原子 u8 状态机
  IDLE / WAITING / RELEASED，`Decision::{InterceptAndAsk, InterceptSilently, Allow}`）：
  拦下关闭 → `api.prevent_close()` → `emit("flush-and-close")` → 前端刷完盘
  调 `notify_flush_done` 放行；另有 3 秒看门狗超时兜底，刷不成也关得掉，
  不把作者锁在窗口里。屏障本身四个 Rust 单测。
  **真机未验**：jsdom 里 `isTauri()` 恒假，「订阅与事件名两边对得上」这一环
  只有装包运行才能证明，本轮只钉住了收到事件之后的顺序与兜底。
- **导出静默交出一份旧稿**：`export_document` 装配时读的是**内存**正文
  （`scan_workspace` 留着全书正文就是为了字数统计与标题兜底），而自动保存
  有 1500 ms 防抖 —— 作者刚敲完的那一段大概率还没落盘，导出却写着「导出完成」。
  现在导出走新增的 `DiskChapterSource`（`ChapterSource` 的磁盘实现，逐章读盘），
  导出面板的 `flushEditor` 句柄做成**必填**（上一版是可选的，于是生产调用点
  根本没传，缺陷就藏在「传不传都行」里），先落盘、落盘失败就取消这次导出。
  钉测试：`export_carries_the_disk_body_not_the_stale_memory_one`、
  `disk_source_yields_nothing_for_a_chapter_the_document_does_not_have`。
  **前置纠正**：`scan.rs` 的模块注释写着「扫描不保留正文」，实际是保留的 ——
  照那条注释去改装配会得到一堆**空文件**，所以先改注释再改代码。
- **切换只读从未生效**（本轮上一条修复引入的）：`MarkdownEditor.resetDocument`
  用挂载时捕获的那份 extension 数组重建状态，等于把 `Compartment` 拍平成
  死值，之后 `reconfigure` 静默空转 —— 该只读时还能打字。改为
  `buildExtensions()` 按当前 `currentReadOnly` 现算。
- **上一章的保存落地时把编辑态从新章顶掉**：`saveChapterBody` 成功后无条件
  `setEditing`，而切章会 flush 上一章、那次保存回来时作者已经在看新章，
  于是界面对着一个刚打开、正文明明就在眼前的章说「这一章的正文没能打开」，
  编辑器还被置成只读。现在只有 `editing()` 仍指向这一章时才回写。
- 测试基建：`__resetWorkspaceState()` 漏清模块级的 `selectedChapterId`，
  下一个用例带着一章挂载，编辑器自己发的读章请求发生在用例设桩**之前**，
  拿到 `undefined` 正文后冒出假失败。串味的用例比失败的用例更难查。
- 「本书信息」那一栏曾渲染成**有标签、没数据**：`<Show when={book() !== null}>`
  传给回调的是布尔值，于是 `info().author` 全是不存在的属性，Solid 安静地
  渲染出三个空 `<dd>`。冒烟测试把它抓出来的（断言的是界面文本，不是类型）。

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
  测量方法不落进仓库就等于不可复现，所以三个脚本一并入库并在文档里给出命令。
- **本轮排查里唯一「在测试环境才暴露」的一条要说明清楚**：对 Solid store 代理
  直接赋值（`layout.leftCollapsed = true`）在本项目的测试环境里写入不生效
  （写一次读一次就是旧值）。真机 WebView 里是否同样无效**没有验证过**，
  因此这条记录只写「测试环境下无效」这个观测到的事实。但改法在两种情况下都
  更对：走 `layout-store` 的 setter 才会带上 `persist()`，折叠状态才写进
  localStorage —— 而此前直接赋值即便生效也绕过了持久化。
- **mock 后端从此要照真实语义实现，不能只做「不报错」**：`restoreFromTrash`
  原先只把条目从回收站数组里抹掉，恢复完大纲依旧为空，于是「恢复一章」这条
  链路在浏览器开发路径里根本测不出来，测试也就无从指认界面缺了重读文稿那一步。
  现在 mock 会记住被删章的摘要并把章放回原来的卷；原卷已不存在时**报错并把
  条目留在回收站**，而不是猜一个地方塞进去（`deleteVolume` 恢复场景未建模）。
- `editor.placeholderBody` 的文案改掉：它写着「编辑器内核将在 M4 里程碑接入」，
  而 M4 早已落地 —— 空态正在对作者播报一条过期的进度公告。同时删掉零引用的
  `editor.placeholderTitle`。
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
- **动效守卫改为递归发现样式文件**：`no-perpetual-animation.test.ts` 原先点名
  三个 CSS 路径，意味着**新增一个样式表就能悄无声息地绕开守卫**，而那时候的
  失败方式是「全绿」。现在递归扫 `src/` 下全部 `.css`，并断言三个已知文件
  确实在扫描清单里（否则清单空掉时规则会静默失效）。
- 删掉文案字典里的 `settings.placeholder`（「设置将在后续里程碑中提供」）：
  零引用，且 M9 早已落地 —— 与上面那个 `SETTINGS_HINT` 是同一句话的第二份。

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
  重建索引）同样点不到。`docs/done-list.md` 描述过这个区域，属文档超前于实现。
- **已修复（本轮）**：EPUB 的 `<manifest>` 空壳与 DOCX 图片降级 ——
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
