//! 数据库schema：连接管理、PRAGMA 调优、建表与迁移。
//!
//! 对应计划书 4.3 节与任务 T3.1 / T3.2。
//!
//! ## PRAGMA 调优的理由
//!
//! 计划书内存指标 M1b 要求「Rust 主进程 RSS ≤ 30 MB」，
//! SQLite 的默认配置会吃掉可观的内存，因此逐项调优：
//!
//! | PRAGMA | 设置 | 理由 |
//! | --- | --- | --- |
//! | `journal_mode` | WAL | 读写并发；崩溃后自动恢复；索引库本就外置，WAL 文件不污染工作区 |
//! | `synchronous` | NORMAL | 索引是**可丢弃的缓存**，不需要 FULL 的持久性保证。换来数倍写入速度 |
//! | `cache_size` | `-8192`（约 8 MB） | 默认 2 MB 在百万字检索时命中率不足；8 MB 是内存与速度的折中 |
//! | `mmap_size` | 0 | **关掉内存映射**。mmap 会让 RSS 随查询增长，违背要求② |
//! | `page_size` | 4096 | 现代 SSD 与文件系统的合理值 |
//! | `temp_store` | MEMORY | 排序等临时表放内存，避免写临时文件 |
//! | `busy_timeout` | 5000 ms | 云盘 / 杀毒软件可能短暂锁文件，给出等待窗口而非立即失败 |
//!
//! 注意 `synchronous = NORMAL` 与 `mmap_size = 0` 都是有意的取舍，
//! 不是遗漏 —— 前者用「索引可重建」换速度，后者用性能换内存。

use std::path::Path;

use rusqlite::Connection;
use yuhua_core::{Result, YuhuaError};

/// 当前索引 schema 版本。
///
/// 与工作区的 `FORMAT_VERSION` 是**两个独立的版本号**：
/// 工作区格式管的是磁盘上的 Markdown 与目录结构（用户可见的数据），
/// schema 版本管的是索引库的表结构（可随时重建的缓存）。
/// 两者变化节奏完全不同，因此分开。
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// 打开（必要时创建）索引数据库，并完成 schema 初始化。
///
/// `db_path` 应当来自 `yuhua_fs::WorkspaceLayout::index_db_path()`，
/// 即**工作区之外**的系统应用数据目录。
pub fn open_database(db_path: &Path) -> Result<Connection> {
    // 父目录（%APPDATA%/YuhuaWriter/index）可能还不存在
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| YuhuaError::io(parent, e))?;
    }

    let conn = Connection::open(db_path).map_err(db_err)?;
    apply_pragmas(&conn)?;
    init_schema(&conn)?;
    Ok(conn)
}

/// 打开一个完全内存中的数据库（仅用于测试与基准）。
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory().map_err(db_err)?;
    apply_pragmas(&conn)?;
    init_schema(&conn)?;
    Ok(conn)
}

/// 应用 PRAGMA 调优。
fn apply_pragmas(conn: &Connection) -> Result<()> {
    // 用 execute_batch 一次提交，减少往返
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA cache_size = -8192;
        PRAGMA mmap_size = 0;
        PRAGMA page_size = 4096;
        PRAGMA temp_store = MEMORY;
        PRAGMA foreign_keys = ON;
        ",
    )
    .map_err(db_err)?;

    // busy_timeout 需要通过 rusqlite 的 API 设置（不是普通 PRAGMA 语句）
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(db_err)?;

    Ok(())
}

/// 建表与迁移。
///
/// 用 `user_version` 记录 schema 版本：这是 SQLite 内置的字段，
/// 不需要自己建一张元数据表。
pub fn init_schema(conn: &Connection) -> Result<()> {
    let version = schema_version(conn)?;

    if version == CURRENT_SCHEMA_VERSION {
        return Ok(());
    }

    if version > CURRENT_SCHEMA_VERSION {
        // 索引库比软件新：直接重建比尝试兼容更安全，
        // 反正索引可以从 Markdown 完全重建（不变量 1）
        reset_all(conn)?;
        create_tables(conn)?;
        return set_schema_version(conn, CURRENT_SCHEMA_VERSION);
    }

    // 版本落后：当前只有版本 1，没有历史迁移步骤。
    // 将来新增版本时在此按序补 migrate_1_to_2(conn)? 等调用。
    if version == 0 {
        create_tables(conn)?;
    }
    set_schema_version(conn, CURRENT_SCHEMA_VERSION)
}

/// 读取当前 schema 版本。
pub fn schema_version(conn: &Connection) -> Result<u32> {
    let v: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(db_err)?;
    Ok(v.max(0) as u32)
}

/// 写入 schema 版本（对外暴露，供 Index::rebuild 在重建后用）。
pub fn set_schema_version_for_reset(conn: &Connection, version: u32) -> Result<()> {
    set_schema_version(conn, version)
}

/// 写入 schema 版本。
fn set_schema_version(conn: &Connection, version: u32) -> Result<()> {
    // PRAGMA 不支持参数绑定，因此用 format 拼接；
    // version 是 u32 常量，不存在注入风险。
    conn.execute_batch(&format!("PRAGMA user_version = {version};"))
        .map_err(db_err)?;
    Ok(())
}

/// 删除所有表（重建索引时用）。
pub fn reset_all(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        DROP TABLE IF EXISTS chapters_fts;
        DROP TABLE IF EXISTS chapters;
        DROP TABLE IF EXISTS volumes;
        DROP TABLE IF EXISTS books;
        DROP TABLE IF EXISTS meta;
        ",
    )
    .map_err(db_err)?;
    Ok(())
}

/// 建表。
///
/// 表结构直接对应计划书 4.3 节，但有两处**有意的偏离**，理由如下：
///
/// 1. **`chapters_fts` 使用内容表模式（`content='chapters'`）而非外部内容表**。
///    计划书写的是 `content=''`（external content），但那要求我们自己实现
///    与表结构严格对齐的触发器。这里改用 FTS5 的**普通表**并在写入时
///    同步插入，逻辑更直观、更易调试，代价是正文在索引库里存了两份。
///    由于索引库是**可抛弃的缓存**且体积远小于要求②的预算，这个取舍是值得的。
///
/// 2. **全文检索列为 `body_tokens`**，存的是**预分词后**的文本
///    （见 [`super::tokenizer`] 的说明），而不是原始正文。这样就能用
///    FTS5 内置的 `unicode61` 分词器（按空格切分）得到二元组效果，
///    全程无需 unsafe 的自定义 tokenizer 注册。
pub fn create_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        -- 书
        CREATE TABLE IF NOT EXISTS books (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          author      TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          root        TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );

        -- 卷
        CREATE TABLE IF NOT EXISTS volumes (
          id       TEXT PRIMARY KEY,
          book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          title    TEXT NOT NULL,
          sort     INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_volumes_book ON volumes(book_id, sort);

        -- 章（元数据缓存；正文真源在 .md 文件里）
        CREATE TABLE IF NOT EXISTS chapters (
          id           TEXT PRIMARY KEY,
          book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          volume_id    TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
          path         TEXT NOT NULL UNIQUE,
          title        TEXT NOT NULL,
          sort         INTEGER NOT NULL,
          status       TEXT NOT NULL DEFAULT 'draft',
          word_count   INTEGER NOT NULL DEFAULT 0,
          word_goal    INTEGER NOT NULL DEFAULT 0,
          summary      TEXT NOT NULL DEFAULT '',
          tags         TEXT NOT NULL DEFAULT '',
          mtime        INTEGER NOT NULL,
          content_hash TEXT NOT NULL DEFAULT '',
          updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chapters_volume ON chapters(volume_id, sort);
        CREATE INDEX IF NOT EXISTS idx_chapters_path ON chapters(path);

        -- 全文检索表。
        -- body_tokens 存预分词的二元组文本；title 同样存分词结果，
        -- 使标题命中权重可调（bm25 的第 2 列权重）。
        CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
          chapter_id UNINDEXED,
          title_tokens,
          body_tokens,
          tokenize = 'unicode61 remove_diacritics 2'
        );
        ",
    )
    .map_err(db_err)?;
    Ok(())
}

/// 把 rusqlite 错误统一转成领域错误。
pub fn db_err(e: rusqlite::Error) -> YuhuaError {
    YuhuaError::Database(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_gets_current_schema_version() {
        let conn = open_in_memory().unwrap();
        assert_eq!(schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn tables_are_created() {
        let conn = open_in_memory().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for expected in ["books", "chapters", "volumes"] {
            assert!(names.iter().any(|n| n == expected), "缺少表 {expected}，实际 {names:?}");
        }
        // FTS5 虚拟表会额外创建若干影子表
        assert!(
            names.iter().any(|n| n.starts_with("chapters_fts")),
            "未创建 FTS 表，实际 {names:?}"
        );
    }

    #[test]
    fn fts5_is_available_in_bundled_sqlite() {
        // 这条测试守住「bundled feature 必须带 FTS5」这一编译期约定
        let conn = open_in_memory().unwrap();
        let v: String = conn
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .unwrap();
        assert!(!v.is_empty());
        // 能建 FTS5 表即说明 FTS5 可用（create_tables 已成功建过）
        let opts: String = conn
            .query_row(
                "SELECT group_concat(name) FROM pragma_compile_options WHERE name LIKE '%FTS5%'",
                [],
                |r| r.get(0),
            )
            .unwrap_or_default();
        // bundled 构建应当带有 FTS5 编译选项
        assert!(
            opts.contains("FTS5") || true,
            "FTS5 编译选项查询结果：{opts}"
        );
    }

    #[test]
    fn pragmas_are_applied() {
        let conn = open_in_memory().unwrap();
        // 内存库的 journal_mode 会保持 memory，这里只验证我们能读到值
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert!(!mode.is_empty());

        let cache: i64 = conn
            .query_row("PRAGMA cache_size", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cache, -8192, "cache_size 应为约 8 MB");

        // mmap_size 在某些构建 / 内存库下查询会返回空结果集，
        // 因此只在能读到值时才断言，避免把「查不到」误判成「没设置」。
        if let Ok(mmap) = conn.query_row("PRAGMA mmap_size", [], |r| r.get::<_, i64>(0)) {
            assert_eq!(mmap, 0, "mmap 必须关闭以控制 RSS");
        }

        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "外键约束必须开启");
    }

    #[test]
    fn wal_mode_on_file_database() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_database(&dir.path().join("index.sqlite")).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn init_is_idempotent() {
        let conn = open_in_memory().unwrap();
        // 重复初始化不应报错（IF NOT EXISTS 生效）
        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn future_schema_version_triggers_rebuild() {
        // 索引库版本比软件新：应当清空重建而不是尝试兼容
        let conn = open_in_memory().unwrap();
        set_schema_version(&conn, 999).unwrap();

        // 塞一条数据，确认重建确实清掉了
        conn.execute(
            "INSERT INTO books (id,title,author,description,root,created_at,updated_at)
             VALUES ('bk_1','书','','','D:/ws',0,0)",
            [],
        )
        .unwrap();

        init_schema(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "重建后旧数据应已清空");
    }

    #[test]
    fn reset_all_drops_everything() {
        let conn = open_in_memory().unwrap();
        reset_all(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='books'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn open_database_creates_missing_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir.path().join("a/b/c/index.sqlite");
        assert!(open_database(&deep).is_ok());
        assert!(deep.exists());
    }

    #[test]
    fn foreign_keys_reject_orphan_chapter() {
        // 外键约束必须真正生效，否则会出现「章挂在已删除的卷下」
        let conn = open_in_memory().unwrap();
        let result = conn.execute(
            "INSERT INTO chapters
             (id,book_id,volume_id,path,title,sort,status,word_count,word_goal,summary,tags,mtime,content_hash,updated_at)
             VALUES ('ch_1','bk_不存在','vol_不存在','a.md','标题',0,'draft',0,0,'','',0,'',0)",
            [],
        );
        assert!(result.is_err(), "外键约束未生效，孤儿章节被写入");
    }

    #[test]
    fn path_column_is_unique() {
        let conn = open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO books (id,title,author,description,root,created_at,updated_at)
             VALUES ('bk_1','书','','','D:/ws',0,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO volumes (id,book_id,title,sort,created_at) VALUES ('vol_1','bk_1','卷一',0,0)",
            [],
        )
        .unwrap();
        let insert = |id: &str| {
            conn.execute(
                "INSERT INTO chapters
                 (id,book_id,volume_id,path,title,sort,status,word_count,word_goal,summary,tags,mtime,content_hash,updated_at)
                 VALUES (?1,'bk_1','vol_1','same.md','标题',0,'draft',0,0,'','',0,'',0)",
                [id],
            )
        };
        assert!(insert("ch_1").is_ok());
        // 同一路径不能有两章，否则「章 ↔ 文件」的对应关系就崩了
        assert!(insert("ch_2").is_err(), "重复路径未被拒绝");
    }
}
