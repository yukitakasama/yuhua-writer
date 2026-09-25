//! 热力图与码字日历的数据准备（任务 T8.7 / T8.8）。
//!
//! 本模块**不画任何图形** —— SVG 是前端的事（计划书 10.5 节）。
//! 它只负责把统计折算成前端能直接消费的数组：
//!
//! - 年热力图：365（或 366）个格子，每格有日期、字数、色阶档位
//! - 月日历：补齐到的网格（含前后补位），每格同样有日期与档位
//! - 色阶：5 档，**预计算**好边界，前端不做逐格 JS 计算
//!
//! ## 为什么要预先分档
//! 计划书 10.5 节的性能约束里明确写了「色阶映射用预计算的 5 档
//! 颜色数组，不做逐格 JS 计算」，以及「365 个 rect 一次插入 DOM，
//! 逐格不做动画」。把分档放在 Rust 层一次算完，前端就只剩
//! 「按 level 取颜色」这一步，是最省事也最快的做法。
//!
//! ## 色阶为什么按分位数而不是固定阈值
//! 固定阈值（例如 0/500/1000/2000/4000 字）在两类用户身上都失效：
//! 日更 200 字的人整张图全灰，日更 8000 字的人整张图全黑 ——
//! 热力图就失去了「看出节奏」的作用。按分位数分档则永远能看出层次。

use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::model::DayRecord;

/// 色阶档数（计划书 10.5 节建议 5 档）。
pub const HEATMAP_LEVELS: u8 = 5;

/// 一个热力图格子。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatCell {
    /// 日期。
    pub date: NaiveDate,
    /// 当日字数。
    pub words: u32,
    /// 色阶档位（0 到 4）。0 表示没有产出。
    pub level: u8,
    /// 是否属于请求的区间（月视图里前后补位的格子为 false）。
    pub in_range: bool,
}

/// 色阶分档表。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelScale {
    /// 各档的**下界**（含）。数组长度等于 HEATMAP_LEVELS，
    /// 第 0 档的下界恒为 0。
    pub thresholds: Vec<u32>,
    /// 样本中的最大字数（0 表示样本全空）。
    pub max_words: u32,
    /// 处于第 1 档及以上的格子数量（即「有产出」的天数）。
    pub active_days: u32,
}

impl Default for LevelScale {
    /// 默认档位：只在全部为空时使用，此时所有格子都是 0 档。
    fn default() -> Self {
        Self {
            thresholds: vec![0; usize::from(HEATMAP_LEVELS)],
            max_words: 0,
            active_days: 0,
        }
    }
}

impl LevelScale {
    /// 把字数映射到档位。
    ///
    /// 从高往低找第一个满足「字数不低于下界」的档位：
    /// 这样即使 thresholds 是非递增的异常数据，结果也总是有限且落在范围内。
    ///
    /// 没有样本（active_days 为 0）时一切非零字数都归 0 档：
    /// 此时没有任何可参照的分布，硬分成 5 档只会给出无意义的颜色。
    pub fn level_of(&self, words: u32) -> u8 {
        if self.active_days == 0 {
            return 0;
        }
        if words == 0 {
            return 0;
        }
        let mut level = 0u8;
        for (index, threshold) in self.thresholds.iter().enumerate() {
            if words >= *threshold {
                level = index as u8;
            }
        }
        level.min(HEATMAP_LEVELS - 1)
    }
}

/// 根据一组「日期到字数」的样本计算色阶。
///
/// 算法：把非零字数升序排列，按下标取 20/40/60/80 分位作为 1 到 4 档的下界。
/// 用分位数而不是等分最大值，是因为写作产量是**长尾分布**：
/// 偶尔爆发的一天会远远高出日常水平，等分会让日常那些天全部挤进第 1 档。
pub fn build_scale(samples: &[u32]) -> LevelScale {
    let mut nonzero: Vec<u32> = samples.iter().copied().filter(|w| *w > 0).collect();
    nonzero.sort_unstable();

    if nonzero.is_empty() {
        return LevelScale::default();
    }

    let max_words = *nonzero.last().unwrap_or(&0);
    let count = nonzero.len();

    // 第 0 档下界恒为 0；第 1 到 4 档取分位数
    let level_count = usize::from(HEATMAP_LEVELS);
    let mut thresholds = vec![0u32; level_count];
    // 第 0 档已经由 vec 的初值 0 填好，这里从第 1 档开始逐档取分位数
    for (level, slot) in thresholds.iter_mut().enumerate().skip(1) {
        // 分位位置：level / 5 处，例如 5 档时分位是 20%、40%、60%、80%
        let position = (count * level) / level_count;
        let index = position.min(count - 1);
        *slot = nonzero[index];
    }

    // 保证各档下界严格递增：样本里大量重复值时（例如所有天都是 100 字），
    // 分位数会算出相同的下界，导致某些档位永远取不到。
    // 逐档向上抬一，让 5 档都能出现，图形才有层次。
    for level in 1..thresholds.len() {
        let previous = thresholds[level - 1];
        let current = &mut thresholds[level];
        if *current <= previous {
            *current = previous.saturating_add(1);
        }
    }

    LevelScale {
        thresholds,
        max_words,
        active_days: count as u32,
    }
}

/// 取某个日期区间的每日字数（含两端）。
pub fn words_in_range(
    days: &BTreeMap<NaiveDate, DayRecord>,
    start: NaiveDate,
    end: NaiveDate,
) -> Vec<(NaiveDate, u32)> {
    if start > end {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = start;
    loop {
        let words = days.get(&cursor).map_or(0, |d| d.words());
        out.push((cursor, words));
        if cursor == end {
            break;
        }
        match cursor.succ_opt() {
            Some(next) => cursor = next,
            // 日期溢出（理论上只会在 9999-12-31 之后发生）时停止，
            // 而不是 panic：统计是辅助功能，不该让整个程序崩掉
            None => break,
        }
    }
    out
}

/// 生成某一年的热力图数据（365 或 366 格）。
///
/// 返回的格子**只覆盖这一年**，前端按「第几周、星期几」摆放即可。
/// 首尾不做补齐：年视图在 GitHub 风格里本来就是按周对齐，
/// 让前端决定是否渲染空白格更灵活。
pub fn year_heatmap(days: &BTreeMap<NaiveDate, DayRecord>, year: i32) -> Vec<HeatCell> {
    let samples: Vec<u32> = words_in_range(
        days,
        NaiveDate::from_ymd_opt(year, 1, 1).unwrap_or_default(),
        NaiveDate::from_ymd_opt(year, 12, 31).unwrap_or_default(),
    )
    .into_iter()
    .map(|(_, w)| w)
    .collect();
    let scale = build_scale(&samples);

    samples
        .into_iter()
        .enumerate()
        .map(|(offset, words)| {
            let date = NaiveDate::from_ymd_opt(year, 1, 1).unwrap_or_default()
                + Duration::days(offset as i64);
            HeatCell {
                date,
                words,
                level: scale.level_of(words),
                in_range: true,
            }
        })
        .collect()
}

/// 月日历网格。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarMonth {
    /// 月份，形如 2026-01。
    pub month: String,
    /// 网格首格日期（当周周一，可能属于上个月）。
    pub grid_start: NaiveDate,
    /// 网格末格日期（当周周日，可能属于下个月）。
    pub grid_end: NaiveDate,
    /// 按行优先排列的格子，长度恒为 7 的整数倍。
    pub cells: Vec<HeatCell>,
    /// 本月总字数。
    pub total_words: u64,
    /// 色阶。
    pub scale: LevelScale,
}

/// 生成某个月的码字日历网格。
///
/// 网格从**本月第一天所在周的周一开始**，到**本月最后一天所在周的周日结束**，
/// 因此长度恒为 7 的整数倍（28 到 42 格）。前端按 7 列摆放即成月历。
///
/// 补位格子的 in_range 为 false，字数照常给出（用于「上月末那两天也写了」
/// 这种细节的悬停提示），但前端可以按需淡化。
pub fn month_calendar(
    days: &BTreeMap<NaiveDate, DayRecord>,
    year: i32,
    month: u32,
) -> CalendarMonth {
    let first = NaiveDate::from_ymd_opt(year, month, 1).unwrap_or_default();
    let next_first = first
        .checked_add_months(chrono::Months::new(1))
        .unwrap_or(first);
    let last = next_first.pred_opt().unwrap_or(first);

    let grid_start = crate::summary::week_start(first);
    // 网格末格：本月最后一天所在周的周日
    let grid_end = crate::summary::week_start(last) + Duration::days(6);

    let raw = words_in_range(days, grid_start, grid_end);
    let samples: Vec<u32> = raw.iter().map(|(_, w)| *w).collect();
    let scale = build_scale(&samples);

    let total_words = days
        .range(first..=last)
        .map(|(_, d)| u64::from(d.words()))
        .sum();

    let cells = raw
        .into_iter()
        .map(|(date, words)| HeatCell {
            date,
            words,
            level: scale.level_of(words),
            in_range: date >= first && date <= last,
        })
        .collect();

    CalendarMonth {
        month: format!("{year:04}-{month:02}"),
        grid_start,
        grid_end,
        cells,
        total_words,
        scale,
    }
}

/// 一段日期区间的汇总，供热力图图例与「本年共计」展示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatSummary {
    /// 区间起始日。
    pub start: NaiveDate,
    /// 区间结束日。
    pub end: NaiveDate,
    /// 区间总字数。
    pub total_words: u64,
    /// 有产出的天数。
    pub active_days: u32,
    /// 区间自然日数。
    pub total_days: u32,
    /// 最高单日。
    pub best_day: u32,
    /// 色阶。
    pub scale: LevelScale,
}

/// 汇总一段区间的热力图数据。
pub fn summarize_range(
    days: &BTreeMap<NaiveDate, DayRecord>,
    start: NaiveDate,
    end: NaiveDate,
) -> HeatSummary {
    let raw = words_in_range(days, start, end);
    let samples: Vec<u32> = raw.iter().map(|(_, w)| *w).collect();
    let scale = build_scale(&samples);
    HeatSummary {
        start,
        end,
        total_words: samples.iter().map(|w| u64::from(*w)).sum(),
        active_days: samples.iter().filter(|w| **w > 0).count() as u32,
        total_days: raw.len() as u32,
        best_day: samples.iter().copied().max().unwrap_or(0),
        scale,
    }
}

/// 某一年有多少天（用于给热力图预留 365 或 366 个格子）。
pub fn days_in_year(year: i32) -> u32 {
    let start = NaiveDate::from_ymd_opt(year, 1, 1).unwrap_or_default();
    let next = NaiveDate::from_ymd_opt(year + 1, 1, 1).unwrap_or(start);
    (next - start).num_days().max(0) as u32
}

/// 某个日期在一周中的列号（周一为 0，周日为 6）。
pub fn weekday_index(date: NaiveDate) -> u8 {
    date.weekday().num_days_from_monday() as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::tests::day;
    use chrono::NaiveDate;

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate {
        day(y, m, dd)
    }

    fn map(list: &[(NaiveDate, u32)]) -> BTreeMap<NaiveDate, DayRecord> {
        let mut out = BTreeMap::new();
        for (date, words) in list {
            let mut record = DayRecord::default();
            if *words > 0 {
                record.add_chapter_delta("ch_1", *words).unwrap();
            }
            out.insert(*date, record);
        }
        out
    }

    #[test]
    fn scale_of_empty_samples_has_five_levels() {
        let scale = build_scale(&[]);
        assert_eq!(scale.thresholds.len(), usize::from(HEATMAP_LEVELS));
        assert_eq!(scale.max_words, 0);
        assert_eq!(scale.active_days, 0);
        assert_eq!(scale.level_of(0), 0);
        // 没有样本时，任何非零字数都落到 0 档（因为所有下界都是 0）
        assert_eq!(scale.level_of(500), 0);
    }

    #[test]
    fn scale_lowest_level_is_zero() {
        let scale = build_scale(&[10, 20, 30, 40, 50]);
        assert_eq!(scale.thresholds[0], 0, "第 0 档必须从 0 开始");
        assert_eq!(scale.level_of(0), 0, "没写字的天永远是 0 档");
    }

    #[test]
    fn scale_thresholds_are_strictly_increasing() {
        // 样本全部相同是最坏情况：分位数会算出相同下界
        let scale = build_scale(&[100, 100, 100, 100, 100]);
        for window in scale.thresholds.windows(2) {
            assert!(
                window[1] > window[0],
                "档位下界必须严格递增：{:?}",
                scale.thresholds
            );
        }
    }

    #[test]
    fn scale_separates_typical_distribution() {
        // 长尾分布：大部分是天 200 到 800，偶尔爆发 10000
        let samples = vec![200, 300, 400, 500, 600, 700, 800, 1000, 10_000];
        let scale = build_scale(&samples);
        assert_eq!(scale.max_words, 10_000);
        assert_eq!(scale.active_days, samples.len() as u32);

        // 日常量级应当落在中间档，而不是全挤进第 1 档
        let daily = scale.level_of(400);
        assert!(daily >= 1, "400 字不该是 0 档，实际 {daily}");
        assert!(scale.level_of(10_000) > daily, "爆发日必须比日常日更深色");
    }

    #[test]
    fn scale_level_of_clamps_to_range() {
        let scale = build_scale(&[10, 20, 30]);
        assert!(scale.level_of(u32::MAX) < HEATMAP_LEVELS);
        assert!(scale.level_of(1) < HEATMAP_LEVELS);
    }

    #[test]
    fn words_in_range_fills_gaps_with_zero() {
        let days = map(&[(d(2026, 1, 15), 1000)]);
        let out = words_in_range(&days, d(2026, 1, 13), d(2026, 1, 17));
        assert_eq!(out.len(), 5, "区间内的每一天都要有格子，没有记录补 0");
        assert_eq!(out[0].1, 0);
        assert_eq!(out[2].1, 1000);
        assert_eq!(out[4].1, 0);
    }

    #[test]
    fn words_in_range_handles_inverted_bounds() {
        let days = map(&[(d(2026, 1, 15), 1000)]);
        assert!(words_in_range(&days, d(2026, 1, 17), d(2026, 1, 13)).is_empty());
    }

    #[test]
    fn words_in_range_of_single_day() {
        let days = map(&[(d(2026, 1, 15), 42)]);
        let out = words_in_range(&days, d(2026, 1, 15), d(2026, 1, 15));
        assert_eq!(out, vec![(d(2026, 1, 15), 42)]);
    }

    #[test]
    fn year_heatmap_has_one_cell_per_day() {
        let days = map(&[(d(2026, 1, 15), 1000)]);
        let cells = year_heatmap(&days, 2026);
        assert_eq!(cells.len(), 365, "2026 年不是闰年");
        assert_eq!(cells[0].date, d(2026, 1, 1));
        assert_eq!(cells[364].date, d(2026, 12, 31));
        assert!(cells.iter().all(|c| c.in_range), "年视图没有补位格");
    }

    #[test]
    fn year_heatmap_supports_leap_years() {
        let cells = year_heatmap(&BTreeMap::new(), 2024);
        assert_eq!(cells.len(), 366, "2024 年是闰年");
        assert_eq!(cells[365].date, d(2024, 12, 31));
    }

    #[test]
    fn year_heatmap_marks_written_days() {
        let days = map(&[(d(2026, 3, 1), 5000)]);
        let cells = year_heatmap(&days, 2026);
        let cell = cells.iter().find(|c| c.date == d(2026, 3, 1)).unwrap();
        assert_eq!(cell.words, 5000);
        assert!(cell.level > 0, "有产出的格子不能是 0 档");
        let empty = cells.iter().find(|c| c.date == d(2026, 3, 2)).unwrap();
        assert_eq!(empty.level, 0);
    }

    #[test]
    fn year_heatmap_of_empty_data_is_all_zero() {
        let cells = year_heatmap(&BTreeMap::new(), 2026);
        assert!(cells.iter().all(|c| c.level == 0 && c.words == 0));
    }

    #[test]
    fn year_heatmap_serializes_with_camel_case() {
        let cells = year_heatmap(&BTreeMap::new(), 2026);
        let json = serde_json::to_string(&cells[0]).unwrap();
        assert!(json.contains("inRange"), "实际：{json}");
        assert!(json.contains("level"));
    }

    #[test]
    fn days_in_year_handles_leap_years() {
        assert_eq!(days_in_year(2026), 365);
        assert_eq!(days_in_year(2024), 366);
        assert_eq!(days_in_year(2000), 366, "能被 400 整除的是闰年");
        assert_eq!(
            days_in_year(1900),
            365,
            "能被 100 整除但不是 400 的不是闰年"
        );
    }

    #[test]
    fn weekday_index_is_monday_based() {
        // 2026-01-12 是周一，2026-01-18 是周日
        assert_eq!(weekday_index(d(2026, 1, 12)), 0);
        assert_eq!(weekday_index(d(2026, 1, 15)), 3);
        assert_eq!(weekday_index(d(2026, 1, 18)), 6);
    }

    #[test]
    fn month_calendar_grid_is_week_aligned() {
        let cal = month_calendar(&BTreeMap::new(), 2026, 1);
        assert_eq!(cal.month, "2026-01");
        assert_eq!(cal.cells.len() % 7, 0, "网格必须是整周");
        assert!(cal.cells.len() >= 28 && cal.cells.len() <= 42);
        assert_eq!(weekday_index(cal.grid_start), 0, "网格首格是周一");
        assert_eq!(weekday_index(cal.grid_end), 6, "网格末格是周日");
    }

    #[test]
    fn month_calendar_marks_in_range_days() {
        let cal = month_calendar(&BTreeMap::new(), 2026, 1);
        let in_range: Vec<_> = cal.cells.iter().filter(|c| c.in_range).collect();
        assert_eq!(in_range.len(), 31, "1 月有 31 天");
        assert_eq!(in_range[0].date, d(2026, 1, 1));
        assert_eq!(in_range[30].date, d(2026, 1, 31));
        // 补位格子必须存在（1 月 1 日是周四，前面要补 3 格）
        assert_eq!(cal.grid_start, d(2025, 12, 29));
    }

    #[test]
    fn month_calendar_of_february_leap_year() {
        let cal = month_calendar(&BTreeMap::new(), 2024, 2);
        let in_range = cal.cells.iter().filter(|c| c.in_range).count();
        assert_eq!(in_range, 29, "2024 年 2 月有 29 天");
        assert_eq!(cal.cells.len() % 7, 0);
    }

    #[test]
    fn month_calendar_totals_only_this_month() {
        // 网格覆盖到上月末与下月初，但它们不该算进本月合计
        let days = map(&[
            (d(2025, 12, 29), 999),
            (d(2026, 1, 15), 1000),
            (d(2026, 1, 31), 500),
        ]);
        let cal = month_calendar(&days, 2026, 1);
        assert_eq!(cal.total_words, 1500);

        // 但补位格子里仍然带着真实字数，供悬停提示使用
        let padding = cal
            .cells
            .iter()
            .find(|c| c.date == d(2025, 12, 29))
            .unwrap();
        assert_eq!(padding.words, 999);
        assert!(!padding.in_range);
    }

    #[test]
    fn month_calendar_scale_uses_grid_samples() {
        let days = map(&[(d(2026, 1, 5), 100), (d(2026, 1, 6), 8000)]);
        let cal = month_calendar(&days, 2026, 1);
        assert_eq!(cal.scale.max_words, 8000);
        let cell = cal.cells.iter().find(|c| c.date == d(2026, 1, 6)).unwrap();
        assert!(cell.level > 0);
    }

    #[test]
    fn month_calendar_december_does_not_leak_into_january() {
        let days = map(&[(d(2026, 1, 1), 777)]);
        let cal = month_calendar(&days, 2025, 12);
        let jan_cell = cal.cells.iter().find(|c| c.date == d(2026, 1, 1));
        if let Some(cell) = jan_cell {
            assert!(!cell.in_range, "下个月的补位格不该算作本月");
        }
        assert_eq!(cal.total_words, 0);
    }

    #[test]
    fn summarize_range_reports_totals() {
        let days = map(&[
            (d(2026, 1, 1), 100),
            (d(2026, 1, 5), 5000),
            (d(2026, 1, 9), 300),
            (d(2026, 2, 1), 9999),
        ]);
        let s = summarize_range(&days, d(2026, 1, 1), d(2026, 1, 10));
        assert_eq!(s.total_words, 5400);
        assert_eq!(s.active_days, 3);
        assert_eq!(s.total_days, 10);
        assert_eq!(s.best_day, 5000);
    }

    #[test]
    fn summarize_range_of_empty_interval() {
        let s = summarize_range(&BTreeMap::new(), d(2026, 1, 5), d(2026, 1, 1));
        assert_eq!(s.total_days, 0);
        assert_eq!(s.total_words, 0);
        assert_eq!(s.best_day, 0);
    }

    #[test]
    fn summarize_range_serializes_with_camel_case() {
        let s = summarize_range(&BTreeMap::new(), d(2026, 1, 1), d(2026, 1, 3));
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("totalWords"), "实际：{json}");
        assert!(json.contains("activeDays"));
        assert!(json.contains("bestDay"));
    }

    #[test]
    fn heatmap_payload_is_compact_enough_for_365_cells() {
        // 年热力图要做成单个 SVG 一次插入，数据本身也必须足够小。
        //
        // 实测：365 个格子、日期以 ISO 字符串形式出现时，JSON 约 21 KB。
        // 这里放宽到 32 KB —— 真正的量级上限在 M8 的 8 MB 内存预算里
        // （T8.9），这条断言的价值是「防止有人往格子里塞额外的大字段」。
        let cells = year_heatmap(&BTreeMap::new(), 2026);
        let json = serde_json::to_string(&cells).unwrap();
        assert!(json.len() < 32_768, "热力图数据过大：{} 字节", json.len());
    }

    #[test]
    fn level_scale_roundtrips_through_json() {
        let scale = build_scale(&[100, 500, 1000]);
        let json = serde_json::to_string(&scale).unwrap();
        assert!(json.contains("maxWords"), "实际：{json}");
        assert!(json.contains("activeDays"));
        let back: LevelScale = serde_json::from_str(&json).unwrap();
        assert_eq!(back, scale);
    }

    #[test]
    fn level_scale_default_is_usable() {
        let scale = LevelScale::default();
        assert_eq!(scale.thresholds.len(), usize::from(HEATMAP_LEVELS));
        assert_eq!(scale.level_of(12345), 0);
    }
}
