# 项目长期笔记

## 仓库与发布

- 远程仓库：`https://github.com/yukitakasama/yuhua-writer.git`（个人账号，Public）
- 原本 package.json / CHANGELOG / 安装指南都指向不存在的组织
  `yuhua-writer/yuhua-writer`，已统一改到上述路径。
- 首次推送前仓库里没有任何 remote，是用 `gh repo create --source=. --remote=origin` 建的。

## 工具链版本（踩过坑，别退回）

- Node **22**：pnpm 11 要求 >= 22.13，用Node 20 会报
  `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`。
- pnpm **11.21.0**：写进 package.json 的 `packageManager` 字段作为唯一真相来源，
  CI 的 pnpm/action-setup 同步该版本。
- `pnpm-workspace.yaml` 必须有 `packages: ["."]`，否则 pnpm 9 直接报
  `packages field missing or empty`。本项目是单包（Rust 工作区归cargo 管）。

## 本机 cargo 不在 PATH

Rust 工具链在 `~/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin/`，需手动加PATH：

```bash
export PATH="$HOME/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin:$PATH"
```

用 `~/.cargo/bin/cargo` 会报command not found（该目录不存在）。

## CI 结构

`.github/workflows/ci.yml` 三个 job：frontend / rust / build（三平台矩阵）。
build 依赖前两个全绿。

三个 job 都需要**先派生图标**（`pnpm icons`）再跑 Rust —— 图标是
assets/icon.svg 的派生产物、被 .gitignore 排除，但 tauri-build 会读
src-tauri/icons/32x32.png（Windows 还要 icon.ico），缺失即 panic。

Linux 需装 `librsvg2-bin` 才有 `rsvg-convert`；只装 `librsvg2-dev`（仅库）不够。
gen-icons.mjs 找不到转换器时只打日志不报错，所以每个 job 后面都跟一个
`test -f src-tauri/icons/32x32.png` 断言步骤。

「获取字体」保留 continue-on-error 是有意的：字体缺失只影响字形回退。

## 时区约定（两处修复过同类问题）

1. **backup.rs**：备份文件名的时间戳写入前归一到 UTC，解析也按 UTC。
   两侧必须同区，否则时间差被偏移量污染，快照会被误判为「刚备份过」而跳过。
   用户跨时区移动工作区会静默丢失备份。

2. **formatAbsoluteTime（前端）**：刻意用本地时区 getter 输出，这是**正确**
   行为（文件修改时间应与用户系统一致）。对应的测试不能硬编码某一时区的
   时刻，要用本地 getter 算期望值。

教训：测试只在开发者本机时区下通过，往往是把环境巧合当成了契约。
本机是 UTC+8，CI 是 UTC —— 改时区相关断言后用
`TZ=<zone> npx vitest run <file>` 复验。

## 死代码

`formatAbsoluteTime` 目前没有任何调用方，测试是唯一使用者。它是给title
提示预留的，接入书架/编辑器时才会用上。

## 本地环境噪声（非缺陷）

- `pnpm test` 可能报 `EPERM ... open ...Temp\...\web\...`：沙箱不允许写临时
  目录，与代码无关，测试本身全绿。
- `cargo test --doc` 偶发 `Os { code: 231 }所有的管道范例都在使用中`：
  Windows 并发编译的资源耗尽，重跑即可。
- `cargo clippy --workspace` 在本机会挂在第三方 crate `schemars 0.8.22`
  （与 indexmap 1.9.3 的泛型参数不匹配）。lockfile 干净、CI 上 clippy 通过，
  是本地 Windows 与 Linux 解析出的依赖组合不同所致。验证自己的代码用
  `cargo clippy -p<crate> --all-targets -- -D warnings`。