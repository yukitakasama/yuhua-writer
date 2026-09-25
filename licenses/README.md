# 第三方许可清单

本目录存放羽化写作随包分发的第三方资产的许可证全文。
应用内「关于 → 开源许可」页面会展示同样内容。

## 清单

| 资产 | 许可证 | 说明 | 全文 |
| --- | --- | --- | --- |
| 羽化写作代码 | MIT | 本项目自身代码 | `../LICENSE` |
| 思源宋体 SC（Source Han Serif SC） | SIL OFL 1.1 | 子集化后更名为 `Yuhua Serif SC` | `OFL-1.1.txt` |
| 霞鹜文楷（LXGW WenKai） | SIL OFL 1.1 | 子集化后更名为 `Yuhua Kai SC` | `OFL-1.1.txt` |

## 重要说明

### 字体许可独立于本项目的 MIT 许可

**字体不因本项目采用 MIT 而变成 MIT。** 思源宋体与霞鹜文楷
各自受 SIL Open Font License 1.1 约束，该许可独立生效。

### OFL 合规要点（子集化构成 Modified Version）

| OFL 要求 | 我们的做法 |
| --- | --- |
| 不得使用保留字体名（RFN） | 子集**一律重命名**为 `Yuhua Serif SC` / `Yuhua Kai SC` |
| 必须随附版权声明与 OFL 全文 | 本目录随包分发，应用内可查看 |
| 不得单独售卖字体 | 字体不单独分发或售卖 |
| 不得用原作者名义背书 | 致谢仅作事实性署名 |

### 字体二进制不入 git

字体源文件与子集产物均**不提交进仓库**，由脚本生成：

- `scripts/fetch-fonts.mjs` —— 从官方 Release 下载固定版本并校验 SHA256
- `scripts/subset-fonts.mjs` —— 子集化与重命名

版本号与哈希记录在 `assets/fonts.lock.json`，保证任何机器、
任何时间的构建产物一致。

## 致谢

感谢 Adobe 与 Google 发布思源宋体，感谢 LXGW 发布霞鹜文楷。
这些高质量的开源中文字体是本项目能够做到「离线可用 + 排版一致」的前提。
