# 变更日志

本文件记录羽化写作的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- 工程骨架：Cargo 工作区（5 个领域 crate）+ Vite/SolidJS/TypeScript(strict) 前端
- **yuhua-core** 领域层：书 / 卷 / 章模型与不变量校验、类型化 ID、
  章节元数据、字数统计三套口径、回收站模型
- **yuhua-fs** 文件系统层：原子写、工作区目录布局与路径安全校验、
  章节读写（BOM/CRLF 归一、Front Matter 解析）、轮转备份、崩溃恢复日志、
  回收站、云盘冲突副本识别、文件监听
- **yuhua-store** 索引层：SQLite + PRAGMA 调优、FTS5 自研中文二元组分词、
  增量索引、全文检索（高亮片段 / 分页 / 权重排序）、字数聚合
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

### 说明

- 内置字体（思源宋体、霞鹜文楷）流水线已就绪，字体二进制不入 git
- 导出引擎与写作统计的数据层正在开发中

[未发布]: https://github.com/yuhua-writer/yuhua-writer/commits/main
