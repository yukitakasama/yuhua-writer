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

### 构建

- CI 接入此前**定义了却从未被调用**的两道守卫脚本：`pnpm check:ipc`
  与 `pnpm check:kit`（放在 `pnpm build` 之后，后者需检查构建产物）。
- `scripts/check-ipc.mjs`：修掉第 5 项「mock 覆盖率」检查的空转
  （原先收集完命令名就丢弃，从未比对），并新增**结构体字段双向比对**
  （12 组）。命令名↔mock 方法的映射改从 `call()` 的调用处提取，
  避免 camelCase 折算带来的假警报。

### 说明

- 内置字体（思源宋体、霞鹜文楷）流水线已就绪，字体二进制不入 git
- **导出引擎已实现但尚未接线**：`yuhua-export` 的六种渲染器
  （TXT / Markdown / HTML / DOCX / EPUB / PDF）全部完成并有集成测试，
  但应用 crate 源码里对 `yuhua_export` 的引用数为 **0** ——
  没有任何 IPC 命令调用它，界面上也无导出入口，**当前完全不可达**。
  这是「写完能交稿」剩下的最后一段路。
- 写作统计的数据层与前端视图（概览 / 日历 / 热力图 / 目标 / 明细）均已完成
- **已知问题（本轮未修）**：`pnpm format:check` 在未改动的 `main` 上即为
  失败（218 个文件）。根因是仓库没有 `.prettierrc`，Prettier 默认值与既有
  代码风格不一致，而 `ci.yml` 把它作为前端 job 的第一步 ——
  也就是说 CI 前端 job 一直不可能通过。需单独一轮处理
  （补 `.prettierrc` 或全量格式化后单独提交）。
- **已知缺口**：`book` 的作者 / 简介 / 书级更新时间在「打开工作区」这条
  路径上不可得（`OpenResult` 不含）。前端现用最小占位并有测试钉死
  「不伪造」，要真正填上需后端新增命令或扩 `OpenResult`。

[未发布]: https://github.com/yukitakasama/yuhua-writer/commits/main
