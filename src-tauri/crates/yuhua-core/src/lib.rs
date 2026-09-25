//! # yuhua-core — 羽化写作领域层
//!
//! 本 crate 是整个应用的**词汇表**：它定义书 / 卷 / 章的结构、元数据格式、
//! 字数口径与统一错误类型，但不碰文件系统、不碰数据库、不碰 Tauri。
//!
//! 这样划分的理由（对应开发计划 3.1 节的分层约束）：
//!
//! - **可测试**：领域规则可以在毫秒级单元测试里验证，无需真实磁盘或窗口。
//! - **可复用**：未来的 CLI、批量导入工具、迁移脚本可以直接依赖本 crate。
//! - **防漂移**：前端拿到的所有类型最终都由这里的 Rust 定义派生，
//!   不允许前端另起一套同名字段。
//!
//! ## 模块地图
//!
//! | 模块 | 职责 |
//! | --- | --- |
//! | error | 统一错误类型，可跨 IPC 边界序列化 |
//! | ids   | 带前缀的类型化 ID，杜绝 book id 当成 chapter id 用 |
//! | meta  | 章节 Front Matter 元数据与状态 |
//! | model | Book / Volume / Chapter 领域模型与不变量校验 |
//! | count | 字数统计三套口径 |
//! | clock | 本机时钟（本地时区偏移 / 当前本地时间） |
//! | trash | 回收站条目模型 |

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod clock;
pub mod count;
pub mod error;
pub mod ids;
pub mod meta;
pub mod model;
pub mod trash;

pub use clock::{local_offset, now_local};
pub use count::{count_words, count_words_all_modes, CountMode, WordCount};
pub use error::{Result, YuhuaError};
pub use ids::{BookId, ChapterId, TypedId, VolumeId};
pub use meta::{ChapterMeta, ChapterStatus};
pub use model::{Book, Chapter, ChapterSummary, Document, OutlineNode, Volume};
pub use trash::TrashEntry;
