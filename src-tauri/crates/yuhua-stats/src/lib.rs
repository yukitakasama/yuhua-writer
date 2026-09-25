//! # yuhua-stats —— 羽化写作写作统计层
//!
//! 对应开发计划书**第 10 章**（写作统计与数据记录）与里程碑 **M8**。
//!
//! 本 crate 回答一个问题：**「我最近写了多少字？」**
//!
//! 它不碰编辑器、不碰 Tauri、不碰渲染 —— 只负责数据的记录、合并与折算。
//! 前端拿到的是可以立即塞进 SVG 的数组，而不是需要二次加工的原始数据。
//!
//! ## 模块地图
//!
//! | 模块 | 职责 | 对应任务 |
//! | --- | --- | --- |
//! | model    | 数据结构与按月分片格式 | T8.1 |
//! | merge    | 单调合并算法（本 crate 的核心） | T8.4 / T8.5 |
//! | store    | 按月分片读写，原子写，冲突副本合并 | T8.1 |
//! | collect  | 保存时的差分采集（只记正差） | T8.2 |
//! | session  | 写作会话记录（起止、时长、章节） | T8.3 |
//! | summary  | 汇总、连续天数、预计完稿日 | T8.6 / T8.10 |
//! | heatmap  | 年热力图与码字日历的数据与色阶 | T8.7 / T8.8 |
//!
//! ## 三条贯穿全层的原则
//!
//! ### 1. 只记增量，不记累计（计划书 10.3 节）
//!
//! 统计文件里存的永远是「当天新增」的字数，全书总字数由章节文件实时算出。
//! 累计值一旦落盘就会与真实内容脱节（换机、手动改 Markdown、云盘覆盖），
//! 而增量值永远是对的。
//!
//! ### 2. 只记正差，且合并取最大值（计划书 10.2 / 10.4 节）
//!
//! 作者删改旧章是常态，让删减抵扣当日产量会得出「今天写了 3000 字
//! 却显示 -2000」这种荒谬结果。因此差分只取正数。
//!
//! 只取正差还带来第二个好处：它让「同日同章的增量」成为**单调量**，
//! 于是多设备合并时可以安全地取最大值，既不会因为相加而翻倍，
//! 也不会因为取平均而抹掉产出。
//!
//! ### 3. 隐私：只记字数与时间，不记正文（计划书 10.6 节）
//!
//! **本 crate 记录的数据只有两类：字数，与时间。**
//!
//! - 章节以 **ID** 出现（ch_xxx），不是标题、不是文件名、更不是正文
//! - 会话只有起止时间与字数，没有输入内容
//! - 全 crate 没有任何字段能承载自由文本，因此即使统计文件随工作区
//!   被同步到用户的云盘，泄漏的也只是「某天写了多少字」这种元数据
//! - 不联网、不上报。数据完全在用户自己的工作区内，用户可随时删除
//!
//! 这条约束由 model 模块的 no_field_can_hold_prose 测试守住：
//! 任何人在模型里新增一个「看起来能装正文」的字段，都必须先过那条测试。
//!
//! ## 一次典型的使用流程
//!
//! text
//! // 打开工作区时建仓库
//! let store = StatsStore::at(&workspace_root);
//!
//! // 保存章节后采集差分（计划书 10.2 节的默认口径）
//! collect_delta(&store, chapter_id, before, after, now)?;
//!
//! // 统计页渲染前，把所有月份合并成按天的映射再汇总
//! let days = store.load_all_days()?;
//! let summary = summarize(&days, today);
//! let heatmap = year_heatmap(&days, 2026);

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod collect;
pub mod heatmap;
pub mod merge;
pub mod model;
pub mod session;
pub mod store;
pub mod summary;

pub use collect::{collect_batch, collect_delta, positive_delta, CollectOutcome};
pub use heatmap::{
    build_scale, days_in_year, month_calendar, summarize_range, year_heatmap, CalendarMonth,
    HeatCell, HeatSummary, LevelScale, HEATMAP_LEVELS,
};
pub use merge::{covers, merge_all, merge_day, merge_monthly};
pub use model::{
    ChapterKey, DayRecord, MonthKey, MonthlyStats, Session, DEFAULT_STREAK_THRESHOLD, STATS_SCHEMA,
};
pub use session::{sessions_on, ActiveSession, SessionTracker, IDLE_TIMEOUT_SECS};
pub use store::{parse_month_file_name, StatsStore};
pub use summary::{
    average_over_window, count_streak, estimate_completion, summarize, summarize_with, Summary,
    AVERAGE_WINDOW_DAYS,
};

#[cfg(test)]
mod integration_tests {
    use super::*;
    use chrono::{FixedOffset, NaiveDate, TimeZone};
    use std::collections::BTreeMap;

    fn ts(y: i32, m: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(y, m, d, h, mi, 0)
            .unwrap()
    }

    fn d(y: i32, m: u32, dd: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, dd).unwrap()
    }

    /// 一个确定性的伪随机数发生器。
    ///
    /// 不引 rand 依赖：属性测试只需要「同一颗种子产生同一串数」，
    /// 用个 xorshift 就够了，还能让失败用例可以精确复现。
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            // xorshift64 的三个移位量是公开的经典参数
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        fn below(&mut self, bound: u64) -> u64 {
            if bound == 0 {
                0
            } else {
                self.next() % bound
            }
        }
    }

    /// 随机造一份月度统计，用来做属性测试。
    fn random_month(rng: &mut Rng, month: u32) -> MonthlyStats {
        let key = MonthKey::new(2026, month).unwrap();
        let mut stats = MonthlyStats::new(&key);
        let day_count = 1 + rng.below(6);
        for _ in 0..day_count {
            let day = d(2026, month, 1 + rng.below(28) as u32);
            let record = stats.day_mut(day);
            let chapter_count = 1 + rng.below(3);
            for _ in 0..chapter_count {
                let id = format!("ch_{}", rng.below(4));
                let words = 1 + rng.below(3000) as u32;
                let _ = record.add_chapter_delta(&id, words);
            }
            let session_count = rng.below(3);
            for _ in 0..session_count {
                let hour = 8 + rng.below(12) as u32;
                let minute = rng.below(60) as u32;
                let words = rng.below(2000) as u32;
                let _ = record.add_chapter_delta("ch_session", 1 + words);
                record.push_session(Session::new(
                    ts(2026, month, 1, hour, minute),
                    5 + rng.below(60) as u32,
                    words,
                    &["ch_0".to_string()],
                ));
            }
        }
        stats
    }

    // ---- 属性测试：随机输入下合并仍需满足 CRDT 三条性质 ----

    #[test]
    fn property_idempotent() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for _ in 0..40 {
            let a = random_month(&mut rng, 1);
            assert_eq!(merge_monthly(&a, &a), a, "幂等性被破坏");
        }
    }

    #[test]
    fn property_commutative() {
        let mut rng = Rng(0x1234_5678_9ABC_DEF0);
        for _ in 0..40 {
            let a = random_month(&mut rng, 1);
            let b = random_month(&mut rng, 1);
            assert_eq!(merge_monthly(&a, &b), merge_monthly(&b, &a), "交换律被破坏");
        }
    }

    #[test]
    fn property_associative() {
        let mut rng = Rng(0xDEAD_BEEF_CAFE_1234);
        for _ in 0..40 {
            let a = random_month(&mut rng, 1);
            let b = random_month(&mut rng, 1);
            let c = random_month(&mut rng, 1);
            let left = merge_monthly(&merge_monthly(&a, &b), &c);
            let right = merge_monthly(&a, &merge_monthly(&b, &c));
            assert_eq!(left, right, "结合律被破坏");
        }
    }

    #[test]
    fn property_repeated_merge_is_stable() {
        // T8.5 的核心：冲突副本被反复合并，结果必须稳定
        let mut rng = Rng(0x0F0F_0F0F_1E1E_1E1E);
        for _ in 0..40 {
            let base = random_month(&mut rng, 1);
            let copy = random_month(&mut rng, 1);
            let once = merge_monthly(&base, &copy);
            let twice = merge_monthly(&once, &copy);
            let thrice = merge_monthly(&twice, &copy);
            assert_eq!(once, twice, "第二次合并改变了结果");
            assert_eq!(twice, thrice, "第三次合并改变了结果");
        }
    }

    #[test]
    fn property_shuffled_orders_converge() {
        // 乱序合并：三份数据用不同顺序折叠，结果必须一致
        let mut rng = Rng(0x5EED_5EED_5EED_5EED);
        for _ in 0..20 {
            let a = random_month(&mut rng, 1);
            let b = random_month(&mut rng, 1);
            let c = random_month(&mut rng, 1);
            let expected = merge_monthly(&merge_monthly(&a, &b), &c);
            for order in [&[&a, &c, &b], &[&c, &b, &a], &[&b, &c, &a]] {
                let mut acc = order[0].clone();
                for next in &order[1..] {
                    acc = merge_monthly(&acc, next);
                }
                assert_eq!(acc, expected, "乱序合并没有收敛");
            }
        }
    }

    #[test]
    fn property_merge_never_loses_chapters() {
        // 合并只会让数据变多：任何一个输入里的章节增量都必须在结果里保留
        let mut rng = Rng(0xABCD_1234_5678_9EF0);
        for _ in 0..30 {
            let a = random_month(&mut rng, 1);
            let b = random_month(&mut rng, 1);
            let merged = merge_monthly(&a, &b);

            for (date, record) in &a.days {
                let out = merged.day(*date).expect("合并不该丢掉整天数据");
                for (key, value) in &record.chapters {
                    assert!(out.chapters.get(key).is_some_and(|v| *v >= *value));
                }
            }
            for (date, record) in &b.days {
                let out = merged.day(*date).expect("合并不该丢掉整天数据");
                for (key, value) in &record.chapters {
                    assert!(out.chapters.get(key).is_some_and(|v| *v >= *value));
                }
            }
        }
    }

    #[test]
    fn property_single_chapter_never_doubles() {
        // 最关键的防翻倍断言：同一章同一天的两份数据合并后，
        // 结果绝不等于两者相加（除非其中一份为 0）
        let mut rng = Rng(0x7777_1111_2222_3333);
        for _ in 0..40 {
            let a = 1 + rng.below(5000) as u32;
            let b = 1 + rng.below(5000) as u32;
            let key = MonthKey::new(2026, 1).unwrap();

            let mut left = MonthlyStats::new(&key);
            left.day_mut(d(2026, 1, 15))
                .add_chapter_delta("ch_1", a)
                .unwrap();
            let mut right = MonthlyStats::new(&key);
            right
                .day_mut(d(2026, 1, 15))
                .add_chapter_delta("ch_1", b)
                .unwrap();

            let merged = merge_monthly(&left, &right);
            let words = merged.day(d(2026, 1, 15)).unwrap().words();
            assert_eq!(words, a.max(b), "取最大而不是相加");
            assert_ne!(words, a + b, "出现了翻倍计数");
        }
    }

    #[test]
    fn property_serialization_is_deterministic() {
        // 同一份内容反复序列化必须得到相同的字节（云盘与版本控制的依赖）
        let mut rng = Rng(0x2468_ACE0_1357_9BDF);
        for _ in 0..30 {
            let m = random_month(&mut rng, 1);
            let first = serde_json::to_string(&m).unwrap();
            let second = serde_json::to_string(&m).unwrap();
            assert_eq!(first, second);

            let back: MonthlyStats = serde_json::from_str(&first).unwrap();
            let third = serde_json::to_string(&back).unwrap();
            assert_eq!(first, third, "反序列化再序列化应当逐字节相同");
        }
    }

    // ---- 端到端：采集 -> 落盘 -> 读出 -> 合并 -> 汇总 ----

    #[test]
    fn end_to_end_write_read_merge_summarize() {
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());

        // 三天写作，各自有正差
        collect_delta(&store, "ch_1", 0, 1200, ts(2026, 1, 13, 9, 0)).unwrap();
        collect_delta(&store, "ch_2", 0, 800, ts(2026, 1, 14, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 1200, 2000, ts(2026, 1, 15, 9, 0)).unwrap();

        let days = store.load_all_days().unwrap();
        assert_eq!(days.len(), 3);
        assert_eq!(days[&d(2026, 1, 15)].words(), 800);

        let s = summarize(&days, d(2026, 1, 15));
        assert_eq!(s.total_words, 2800);
        assert_eq!(s.today, 800);
        assert_eq!(s.active_days, 3);
        assert_eq!(s.streak, 3, "连续三天都写了");
        assert_eq!(s.best_day, 1200);
        // 近 7 日平均 =(1200 + 800 + 800) / 7 = 400
        assert_eq!(s.average_per_day_7, 400);
    }

    #[test]
    fn end_to_end_session_flow() {
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        let mut tracker = SessionTracker::new();

        tracker.begin(ts(2026, 1, 15, 9, 12));
        tracker.add_words("ch_1", 1520, ts(2026, 1, 15, 9, 59));
        let record = tracker.finish_and_store(&store).unwrap().unwrap();
        assert_eq!(record.minutes, 47);

        let sessions = sessions_on(&store, d(2026, 1, 15)).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].words, 1520);

        let days = store.load_all_days().unwrap();
        let s = summarize(&days, d(2026, 1, 15));
        assert_eq!(s.total_minutes, 47);
    }

    #[test]
    fn end_to_end_conflict_copy_merges_without_double_counting() {
        // 场景：两台设备在同一天各写一部分，云盘产生冲突副本
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());

        // 设备 A 的产出
        collect_delta(&store, "ch_1", 0, 2000, ts(2026, 1, 15, 9, 0)).unwrap();

        // 设备 B 的产出：改的是同一章的一部分，外加一章新的
        let month = MonthKey::new(2026, 1).unwrap();
        let mut original = store.load(&month).unwrap();
        original
            .day_mut(d(2026, 1, 15))
            .add_chapter_delta("ch_1", 1500)
            .unwrap();
        original
            .day_mut(d(2026, 1, 15))
            .add_chapter_delta("ch_2", 600)
            .unwrap();
        std::fs::write(
            store.dir().join("daily-2026-01 (冲突副本 2026-01-16).json"),
            serde_json::to_string(&original).unwrap(),
        )
        .unwrap();

        let merged = store.load_merged(&month).unwrap();
        let words = merged.day(d(2026, 1, 15)).unwrap().words();
        assert_eq!(words, 2000 + 600, "ch_1 取 2000（不翻倍），ch_2 累加");
        assert_ne!(words, 2000 + 1500 + 600, "出现了翻倍计数");
    }

    #[test]
    fn end_to_end_heatmap_and_calendar_agree_on_totals() {
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        collect_delta(&store, "ch_1", 0, 1500, ts(2026, 1, 6, 9, 0)).unwrap();
        collect_delta(&store, "ch_2", 0, 2500, ts(2026, 1, 20, 9, 0)).unwrap();

        let days = store.load_all_days().unwrap();
        let cal = month_calendar(&days, 2026, 1);
        let heat = year_heatmap(&days, 2026);
        let year_total: u32 = heat.iter().map(|c| c.words).sum();

        assert_eq!(cal.total_words, 4000);
        assert_eq!(
            u64::from(year_total),
            cal.total_words,
            "两个视图的数字必须一致"
        );
        assert_eq!(heat.len(), 365);
    }

    #[test]
    fn end_to_end_stats_never_store_prose() {
        // 隐私要求的端到端验证：走完整流程后，磁盘上的文件里
        // 只有 ID、日期与数字，没有任何正文
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        collect_delta(&store, "ch_01J8XK2M9P", 0, 1520, ts(2026, 1, 15, 9, 0)).unwrap();

        let mut tracker = SessionTracker::new();
        tracker.begin(ts(2026, 1, 15, 9, 0));
        tracker.add_words("ch_01J8XK2M9P", 1520, ts(2026, 1, 15, 9, 47));
        tracker.finish_and_store(&store).unwrap();

        let raw =
            std::fs::read_to_string(store.path_for(&MonthKey::new(2026, 1).unwrap())).unwrap();
        for forbidden in ["body", "content", "excerpt", "正文"] {
            assert!(
                !raw.contains(forbidden),
                "统计文件里出现了 {forbidden}：{raw}"
            );
        }
        assert!(
            raw.contains("ch_01J8XK2M9P"),
            "章节 ID 应当在，用于分章统计"
        );
    }

    #[test]
    fn end_to_end_summary_of_an_empty_workspace() {
        // 全新工作区：所有数字为 0，且不能 panic、不能除零
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        let days: BTreeMap<NaiveDate, DayRecord> = store.load_all_days().unwrap();
        let s = summarize_with(
            &days,
            d(2026, 1, 15),
            DEFAULT_STREAK_THRESHOLD,
            Some(100_000),
        );

        assert_eq!(s.total_words, 0);
        assert_eq!(s.average_per_day_7, 0);
        assert_eq!(s.estimated_completion, None, "没有速度数据时不猜完稿日");
        assert_eq!(s.streak, 0);
    }

    #[test]
    fn end_to_end_month_boundary_keeps_two_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        collect_delta(&store, "ch_1", 0, 1000, ts(2026, 1, 31, 23, 0)).unwrap();
        collect_delta(&store, "ch_1", 1000, 3000, ts(2026, 2, 1, 1, 0)).unwrap();

        let months = store.months().unwrap();
        assert_eq!(months.len(), 2, "跨月应当产生两个分片");
        assert_eq!(months[0], MonthKey::new(2026, 1).unwrap());

        let days = store.load_all_days().unwrap();
        assert_eq!(days[&d(2026, 1, 31)].words(), 1000);
        assert_eq!(days[&d(2026, 2, 1)].words(), 2000);
    }

    #[test]
    fn end_to_end_linear_writing_is_counted_exactly_once() {
        // 一次不间断的写作（基线随当日已记推进）必须精确记 2000 字，
        // 既不少算也不翻倍
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        collect_delta(&store, "ch_1", 0, 800, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 800, 1400, ts(2026, 1, 15, 9, 30)).unwrap();
        collect_delta(&store, "ch_1", 1400, 2000, ts(2026, 1, 15, 10, 0)).unwrap();

        let days = store.load_all_days().unwrap();
        assert_eq!(days[&d(2026, 1, 15)].words(), 2000);
    }

    #[test]
    fn end_to_end_multiple_sessions_sum_to_total_minutes() {
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        let mut tracker = SessionTracker::new();

        tracker.begin(ts(2026, 1, 15, 9, 0));
        tracker.add_words("ch_1", 500, ts(2026, 1, 15, 9, 30));
        tracker.finish_and_store(&store).unwrap();

        tracker.begin(ts(2026, 1, 15, 20, 0));
        tracker.add_words("ch_1", 300, ts(2026, 1, 15, 20, 45));
        tracker.finish_and_store(&store).unwrap();

        let days = store.load_all_days().unwrap();
        let s = summarize(&days, d(2026, 1, 15));
        assert_eq!(s.total_minutes, 30 + 45);
        assert_eq!(days[&d(2026, 1, 15)].sessions.len(), 2);
    }
}
