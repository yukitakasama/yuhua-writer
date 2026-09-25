//! 全文检索 API。
//!
//! 对应任务 T3.7：关键词、高亮片段、排序、分页。
//!
//! ## 查询流程
//!
//! ```text
//! 用户输入「羽化」
//!   ↓ BigramTokenizer::match_expression
//! FTS5 MATCH 表达式：加引号的 token
//!   ↓ 与 chapters_fts 的标题 / 正文列匹配
//! 命中的章节 ID + bm25 分值
//!   ↓ JOIN chapters 取回标题与路径
//! 结果列表（按相关度排序，分页）
//!   ↓ 可选：生成高亮片段
//! ```
//!
//! ## 排序：标题命中优先
//!
//! 用 FTS5 的 bm25() 函数，并把标题列的权重设得比正文高：
//! `bm25(chapters_fts, 0.0, 5.0, 1.0)`。
//!
//! 参数是「第 1 列权重 0、第 2 列 5、第 3 列 1」。
//! 第 1 列是 chapter_id（UNINDEXED，不参与评分，权重给 0），
//! 第 2 列是标题、第 3 列是正文。**标题命中给 5 倍权重**：
//! 搜「落羽」时，标题就叫《第一章 落羽》的章节应当排在
//! 正文里偶然提到一次「落羽」的章节之前。
//!
//! ## 高亮片段为什么不交给 SQLite
//!
//! FTS5 有 snippet() 函数，但它作用在**预分词的 token 文本**上，
//! 输出的是带空格的碎片，直接展示给用户是错的。
//! 因此高亮由本模块在**原始正文**上重新定位关键词位置来做。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use yuhua_core::Result;

use crate::schema::db_err;
use crate::tokenizer::{bigram_tokens, query_tokens, unique_tokens, BigramTokenizer};

/// 检索请求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    /// 关键词。
    pub keyword: String,
    /// 每页条数（默认 30）。
    #[serde(default)]
    pub limit: Option<u32>,
    /// 偏移量（默认 0）。
    #[serde(default)]
    pub offset: Option<u32>,
    /// 是否只在标题中检索（默认 false）。
    #[serde(default)]
    pub title_only: bool,
    /// 只检索指定卷（None 表示全部）。
    #[serde(default)]
    pub volume_id: Option<String>,
}

impl SearchQuery {
    /// 构造一个基本查询。
    pub fn new(keyword: impl Into<String>) -> Self {
        Self {
            keyword: keyword.into(),
            limit: None,
            offset: None,
            title_only: false,
            volume_id: None,
        }
    }

    /// 生效的每页条数。
    pub fn effective_limit(&self) -> u32 {
        // 上限 200：防止前端传个大数把整个索引拉进内存（要求②）
        self.limit.unwrap_or(30).clamp(1, 200)
    }

    /// 生效的偏移量。
    pub fn effective_offset(&self) -> u32 {
        self.offset.unwrap_or(0)
    }
}

/// 一条检索结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 章节 ID。
    pub chapter_id: String,
    /// 章节标题。
    pub title: String,
    /// 相对路径（用于跳转定位）。
    pub path: String,
    /// 所属卷 ID。
    pub volume_id: String,
    /// 相关度分值（越小越相关，FTS5 的 bm25 约定）。
    pub score: f64,
    /// 命中位置的高亮片段。
    pub snippets: Vec<HighlightSnippet>,
}

/// 一段高亮片段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightSnippet {
    /// 片段文本（已截取上下文）。
    pub text: String,
    /// 关键词在 text 中的字节区间列表，供前端渲染高亮。
    ///
    /// 用字节区间而非直接插入 HTML 标记：**前端不应把检索结果当 HTML 插入**，
    /// 那样会有 XSS 风险（正文里可能有 script 标签）。
    pub ranges: Vec<[usize; 2]>,
}

/// 检索结果集。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// 当前页的结果。
    pub hits: Vec<SearchHit>,
    /// 命中的章节总数。
    pub total: u32,
    /// 本次查询使用的每页条数。
    pub limit: u32,
    /// 本次查询的偏移量。
    pub offset: u32,
    /// 查询被识别出的 token（用于解释「为什么没搜到」）。
    pub tokens: Vec<String>,
}

impl SearchResults {
    /// 是否还有下一页。
    pub fn has_more(&self) -> bool {
        let fetched = self.offset + self.hits.len() as u32;
        fetched < self.total
    }
}

/// 执行检索。
pub fn search(conn: &Connection, query: &SearchQuery) -> Result<SearchResults> {
    let tokenizer = BigramTokenizer;
    let keyword = query.keyword.trim();

    // 空查询直接返回空结果，不要让它变成「匹配全部」
    if keyword.is_empty() {
        return Ok(empty_results(query));
    }

    // 构造 MATCH 表达式。单字查询用前缀匹配扩大召回。
    let tokens = query_tokens(keyword);
    let single_char = tokens.len() == 1 && tokens[0].chars().count() == 1;
    let match_expr = if single_char {
        tokenizer.prefix_expression(keyword)
    } else {
        tokenizer.match_expression(keyword)
    };

    let Some(match_expr) = match_expr else {
        // 查询串里没有任何可检索的字符（例如全是标点）
        return Ok(empty_results(query));
    };

    // 列过滤：FTS5 的 `{列名} : 表达式` 语法把匹配限制在指定列。
    // title_only 时只看标题列，否则标题 + 正文都看。
    let match_expr = if query.title_only {
        format!(" {{title_tokens}} : ({match_expr})")
    } else {
        match_expr
    };

    let total = count_matches(conn, &match_expr, query)?;
    let limit = query.effective_limit();
    let offset = query.effective_offset();

    // 主查询：JOIN 元数据表，按 bm25 排序。
    // bm25 的第 1 个参数必须是 FTS 表名，其后依次是各列权重。
    // 列序：chapter_id(不评分) / title_tokens / body_tokens
    let sql = "\
        SELECT
            c.id, c.title, c.path, c.volume_id,
            bm25(chapters_fts, 0.0, 5.0, 1.0) AS score
        FROM chapters_fts
        JOIN chapters c ON c.id = chapters_fts.chapter_id
        WHERE chapters_fts MATCH ?1
          AND (?2 IS NULL OR c.volume_id = ?2)
        ORDER BY score ASC, c.sort ASC
        LIMIT ?3 OFFSET ?4\
    ";

    let mut stmt = conn.prepare(sql).map_err(db_err)?;
    let rows = stmt
        .query_map(
            params![match_expr, query.volume_id.as_deref(), limit, offset],
            |row| {
                Ok(SearchHit {
                    chapter_id: row.get(0)?,
                    title: row.get(1)?,
                    path: row.get(2)?,
                    volume_id: row.get(3)?,
                    score: row.get(4)?,
                    snippets: Vec::new(),
                })
            },
        )
        .map_err(db_err)?;

    let hits: Vec<SearchHit> = rows.filter_map(|r| r.ok()).collect();

    Ok(SearchResults {
        hits,
        total,
        limit,
        offset,
        tokens,
    })
}

/// 构造空结果集。
fn empty_results(query: &SearchQuery) -> SearchResults {
    SearchResults {
        hits: Vec::new(),
        total: 0,
        limit: query.effective_limit(),
        offset: query.effective_offset(),
        tokens: Vec::new(),
    }
}

/// 统计匹配总数。
fn count_matches(conn: &Connection, match_expr: &str, query: &SearchQuery) -> Result<u32> {
    let sql = "\
        SELECT COUNT(*)
        FROM chapters_fts
        JOIN chapters c ON c.id = chapters_fts.chapter_id
        WHERE chapters_fts MATCH ?1
          AND (?2 IS NULL OR c.volume_id = ?2)\
    ";
    let n: i64 = conn
        .query_row(
            sql,
            params![match_expr, query.volume_id.as_deref()],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    Ok(n.max(0) as u32)
}

/// 一组相邻的命中：`(组起始字节, 组结束字节, 组内所有命中区间)`。
type MatchGroup = (usize, usize, Vec<(usize, usize)>);

/// 在**原始正文**上生成高亮片段。
///
/// 公开此函数是为了让上层（命令层）可以在从文件读到正文后复用同一套
/// 片段生成逻辑，保证 UI 展示与实际文件内容一致。
///
/// ## 实现要点
///
/// - 按**字节**定位但始终落在字符边界上，避免中文被切碎
/// - 每段片段带约 20 个字符的上下文
/// - 相邻命中合并，避免片段重叠导致同一处高亮两遍
/// - 最多返回 max 段
pub fn make_snippets(text: &str, keyword: &str, max: usize) -> Vec<HighlightSnippet> {
    let kw = keyword.trim();
    if kw.is_empty() || text.is_empty() || max == 0 {
        return Vec::new();
    }

    // 片段两侧保留的上下文字节数
    const CONTEXT: usize = 40;
    // 两处命中的间隔小于此值时合并进同一片段
    const MERGE_DISTANCE: usize = 80;

    // 收集所有命中位置（字节区间）
    let mut matches: Vec<(usize, usize)> = Vec::new();
    let mut search_from = 0usize;
    while let Some(rel) = text[search_from..].find(kw) {
        let abs = search_from + rel;
        let end = abs + kw.len();
        matches.push((abs, end));
        // 从命中末尾继续找，避免重叠匹配导致的死循环
        search_from = if end > abs { end } else { abs + 1 };
        if matches.len() >= max * 8 {
            break; // 少量采样足够生成 max 段
        }
    }

    if matches.is_empty() {
        return Vec::new();
    }

    // 合并距离很近的命中。
    // 每组的形状是 (组起始字节, 组结束字节, 组内所有命中区间)。
    // 用类型别名避免写出难以阅读的嵌套元组。
    let mut groups: Vec<MatchGroup> = Vec::new();
    for (s, e) in matches {
        match groups.last_mut() {
            Some(g) if s.saturating_sub(g.1) <= MERGE_DISTANCE => {
                g.1 = e;
                g.2.push((s, e));
            }
            _ => groups.push((s, e, vec![(s, e)])),
        }
    }

    groups
        .into_iter()
        .take(max)
        .map(|(g_start, g_end, hits)| {
            let frag_start = floor_char_boundary(text, g_start.saturating_sub(CONTEXT));
            let frag_end = ceil_char_boundary(text, (g_end + CONTEXT).min(text.len()));

            let fragment = &text[frag_start..frag_end];
            let ranges: Vec<[usize; 2]> = hits
                .iter()
                .map(|(s, e)| [s - frag_start, e - frag_start])
                .collect();

            HighlightSnippet {
                text: fragment.to_string(),
                ranges,
            }
        })
        .collect()
}

/// 向下取到最近的字符边界。
fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// 向上取到最近的字符边界。
fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

/// 统计一段文本的 token 数量（调试 / 诊断用）。
pub fn token_stats(text: &str) -> (usize, usize) {
    let all = bigram_tokens(text);
    let unique = unique_tokens(text);
    (all.len(), unique.len())
}

/// 校验一个查询串是否能产生有效检索。
pub fn is_searchable(keyword: &str) -> bool {
    !unique_tokens(keyword).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{content_hash, Index};
    use crate::schema::open_in_memory;
    use chrono::{DateTime, FixedOffset, TimeZone};
    use yuhua_core::model::{Chapter, Document};

    fn ts() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 1, 1, 9, 0, 0)
            .unwrap()
    }

    /// 建一个装好若干章节的索引库，返回 (Index, 章节 ID 列表)。
    fn seeded() -> Index {
        let conn = open_in_memory().unwrap();
        let idx = Index::new(conn);
        let doc = Document::new("测试书", ts());
        let vol = doc.volumes[0].id.clone();
        idx.upsert_book(&doc.book, "D:/ws").unwrap();
        idx.sync_volumes(&doc.volumes).unwrap();

        let samples = [
            ("第一章 落羽", "羽化写作的第一章正文，主角名叫落羽。", "manuscript/001.md"),
            ("第二章 山雨", "山中下起了大雨，落羽躲进破庙里避雨。", "manuscript/002.md"),
            ("第三章 风起", "风起云涌，与羽化无关的一段描写。", "manuscript/003.md"),
        ];
        for (title, body, path) in samples {
            let mut c = Chapter::new(&doc.book.id, &vol, title, path, 0, ts());
            c.body = body.to_string();
            c.content_hash = content_hash(body);
            idx.upsert_chapter(&c).unwrap();
        }
        idx
    }

    #[test]
    fn finds_chinese_keyword_in_body() {
        let idx = seeded();
        let r = search(idx.connection(), &SearchQuery::new("羽化")).unwrap();
        // 第一章与第三章都提到「羽化」
        assert_eq!(r.total, 2, "命中 {}", r.total);
    }

    #[test]
    fn finds_two_char_word_inside_longer_run() {
        // 二元组方案的核心价值：两字词必须能命中，这是 FTS5 默认分词器做不到的
        let idx = seeded();
        let r = search(idx.connection(), &SearchQuery::new("落羽")).unwrap();
        assert!(r.total >= 2, "『落羽』应命中多处，实际 {}", r.total);
    }

    #[test]
    fn title_hits_rank_above_body_hits() {
        // 权重设计：标题命中(5.0) 应当排在仅正文命中(1.0) 之前
        let idx = seeded();
        let r = search(idx.connection(), &SearchQuery::new("落羽")).unwrap();
        assert!(!r.hits.is_empty());
        assert!(
            r.hits[0].title.contains("落羽"),
            "标题含关键词的章节应排第一，实际第一名是 {:?}",
            r.hits[0].title
        );
    }

    #[test]
    fn no_results_for_absent_keyword() {
        let idx = seeded();
        let r = search(idx.connection(), &SearchQuery::new("完全不存在的内容")).unwrap();
        assert_eq!(r.total, 0);
        assert!(r.hits.is_empty());
    }

    #[test]
    fn empty_keyword_returns_nothing() {
        let idx = seeded();
        let r = search(idx.connection(), &SearchQuery::new("")).unwrap();
        assert_eq!(r.total, 0);
    }

    #[test]
    fn punctuation_only_query_returns_nothing() {
        let idx = seeded();
        let r = search(idx.connection(), &SearchQuery::new("，。！？")).unwrap();
        assert_eq!(r.total, 0);
        assert!(r.tokens.is_empty());
    }

    #[test]
    fn single_char_query_uses_prefix_matching() {
        // 单字「羽」应能命中含「羽化」的章节
        let idx = seeded();
        let r = search(idx.connection(), &SearchQuery::new("羽")).unwrap();
        assert!(r.total >= 2, "单字查询应命中，实际 {}", r.total);
    }

    #[test]
    fn pagination_limits_hits_but_reports_full_total() {
        let idx = seeded();
        let mut q = SearchQuery::new("羽化");
        q.limit = Some(1);
        let r = search(idx.connection(), &q).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.total, 2, "total 应是命中总数而非本页条数");
        assert!(r.has_more());
    }

    #[test]
    fn offset_skips_results() {
        let idx = seeded();
        let mut q = SearchQuery::new("羽化");
        q.limit = Some(10);
        q.offset = Some(1);
        let r = search(idx.connection(), &q).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert!(!r.has_more());
    }

    #[test]
    fn title_only_filters_out_body_matches() {
        let idx = seeded();
        let mut q = SearchQuery::new("羽化");
        q.title_only = true;
        let r = search(idx.connection(), &q).unwrap();
        // 只有第三章标题里没有「羽化」，实际没有任何标题含「羽化」
        // 因此 title_only 下应命中 0，验证了列过滤生效
        assert_eq!(r.total, 0, "title_only 应只在标题列检索，实际命中 {}", r.total);
    }

    #[test]
    fn volume_filter_restricts_results() {
        let idx = seeded();
        let vol: String = idx
            .connection()
            .query_row("SELECT id FROM volumes LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let mut q = SearchQuery::new("羽化");
        q.volume_id = Some(vol);
        let r = search(idx.connection(), &q).unwrap();
        // 全部章节都在同一卷下，因此结果不应减少
        assert_eq!(r.total, 2);
    }

    #[test]
    fn unknown_volume_filter_yields_nothing() {
        let idx = seeded();
        let mut q = SearchQuery::new("羽化");
        q.volume_id = Some("vol_不存在".into());
        let r = search(idx.connection(), &q).unwrap();
        assert_eq!(r.total, 0);
    }

    #[test]
    fn results_carry_path_for_navigation() {
        // 点击结果要能跳转，路径必须在结果里
        let idx = seeded();
        let r = search(idx.connection(), &SearchQuery::new("羽化")).unwrap();
        for hit in &r.hits {
            assert!(hit.path.ends_with(".md"), "结果缺少可跳转路径：{hit:?}");
            assert!(!hit.chapter_id.is_empty());
            assert!(!hit.volume_id.is_empty());
        }
    }

    #[test]
    fn deleted_chapter_disappears_from_search() {
        let idx = seeded();
        let before = search(idx.connection(), &SearchQuery::new("羽化")).unwrap().total;
        assert_eq!(before, 2);

        // 找到含「羽化」的一章删掉
        let id: String = idx
            .connection()
            .query_row(
                "SELECT chapter_id FROM chapters_fts WHERE body_tokens LIKE '%羽化%' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        idx.remove_chapter(&id).unwrap();

        let after = search(idx.connection(), &SearchQuery::new("羽化")).unwrap().total;
        assert_eq!(after, 1, "删除后检索结果未同步减少");
    }

    #[test]
    fn make_snippets_finds_keyword_with_correct_range() {
        let text = "这是一段很长的正文，中间包含羽化这个词，后面还有更多内容。";
        let s = make_snippets(text, "羽化", 3);
        assert_eq!(s.len(), 1);
        let [a, b] = s[0].ranges[0];
        assert_eq!(&s[0].text[a..b], "羽化");
    }

    #[test]
    fn make_snippets_returns_empty_when_absent() {
        assert!(make_snippets("这里没有那个词", "羽化", 3).is_empty());
    }

    #[test]
    fn make_snippets_returns_empty_for_empty_inputs() {
        assert!(make_snippets("", "羽化", 3).is_empty());
        assert!(make_snippets("正文", "", 3).is_empty());
        assert!(make_snippets("正文", "   ", 3).is_empty());
        assert!(make_snippets("正文", "羽化", 0).is_empty());
    }

    #[test]
    fn make_snippets_respects_max() {
        let text = "羽化".to_string() + &"间隔很长的内容".repeat(60);
        let s = make_snippets(&text, "羽化", 1);
        assert!(s.len() <= 1);
    }

    #[test]
    fn make_snippets_never_splits_multibyte_chars() {
        // 中文多字节，截断必须落在字符边界上，否则会 panic
        let text = "字".repeat(200) + "羽化" + &"字".repeat(200);
        let s = make_snippets(&text, "羽化", 1);
        assert_eq!(s.len(), 1);
        let [a, b] = s[0].ranges[0];
        assert_eq!(&s[0].text[a..b], "羽化");
    }

    #[test]
    fn char_boundary_helpers_always_land_on_boundaries() {
        let s = "中文abc日";
        for i in 0..=s.len() {
            assert!(s.is_char_boundary(floor_char_boundary(s, i)), "floor({i}) 越界");
            assert!(s.is_char_boundary(ceil_char_boundary(s, i)), "ceil({i}) 越界");
        }
        assert_eq!(floor_char_boundary(s, 999), s.len());
        assert_eq!(ceil_char_boundary(s, 999), s.len());
    }

    #[test]
    fn query_defaults_are_sane() {
        let q = SearchQuery::new("羽化");
        assert_eq!(q.effective_limit(), 30);
        assert_eq!(q.effective_offset(), 0);
        assert!(!q.title_only);
    }

    #[test]
    fn query_limit_is_clamped_to_protect_memory() {
        let mut q = SearchQuery::new("x");
        q.limit = Some(999_999);
        assert_eq!(q.effective_limit(), 200);
        q.limit = Some(0);
        assert_eq!(q.effective_limit(), 1);
    }

    #[test]
    fn has_more_logic_is_correct() {
        let mk = |total: u32, offset: u32, n: usize| SearchResults {
            hits: (0..n).map(|_| dummy_hit()).collect(),
            total,
            limit: 30,
            offset,
            tokens: vec![],
        };
        assert!(mk(100, 0, 30).has_more());
        assert!(!mk(30, 0, 30).has_more());
        assert!(!mk(100, 90, 10).has_more());
        assert!(mk(100, 0, 5).has_more());
    }

    fn dummy_hit() -> SearchHit {
        SearchHit {
            chapter_id: "ch_x".into(),
            title: "t".into(),
            path: "p.md".into(),
            volume_id: "vol_x".into(),
            score: 1.0,
            snippets: vec![],
        }
    }

    #[test]
    fn is_searchable_detects_valid_queries() {
        assert!(is_searchable("羽化"));
        assert!(is_searchable("hello"));
        assert!(!is_searchable(""));
        assert!(!is_searchable("，。"));
    }

    #[test]
    fn token_stats_reports_counts() {
        let (all, unique) = token_stats("羽化羽化");
        assert!(all > 0);
        assert!(unique <= all);
    }

    #[test]
    fn snippets_merge_nearby_matches() {
        let text = "羽化作者，羽化写作";
        let s = make_snippets(text, "羽化", 5);
        assert_eq!(s.len(), 1, "相邻命中应合并为一段");
        assert_eq!(s[0].ranges.len(), 2, "应记录两个高亮区间");
    }

    #[test]
    fn search_is_stable_under_repeated_calls() {
        let idx = seeded();
        let a = search(idx.connection(), &SearchQuery::new("羽化")).unwrap();
        let b = search(idx.connection(), &SearchQuery::new("羽化")).unwrap();
        assert_eq!(a.hits, b.hits, "相同查询应返回稳定顺序");
    }
}