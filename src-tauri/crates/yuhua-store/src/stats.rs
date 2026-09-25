//! 字数聚合查询。
//!
//! 对应任务 T3.6「字数统计引擎（三套口径）」与 T5.5「字数面板：
//! 本章 / 本卷 / 全书 / 今日」。
//!
//! ## 为什么字数要从索引查而不是每次遍历文件
//!
//! UI 上「本章 / 本卷 / 全书」的数字会随着每次按键变化（防抖后），
//! 若每次都重新读磁盘上全部章节文件算字数，百万字作品会不堪重负。
//! 索引里已经存了每章的 `word_count`，聚合只是一个 SQL 查询。
//!
//! ## 三套口径的处理
//!
//! 索引表里只存了默认口径（不含标点）的字数，因为：
//!
//! - 三套口径的数字用途不同，默认口径是**绝大多数场景**下要显示的
//! - 存三份会放大索引体积，而索引已经为了二元组付了一倍存储代价
//!
//! 需要其它口径时，由 [`WordStats::with_all_modes`] 在内存中
//! 按比例估算，或由上层读取原文重新统计（仅在用户显式切换口径时发生）。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use yuhua_core::{Result, YuhuaError};

use crate::schema::db_err;

/// 字数统计结果。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordStats {
    /// 本章字数（未指定章节时为 0）。
    pub chapter: u32,
    /// 本卷字数（未指定卷时为 0）。
    pub volume: u32,
    /// 全书字数。
    pub book: u32,
    /// 章数。
    pub chapter_count: u32,
    /// 卷数。
    pub volume_count: u32,
}

impl WordStats {
    /// 本章占全书的比例（0.0–1.0）。
    pub fn chapter_ratio(&self) -> f64 {
        if self.book == 0 {
            0.0
        } else {
            self.chapter as f64 / self.book as f64
        }
    }

    /// 全局平均每章字数。
    ///
    /// 用 `checked_div` 而不是先判断再相除：既表达「除数为零时取 0」
    /// 这个意图，也省掉一个分支。
    pub fn average_chapter(&self) -> u32 {
        self.book.checked_div(self.chapter_count).unwrap_or(0)
    }
}

/// 查询全书 / 指定卷 / 指定章的字数。
pub fn word_stats(
    conn: &Connection,
    book_id: &str,
    volume_id: Option<&str>,
    chapter_id: Option<&str>,
) -> Result<WordStats> {
    let book: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE book_id = ?1",
            params![book_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;

    let chapter_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM chapters WHERE book_id = ?1",
            params![book_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;

    let volume_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM volumes WHERE book_id = ?1",
            params![book_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;

    let volume = match volume_id {
        Some(vid) => conn
            .query_row(
                "SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE volume_id = ?1",
                params![vid],
                |r| r.get(0),
            )
            .map_err(db_err)?,
        None => 0,
    };

    let chapter = match chapter_id {
        Some(cid) => conn
            .query_row(
                "SELECT COALESCE(word_count, 0) FROM chapters WHERE id = ?1",
                params![cid],
                |r| r.get(0),
            )
            .unwrap_or(0),
        None => 0,
    };

    Ok(WordStats {
        chapter: chapter.max(0) as u32,
        volume: volume.max(0) as u32,
        book: book.max(0) as u32,
        chapter_count: chapter_count.max(0) as u32,
        volume_count: volume_count.max(0) as u32,
    })
}

/// 分章字数排行（用于统计页的「各章字数排行」）。
///
/// 返回 `(章节标题, 字数)`，按字数降序。
pub fn chapter_word_ranking(
    conn: &Connection,
    book_id: &str,
    limit: u32,
) -> Result<Vec<(String, u32)>> {
    let mut stmt = conn
        .prepare(
            "SELECT title, word_count FROM chapters
             WHERE book_id = ?1
             ORDER BY word_count DESC
             LIMIT ?2",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![book_id, limit], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
        })
        .map_err(db_err)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 分卷字数分布（用于统计页的「卷分布」）。
pub fn volume_word_distribution(
    conn: &Connection,
    book_id: &str,
) -> Result<Vec<(String, String, u32)>> {
    let mut stmt = conn
        .prepare(
            "SELECT v.id, v.title, COALESCE(SUM(c.word_count), 0) AS total
             FROM volumes v
             LEFT JOIN chapters c ON c.volume_id = v.id
             WHERE v.book_id = ?1
             GROUP BY v.id
             ORDER BY v.sort ASC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![book_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)? as u32,
            ))
        })
        .map_err(db_err)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 各卷的章节数。
pub fn volume_chapter_counts(conn: &Connection, book_id: &str) -> Result<Vec<(String, u32)>> {
    let mut stmt = conn
        .prepare(
            "SELECT v.id, COUNT(c.id)
             FROM volumes v
             LEFT JOIN chapters c ON c.volume_id = v.id
             WHERE v.book_id = ?1
             GROUP BY v.id",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![book_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
        })
        .map_err(db_err)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 按状态统计章节数（草稿 / 已完成 / 修订中）。
pub fn status_breakdown(conn: &Connection, book_id: &str) -> Result<Vec<(String, u32)>> {
    let mut stmt = conn
        .prepare("SELECT status, COUNT(*) FROM chapters WHERE book_id = ?1 GROUP BY status")
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![book_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
        })
        .map_err(db_err)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 校验统计查询的前提（供测试与诊断用）。
#[doc(hidden)]
pub fn require_non_empty(s: &str) -> Result<()> {
    if s.trim().is_empty() {
        return Err(YuhuaError::InvalidInput("book_id 不能为空".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{content_hash, Index};
    use crate::schema::open_in_memory;
    use chrono::{DateTime, FixedOffset, TimeZone};
    use yuhua_core::model::{Chapter, Document, Volume};

    fn ts() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 1, 1, 9, 0, 0)
            .unwrap()
    }

    struct Setup {
        idx: Index,
        book_id: String,
        vol1: String,
        vol2: String,
        ch1: String,
        ch2: String,
    }

    /// 建库：两卷、三章，字数分别是 4 / 6 / 10。
    fn setup() -> Setup {
        let conn = open_in_memory().unwrap();
        let idx = Index::new(conn);
        let doc = Document::new("测试书", ts());
        let book_id = doc.book.id.clone();
        let vol1 = doc.volumes[0].id.clone();
        let vol2 = Volume::new(&book_id, "第二卷", 1, ts());
        let vol2_id = vol2.id.clone();

        idx.upsert_book(&doc.book, "D:/ws").unwrap();
        idx.sync_volumes(&[doc.volumes[0].clone(), vol2]).unwrap();

        let mk = |vol: &yuhua_core::VolumeId, title: &str, path: &str, body: &str, sort: i32| {
            let mut c = Chapter::new(&book_id, vol, title, path, sort, ts());
            c.body = body.to_string();
            c.content_hash = content_hash(body);
            c
        };

        let c1 = mk(&vol1, "第一章", "m/001.md", "一二三四", 0); // 4 字
        let c2 = mk(&vol1, "第二章", "m/002.md", "一二三四五六", 1); // 6 字
        let c3 = mk(&vol2_id, "第三章", "m/003.md", "一二三四五六七八九十", 0); // 10 字

        for c in [&c1, &c2, &c3] {
            idx.upsert_chapter(c).unwrap();
        }

        Setup {
            idx,
            book_id: book_id.as_str().to_string(),
            vol1: vol1.as_str().to_string(),
            vol2: vol2_id.as_str().to_string(),
            ch1: c1.meta.id.as_str().to_string(),
            ch2: c2.meta.id.as_str().to_string(),
        }
    }

    #[test]
    fn book_total_sums_all_chapters() {
        let s = setup();
        let st = word_stats(s.idx.connection(), &s.book_id, None, None).unwrap();
        assert_eq!(st.book, 20);
        assert_eq!(st.chapter_count, 3);
        assert_eq!(st.volume_count, 2);
    }

    #[test]
    fn volume_total_restricted_to_that_volume() {
        let s = setup();
        let st = word_stats(s.idx.connection(), &s.book_id, Some(&s.vol1), None).unwrap();
        assert_eq!(st.volume, 10); // 4 + 6
        assert_eq!(st.book, 20, "全书字数不受 volume 参数影响");

        let st2 = word_stats(s.idx.connection(), &s.book_id, Some(&s.vol2), None).unwrap();
        assert_eq!(st2.volume, 10);
    }

    #[test]
    fn chapter_total_for_specific_chapter() {
        let s = setup();
        let st = word_stats(s.idx.connection(), &s.book_id, None, Some(&s.ch1)).unwrap();
        assert_eq!(st.chapter, 4);

        let st2 = word_stats(s.idx.connection(), &s.book_id, None, Some(&s.ch2)).unwrap();
        assert_eq!(st2.chapter, 6);
    }

    #[test]
    fn all_three_dimensions_together() {
        let s = setup();
        let st = word_stats(s.idx.connection(), &s.book_id, Some(&s.vol1), Some(&s.ch2)).unwrap();
        assert_eq!(st.chapter, 6);
        assert_eq!(st.volume, 10);
        assert_eq!(st.book, 20);
    }

    #[test]
    fn unknown_ids_yield_zeros_not_errors() {
        // UI 上打开一个刚删除的章节时不应崩，显示 0 即可
        let s = setup();
        let st = word_stats(
            s.idx.connection(),
            "bk_不存在",
            Some("vol_不存在"),
            Some("ch_不存在"),
        )
        .unwrap();
        assert_eq!(st.book, 0);
        assert_eq!(st.volume, 0);
        assert_eq!(st.chapter, 0);
    }

    #[test]
    fn empty_book_has_zero_stats() {
        let conn = open_in_memory().unwrap();
        let st = word_stats(&conn, "bk_none", None, None).unwrap();
        assert_eq!(st, WordStats::default());
    }

    #[test]
    fn chapter_ratio_is_computed_correctly() {
        let mut st = WordStats {
            chapter: 25,
            book: 100,
            ..Default::default()
        };
        assert!((st.chapter_ratio() - 0.25).abs() < f64::EPSILON);

        st.book = 0;
        assert_eq!(st.chapter_ratio(), 0.0, "空书不应产生 NaN");
    }

    #[test]
    fn average_chapter_handles_zero_chapters() {
        let mut st = WordStats::default();
        assert_eq!(st.average_chapter(), 0);
        st.book = 100;
        st.chapter_count = 4;
        assert_eq!(st.average_chapter(), 25);
    }

    #[test]
    fn chapter_ranking_is_sorted_desc() {
        let s = setup();
        let r = chapter_word_ranking(s.idx.connection(), &s.book_id, 10).unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].1, 10);
        assert_eq!(r[1].1, 6);
        assert_eq!(r[2].1, 4);
    }

    #[test]
    fn chapter_ranking_respects_limit() {
        let s = setup();
        let r = chapter_word_ranking(s.idx.connection(), &s.book_id, 2).unwrap();
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn volume_distribution_includes_empty_volumes() {
        // LEFT JOIN：字数为 0 的卷也要出现在分布图里，否则图表会缺一块
        let s = setup();
        let conn = s.idx.connection();
        let doc_book_id = &s.book_id;
        let vol3 = Volume::new(
            &yuhua_core::BookId::parse(doc_book_id.clone()).unwrap(),
            "空的第三卷",
            2,
            ts(),
        );
        s.idx.sync_volumes(&[vol3]).unwrap();

        let dist = volume_word_distribution(conn, doc_book_id).unwrap();
        assert_eq!(dist.len(), 3, "空卷应被包含：{dist:?}");
        let counts = volume_chapter_counts(conn, doc_book_id).unwrap();
        assert_eq!(counts.len(), 3);
    }

    #[test]
    fn volume_distribution_sums_match_book_total() {
        let s = setup();
        let dist = volume_word_distribution(s.idx.connection(), &s.book_id).unwrap();
        let sum: u32 = dist.iter().map(|(_, _, w)| w).sum();
        let st = word_stats(s.idx.connection(), &s.book_id, None, None).unwrap();
        assert_eq!(sum, st.book, "各卷字数之和不等于全书字数");
    }

    #[test]
    fn volume_distribution_is_ordered_by_sort() {
        let s = setup();
        let dist = volume_word_distribution(s.idx.connection(), &s.book_id).unwrap();
        assert_eq!(dist[0].0, s.vol1);
        assert_eq!(dist[1].0, s.vol2);
    }

    #[test]
    fn status_breakdown_groups_by_status() {
        let s = setup();
        let b = status_breakdown(s.idx.connection(), &s.book_id).unwrap();
        // 都是默认的 draft
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].0, "draft");
        assert_eq!(b[0].1, 3);
    }

    #[test]
    fn status_breakdown_reflects_updates() {
        let s = setup();
        // 把第一章改成已完成
        s.idx
            .connection()
            .execute(
                "UPDATE chapters SET status = 'done' WHERE id = ?1",
                params![s.ch1],
            )
            .unwrap();
        let b = status_breakdown(s.idx.connection(), &s.book_id).unwrap();
        let map: std::collections::HashMap<String, u32> = b.into_iter().collect();
        assert_eq!(map.get("done"), Some(&1));
        assert_eq!(map.get("draft"), Some(&2));
    }

    #[test]
    fn require_non_empty_rejects_blank() {
        assert!(require_non_empty("bk_1").is_ok());
        assert!(require_non_empty("").is_err());
        assert!(require_non_empty("   ").is_err());
    }

    #[test]
    fn stats_update_after_chapter_edit() {
        // 模拟写作过程：改一章的字数，全书统计应当跟随变化
        let s = setup();
        let before = word_stats(s.idx.connection(), &s.book_id, None, None)
            .unwrap()
            .book;
        assert_eq!(before, 20);

        // 找到第一章并加长它
        let id = s.ch1.clone();
        let body = "一二三四五六七八九十十一十二"; // 12 字
        s.idx
            .connection()
            .execute(
                "UPDATE chapters SET word_count = ?1 WHERE id = ?2",
                params![12i64, id],
            )
            .unwrap();

        let after = word_stats(s.idx.connection(), &s.book_id, None, None)
            .unwrap()
            .book;
        assert_eq!(after, 28);
        let _ = body;
    }

    #[test]
    fn word_stats_serializes_to_camel_case() {
        // 前端按 camelCase 读取，字段名是契约
        let st = WordStats {
            chapter: 1,
            volume: 2,
            book: 3,
            chapter_count: 4,
            volume_count: 5,
        };
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("chapterCount"));
        assert!(json.contains("volumeCount"));
    }
}
