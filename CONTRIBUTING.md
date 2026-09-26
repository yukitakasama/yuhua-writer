# 贡献指南

感谢你愿意参与羽化写作。本文档说明本项目的开发约定。

## 开发环境

| 工具 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | 前端构建 |
| pnpm | ≥ 9 | 包管理（**不要用 npm / yarn**，锁文件是 pnpm 的） |
| Rust | ≥ 1.77 | 内核 |
| WebView2 | Evergreen | Windows 运行必需 |

```bash
pnpm install
pnpm tauri:dev
```

## 提交前必须通过

```bash
cargo fmt --all                                    # 格式化
cargo clippy --workspace --all-targets -- -D warnings   # 零警告
cargo test --workspace                             # Rust 测试
pnpm typecheck                                     # 类型检查
pnpm lint                                          # ESLint
pnpm test                                          # 前端测试
pnpm check:ipc                                     # IPC 契约一致性
pnpm build && pnpm check:kit                       # 预览页未进生产产物
```

> **`pnpm check:ipc` 不可跳过。** 它校验前端 `src/lib/ipc/` 与 Rust
> `src-tauri/src/` 的契约没有漂移，包括**结构体字段名、命令名、参数名、
> 错误码与枚举取值**。这类漂移在浏览器里看不出来（`pnpm dev` 走 mock
> 后端），到 Tauri 里就是功能全坏 —— 历史上已经发生过两次。
>
> **改了 IPC 相关的任一侧，两侧必须同时改**：`src/lib/ipc/types.ts`
> 的字段名或 `src-tauri/src/commands.rs` 的参数名。`check:ipc` 会拦住
> 忘了改的那一半。

> ⚠️ **`pnpm format:check` 目前在未改动的 `main` 上就是失败的**
> （218 个文件）。根因是仓库没有 `.prettierrc`，Prettier 默认值与既有
> 代码风格不一致。这是待修的既有问题：在你改动的文件上跑
> `pnpm exec prettier --check <你改的文件>` 即可，**不要**跑
> `pnpm format`（它会重排全仓 200+ 个无关文件，把真正的改动淹没）。

**完成定义**：一个改动算完成，当且仅当：

1. 代码已合并到 `main`
2. 相关测试通过，新增逻辑有测试覆盖
3. `cargo clippy -D warnings` 与前端 lint 全绿
4. 涉及 UI 的改动，动效符合设计文档且实测流畅
5. 涉及性能敏感路径的改动，基准未退化
6. 涉及字体或资源的改动，已核对 OFL 合规与体积预算
7. 涉及导出的改动，已在真实办公软件 / 阅读器上打开验证过产物
8. 文档与 CHANGELOG 已同步更新

第 2 条有两条本项目踩过的教训，值得单独写明：

- **不能被测试触达的代码等于没有测试。** `save_chapter` 的并发覆盖防护
  曾内联在 `#[tauri::command]` 函数里，而 `tauri::State<'_, T>` 无法在
  单测中构造 —— 于是这段安全关键逻辑长期零覆盖，直到审查才发现它
  在读失败时会反向放行一次覆盖。**把逻辑抽成不依赖 `State` 的纯函数再测。**
- **测试的"判据"必须独立于被验证的实现。** IPC 契约测试若照着 mock
  后端的形状写，就只能证明"前端和 mock 一致"，证明不了"前端和 Rust 一致"。
  契约测试必须**照着 Rust 侧的真实形状**断言。

## 分支与提交

- 分支模型：`main` 保护 + `feat/*` / `fix/*` / `docs/*` 短分支
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
  `feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`
- 提交信息用中文书写正文，说明**为什么**这样改

## 代码约定

### 通用

- **注释一律中文**，解释「为什么这样做」而不是「这行做了什么」
- **零 emoji**：无论是代码、注释还是文档，都不要使用 emoji
- **零外链**：不引入 CDN、外链图片、图标字体、图表库

### Rust

- 错误统一用 `yuhua_core::YuhuaError`，不要各自定义
- 禁止 `unsafe`（工作区已设 `unsafe_code = "forbid"`）
- 所有 `pub` 项必须有文档注释（`#![warn(missing_docs)]`）
- 领域层（`yuhua-*` crate）**不依赖 Tauri**，保证可独立测试
- 文件 IO 走 `yuhua_fs`，不要在别处直接 `std::fs::write` 写正文
- **`.yuhua/workspace.json` 里记录的 `dirName` 是磁盘上的身份，只能从
  磁盘读取或沿用，绝不能由 `sort` / `title` 这类可变字段现算。**
  现算会在卷被重命名或重排后指向不存在的目录，导致该卷在下次扫描时
  被丢弃并以新 ID 重建 —— 表现为「改个卷名，卷整个消失」。
  这条规则是实际踩出来的，改动卷相关逻辑前先读
  `yuhua-fs/src/workspace.rs` 里 `VolumeRecord` 的文档注释。
- **给已有 JSON 结构体加字段时必须加 `#[serde(default)]`。** 否则旧文件
  会因为缺字段而**整个解析失败**，用户的工作区直接打不开。这是往
  `workspace.json` 加 `volumes` 时风险最高的一个决定。

### TypeScript / SolidJS

- 开启 strict，不要用 `any`（必要时用 `unknown` 再收窄）
- 界面文案一律放 `src/strings/`，不要硬编码在组件里
- 状态用 Solid 原生 signal / store，不引入状态管理库
- 图标一律手写 SVG 组件，放 `src/icons/`，一图一文件

### 动效

**只动画 `transform` 与 `opacity`。永不动画
`width / height / top / left / margin / box-shadow / filter`。**

动画结束后必须移除 `will-change`。长列表滚动时暂停非可视区的入场动效。
全局遵守 `prefers-reduced-motion`。

## 依赖策略

- **前端运行时依赖优先为零**。新增依赖需在 PR 中说明理由与体积影响
- Rust 依赖同样需要说明理由，并注意打包体积
- 字体、图标等二进制资产**不提交 git**，由脚本生成

## 报告问题

请使用仓库的 Issue 模板。提交 bug 时请附上：

- 操作系统与版本
- 羽化写作版本（关于页可见）
- 复现步骤
- 若涉及数据问题，附上工作区目录结构（**不要上传正文内容**）

## 数据安全红线

以下行为在任何 PR 中都不被接受：

- 静默覆盖用户的正文内容
- 自动删除用户文件（包括冲突副本）
- 把索引库放进工作区目录
- 在用户未确认的情况下执行破坏性操作
