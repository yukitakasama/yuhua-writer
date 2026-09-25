## 这个 PR 做了什么

<!-- 一句话说明，然后分点列出关键改动 -->

## 关联 Issue

Closes #

## 检查清单

- [ ] `cargo fmt --all` 已通过
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` 零警告
- [ ] `cargo test --workspace` 全绿
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿
- [ ] 新增逻辑有测试覆盖
- [ ] 文档与 CHANGELOG 已更新
- [ ] 无 emoji、无外链资源、无图标字体

## 若涉及 UI

- [ ] 动效只使用 `transform` / `opacity`
- [ ] 动画结束后已移除 `will-change`
- [ ] 遵守 `prefers-reduced-motion`
- [ ] 纯键盘可完成操作

## 若涉及性能敏感路径

<!-- 说明是否跑过基准，结果如何 -->

## 若涉及导出

- [ ] 已在真实办公软件 / 阅读器中打开验证产物

## 数据安全自查

- [ ] 不会静默覆盖用户正文
- [ ] 不会自动删除用户文件
- [ ] 没有把索引库放进工作区
