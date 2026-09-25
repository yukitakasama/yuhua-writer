//! # yuhua-store — 羽化写作索引层
//!
//! 本 crate 把 Markdown 文件索引进 SQLite，提供中文全文检索与字数统计查询。
//!
//! ## 最重要的一条约束
//!
//! > 不变量 1：**文件是真源，索引是缓存。** 删除索引库后应用必须能
//! > 完全重建，且用户无感。
//!
//! 这条约束贯穿本 crate 的每一处设计：
//!
//! - 索引里**不存放任何**文件里没有的信息（除纯计算出的 word_count 等派生值）
//! - 任何索引损坏都只需 [`Index::rebuild`]，不涉及数据恢复
//! - 索引库放在系统应用数据目录，**绝不进工作区**（见 yuhua-fs::layout）
//!
//! ## 中文分词的现实问题
//!
//! FTS5 自带的 `unicode61` 分词器按空白与标点切分，对中文完全不可用：
//! 「羽化写作」会被当成**一个词**，搜「羽化」什么都搜不到。
//! 内置的 `trigram` 分词器要求查询串至少 3 个字符，搜两字词（中文里极其常见：
//! 「羽化」「写作」「主角」）同样失效。
//!
//! 因此本 crate 自研 [`tokenizer::BigramTokenizer`]：
//!
//! - 中日韩文字按**相邻二字**切分：「羽化写作」→ `羽化` / `化写` / `写作`
//! - ASCII 字母数字按词切分并小写化
//! - 单字查询退化为前缀匹配
//!
//! 代价是索引体积约翻倍（每 n 个字产生 n-1 个 token），
//! 换来的是**任意两字中文词都能精确命中**，这是检索可用性的底线。
//!
//! ## 模块地图
//!
//! | 模块 | 职责 |
//! | --- | --- |
//! | [`tokenizer`] | FTS5 中文二元组分词器 |
//! | [`schema`]    | 建表、迁移、PRAGMA 调优 |
//! | [`index`]     | 索引增删改、增量扫描、重建 |
//! | [`search`]    | 检索 API：关键词、高亮片段、分页 |
//! | [`stats`]     | 字数聚合查询（本章 / 本卷 / 全书 / 今日） |

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod index;
pub mod schema;
pub mod search;
pub mod stats;
pub mod tokenizer;

pub use index::{Index, IndexOutcome};
pub use schema::{open_database, CURRENT_SCHEMA_VERSION};
pub use search::{SearchHit, SearchQuery, SearchResults};
pub use stats::WordStats;
pub use tokenizer::{bigram_tokens, query_tokens, unique_tokens, BigramTokenizer};
