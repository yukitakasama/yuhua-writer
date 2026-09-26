# 羽化写作（Yuhua Writer）

面向中文长篇小说的**本地优先**写作软件。以 Markdown 文件为唯一真源，
不绑定任何云服务，工作区就是一个可以直接放进网盘的普通文件夹。

> 当前版本 `v0.1.0-alpha.0`，处于第一阶段开发中。
>
> ⚠️ **导出功能当前不可达**：`yuhua-export` 的六种渲染器（TXT / Markdown /
> HTML / DOCX / EPUB / PDF）都已实现并有集成测试，但**还没有任何 IPC 命令
> 调用它**，界面上也没有导出入口。这是「写完能交稿」这一目标剩下的最后一段路。
> 详见 [docs/done-list.md](./docs/done-list.md) 的「已知缺口汇总」。

## 这是什么

一个网文作者可以**只用这个软件**完成一天的更新：打开即写、不用手动保存、
断电不丢稿、想找某段能搜到、写完能按平台要求导出交稿。

## 设计取向

| 取向 | 具体做法 |
| --- | --- |
| **数据属于用户** | 正文是标准 Markdown，任何编辑器都能打开；索引库是纯缓存，删掉可一键重建 |
| **零丢失** | 原子写（临时文件 + fsync + 重命名）、轮转备份、崩溃日志、回收站 |
| **低内存** | Tauri 2 复用系统 WebView，不打包 Chromium；编辑器视口渲染，内存与文档长度解耦 |
| **无服务器** | 不提供自建同步服务；工作区放进任意网盘即可同步，软件负责识别冲突副本 |
| **零装饰** | 全仓零 emoji、零图标字体、零外链图片；所有图标与图表均为手写内联 SVG |

## 技术栈

- **外壳**：Tauri 2（Rust 内核 + 系统 WebView）
- **前端**：SolidJS + TypeScript（strict）+ Vite
- **编辑器**：CodeMirror 6（Markdown 源码编辑 + 即时渲染）
- **索引**：SQLite + FTS5，自研中文二元组分词器
- **领域层**：5 个纯 Rust crate（core / fs / store / export / stats）

## 快速开始

### 前置条件

- **Node.js** ≥ 20 与 **pnpm** ≥ 9
- **Rust** ≥ 1.77
- **Microsoft Edge WebView2 运行时**（Windows）
  Windows 11 已预装；Windows 10 通常随 Edge 一起安装。
  若缺失，应用启动时会弹出原生提示并提供官方下载入口。
  这是微软随系统免费提供的组件，不是本软件的额外要求。

### 开发

```bash
pnpm install          # 安装前端依赖
pnpm tauri:dev        # 启动桌面应用（会自动拉起 Vite）
pnpm dev              # 只跑前端（浏览器内用 mock 数据，不需要 Tauri）
```

### 测试

```bash
cargo test --workspace     # Rust 领域层全部测试
pnpm test                  # 前端单元测试
pnpm typecheck             # TypeScript 类型检查
cargo clippy --workspace --all-targets -- -D warnings
pnpm check:ipc             # IPC 契约一致性（前后端字段 / 命令 / 错误码）
pnpm build && pnpm check:kit   # 组件预览页未泄漏进生产产物
```

> `pnpm check:ipc` 与 `pnpm check:kit` 已接入 CI，改 IPC 相关代码时请本地先跑。
> 前者能拦住「前端字段名与 Rust 不一致」这类**在浏览器里看不出来、
> 到 Tauri 里功能全坏**的漂移。

### 构建

```bash
pnpm icons            # 从 assets/icon.svg 派生全平台图标
pnpm tauri:build      # 产出 Windows 安装包与便携版
```

## 仓库结构

```text
src/                      前端（SolidJS + TS）
  app/                    应用壳：布局、路由、启动引导
  design/                 设计令牌、动效原语、UI 组件原语、图表基座
  features/               按功能划分：书架 / 卷章 / 编辑器 / 检索 / 导出 / 统计 / 设置
  icons/                  手写 SVG 图标（一图一文件，便于 tree-shaking）
  strings/                全部界面文案（集中管理，为后续多语言预留）
  lib/                    IPC 绑定与工具

src-tauri/                Rust 侧
  src/                    命令层（薄壳）+ WebView2 探测 + 装配扫描
  crates/
    yuhua-core/           领域层：Book / Volume / Chapter 模型与不变量
    yuhua-fs/             文件系统层：原子写、备份、回收站、冲突识别、文件监听
    yuhua-store/          索引层：SQLite + FTS5 中文二元组分词、检索
    yuhua-export/         导出引擎：Document IR + 多格式渲染器
    yuhua-stats/          写作统计：码字日历、热力图数据、单调合并

assets/                   品牌资产（icon.svg 为唯一源文件）
docs/                     设计与计划文档
scripts/                  构建期脚本（图标派生、字体流水线、基准采集）
```

## 工作区格式

工作区是一个普通文件夹，**里面只有文本，没有任何二进制**：

```text
我的小说/
├─ .yuhua/           引擎目录（配置、备份、崩溃日志、统计）
├─ manuscript/       正文（Markdown，真源）
│  └─ 001-第一卷 风起/
│     └─ 001-第一章 落羽.md
├─ outline/          大纲
├─ characters/       人物
├─ worldbuilding/    设定
└─ .trash/           回收站
```

索引数据库**不在工作区里**，而是放在系统应用数据目录
（Windows 下为 `%APPDATA%\YuhuaWriter\index\<工作区ID>.sqlite`）。
原因是 SQLite 是二进制且带 WAL 与共享内存文件，云盘客户端对
正在写入的二进制做部分同步极易损坏；而索引本来就是可抛弃的缓存。

章节文件的 Front Matter 是元数据的真源：

```markdown
---
id: ch_01J8XK2M9P
title: 第一章 落羽
status: draft
wordGoal: 3000
created: 2026-01-01T09:00:00+08:00
updated: 2026-01-01T21:30:00+08:00
tags: []
---

正文内容……
```

**卷的名字与顺序存在 `.yuhua/workspace.json` 的 `volumes` 字段里**，
不从目录名反推。这样重命名卷只写一次配置，不会让云盘 / Git 看到
「目录被删除又新建」。详见 [docs/workspace-format.md](./docs/workspace-format.md)。

## 云盘同步

工作区零二进制，因此可以直接放进任何云盘：

坚果云 / 阿里云盘 / OneDrive / Dropbox / Google Drive / iCloud Drive /
Syncthing / 局域网共享 / U 盘 / Git。

软件为此做三件事：

1. 索引库移出工作区，避免二进制被部分同步
2. 监听外部改动，未在编辑的章节自动重载
3. 识别冲突副本（`xxx (冲突副本 2026-01-01).md`）并提示，
   **绝不自动删除任何文件**

能力边界：提供的是**最终一致性同步**，不是实时协作。建议同一时间
只用一台设备编辑；同时改同一章会产生冲突副本，需要人工合并。

## 许可证

代码以 **MIT** 许可证发布，见 [LICENSE](./LICENSE)。

内置字体（思源宋体、霞鹜文楷）采用 **SIL OFL 1.1**，
**独立于 MIT 生效**，全文见 `licenses/` 目录。
子集化后的字体已按 OFL 要求重命名为 `Yuhua Serif SC` 与
`Yuhua Kai SC`，不使用原作者的保留字体名。

## 参与贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。提交信息遵循
[Conventional Commits](https://www.conventionalcommits.org/)。
