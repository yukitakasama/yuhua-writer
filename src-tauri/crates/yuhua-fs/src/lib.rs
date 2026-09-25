//! # yuhua-fs — 羽化写作文件系统层
//!
//! 本 crate 负责**让数据不丢**，这是整个软件里最不能出错的部分。
//! 对应计划书第 4.4 节的五种机制，以及第 3.2 节的不变量：
//!
//! > 不变量 2：**写入必须原子。** 任何时刻断电，磁盘上要么是旧内容、
//! > 要么是新内容，不允许半截文件。
//!
//! ## 模块地图
//!
//! | 模块 | 职责 | 对应计划书 |
//! | --- | --- | --- |
//! | [`atomic`]    | 原子写（tmp + fsync + rename + 回滚） | 4.4 表 / T2.5 |
//! | [`layout`]    | 工作区目录结构、路径拼装、格式版本迁移 | 4.1 / T2.3 |
//! | [`workspace`] | 工作区创建 / 打开 / 校验 / 最近列表 | T2.2 |
//! | [`chapter_io`]| 章节读写、BOM/CRLF 归一、Front Matter | 4.2 / T2.4 |
//! | [`backup`]    | 轮转备份（保留最近 20 份） | 4.4 / T2.6 |
//! | [`journal`]   | 崩溃恢复日志 | 4.4 / T2.6 |
//! | [`trash`]     | 回收站：软删除 / 恢复 / 过期清理 | 4.4 / T2.7 |
//! | [`conflict`]  | 云盘冲突副本识别（只提示不删除） | 4.5 / T2.13 |
//! | [`watch`]     | 文件监听与外部改动事件 | 4.5 / T2.8 |
//!
//! ## 一条贯穿全层的原则
//!
//! **所有路径都是相对于工作区根的 `/` 分隔字符串**，进入本层时由
//! [`layout::WorkspaceLayout`] 负责拼接与安全校验。绝对路径与
//! `..` 逃逸在绝大多数入口就被拒绝 —— 工作区放进云盘、被整体移动、
//! 或用户在多台设备上同步，都是常态，只有相对路径能在这些场景下存活。

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod atomic;
pub mod backup;
pub mod chapter_io;
pub mod conflict;
pub mod journal;
pub mod layout;
pub mod trash;
pub mod watch;
pub mod workspace;

pub use atomic::{atomic_write, atomic_write_bytes};
pub use chapter_io::{read_chapter, split_front_matter, write_chapter, ChapterFile};
pub use conflict::{detect_conflicts, is_conflict_copy, DetectedConflict};
pub use journal::{Journal, JournalEntry};
pub use layout::{WorkspaceLayout, FORMAT_VERSION};
pub use trash::{TrashItem, TrashManager};
pub use workspace::{RecentWorkspace, Workspace, WorkspaceConfig, WorkspaceSummary};
