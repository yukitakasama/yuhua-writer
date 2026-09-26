# 羽化写作 · 开发文档索引

> 本目录包含第一阶段开发的所有规划、执行记录与技术文档。

## 📋 核心文档

### 规划与追踪
- **[第一阶段开发计划.md](./第一阶段开发计划.md)** - 完整开发计划 v1.2（15 周，M0-M11）
- **[第一阶段任务清单.md](./第一阶段任务清单.md)** - 逐任务执行清单 v1.3
- **[done-list.md](./done-list.md)** - 实际完成情况记录（含验证依据）
- **[fix-plan-p0.md](./fix-plan-p0.md)** - P0 缺陷修复工作单

### 里程碑完成报告
- **[M1-completion-summary.md](./M1-completion-summary.md)** - M1 设计系统与动效基座完成总结
- **[M2-completion-summary.md](./M2-completion-summary.md)** - M2 Rust 内核完成总结（13/15 任务）
- **[更新报告.md](./更新报告.md)** - 阶段性开发进展报告（含历史快照）

### 技术文档
- **[workspace-format.md](./workspace-format.md)** - 工作区目录结构规范
- **[pdf-spike.md](./pdf-spike.md)** - PDF 导出技术方案设计
- **[benchmarks.md](./benchmarks.md)** - 性能基准测量指引
- **[导出手册.md](./导出手册.md)** - 六格式导出适用场景与平台要求
- **[安装指南.md](./安装指南.md)** - 安装前置要求（含 WebView2）

## 📊 当前开发状态（2026-09-26）

### 里程碑进度总览

| 里程碑 | 状态 | 完成度 | 关键成果 |
|--------|------|--------|----------|
| M0 - 工程骨架 | ✅ | 14/14 | 工程可构建，字体流水线、CI、守卫脚本就绪 |
| M1 - 设计系统 | ✅ | 13/13 | 令牌/动效/61 图标/组件原语/图表基座 |
| **M2 - Rust 内核** | ✅ | **13/15** | **工作区/文件安全/原子写/备份/回收站/索引外置** |
| M3 - 索引层 | ✅ | 9/9 | FTS5 中文分词、百万字检索 ≤300ms |
| M4 - 编辑器内核 | ✅ | 15/15 | CodeMirror 6、IME 专项、自动保存、光标记忆 |
| M5 - 书架管理 | ✅ | 7/7 | 应用壳/书架/卷章树/字数面板 |
| M6 - 检索大纲 | ✅ | 3/4 | 检索面板 + 跳转高亮 + 大纲视图 |
| M7 - 导出引擎 | 🔄 | 15/20 | 五格式渲染器 + 纯 Rust PDF，**未接线** |
| M8 - 写作统计 | ✅ | 14/14 | 数据层 + 统计页（日历/热力图/目标） |
| M9 - 外观设置 | ✅ | 9/9 | 主题/字体选择/排版设置/首次向导 |
| M10 - 跨端构建 | 🔄 | 8/12 | CI 配置就绪，未实际出包 |
| M11 - 性能验收 | ⏳ | 1/8 | P5 已自动化，其余需真实窗口环境 |

**图例**: ✅ 完成 | 🔄 部分完成 | ⏳ 未开始

### M2 详细状态

**完成任务 (13/15)**:
- ✅ T2.1 - 领域模型与 5 条不变量校验
- ✅ T2.2 - 工作区创建/打开/校验/最近列表
- ✅ T2.3 - 目录结构与格式版本迁移
- ✅ T2.4 - 章节读写（UTF-8/BOM/CRLF/Front Matter）
- ✅ T2.5 - 原子写（fsync + rename）
- ✅ T2.6 - 轮转备份与崩溃日志
- ✅ T2.7 - 回收站（含路径守卫加固）
- ✅ T2.8 - 文件监听与外部改动策略
- ✅ T2.9 - 30 个 Tauri 命令 + 统一错误类型
- ✅ T2.10 - 937 个单元与集成测试
- ✅ T2.12 - 索引库外置到系统应用数据目录
- ✅ T2.13 - 云盘冲突副本识别（只提示不删除）
- ✅ T2.15 - 保存钩子（M8 统计依赖）

**未完成任务 (2/15)**:
- ❌ T2.11 - 1 GB 工作区不 OOM（需大规模真实数据）
- ❌ T2.14 - 工作区导出 zip（Should 项，已有基础设施）

**详见**: [M2-completion-summary.md](./M2-completion-summary.md)

## 🧪 代码质量指标（P0 修复轮后实测）

### Rust
```bash
cargo test --workspace        # 937 通过, 0 失败
cargo clippy --all-targets -- -D warnings  # 0 警告
cargo fmt --all -- --check    # 格式合规
```

### 前端
```bash
pnpm test          # 35 文件 / 1971 通过
pnpm typecheck     # 0 错误
pnpm lint          # 0 警告
pnpm check:ipc     # 契约一致
pnpm check:kit     # 组件预览可达
pnpm build         # 构建成功
```

**已知例外**: `pnpm format:check` 在未改动的 main 上失败（218 个文件，缺 `.prettierrc`）

## 🔒 安全性保证

### 代码审查发现并修复的缺陷（3 个）

| 级别 | 缺陷 | 修复 | 回归测试 |
|------|------|------|----------|
| P1 | XML 控制字符未过滤 | 采用 `escape_xml` 规则丢弃 C0 控制字符 | `control_characters_are_stripped_from_output` |
| P1 | SVG 数据 URL XSS 通道 | 改为位图 MIME 精确白名单 | `svg_data_urls_are_rejected` |
| P2 | 回收站可自我嵌套 | 拒绝保留目录 + 复制自嵌套检查 | `reserved_paths_cannot_be_trashed`, `copy_recursive_rejects_self_nesting` |

### 文件安全机制（均有测试覆盖）

- ✅ 原子写：不留半截文件
- ✅ 轮转备份：5 分钟 / 20 份上限
- ✅ 回收站：恢复拒绝覆盖
- ✅ 路径守卫：拒绝逃逸与保留目录
- ✅ 冲突识别：只提示不删除（7 种云盘命名）
- ✅ 索引外置：避免云盘同步冲突
- ✅ 崩溃恢复：启动时清理临时文件

## 📈 下一步工作

### 高优先级
1. **导出链路接线** - 渲染器已完成但完全不可达，需接入命令层与前端
2. **性能验收（M11）** - 需真实窗口环境测量 M1-M8/P1-P11 指标
3. **实际出包（M10）** - Windows/macOS/Linux 三平台验证

### 中优先级
4. **Prettier 配置** - 修复 CI 前端 job 阻塞问题
5. **图片内嵌** - EPUB manifest 与 DOCX 图片处理
6. **epubcheck 接入 CI** - 需 Java 环境

### 低优先级（已确认但未修）
- 自动保存丢失更新风险
- `reload_and_sync` 持锁全盘扫描
- `Index::rebuild` 缺事务
- `trash.rs` 跨盘判据过粗
- `Resizer.tsx` 监听器泄漏
- 卷章树拖拽键盘可达性缺口

## 🔗 相关链接

- [CONTRIBUTING.md](../CONTRIBUTING.md) - 贡献指南
- [CHANGELOG.md](../CHANGELOG.md) - 变更日志
- [README.md](../README.md) - 项目主页
- [licenses/](../licenses/) - 第三方许可清单

---

**最后更新**: 2026-09-26  
**维护者**: Kiro (AI Assistant)
