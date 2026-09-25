//! 汇总计算（任务 T8.6，计划书 10.1 节的「汇总统计」与「连续天数」）。
//!
//! 本模块把按天的增量数据折算成用户真正关心的数字：
//! 总字数、本月、本周、今日、平均日更、最高单日、累计写作时长、
//! 预计完稿日、连续天数。
//!
//! ## 三条容易算错的地方
//!
//! 1. **平均日更的分母**：计划书要求「近 7 日平均日更」用于预计完稿。
//!    分母必须是 7（自然日），**不是「有写字的天数」**。
//!    否则「一周写了 7000 字但只写了 1 天」会算出日更 7000，
//!    预计完稿日直接变成明天，毫无参考价值。
//! 2. **除零**：平均日更为 0（新用户、或近一周没写）时，
//!    预计完稿日必须返回 None，而不是无穷大或 1970 年。
//! 3. **连续天数与今天**：今天还没写字**不应该**把昨天断掉。
//!    具体规则见 count_streak 的文档。
//!
//! ## 只读，不改数据
//!
//! 本模块所有函数都是只读的：它们从「日期到单日记录」的映射出发计算，
//! 不写盘、不改动输入。这样 UI 可以任意频率地重算，没有副作用。

use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::model::{DEFAULT_STREAK_THRESHOLD, DayRecord};

/// 近 7 日平均日更所用的窗口长度（天）。
pub const AVERAGE_WINDOW_DAYS: i64 = 7;

/// 汇总统计结果。
///
/// 字段全部用 u64：单日产量可能被多设备合并放大（保守估计仍有界），
/// 而累计时长在长期使用后会超过 u32 的分钟上限（约 8000 年？不，
/// u32 分钟约为 8170 年，但累加乘法中间值容易溢出，故统一放宽）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// 全部历史累计的字数。
    pub total_words: u64,
    /// 本月字数。
    pub this_month: u64,
    /// 本周字数（周一为一周之始）。
    pub this_week: u64,
    /// 今日字数。
    pub today: u64,
    /// 有记录的天数（不要求达到阈值）。
    pub active_days: u64,
    /// 平均日更（总字数除以有记录的天数，向下取整）。
    pub average_per_active_day: u64,
    /// 近 7 个自然日的平均日更（含今天，无记录的日子算 0）。
    pub average_per_day_7: u64,
    /// 最高单日字数。
    pub best_day: u64,
    /// 最高单日是哪一天（没有任何记录时为 None）。
    pub best_day_date: Option<NaiveDate>,
    /// 累计写作时长（分钟）。
    pub total_minutes: u64,
    /// 连续码字天数（阈值见 streak_threshold）。
    pub streak: u32,
    /// 计算连续天数时使用的阈值。
    pub streak_threshold: u32,
    /// 预计完稿日；无法估算时为 None。
    pub estimated_completion: Option<NaiveDate>,
    /// 预计还需多少天（无法估算时为 None）。
    pub remaining_days: Option<u64>,
}

/// 从「日期到单日记录」的映射计算汇总。
///
/// `today` 由调用方传入而不是取系统当前时间：
/// 测试需要可复现，命令层也需要在跨零点时明确指定「算哪一天」。
pub fn summarize(days: &BTreeMap<NaiveDate, DayRecord>, today: NaiveDate) -> Summary {
    summarize_with(days, today, DEFAULT_STREAK_THRESHOLD, None)
}

/// 完整版汇总计算。
///
/// 参数：
///
/// - threshold：连续天数的达标阈值（默认 100 字）
/// - total_target：全书目标字数，用于预计完稿日；None 表示不估算
pub fn summarize_with(
    days: &BTreeMap<NaiveDate, DayRecord>,
    today: NaiveDate,
    threshold: u32,
    total_target: Option<u64>,
) -> Summary {
    let mut total_words = 0u64;
    let mut total_minutes = 0u64;
    let mut active_days = 0u64;
    let mut best_day = 0u64;
    let mut best_day_date = None;
    let mut this_month = 0u64;
    let mut this_week = 0u64;

    for (date, record) in days {
        let words = u64::from(record.words());
        total_words += words;
        total_minutes += u64::from(record.minutes());
        if words > 0 {
            active_days += 1;
        }
        // 最高单日用严格大于：并列时保留更早的那天，
        // 这样反复重算不会让日期在并列的日子里跳来跳去
        if words > best_day {
            best_day = words;
            best_day_date = Some(*date);
        }
        if same_month(*date, today) {
            this_month += words;
        }
        if in_week_of(*date, today) {
            this_week += words;
        }
    }

    let today_words = days.get(&today).map_or(0, |d| u64::from(d.words()));

    // 平均日更：分母是「有记录的天数」。没有任何记录时为 0，不除零。
    let average_per_active_day = total_words.checked_div(active_days).unwrap_or(0);

    let average_per_day_7 = average_over_window(days, today, AVERAGE_WINDOW_DAYS);
    let streak = count_streak(days, today, threshold);
    let (estimated_completion, remaining_days) =
        estimate_completion(total_words, total_target, average_per_day_7, today);

    Summary {
        total_words,
        this_month,
        this_week,
        today: today_words,
        active_days,
        average_per_active_day,
        average_per_day_7,
        best_day,
        best_day_date,
        total_minutes,
        streak,
        streak_threshold: threshold,
        estimated_completion,
        remaining_days,
    }
}

/// 判断两个日期是否同一个月。
fn same_month(a: NaiveDate, b: NaiveDate) -> bool {
    a.year() == b.year() && a.month() == b.month()
}

/// 判断某个日期是否落在「以 today 所在周的周一为起点」的那一周内。
///
/// 以周一起算而不是周日：中文语境下「本周」默认从周一开始，
/// 且计划书 10.1 节把周目标与日目标并列，周目标自然也是周一起算。
pub fn in_week_of(date: NaiveDate, today: NaiveDate) -> bool {
    let start = week_start(today);
    let end = start + Duration::days(7);
    date >= start && date < end
}

/// 取某个日期所在周的周一。
pub fn week_start(date: NaiveDate) -> NaiveDate {
    // num_days_from_monday 是 chrono 提供的方法，周一为 0
    date - Duration::days(i64::from(date.weekday().num_days_from_monday()))
}

/// 计算「以 end 为最后一天、往前 len 个自然日」的平均日更。
///
/// **分母恒为 len**（自然日数），不是「有写字的天数」。
/// 这是 10.1 节「平均日更」与用户直觉一致的关键：
/// 一周里只写了一天，那平均日更就是那天的字数除以 7。
pub fn average_over_window(
    days: &BTreeMap<NaiveDate, DayRecord>,
    end: NaiveDate,
    len: i64,
) -> u64 {
    if len <= 0 {
        return 0;
    }
    let start = end - Duration::days(len - 1);
    let mut sum = 0u64;
    for (date, record) in days.range(start..=end) {
        let _ = date;
        sum += u64::from(record.words());
    }
    sum / (len as u64)
}

/// 计算连续码字天数。
///
/// ## 规则
///
/// 1. 只有当日字数达到 `threshold` 才算「写了」（默认 100 字，
///    避免改一个错别字就刷出连续 365 天）
/// 2. **今天还没写不算断**：从今天开始往前回溯，若今天不达标则从昨天
///    开始数。否则用户每天早上打开软件都会看到「连续天数：0」，
///    这会让人以为记录被清空了
/// 3. **昨天也没写才算断**：回溯到今天与昨天都不达标时立即停止
pub fn count_streak(
    days: &BTreeMap<NaiveDate, DayRecord>,
    today: NaiveDate,
    threshold: u32,
) -> u32 {
    let reached = |date: NaiveDate| {
        days.get(&date)
            .map(|d| d.reached(threshold))
            .unwrap_or(false)
    };

    // 今天达标就从今天数；今天还没写就从昨天数（规则 2）
    let mut cursor = if reached(today) {
        today
    } else {
        today - Duration::days(1)
    };

    let mut streak = 0u32;
    while reached(cursor) {
        streak += 1;
        // 用 checked_sub 而不是直接减：日期到 1970 年之前会得到空值，
        // 此时循环自然结束，不会 panic
        match cursor.pred_opt() {
            Some(prev) => cursor = prev,
            None => break,
        }
    }
    streak
}

/// 预计完稿日。
///
/// 算法（计划书 10.1 节的「预计完稿日」，主体是剩余字数除以近 7 日平均日更）：
///
/// ```text
/// 剩余字数 = 目标字数 - 已写字数
/// 剩余天数 = 剩余字数 / 近 7 日平均日更（向上取整）
/// 完稿日   = 今天 + 剩余天数
/// ```
///
/// 返回 `(完稿日, 剩余天数)`，无法估算时两者皆为 None。**三种 None 的情形**：
///
/// 1. 没设目标字数（调用方传 None）
/// 2. 已经写到或超过目标（剩余为 0，没有「何时完成」可言）
/// 3. **近 7 日平均日更为 0** —— 这里必须返回 None 而不是除零，
///    否则会得到无穷大或 panic。UI 上应显示「暂无数据，写几天就好」
pub fn estimate_completion(
    total_words: u64,
    total_target: Option<u64>,
    average_per_day_7: u64,
    today: NaiveDate,
) -> (Option<NaiveDate>, Option<u64>) {
    let Some(target) = total_target else {
        return (None, None);
    };
    let remaining = target.saturating_sub(total_words);
    if remaining == 0 {
        return (None, Some(0));
    }
    if average_per_day_7 == 0 {
        // 没有可用的速度估计：不猜，也不用无穷大冒充一个日期
        return (None, None);
    }

    // 向上取整：还剩 1 个字也要算一天
    let days = remaining.div_ceil(average_per_day_7);

    // 天数过大时（例如目标一亿字、日更 1 字）日期会溢出 chrono 的范围，
    // 此时宁可返回 None 也不要给出一个荒谬的年份
    let offset = i64::try_from(days).ok().and_then(|d| Duration::try_days(d));
    let Some(offset) = offset else {
        return (None, Some(days));
    };
    match today.checked_add_signed(offset) {
        Some(date) => (Some(date), Some(days)),
        None => (None, Some(days)),
    }
}

/// 把累计分钟数折成「X 小时 Y 分钟」的可读文本。
///
/// 纯展示用途，因此放在领域层而不是前端：
/// 命令层返回数字给前端做本地化，这里提供的是给日志与 CLI 用的形式。
pub fn format_minutes(total: u64) -> String {
    let hours = total / 60;
    let minutes = total % 60;
    if hours == 0 {
        format!("{minutes} 分钟")
    } else if minutes == 0 {
        format!("{hours} 小时")
    } else {
        format!("{hours} 小时 {minutes} 分钟")
    }
}

/// 达成率（0.0 起，可超过 1.0）；分母为 0 时返回 None。
pub fn ratio(done: u64, target: u64) -> Option<f64> {
    if target == 0 {
        None
    } else {
        Some(done as f64 / target as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::tests::day;

    /// 由 (日期, 字数) 列表构造映射。
    fn days(list: &[(NaiveDate, u32)]) -> BTreeMap<NaiveDate, DayRecord> {
        let mut map = BTreeMap::new();
        for (date, words) in list {
            let mut record = DayRecord::default();
            record.add_chapter_delta("ch_1", *words).unwrap();
            map.insert(*date, record);
        }
        map
    }

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate {
        day(y, m, dd)
    }

    #[test]
    fn empty_days_produce_zero_summary() {
        let s = summarize(&BTreeMap::new(), d(2026, 1, 15));
        assert_eq!(s.total_words, 0);
        assert_eq!(s.active_days, 0);
        assert_eq!(s.average_per_active_day, 0, "不能除零");
        assert_eq!(s.average_per_day_7, 0);
        assert_eq!(s.best_day, 0);
        assert_eq!(s.best_day_date, None);
        assert_eq!(s.total_minutes, 0);
        assert_eq!(s.streak, 0);
        assert_eq!(s.estimated_completion, None);
    }

    #[test]
    fn totals_sum_every_day() {
        let map = days(&[
            (d(2026, 1, 10), 1000),
            (d(2026, 1, 11), 2000),
            (d(2026, 1, 12), 500),
        ]);
        let s = summarize(&map, d(2026, 1, 12));
        assert_eq!(s.total_words, 3500);
        assert_eq!(s.active_days, 3);
        assert_eq!(s.average_per_active_day, 3500 / 3);
    }

    #[test]
    fn this_month_and_this_week_are_scoped() {
        // 2026-01-15 是周四；本周为 01-12（周一）到 01-18
        let map = days(&[
            (d(2026, 1, 1), 100),
            (d(2026, 1, 12), 200),
            (d(2026, 1, 15), 300),
            (d(2026, 1, 18), 400),
            (d(2026, 1, 19), 999),
            (d(2025, 12, 20), 777),
        ]);
        let s = summarize(&map, d(2026, 1, 15));
        assert_eq!(s.this_month, 100 + 200 + 300 + 400 + 999);
        assert_eq!(s.this_week, 200 + 300 + 400, "本周含周一与周日，不含下周一");
        assert_eq!(s.today, 300);
    }

    #[test]
    fn week_starts_on_monday() {
        // 2026-01-15 是周四，本周起点是 01-12
        assert_eq!(week_start(d(2026, 1, 15)), d(2026, 1, 12));
        assert_eq!(week_start(d(2026, 1, 12)), d(2026, 1, 12), "周一自己就是起点");
        assert_eq!(week_start(d(2026, 1, 18)), d(2026, 1, 12), "周日仍属本周");
        assert_eq!(week_start(d(2026, 1, 19)), d(2026, 1, 19), "下周一开新的一周");
    }

    #[test]
    fn in_week_of_is_a_half_open_range() {
        assert!(in_week_of(d(2026, 1, 12), d(2026, 1, 15)));
        assert!(in_week_of(d(2026, 1, 18), d(2026, 1, 15)));
        assert!(!in_week_of(d(2026, 1, 11), d(2026, 1, 15)));
        assert!(!in_week_of(d(2026, 1, 19), d(2026, 1, 15)));
    }

    #[test]
    fn best_day_picks_the_maximum() {
        let map = days(&[(d(2026, 1, 10), 800), (d(2026, 1, 11), 3000), (d(2026, 1, 12), 1200)]);
        let s = summarize(&map, d(2026, 1, 12));
        assert_eq!(s.best_day, 3000);
        assert_eq!(s.best_day_date, Some(d(2026, 1, 11)));
    }

    #[test]
    fn best_day_ties_keep_the_earliest_date() {
        // 并列时保留更早的那天，反复重算不会让日期跳来跳去
        let map = days(&[(d(2026, 1, 10), 1000), (d(2026, 1, 11), 1000)]);
        let s = summarize(&map, d(2026, 1, 11));
        assert_eq!(s.best_day_date, Some(d(2026, 1, 10)));
    }

    #[test]
    fn average_over_window_divides_by_calendar_days() {
        // 一周里只写了一天 7000 字，平均日更是 1000 而不是 7000
        let map = days(&[(d(2026, 1, 15), 7000)]);
        assert_eq!(average_over_window(&map, d(2026, 1, 15), 7), 1000);
    }

    #[test]
    fn average_over_window_ignores_days_outside_the_range() {
        let map = days(&[(d(2026, 1, 1), 9999), (d(2026, 1, 15), 700)]);
        assert_eq!(average_over_window(&map, d(2026, 1, 15), 7), 100);
    }

    #[test]
    fn average_over_window_with_zero_length_is_zero() {
        let map = days(&[(d(2026, 1, 15), 7000)]);
        assert_eq!(average_over_window(&map, d(2026, 1, 15), 0), 0, "不能除零");
        assert_eq!(average_over_window(&map, d(2026, 1, 15), -3), 0);
    }

    #[test]
    fn average_over_window_of_single_day() {
        let map = days(&[(d(2026, 1, 15), 700)]);
        assert_eq!(average_over_window(&map, d(2026, 1, 15), 1), 700);
    }

    #[test]
    fn summary_seven_day_average_uses_today_as_anchor() {
        // 今天没写、昨天写了 7000：近 7 日窗口仍覆盖昨天
        let map = days(&[(d(2026, 1, 14), 7000)]);
        let s = summarize(&map, d(2026, 1, 15));
        assert_eq!(s.average_per_day_7, 1000);
    }

    // ---- 连续天数（T8.10）----

    #[test]
    fn streak_counts_consecutive_days() {
        let map = days(&[
            (d(2026, 1, 11), 500),
            (d(2026, 1, 12), 500),
            (d(2026, 1, 13), 500),
            (d(2026, 1, 14), 500),
            (d(2026, 1, 15), 500),
        ]);
        assert_eq!(count_streak(&map, d(2026, 1, 15), 100), 5);
    }

    #[test]
    fn streak_survives_a_day_that_is_not_written_yet() {
        // 关键行为：今天还没写字，不该把昨天开始的连续记录断掉
        let map = days(&[(d(2026, 1, 13), 500), (d(2026, 1, 14), 500)]);
        assert_eq!(
            count_streak(&map, d(2026, 1, 15), 100),
            2,
            "今天还没写，连续天数应从昨天继续数"
        );
    }

    #[test]
    fn streak_breaks_when_yesterday_was_also_missed() {
        let map = days(&[(d(2026, 1, 12), 500), (d(2026, 1, 13), 500)]);
        assert_eq!(
            count_streak(&map, d(2026, 1, 15), 100),
            0,
            "昨天与今天都没写，连续记录已断"
        );
    }

    #[test]
    fn streak_today_only_is_one() {
        let map = days(&[(d(2026, 1, 15), 500)]);
        assert_eq!(count_streak(&map, d(2026, 1, 15), 100), 1);
    }

    #[test]
    fn streak_stops_at_the_first_gap() {
        let map = days(&[
            (d(2026, 1, 9), 500),
            (d(2026, 1, 12), 500),
            (d(2026, 1, 13), 500),
            (d(2026, 1, 14), 500),
            (d(2026, 1, 15), 500),
        ]);
        assert_eq!(count_streak(&map, d(2026, 1, 15), 100), 4, "1 月 10、11 日断了");
    }

    #[test]
    fn streak_respects_threshold() {
        // 只改了错别字（50 字）不算一天，否则连续天数没有意义
        let map = days(&[(d(2026, 1, 14), 500), (d(2026, 1, 15), 50)]);
        assert_eq!(count_streak(&map, d(2026, 1, 15), 100), 1);
        assert_eq!(
            count_streak(&map, d(2026, 1, 15), 10),
            2,
            "阈值调到 10 时两天都达标"
        );
    }

    #[test]
    fn streak_threshold_boundary_is_inclusive() {
        let map = days(&[(d(2026, 1, 15), 100)]);
        assert_eq!(count_streak(&map, d(2026, 1, 15), 100), 1, "恰好等于阈值算达标");
        let map = days(&[(d(2026, 1, 15), 99)]);
        assert_eq!(count_streak(&map, d(2026, 1, 15), 100), 0);
    }

    #[test]
    fn streak_is_zero_on_empty_data() {
        assert_eq!(count_streak(&BTreeMap::new(), d(2026, 1, 15), 100), 0);
    }

    #[test]
    fn streak_ignores_future_days() {
        // 时间被调错、或数据里有未来日期时，不该把它们算进连续天数
        let map = days(&[(d(2026, 1, 16), 500), (d(2026, 1, 15), 500)]);
        assert_eq!(count_streak(&map, d(2026, 1, 15), 100), 1);
    }

    #[test]
    fn streak_uses_configured_threshold_in_summary() {
        let map = days(&[(d(2026, 1, 15), 60)]);
        let s = summarize_with(&map, d(2026, 1, 15), 50, None);
        assert_eq!(s.streak, 1);
        assert_eq!(s.streak_threshold, 50);
    }

    // ---- 预计完稿日（T8.6）----

    #[test]
    fn estimate_returns_none_without_target() {
        let (date, days_left) = estimate_completion(10_000, None, 1000, d(2026, 1, 15));
        assert_eq!(date, None);
        assert_eq!(days_left, None, "没设目标就不能猜完稿日");
    }

    #[test]
    fn estimate_returns_none_when_average_is_zero() {
        // 关键：不能除零
        let (date, days_left) = estimate_completion(0, Some(100_000), 0, d(2026, 1, 15));
        assert_eq!(date, None, "平均日更为 0 时必须返回 None");
        assert_eq!(days_left, None);
    }

    #[test]
    fn estimate_returns_none_when_target_already_reached() {
        let (date, days_left) = estimate_completion(100_000, Some(100_000), 2000, d(2026, 1, 15));
        assert_eq!(date, None, "已经达标，没有「何时完成」可言");
        assert_eq!(days_left, Some(0));

        // 超额完成同样如此
        let (date, _) = estimate_completion(200_000, Some(100_000), 2000, d(2026, 1, 15));
        assert_eq!(date, None);
    }

    #[test]
    fn estimate_computes_remaining_days() {
        // 还剩 80000 字，日更 2000，需要 40 天
        let (date, days_left) = estimate_completion(20_000, Some(100_000), 2000, d(2026, 1, 15));
        assert_eq!(days_left, Some(40));
        assert_eq!(date, Some(d(2026, 2, 24)), "1 月 15 日加 40 天是 2 月 24 日");
    }

    #[test]
    fn estimate_rounds_remaining_days_up() {
        // 还剩 3 字，日更 2：需要 2 天
        let (_, days_left) = estimate_completion(97, Some(100), 2, d(2026, 1, 15));
        assert_eq!(days_left, Some(2));
        // 恰好整除时不多算一天
        let (_, days_left) = estimate_completion(96, Some(100), 2, d(2026, 1, 15));
        assert_eq!(days_left, Some(2));
        let (_, days_left) = estimate_completion(98, Some(100), 2, d(2026, 1, 15));
        assert_eq!(days_left, Some(1));
    }

    #[test]
    fn estimate_crosses_month_and_year_boundaries() {
        // 3100 字、日更 100：需要 31 天，2026-12-25 加 31 天是 2027-01-25
        let (date, days_left) = estimate_completion(0, Some(3100), 100, d(2026, 12, 25));
        assert_eq!(days_left, Some(31));
        assert_eq!(date, Some(d(2027, 1, 25)), "跨年也要算对");
    }

    #[test]
    fn estimate_refuses_absurd_horizons() {
        // 日更 1 字、目标一亿字：天数超出 i64 天能表示的日期范围时应返回 None
        let (date, days_left) = estimate_completion(0, Some(100_000_000), 1, d(2026, 1, 15));
        assert_eq!(days_left, Some(100_000_000));
        assert_eq!(date, None, "荒谬的年份宁可返回 None");
    }

    #[test]
    fn summary_includes_estimate_only_with_target() {
        let map = days(&[(d(2026, 1, 15), 2000)]);
        let no_target = summarize_with(&map, d(2026, 1, 15), 100, None);
        assert_eq!(no_target.estimated_completion, None);
        assert_eq!(no_target.remaining_days, None);

        let with_target = summarize_with(&map, d(2026, 1, 15), 100, Some(102_000));
        // 近 7 日平均 = 2000 / 7 = 285；剩余 100000 / 285 = 351 天
        assert_eq!(with_target.average_per_day_7, 285);
        assert_eq!(with_target.remaining_days, Some(351));
        assert!(with_target.estimated_completion.is_some());
    }

    #[test]
    fn summary_total_minutes_adds_sessions() {
        use crate::model::tests::ts;
        use crate::model::Session;
        let mut map: BTreeMap<NaiveDate, DayRecord> = BTreeMap::new();
        let mut record = DayRecord::default();
        record.add_chapter_delta("ch_1", 500).unwrap();
        record.push_session(Session::new(ts(2026, 1, 15, 9, 0), 47, 500, &[]));
        record.push_session(Session::new(ts(2026, 1, 15, 21, 0), 30, 0, &[]));
        map.insert(d(2026, 1, 15), record);

        let s = summarize(&map, d(2026, 1, 15));
        assert_eq!(s.total_minutes, 77);
    }

    #[test]
    fn summary_serializes_to_camel_case() {
        let s = summarize(&BTreeMap::new(), d(2026, 1, 15));
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("totalWords"), "实际：{json}");
        assert!(json.contains("estimatedCompletion"));
        assert!(json.contains("streakThreshold"));
        assert!(json.contains("averagePerDay7"));
    }

    #[test]
    fn format_minutes_reads_naturally() {
        assert_eq!(format_minutes(0), "0 分钟");
        assert_eq!(format_minutes(45), "45 分钟");
        assert_eq!(format_minutes(60), "1 小时");
        assert_eq!(format_minutes(121), "2 小时 1 分钟");
    }

    #[test]
    fn ratio_handles_zero_target() {
        assert_eq!(ratio(50, 0), None, "不能除零");
        assert_eq!(ratio(50, 100), Some(0.5));
        assert_eq!(ratio(200, 100), Some(2.0));
    }

}
