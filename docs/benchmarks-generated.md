# 基准采集记录

由 `scripts/bench/collect.mjs` 自动生成。

## 环境

| 项 | 值 |
| --- | --- |
| 采集时间 | 2026-10-06T15:18:10.185Z |
| 平台 | win32 10.0.26200 (x64) |
| CPU | Intel(R) Core(TM) i7-14650HX |
| CPU 核心数 | 24 |
| 内存总量 | 32380.95 MB |
| Node | v24.15.0 |
| pnpm | 11.21.0 |
| Rust | cargo 1.95.0 (f2d3ce0bd 2026-03-21) |

## 前端产物

| 项 | 值 |
| --- | --- |
| dist 总体积 | 10.26 MB |
| dist 文件数 | 12 |

各 chunk：

| 文件 | 体积 |
| --- | --- |
| DevKit-CLbiUEfA.js | 0.02 MB |
| devkit-DwB4tJPj.css | 0.00 MB |
| editor-DoNjnIsj.js | 0.51 MB |
| index-C7OyvLSe.js | 0.00 MB |
| index-CMLrrNZM.css | 0.05 MB |
| index-DyHx8RMh.js | 0.00 MB |
| index-jhxnznsm.js | 0.22 MB |
| path-CCMeimKg.js | 0.00 MB |
| solid-BTZ1Kot6.js | 0.02 MB |

## 字体资产

字体源文件：4 个，合计 71.22 MB。

注意：安装包预算 P6 要求内置 WOFF2 子集 ≤ 12 MB。
子集产物在 `src/fonts/`（不入 git），请单独核验其体积。

## Rust 测试

待运行测试数：980

## 需要手动采集的指标

以下指标依赖真实窗口环境，必须人工测量并填入本文件：

| 编号 | 指标 | 目标 | 测量方法 |
| --- | --- | --- | --- |
| M1 | 冷启动应用组总内存 | ≤ 150 MB | 任务管理器 → 应用分组（含 WebView2 子进程） |
| M1b | Rust 主进程 RSS | ≤ 30 MB | 任务管理器 → 详细信息 → yuhua-writer.exe |
| M2 | 打开 100 万字工作区并编辑的增幅 | ≤ 50 MB | 打开前后各记一次 M1 |
| M3 | 连续输入 30 分钟内存漂移 | ≤ 10 MB 且无单调增长 | 第 5 分钟与第 30 分钟各记一次 |
| M4 | 空闲 5 分钟 CPU | ≤ 1% | 任务管理器 → 性能 |
| M5 | 内置字体常驻内存（≤ 2 字族） | ≤ 24 MB | DevTools 内存快照对比 |
| M6 | 切换字族 60 秒后可回收 | 回落，残留 ≤ 4 MB | 切换后等 60 秒再快照 |
| M7 | 导出 100 万字 / 300 章内存峰值 | ≤ 120 MB，不随书量增长 | 导出全程监控峰值 |
| M8 | 打开统计页后内存增幅 | ≤ 8 MB | 进入统计页前后对比 |
| P1 | 按键到字形上屏延迟 | P95 ≤ 16 ms | DevTools Performance 录制 |
| P2 | 动效帧率 | 每秒掉帧 ≤ 2 | DevTools Performance |
| P3 | 冷启动到可输入 | ≤ 1.5 s | 秒表 / 日志时间戳 |
| P4 | 打开 1 万字章节 | ≤ 150 ms | 应用内埋点 |
| P5 | 100 万字全文检索 | ≤ 300 ms | cargo test 集成测试输出 |
| P6 | Windows 安装包体积 | ≤ 25 MB | 构建产物文件属性 |
| P7 | 首屏字体加载到可读 | ≤ 120 ms | DevTools Network |
| P8 | 导出 30 万字 / 100 章 DOCX | ≤ 5 s | 应用内计时 |
| P9 | 导出 30 万字 / 100 章 EPUB 过 epubcheck | ≤ 6 s，零 error | 应用内计时 + epubcheck |
| P10 | PDF 中文嵌入、可搜索可复制 | 必须满足 | 打开导出的 PDF 尝试选中文字 |
| P11 | 统计页（年热力图）首次渲染 | ≤ 200 ms | DevTools Performance |
