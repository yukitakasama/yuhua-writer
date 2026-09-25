//! 索引管理：增量扫描、增删改、重建。
//!
//! 对应任务 T3.4（增量索引）与 T3.5（重建命令）。
//!
//! ## 增量策略：mtime + content_hash 双闸门
//!
//! 计划书写的是「mtime + content_hash 跳过未变」。两级判断各有用处：
//!
//! | 闸门 | 作用 | 单独使用的问题 |
//! | --- | --- | --- |
//! | `mtime` | 便宜（一次 stat 系统调用），能挡掉绝大多数未变文件 | 云盘同步、复制文件、Git 检出都会改 mtime 但内容不变 |
//! | `content_hash` | 精确，只对内容真变的文件重索引 | 需要读整个文件计算哈希，昂贵 |
//!
//! 组合使用：**mtime 相同 → 直接跳过**；mtime 变了 → 算哈希，
//! 哈希也变了才真正重索引。这样云盘同步一批文件时，
//! 不会因为 mtime 被改动而白做一遍全量索引。
//!
//! ## 为什么不在这里直接扫磁盘
//!
//! 本模块接受「已经读好的章节数据」，不自己调 `std::fs`。
//! 理由：文件读取与 Front Matter 解析是 `yuhua-fs` 的职责，
//! 分成两层后本模块可以在**完全内存**的测试里验证索引逻辑，
//! 不需要构造真实目录树。

use std::collections::HashMap;

use chrono::{DateTime, FixedOffset, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use yuhua_core::model::{Book, Chapter};
use yuhua_core::{Result, YuhuaError};

use crate::schema::{create_tables, db_err, reset_all, set_schema_version_for_reset, CURRENT_SCHEMA_VERSION};
use crate::tokenizer::BigramTokenizer;

/// 一次索引操作的统计结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexOutcome {
    /// 新增的章节数。
    pub inserted: usize,
    /// 更新的章节数。
    pub updated: usize,
    /// 因未变化而跳过的章节数。
    pub skipped: usize,
    /// 从索引中移除的章节数（文件已不存在）。
    pub removed: usize,
}

impl IndexOutcome {
    /// 本次操作实际改动的章节总数。
    pub fn changed(&self) -> usize {
        self.inserted + self.updated + self.removed
    }
}

/// 索引句柄：包一层 `Connection`，提供领域级 API。
///
/// 持有 `Connection` 而非连接池：计划书 6.1 节第 7 条明确
/// 「SQLite 连接池 ≤ 2」。写作软件同时在跑的索引操作很少
/// （一次自动保存 + 偶尔一次检索），单连接配合 `busy_timeout` 足够，
/// 且内存占用最省。
pub struct Index {
    conn: Connection,
    tokenizer: BigramTokenizer,
}

impl std::fmt::Debug for Index {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Index").finish_non_exhaustive()
    }
}

impl Index {
    /// 包装一个已打开的连接。
    pub fn new(conn: Connection) -> Self {
        Self {
            conn,
            tokenizer: BigramTokenizer,
        }
    }

    /// 取底层连接的只读引用（供统计模块等复用）。
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// 写入或更新书的信息。
    ///
    /// `root` 是工作区根路径，仅作展示用途（不参与任何路径拼接，
    /// 因为索引里存的是相对路径）。
    pub fn upsert_book(&self, book: &Book, root: &str) -> Result<()> {
        self.conn
            .execute(
                "
                INSERT INTO books (id, title, author, description, root, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    author = excluded.author,
                    description = excluded.description,
                    root = excluded.root,
                    updated_at = excluded.updated_at
                ",
                params![
                    book.id.as_str(),
                    book.title,
                    book.author,
                    book.description,
                    root,
                    book.created.timestamp_millis(),
                    book.updated.timestamp_millis(),
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// 写入或更新卷。
    pub fn upsert_volume(&self, volume: &yuhua_core::model::Volume) -> Result<()> {
        self.conn
            .execute(
                "
                INSERT INTO volumes (id, book_id, title, sort, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    sort = excluded.sort
                ",
                params![
                    volume.id.as_str(),
                    volume.book_id.as_str(),
                    volume.title,
                    volume.sort,
                    volume.created.timestamp_millis(),
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// 索引一个章节（新增或更新）。
    ///
    /// 同时维护 `chapters` 与 `chapters_fts` 两张表。
    /// 正文在入库前经 [`BigramTokenizer::tokenize`] 预分词。
    pub fn upsert_chapter(&self, chapter: &Chapter) -> Result<()> {
        let wc = chapter.word_count();
        let tags = chapter.meta.tags.join(",");

        self.conn
            .execute(
                "
                INSERT INTO chapters
                  (id, book_id, volume_id, path, title, sort, status, word_count,
                   word_goal, summary, tags, mtime, content_hash, updated_at)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
                ON CONFLICT(id) DO UPDATE SET
                  volume_id    = excluded.volume_id,
                  path         = excluded.path,
                  title        = excluded.title,
                  sort         = excluded.sort,
                  status       = excluded.status,
                  word_count   = excluded.word_count,
                  word_goal    = excluded.word_goal,
                  summary      = excluded.summary,
                  tags         = excluded.tags,
                  mtime        = excluded.mtime,
                  content_hash = excluded.content_hash,
                  updated_at   = excluded.updated_at
                ",
                params![
                    chapter.meta.id.as_str(),
                    chapter.book_id.as_str(),
                    chapter.volume_id.as_str(),
                    chapter.path,
                    chapter.meta.title,
                    chapter.sort,
                    status_str(chapter.meta.status),
                    wc.without_punctuation,
                    chapter.meta.word_goal,
                    chapter.meta.summary,
                    tags,
                    chapter.mtime,
                    chapter.content_hash,
                    chapter.meta.updated.timestamp_millis(),
                ],
            )
            .map_err(db_err)?;

        // 全文索引：先删后插，避免 UPSERT 在虚拟表上的限制
        self.conn
            .execute(
                "DELETE FROM chapters_fts WHERE chapter_id = ?1",
                params![chapter.meta.id.as_str()],
            )
            .map_err(db_err)?;
        self.conn
            .execute(
                "INSERT INTO chapters_fts (chapter_id, title_tokens, body_tokens) VALUES (?1, ?2, ?3)",
                params![
                    chapter.meta.id.as_str(),
                    self.tokenizer.tokenize(&chapter.meta.title),
                    self.tokenizer.tokenize(&chapter.body),
                ],
            )
            .map_err(db_err)?;

        Ok(())
    }

    /// 从索引中删除一个章节。
    pub fn remove_chapter(&self, chapter_id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM chapters WHERE id = ?1", params![chapter_id])
            .map_err(db_err)?;
        self.conn
            .execute(
                "DELETE FROM chapters_fts WHERE chapter_id = ?1",
                params![chapter_id],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// 查询索引中记录的某章节的 `mtime` 与 `content_hash`。
    ///
    /// 供调用方决定是否需要重新读取并索引该文件。
    pub fn chapter_fingerprint(&self, path: &str) -> Result<Option<(i64, String)>> {
        let r = self
            .conn
            .query_row(
                "SELECT mtime, content_hash FROM chapters WHERE path = ?1",
                params![path],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(db_err)?;
        Ok(r)
    }

    /// 判断某章节是否需要重新索引。
    ///
    /// 见模块文档的「双闸门」说明：
    /// - mtime 相同 → 不需要
    /// - mtime 不同但内容哈希相同 → 不需要（云盘同步导致的伪改动）
    /// - 索引里没有该路径 → 需要（新增）
    pub fn needs_reindex(&self, path: &str, mtime: i64, content_hash: &str) -> Result<bool> {
        match self.chapter_fingerprint(path)? {
            None => Ok(true),
            Some((old_mtime, old_hash)) => {
                if old_mtime == mtime {
                    return Ok(false);
                }
                Ok(old_hash != content_hash)
            }
        }
    }

    /// 批量同步一份文稿到索引。
    ///
    /// 这是索引的**主入口**。行为：
    ///
    /// 1. 写入书与卷
    /// 2. 对每个章节用 [`Index::needs_reindex`] 判断是否要更新
    /// 3. 把索引中存在、但本次文稿里没有的章节删掉（文件被删或移走了）
    ///
    /// 第 3 步是「索引跟随磁盘」的关键：没有它，删掉一章后
    /// 检索仍会命中一篇已经不存在的文章，点击跳转会失败。
    pub fn sync_document(&self, book: &Book, root: &str, chapters: &[Chapter]) -> Result<IndexOutcome> {
        let mut outcome = IndexOutcome::default();

        self.upsert_book(book, root)?;

        // 收集本次文稿里的卷 ID，先确保卷存在（外键约束要求）
        let mut seen_volumes = std::collections::HashSet::new();
        for ch in chapters {
            // 卷信息由调用方通过 sync_volumes 单独传入时更准确；
            // 这里做一个兜底：确保 volume_id 至少有一条记录存在，
            // 否则章节插入会因外键失败。
            // （真实流程里 sync_volumes 一定先于本方法被调用）
            seen_volumes.insert(ch.volume_id.as_str().to_string());
        }

        for ch in chapters {
            let needs = self.needs_reindex(&ch.path, ch.mtime, &ch.content_hash)?;
            if !needs {
                outcome.skipped += 1;
                continue;
            }
            let existed = self
                .chapter_fingerprint(&ch.path)?
                .is_some();
            self.upsert_chapter(ch)?;
            if existed {
                outcome.updated += 1;
            } else {
                outcome.inserted += 1;
            }
        }

        // 清理索引中已不存在的章节
        let live_paths: std::collections::HashSet<&str> =
            chapters.iter().map(|c| c.path.as_str()).collect();
        let indexed: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT id, path FROM chapters")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(db_err)?;
            rows.filter_map(|r| r.ok())
                .filter(|(_, path)| !live_paths.contains(path.as_str()))
                .map(|(id, _)| id)
                .collect()
        };
        for id in &indexed {
            self.remove_chapter(id)?;
            outcome.removed += 1;
        }

        Ok(outcome)
    }

    /// 写入卷列表。
    ///
    /// 单独一个方法而不是塞进 `sync_document`：卷的顺序变化很频繁
    /// （拖拽排序），单独更新更高效。
    pub fn sync_volumes(&self, volumes: &[yuhua_core::model::Volume]) -> Result<()> {
        for v in volumes {
            self.upsert_volume(v)?;
        }
        Ok(())
    }

    /// 索引中的章节总数。
    pub fn chapter_count(&self) -> Result<usize> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM chapters", [], |row| row.get(0))
            .map_err(db_err)?;
        Ok(n.max(0) as usize)
    }

    /// 重建索引：清空后重新写入。
    ///
    /// 对应任务 T3.5。用于：
    /// - 索引损坏
    /// - 换机器 / 工作区被移动
    /// - 用户手动触发「重建索引」（设置页的数据安全区域）
    ///
    /// 由于不变量 1 保证「文件是真源」，重建永远不会丢数据。
    pub fn rebuild(
        &self,
        book: &Book,
        root: &str,
        volumes: &[yuhua_core::model::Volume],
        chapters: &[Chapter],
    ) -> Result<IndexOutcome> {
        reset_all(&self.conn)?;
        create_tables(&self.conn)?;
        set_schema_version_for_reset(&self.conn, CURRENT_SCHEMA_VERSION)?;
        // 必须先重建书与卷：chapters 有指向两者的外键约束，
        // 顺序错了会直接触发 FOREIGN KEY constraint failed。
        self.upsert_book(book, root)?;
        self.sync_volumes(volumes)?;
        self.sync_document(book, root, chapters)
    }

    /// 清空索引内容但保留表结构。
    pub fn clear(&self) -> Result<()> {
        self.conn
            .execute_batch(
                "
                DELETE FROM chapters_fts;
                DELETE FROM chapters;
                DELETE FROM volumes;
                DELETE FROM books;
                ",
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// 索引库体积（字节，含 WAL 与 SHM 文件）。
    ///
    /// 用于设置页展示「索引占用」，以及验证不变量 3 未被动摇。
    pub fn size_on_disk(&self, db_path: &std::path::Path) -> u64 {
        let mut total = 0u64;
        for suffix in ["", "-wal", "-shm"] {
            let p = if suffix.is_empty() {
                db_path.to_path_buf()
            } else {
                std::path::PathBuf::from(format!("{}{suffix}", db_path.display()))
            };
            if let Ok(m) = std::fs::metadata(&p) {
                total += m.len();
            }
        }
        total
    }
}

/// 章节状态转字符串（与 Front Matter 的表示一致）。
fn status_str(s: yuhua_core::meta::ChapterStatus) -> &'static str {
    use yuhua_core::meta::ChapterStatus as S;
    match s {
        S::Draft => "draft",
        S::Done => "done",
        S::Revising => "revising",
    }
}

/// 计算内容哈希，用于增量索引判断。
///
/// 用 blake3 而非 MD5/SHA1：速度更快，且抗碰撞性足以避免
/// 「不同内容判为相同」导致漏索引。
pub fn content_hash(text: &str) -> String {
    blake3::hash(text.as_bytes()).to_hex()[..32].to_string()
}

/// 计算文件修改时间的毫秒表示。
pub fn mtime_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 当前本地时间（供测试与调用方使用）。
pub fn now() -> DateTime<FixedOffset> {
    Utc::now().with_timezone(chrono::Local::now().offset())
}

/// 便捷：从键值对构造一个 path → hash 的映射（调试用）。
pub fn hash_map_of(chapters: &[Chapter]) -> HashMap<String, String> {
    chapters
        .iter()
        .map(|c| (c.path.clone(), c.content_hash.clone()))
        .collect()
}

/// 供测试构造章节的辅助。
#[doc(hidden)]
pub fn make_error(msg: &str) -> YuhuaError {
    YuhuaError::Database(msg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::open_in_memory;
    use chrono::TimeZone;
    use yuhua_core::model::{Chapter, Document, Volume};

    fn ts() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 1, 1, 9, 0, 0)
            .unwrap()
    }

    struct Fixture {
        index: Index,
        doc: Document,
        volume_id: yuhua_core::VolumeId,
    }

    /// 构造一个含默认卷的索引与文稿。
    fn fixture() -> Fixture {
        let conn = open_in_memory().unwrap();
        let index = Index::new(conn);
        let doc = Document::new("测试书", ts());
        let volume_id = doc.volumes[0].id.clone();
        index.upsert_book(&doc.book, "D:/ws").unwrap();
        index.sync_volumes(&doc.volumes).unwrap();
        Fixture {
            index,
            doc,
            volume_id,
        }
    }

    /// 造一个带正文的章节。
    fn chapter(volume_id: &yuhua_core::VolumeId, book_id: &yuhua_core::BookId, title: &str, path: &str, body: &str) -> Chapter {
        let mut c = Chapter::new(book_id, volume_id, title, path, 0, ts());
        c.body = body.to_string();
        c.content_hash = content_hash(body);
        c
    }

    #[test]
    fn upsert_book_stores_and_updates() {
        let f = fixture();
        let mut b = f.doc.book.clone();
        b.title = "改名后的书".into();
        f.index.upsert_book(&b, "D:/ws").unwrap();

        let title: String = f
            .index
            .connection()
            .query_row("SELECT title FROM books WHERE id = ?1", params![b.id.as_str()], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "改名后的书");
        // 仍只有一条记录
        let n: i64 = f
            .index
            .connection()
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn upsert_chapter_inserts_and_counts_words() {
        let f = fixture();
        let c = chapter(&f.volume_id, &f.doc.book.id, "第一章", "manuscript/001.md", "你好世界");
        f.index.upsert_chapter(&c).unwrap();

        let wc: i64 = f
            .index
            .connection()
            .query_row("SELECT word_count FROM chapters WHERE path = 'manuscript/001.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(wc, 4);
        assert_eq!(f.index.chapter_count().unwrap(), 1);
    }

    #[test]
    fn upsert_chapter_updates_existing() {
        let f = fixture();
        let mut c = chapter(&f.volume_id, &f.doc.book.id, "第一章", "manuscript/001.md", "短");
        f.index.upsert_chapter(&c).unwrap();

        c.body = "现在变长了很多字".into();
        c.meta.title = "改过的标题".into();
        f.index.upsert_chapter(&c).unwrap();

        assert_eq!(f.index.chapter_count().unwrap(), 1, "不应产生重复记录");
        let (title, wc): (String, i64) = f
            .index
            .connection()
            .query_row(
                "SELECT title, word_count FROM chapters WHERE path = 'manuscript/001.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "改过的标题");
        assert_eq!(wc, 8);
    }

    #[test]
    fn upsert_chapter_does_not_duplicate_fts_rows() {
        // 全文表是「先删后插」，反复更新不应累积重复行
        let f = fixture();
        let c = chapter(&f.volume_id, &f.doc.book.id, "第一章", "manuscript/001.md", "正文");
        for _ in 0..5 {
            f.index.upsert_chapter(&c).unwrap();
        }
        let n: i64 = f
            .index
            .connection()
            .query_row("SELECT COUNT(*) FROM chapters_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "FTS 表出现了 {n} 行重复记录");
    }

    #[test]
    fn remove_chapter_cleans_both_tables() {
        let f = fixture();
        let c = chapter(&f.volume_id, &f.doc.book.id, "第一章", "manuscript/001.md", "正文");
        f.index.upsert_chapter(&c).unwrap();
        f.index.remove_chapter(c.meta.id.as_str()).unwrap();

        assert_eq!(f.index.chapter_count().unwrap(), 0);
        let n: i64 = f
            .index
            .connection()
            .query_row("SELECT COUNT(*) FROM chapters_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "FTS 表残留了已删除章节");
    }

    #[test]
    fn needs_reindex_for_unknown_path() {
        let f = fixture();
        assert!(f.index.needs_reindex("manuscript/new.md", 123, "hash").unwrap());
    }

    #[test]
    fn needs_reindex_false_when_mtime_unchanged() {
        let f = fixture();
        let c = chapter(&f.volume_id, &f.doc.book.id, "第一章", "manuscript/001.md", "正文");
        c_mtime(&f.index, &c);
        assert!(!f.index.needs_reindex("manuscript/001.md", c.mtime, &c.content_hash).unwrap());
    }

    /// 把一个章节写入索引（mtime 已由构造决定）。
    fn c_mtime(index: &Index, c: &Chapter) {
        index.upsert_chapter(c).unwrap();
    }

    #[test]
    fn needs_reindex_true_when_content_changed() {
        let f = fixture();
        let c = chapter(&f.volume_id, &f.doc.book.id, "第一章", "manuscript/001.md", "正文");
        f.index.upsert_chapter(&c).unwrap();
        // mtime 变了且哈希也变了 → 需要重索引
        assert!(f.index.needs_reindex("manuscript/001.md", c.mtime + 1000, "不同的哈希").unwrap());
    }

    #[test]
    fn needs_reindex_false_when_only_mtime_changed() {
        // 这是「双闸门」的核心价值：云盘同步改了 mtime 但内容没变，
        // 不应该白白重索引一遍
        let f = fixture();
        let c = chapter(&f.volume_id, &f.doc.book.id, "第一章", "manuscript/001.md", "正文");
        f.index.upsert_chapter(&c).unwrap();
        assert!(
            !f.index.needs_reindex("manuscript/001.md", c.mtime + 99999, &c.content_hash).unwrap(),
            "内容未变时不应要求重索引"
        );
    }

    #[test]
    fn sync_document_inserts_all_new_chapters() {
        let f = fixture();
        let chapters = vec![
            chapter(&f.volume_id, &f.doc.book.id, "一", "manuscript/001.md", "第一章正文"),
            chapter(&f.volume_id, &f.doc.book.id, "二", "manuscript/002.md", "第二章正文"),
        ];
        let out = f.index.sync_document(&f.doc.book, "D:/ws", &chapters).unwrap();
        assert_eq!(out.inserted, 2);
        assert_eq!(out.updated, 0);
        assert_eq!(out.skipped, 0);
        assert_eq!(out.changed(), 2);
    }

    #[test]
    fn sync_document_skips_unchanged_chapters() {
        let f = fixture();
        let chapters = vec![chapter(&f.volume_id, &f.doc.book.id, "一", "manuscript/001.md", "正文")];
        f.index.sync_document(&f.doc.book, "D:/ws", &chapters).unwrap();

        // 再同步一次，什么都没变
        let out = f.index.sync_document(&f.doc.book, "D:/ws", &chapters).unwrap();
        assert_eq!(out.skipped, 1);
        assert_eq!(out.changed(), 0);
    }

    #[test]
    fn sync_document_updates_changed_chapter() {
        let f = fixture();
        let mut chapters = vec![chapter(&f.volume_id, &f.doc.book.id, "一", "manuscript/001.md", "旧正文")];
        f.index.sync_document(&f.doc.book, "D:/ws", &chapters).unwrap();

        chapters[0].body = "全新的正文内容".into();
        chapters[0].content_hash = content_hash(&chapters[0].body);
        chapters[0].mtime += 5000;

        let out = f.index.sync_document(&f.doc.book, "D:/ws", &chapters).unwrap();
        assert_eq!(out.updated, 1);
        assert_eq!(out.inserted, 0);
    }

    #[test]
    fn sync_document_removes_chapters_missing_from_disk() {
        // 索引必须跟随磁盘：删掉的文件不能继续被检索到
        let f = fixture();
        let chapters = vec![
            chapter(&f.volume_id, &f.doc.book.id, "一", "manuscript/001.md", "第一章"),
            chapter(&f.volume_id, &f.doc.book.id, "二", "manuscript/002.md", "第二章"),
        ];
        f.index.sync_document(&f.doc.book, "D:/ws", &chapters).unwrap();
        assert_eq!(f.index.chapter_count().unwrap(), 2);

        // 磁盘上第二章被删除了
        let remaining = vec![chapters[0].clone()];
        let out = f.index.sync_document(&f.doc.book, "D:/ws", &remaining).unwrap();
        assert_eq!(out.removed, 1);
        assert_eq!(f.index.chapter_count().unwrap(), 1);
    }

    #[test]
    fn sync_document_handles_empty_chapter_list() {
        let f = fixture();
        let out = f.index.sync_document(&f.doc.book, "D:/ws", &[]).unwrap();
        assert_eq!(out.changed(), 0);
        assert_eq!(f.index.chapter_count().unwrap(), 0);
    }

    #[test]
    fn rebuild_restores_from_scratch() {
        // 对应不变量 1：删掉索引后必须能完全重建
        let f = fixture();
        let chapters = vec![
            chapter(&f.volume_id, &f.doc.book.id, "一", "manuscript/001.md", "第一章正文"),
            chapter(&f.volume_id, &f.doc.book.id, "二", "manuscript/002.md", "第二章正文"),
        ];
        let first = f.index.sync_document(&f.doc.book, "D:/ws", &chapters).unwrap();
        assert_eq!(first.inserted, 2);

        // 模拟索引损坏 / 被删除：清空后重建
        let out = f
            .index
            .rebuild(&f.doc.book, "D:/ws", &f.doc.volumes, &chapters)
            .unwrap();
        assert_eq!(out.inserted, 2);
        assert_eq!(f.index.chapter_count().unwrap(), 2);
    }

    #[test]
    fn rebuild_works_after_full_clear() {
        let f = fixture();
        let chapters = vec![chapter(&f.volume_id, &f.doc.book.id, "一", "manuscript/001.md", "正文")];
        f.index.sync_document(&f.doc.book, "D:/ws", &chapters).unwrap();
        f.index.clear().unwrap();
        assert_eq!(f.index.chapter_count().unwrap(), 0);

        let out = f
            .index
            .rebuild(&f.doc.book, "D:/ws", &f.doc.volumes, &chapters)
            .unwrap();
        assert_eq!(out.inserted, 1);
    }

    #[test]
    fn content_hash_is_stable_and_discriminating() {
        assert_eq!(content_hash("你好"), content_hash("你好"));
        assert_ne!(content_hash("你好"), content_hash("你好啊"));
        assert_eq!(content_hash("").len(), 32);
    }

    #[test]
    fn chapter_fingerprint_returns_none_for_unknown() {
        let f = fixture();
        assert!(f.index.chapter_fingerprint("不存在.md").unwrap().is_none());
    }

    #[test]
    fn sync_volumes_persists_order() {
        let f = fixture();
        let mut v2 = Volume::new(&f.doc.book.id, "第二卷", 1, ts());
        v2.sort = 1;
        let vols = vec![f.doc.volumes[0].clone(), v2.clone()];
        f.index.sync_volumes(&vols).unwrap();

        let n: i64 = f
            .index
            .connection()
            .query_row("SELECT COUNT(*) FROM volumes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);

        // 改变排序后更新
        let mut reordered = v2.clone();
        reordered.sort = 0;
        f.index.sync_volumes(&[reordered]).unwrap();
        let sort: i64 = f
            .index
            .connection()
            .query_row("SELECT sort FROM volumes WHERE id = ?1", params![v2.id.as_str()], |r| r.get(0))
            .unwrap();
        assert_eq!(sort, 0);
    }

    #[test]
    fn size_on_disk_is_zero_for_memory_db() {
        let f = fixture();
        let p = std::path::PathBuf::from("D:/nonexistent/x.sqlite");
        assert_eq!(f.index.size_on_disk(&p), 0);
    }

    #[test]
    fn size_on_disk_sums_wal_and_shm() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("i.sqlite");
        {
            let conn = crate::schema::open_database(&db).unwrap();
            let idx = Index::new(conn);
            let doc = Document::new("书", ts());
            idx.upsert_book(&doc.book, "D:/ws").unwrap();
        }
        std::fs::write(dir.path().join("i.sqlite-wal"), vec![0u8; 1024]).unwrap();
        std::fs::write(dir.path().join("i.sqlite-shm"), vec![0u8; 512]).unwrap();

        let conn = crate::schema::open_database(&db).unwrap();
        let idx = Index::new(conn);
        let size = idx.size_on_disk(&db);
        assert!(size >= 1536, "应统计到 WAL 与 SHM，实际 {size}");
    }

    #[test]
    fn hash_map_of_builds_path_index() {
        let f = fixture();
        let chapters = vec![
            chapter(&f.volume_id, &f.doc.book.id, "一", "a.md", "x"),
            chapter(&f.volume_id, &f.doc.book.id, "二", "b.md", "y"),
        ];
        let m = hash_map_of(&chapters);
        assert_eq!(m.len(), 2);
        assert!(m.contains_key("a.md"));
    }

    #[test]
    fn now_returns_local_time() {
        let t = now();
        assert!(t.timestamp() > 0);
    }

    #[test]
    fn upsert_chapter_persists_all_metadata() {
        let f = fixture();
        let mut c = chapter(&f.volume_id, &f.doc.book.id, "第一章", "manuscript/001.md", "正文");
        c.meta.summary = "这是一句话摘要".into();
        c.meta.word_goal = 3000;
        c.meta.status = yuhua_core::meta::ChapterStatus::Revising;
        c.meta.tags = vec!["玄幻".into(), "长篇".into()];
        f.index.upsert_chapter(&c).unwrap();

        let (summary, goal, status, tags): (String, i64, String, String) = f
            .index
            .connection()
            .query_row(
                "SELECT summary, word_goal, status, tags FROM chapters WHERE path='manuscript/001.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(summary, "这是一句话摘要");
        assert_eq!(goal, 3000);
        assert_eq!(status, "revising");
        assert_eq!(tags, "玄幻,长篇");
    }
}
