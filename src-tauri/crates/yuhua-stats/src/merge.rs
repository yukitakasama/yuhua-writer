//! 单调合并算法 —— 本 crate 的核心（任务 T8.4 / T8.5，计划书 10.4 节）。
//!
//! ## 为什么需要它
//!
//! 统计文件躺在工作区里，而工作区是会被云盘同步的（计划书 4.5 节）。
//! 于是必然出现这种情况：设备 A 写到 21:00，设备 B 写到 21:05，
//! 云盘把两边都上传，最后落盘的是 B 的版本 —— **A 那 2000 字凭空消失**。
//! 云盘只提供「最后写入者胜」的文件级语义，它不懂统计的含义。
//!
//! 我们的对策不是去跟云盘打架，而是让**合并本身变得无害**：
//! 设计一个运算 merge，使得
//!
//! text
//! 幂等性  merge(x, x) = x
//! 交换律  merge(x, y) = merge(y, x)
//! 结合律  merge(merge(x, y), z) = merge(x, merge(y, z))
//!
//! 三者合起来意味着：**无论冲突副本以什么顺序、被合并几次，
//! 最终结果都相同**。这正是「收敛复制数据类型」（CRDT）的定义，
//! 也是我们能在没有服务器的前提下谈数据安全的基础。
//!
//! 由结合律与幂等性可推出重复合并无害（T8.5 要求的「重复合并」场景）：
//!
//! text
//! merge(merge(x, y), y) = merge(x, merge(y, y)) = merge(x, y)
//!
//! ## 合并规则（计划书 10.4 节原表）
//!
//! | 数据 | 规则 | 为什么 |
//! | --- | --- | --- |
//! | chapters[c] | 取最大值 | 同章同日的增量是单调量，取 max 防止两设备相加翻倍 |
//! | sessions | 按 start 去重后并集 | 会话天然带唯一时间戳 |
//! | goal | 时间戳新者胜 | 目标是用户显式设置，不是累加量 |
//!
//! ## 冲突副本的来源（包括非云盘场景）
//!
//! 实践中同一份统计会出现多个版本：
//!
//! - OneDrive：daily-2026-01 (计算机的冲突副本 2026-01-15).json
//! - 坚果云：daily-2026-01 (冲突副本 2026-01-15).json
//! - Dropbox：daily-2026-01 (Conflicted copy 2026-01-15).json
//! - Syncthing：daily-2026-01.sync-conflict-20260115-120000-ABCDEF.json
//! - 用户手工：把文件复制一份叫 daily-2026-01 - 副本.json
//!
//! 这些文件的**内容都是合法的 MonthlyStats**，只是文件名不同。
//! 所以本模块只认内容、不认文件名：上层把所有候选文件读出来交给
//! merge_all，合并结果就是数据的并集。

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, FixedOffset, NaiveDate};

use crate::model::{DayRecord, MonthKey, MonthlyStats, Session};

/// 合并一天的两份记录。
///
/// 逐字段应用 10.4 节的规则。**本函数不触碰 self，永远返回新值**：
/// 合并结果有时是 other 中的对象，若就地修改会污染调用方持有的数据，
/// 而调用方（例如扫描目录的流程）后面还要用原始数据做别的事。
pub fn merge_day(left: &DayRecord, right: &DayRecord) -> DayRecord {
    // 章节增量：逐键取最大值。
    //
    // 必须两边都遍历：某个键可能只在一边出现（另一台设备新增的章节），
    // 只遍历 left 会漏掉 right 独有的章节，这是最容易写错的地方。
    let mut chapters: BTreeMap<_, _> = left.chapters.clone();
    for (key, value) in &right.chapters {
        let entry = chapters.entry(key.clone()).or_insert(0);
        *entry = (*entry).max(*value);
    }

    // 会话：按身份（开始时间的毫秒戳）去重后并集。
    //
    // 用 BTreeMap 而不是先收集再去重：BTreeMap 顺带完成了排序，
    // 而排序是「序列化确定性」的要求 —— 顺序不同的两份文件必须合并出
    // 字节相同的第三份，否则云盘会一直制造新的冲突副本。
    let mut by_identity: BTreeMap<i64, Session> = BTreeMap::new();
    for session in left.sessions.iter().chain(right.sessions.iter()) {
        by_identity
            .entry(session.identity())
            .and_modify(|existing| *existing = existing.merge_with(session))
            .or_insert_with(|| session.clone());
    }

    // 峰值基线：与章节增量同理逐键取最大值。
    //
    // 峰值是**单调量**（只升不降），因此两台设备各写一部分时取 max
    // 恰好等于「两台设备里写过的最长版本」，既不会互相覆盖，
    // 也不会因此重复记账。
    let mut peaks: BTreeMap<_, _> = left.peaks.clone();
    for (key, value) in &right.peaks {
        let entry = peaks.entry(key.clone()).or_insert(0);
        *entry = (*entry).max(*value);
    }

    let (goal, goal_updated_at) = merge_goal(left, right);

    DayRecord {
        chapters,
        peaks,
        sessions: by_identity.into_values().collect(),
        goal,
        goal_updated_at,
    }
}

/// 合并两天的目标设置，返回（目标值，最后修改时间）。
///
/// 实现「最后修改者胜」（LWW），并在时间戳打平时用取值兜底，
/// 保证同一对输入无论顺序如何都收敛到同一个结果（交换律）。
fn merge_goal(
    left: &DayRecord,
    right: &DayRecord,
) -> (Option<u32>, Option<DateTime<FixedOffset>>) {
    match (left.goal_updated_at, right.goal_updated_at) {
        (None, None) => (left.goal.or(right.goal), None),
        // 只有一边有戳：有戳的那边是「知道自己在改」，优先
        (Some(t), None) => (left.goal, Some(t)),
        (None, Some(t)) => (right.goal, Some(t)),
        (Some(lt), Some(rt)) => {
            if lt > rt {
                (left.goal, Some(lt))
            } else if rt > lt {
                (right.goal, Some(rt))
            } else if right.goal > left.goal {
                // 时间戳打平（例如两台设备在同一秒设置了目标）：
                // 取较大的目标值，让合并结果与输入顺序无关
                (right.goal, Some(rt))
            } else {
                (left.goal, Some(lt))
            }
        }
    }
}

/// 合并两天的记录，就地写回左侧。
pub fn merge_day_into(target: &mut DayRecord, other: &DayRecord) {
    *target = merge_day(target, other);
}

/// 合并两份月度统计。
///
/// 正常情况下调用方已经按文件名分片（计划书 10.4 节「跨月文件互不影响」），
/// 所以传进来的两份多半同月。这里仍然按「日期取并集」处理，
/// 不做月份校验：统计文件是**可抛弃数据**，宁可多留一个月的数据，
/// 也不要因为文件里 month 字段被人手改过就整份丢弃。
pub fn merge_monthly(left: &MonthlyStats, right: &MonthlyStats) -> MonthlyStats {
    let mut days: BTreeMap<NaiveDate, DayRecord> = left.days.clone();
    for (date, record) in &right.days {
        days.entry(*date)
            .and_modify(|existing| *existing = merge_day(existing, record))
            .or_insert_with(|| record.clone());
    }

    // 版本号取两者较大：合并结果里含有较新版本才有的字段，
    // 标成旧版本会误导上层去做多余的迁移。
    let schema = left.schema.max(right.schema);

    // 月份字段优先取非空的：允许一边是手写的残缺文件
    let month = if left.month.is_empty() {
        right.month.clone()
    } else {
        left.month.clone()
    };

    MonthlyStats {
        schema,
        month,
        days,
    }
}

/// 批量合并多份月度统计，返回单一结果。
///
/// 折叠顺序对结果没有影响（结合律加交换律），因此这里用什么顺序都行 ——
/// 但**空输入必须返回 None 而不是默认值**：上层据此区分
/// 「这个月还没有任何统计」与「这个月写了 0 字」，前者不该建空文件。
pub fn merge_all(parts: &[MonthlyStats]) -> Option<MonthlyStats> {
    let mut iter = parts.iter();
    let first = iter.next()?.clone();
    Some(iter.fold(first, |acc, next| merge_monthly(&acc, next)))
}

/// 判断左侧是否已经把右侧包含在内。
///
/// 用途：文件监听回调里判断「磁盘上的新内容是否真的带来了新信息」。
/// 若已被内存中的版本覆盖，就没必要触发 UI 重算，
/// 这能避免自我写入引发的监听回环。
pub fn covers(left: &MonthlyStats, right: &MonthlyStats) -> bool {
    merge_monthly(left, right) == *left
}

/// 统计文件里出现过的所有月份。
///
/// 用于「导出全部统计」「重建年度热力图」这类需要跨月遍历的场景。
/// 无法解析的月份字符串会被跳过：统计是辅助数据，
/// 不该因为一个手改坏的文件就让整次遍历失败。
pub fn months_in(stats: &[MonthlyStats]) -> Vec<MonthKey> {
    let mut set: BTreeSet<MonthKey> = BTreeSet::new();
    for file in stats {
        if let Ok(month) = MonthKey::parse(&file.month) {
            set.insert(month);
        }
    }
    set.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::tests::{day, ts};
    use crate::model::ChapterKey;

    /// 构造一份「设备 A」式的统计，便于写测试。
    fn sample() -> MonthlyStats {
        let m = MonthKey::new(2026, 1).unwrap();
        let mut s = MonthlyStats::new(&m);
        {
            let d = s.day_mut(day(2026, 1, 15));
            d.add_chapter_delta("ch_1", 1520).unwrap();
            d.add_chapter_delta("ch_2", 980).unwrap();
            d.push_session(Session::new(ts(2026, 1, 15, 9, 12), 47, 1520, &[]));
            d.set_goal(Some(3000), ts(2026, 1, 15, 9, 0));
        }
        s
    }

    /// 构造一份「设备 B」式的统计。
    fn other() -> MonthlyStats {
        let m = MonthKey::new(2026, 1).unwrap();
        let mut s = MonthlyStats::new(&m);
        {
            let d = s.day_mut(day(2026, 1, 15));
            d.add_chapter_delta("ch_1", 900).unwrap();
            d.add_chapter_delta("ch_3", 400).unwrap();
            d.push_session(Session::new(ts(2026, 1, 15, 21, 5), 20, 300, &[]));
            d.set_goal(Some(5000), ts(2026, 1, 15, 22, 0));
        }
        s
    }

    #[test]
    fn chapter_takes_max_not_sum() {
        let a = sample();
        let b = other();
        let merged = merge_monthly(&a, &b);
        let d = merged.day(day(2026, 1, 15)).unwrap();
        // ch_1：A 是 1520，B 是 900，取 1520（若相加则为 2420，就是翻倍计数）
        assert_eq!(
            d.chapters.get(&ChapterKey::new("ch_1").unwrap()),
            Some(&1520)
        );
        // ch_2 只在 A 出现，ch_3 只在 B 出现，两者都要保留
        assert_eq!(
            d.chapters.get(&ChapterKey::new("ch_2").unwrap()),
            Some(&980)
        );
        assert_eq!(
            d.chapters.get(&ChapterKey::new("ch_3").unwrap()),
            Some(&400)
        );
        assert_eq!(d.words(), 1520 + 980 + 400);
    }

    #[test]
    fn sessions_union_dedupes_by_start() {
        let a = sample();
        let b = other();
        let merged = merge_monthly(&a, &b);
        let d = merged.day(day(2026, 1, 15)).unwrap();
        assert_eq!(d.sessions.len(), 2, "两次不同时间的会话都应保留");
        assert_eq!(d.sessions[0].start, ts(2026, 1, 15, 9, 12));
        assert_eq!(d.sessions[1].start, ts(2026, 1, 15, 21, 5));
    }

    #[test]
    fn duplicate_session_does_not_double_minutes() {
        let a = sample();
        let mut b = MonthlyStats::new(&MonthKey::new(2026, 1).unwrap());
        b.day_mut(day(2026, 1, 15))
            .push_session(Session::new(ts(2026, 1, 15, 9, 12), 47, 1520, &[]));
        let merged = merge_monthly(&a, &b);
        assert_eq!(
            merged.day(day(2026, 1, 15)).unwrap().minutes(),
            47,
            "同一次会话在两份文件里都出现时只应算一次"
        );
    }

    #[test]
    fn session_conflict_merges_field_wise() {
        // 同一次会话，一台设备记了时长，另一台记了章节
        let m = MonthKey::new(2026, 1).unwrap();
        let mut a = MonthlyStats::new(&m);
        a.day_mut(day(2026, 1, 15))
            .push_session(Session::new(ts(2026, 1, 15, 9, 12), 47, 0, &[]));
        let mut b = MonthlyStats::new(&m);
        b.day_mut(day(2026, 1, 15)).push_session(Session::new(
            ts(2026, 1, 15, 9, 12),
            0,
            1520,
            &["ch_1".into()],
        ));

        let merged = merge_monthly(&a, &b);
        let s = &merged.day(day(2026, 1, 15)).unwrap().sessions[0];
        assert_eq!(s.minutes, 47);
        assert_eq!(s.words, 1520);
        assert_eq!(s.chapters, vec!["ch_1"]);
    }

    #[test]
    fn goal_uses_last_writer_wins() {
        let a = sample(); // 9:00 设了 3000
        let b = other(); // 22:00 设了 5000
        let merged = merge_monthly(&a, &b);
        assert_eq!(merged.day(day(2026, 1, 15)).unwrap().goal, Some(5000));

        // 反向合并必须给出同样结果（交换律）
        let reversed = merge_monthly(&b, &a);
        assert_eq!(reversed.day(day(2026, 1, 15)).unwrap().goal, Some(5000));
    }

    #[test]
    fn goal_deletion_wins_if_newer() {
        // 设备 A 在 22:00 清除了目标，设备 B 早上 9:00 的旧目标不能复活
        let m = MonthKey::new(2026, 1).unwrap();
        let mut a = MonthlyStats::new(&m);
        a.day_mut(day(2026, 1, 15))
            .set_goal(None, ts(2026, 1, 15, 22, 0));
        let mut b = MonthlyStats::new(&m);
        b.day_mut(day(2026, 1, 15))
            .set_goal(Some(3000), ts(2026, 1, 15, 9, 0));

        let merged = merge_monthly(&a, &b);
        assert_eq!(merged.day(day(2026, 1, 15)).unwrap().goal, None);
        assert_eq!(
            merge_monthly(&b, &a).day(day(2026, 1, 15)).unwrap().goal,
            None,
            "反向合并也必须清除，否则交换律被破坏"
        );
    }

    #[test]
    fn goal_with_equal_timestamps_is_order_independent() {
        // 两台设备在同一秒设置了不同目标：必须收敛到同一个值
        let m = MonthKey::new(2026, 1).unwrap();
        let mut a = MonthlyStats::new(&m);
        a.day_mut(day(2026, 1, 15))
            .set_goal(Some(1000), ts(2026, 1, 15, 10, 0));
        let mut b = MonthlyStats::new(&m);
        b.day_mut(day(2026, 1, 15))
            .set_goal(Some(2000), ts(2026, 1, 15, 10, 0));

        let ab = merge_monthly(&a, &b);
        let ba = merge_monthly(&b, &a);
        assert_eq!(ab, ba, "时间戳打平时仍必须满足交换律");
        assert_eq!(ab.day(day(2026, 1, 15)).unwrap().goal, Some(2000));
    }

    #[test]
    fn goal_only_on_one_side_is_preserved() {
        let m = MonthKey::new(2026, 1).unwrap();
        let mut a = MonthlyStats::new(&m);
        a.day_mut(day(2026, 1, 15))
            .set_goal(Some(3000), ts(2026, 1, 15, 9, 0));
        let mut b = MonthlyStats::new(&m);
        b.day_mut(day(2026, 1, 15))
            .add_chapter_delta("ch_1", 10)
            .unwrap();

        let merged = merge_monthly(&a, &b);
        assert_eq!(merged.day(day(2026, 1, 15)).unwrap().goal, Some(3000));
    }

    #[test]
    fn goal_without_timestamp_still_survives() {
        // 用户手写的统计文件没有 goalUpdatedAt 字段，目标也不能丢
        let raw = r#"{"chapters": {},"sessions": [],"goal": 2000}"#;
        let hand: DayRecord = serde_json::from_str(raw).unwrap();
        let m = MonthKey::new(2026, 1).unwrap();
        let mut auto = MonthlyStats::new(&m);
        auto.day_mut(day(2026, 1, 15))
            .add_chapter_delta("ch_1", 100)
            .unwrap();

        let mut hand_month = MonthlyStats::new(&m);
        hand_month.days.insert(day(2026, 1, 15), hand);

        let merged = merge_monthly(&auto, &hand_month);
        let d = merged.day(day(2026, 1, 15)).unwrap();
        assert_eq!(d.goal, Some(2000));
        assert_eq!(d.words(), 100);
    }

    // ---- 以下四个测试对应 T8.5 明确要求的三类幂等场景 ----

    #[test]
    fn idempotent_self_merge() {
        // 幂等：merge(x, x) 等于 x
        let a = sample();
        assert_eq!(merge_monthly(&a, &a), a);
    }

    #[test]
    fn idempotent_repeated_merge() {
        // 重复合并：同一份冲突副本被合并两次、三次，结果不变
        let a = sample();
        let b = other();
        let once = merge_monthly(&a, &b);
        let twice = merge_monthly(&once, &b);
        let thrice = merge_monthly(&merge_monthly(&once, &b), &b);
        assert_eq!(once, twice);
        assert_eq!(twice, thrice);
    }

    #[test]
    fn commutative_regardless_of_order() {
        // 交换律：合并顺序不影响结果
        let a = sample();
        let b = other();
        assert_eq!(merge_monthly(&a, &b), merge_monthly(&b, &a));
    }

    #[test]
    fn associative_across_three_devices() {
        // 结合律：三台设备的合并顺序不影响结果
        let a = sample();
        let b = other();
        let mut c = MonthlyStats::new(&MonthKey::new(2026, 1).unwrap());
        {
            let d = c.day_mut(day(2026, 1, 15));
            d.add_chapter_delta("ch_1", 3000).unwrap();
            d.add_chapter_delta("ch_4", 60).unwrap();
            d.push_session(Session::new(ts(2026, 1, 15, 14, 0), 15, 200, &[]));
        }

        let left = merge_monthly(&merge_monthly(&a, &b), &c);
        let right = merge_monthly(&a, &merge_monthly(&b, &c));
        assert_eq!(left, right, "先并 a b 再并 c 必须等于先并 b c 再并 a");

        // 全部乱序排列都应收敛到同一结果
        for order in [&[&a, &c, &b], &[&c, &b, &a], &[&b, &a, &c]] {
            let mut acc = order[0].clone();
            for next in &order[1..] {
                acc = merge_monthly(&acc, next);
            }
            assert_eq!(acc, left, "乱序合并结果不一致");
        }
    }

    #[test]
    fn merge_with_empty_is_identity() {
        // 单位元：空文件参与合并不改变任何数据（首次同步时的常见情形）
        let a = sample();
        let empty = MonthlyStats::new(&MonthKey::new(2026, 1).unwrap());
        assert_eq!(merge_monthly(&a, &empty), a);
        assert_eq!(merge_monthly(&empty, &a), a);
    }

    #[test]
    fn months_stay_separate() {
        // 跨月互不影响：1 月与 2 月的数据在同一份结构里各占各的日期键
        let jan = sample();
        let mut feb = MonthlyStats::new(&MonthKey::new(2026, 2).unwrap());
        feb.day_mut(day(2026, 2, 1))
            .add_chapter_delta("ch_9", 777)
            .unwrap();

        let merged = merge_monthly(&jan, &feb);
        assert!(
            merged.day(day(2026, 2, 1)).is_some(),
            "并集不会丢月份外的数据"
        );
        assert_eq!(merged.day(day(2026, 2, 1)).unwrap().words(), 777);
        assert_eq!(merged.day(day(2026, 1, 15)).unwrap().words(), 2500);

        let months = months_in(&[jan, feb]);
        assert_eq!(
            months,
            vec![
                MonthKey::new(2026, 1).unwrap(),
                MonthKey::new(2026, 2).unwrap()
            ]
        );
    }

    #[test]
    fn months_in_skips_unparsable_months() {
        // 手改坏的文件不该让整次遍历失败
        let mut broken = MonthlyStats::new(&MonthKey::new(2026, 1).unwrap());
        broken.month = "看不懂的月份".into();
        let good = MonthlyStats::new(&MonthKey::new(2026, 3).unwrap());
        let months = months_in(&[broken, good]);
        assert_eq!(months, vec![MonthKey::new(2026, 3).unwrap()]);
    }

    #[test]
    fn merge_keeps_newer_schema_version() {
        let mut a = sample();
        a.schema = 1;
        let mut b = sample();
        b.schema = 2;
        assert_eq!(merge_monthly(&a, &b).schema, 2);
        assert_eq!(merge_monthly(&b, &a).schema, 2, "版本号也要满足交换律");
    }

    #[test]
    fn merge_all_returns_none_for_empty_input() {
        assert!(
            merge_all(&[]).is_none(),
            "没有文件时不能凭空造出一个空月份"
        );
        let a = sample();
        assert_eq!(merge_all(std::slice::from_ref(&a)), Some(a.clone()));
        assert_eq!(merge_all(&[a.clone(), a.clone()]), Some(a));
    }

    #[test]
    fn merge_all_folds_every_part() {
        let parts = vec![sample(), other()];
        let merged = merge_all(&parts).unwrap();
        assert_eq!(merged, merge_monthly(&parts[0], &parts[1]));
    }

    #[test]
    fn covers_detects_subset_relationship() {
        let a = sample();
        let b = other();
        let merged = merge_monthly(&a, &b);
        assert!(covers(&merged, &a), "并集应当覆盖参与合并的任一份");
        assert!(covers(&merged, &b));
        assert!(!covers(&a, &merged), "子集不覆盖并集");
    }

    #[test]
    fn covers_is_reflexive() {
        let a = sample();
        assert!(covers(&a, &a));
    }

    #[test]
    fn merge_day_handles_empty_sides() {
        let empty = DayRecord::default();
        let mut d = DayRecord::default();
        d.add_chapter_delta("ch_1", 10).unwrap();

        assert_eq!(merge_day(&empty, &d), d);
        assert_eq!(merge_day(&d, &empty), d);
        assert_eq!(merge_day(&empty, &empty), empty);
    }

    #[test]
    fn merge_day_into_writes_back() {
        let mut target = DayRecord::default();
        target.add_chapter_delta("ch_1", 10).unwrap();
        let mut incoming = DayRecord::default();
        incoming.add_chapter_delta("ch_1", 50).unwrap();
        incoming.add_chapter_delta("ch_2", 5).unwrap();

        merge_day_into(&mut target, &incoming);
        assert_eq!(target.words(), 55);
    }

    #[test]
    fn merge_result_is_serialization_stable() {
        // 序列化确定性：判断「两份文件内容是否等价」靠的就是这个。
        // 若合并结果依赖输入顺序，云盘会不停制造新的冲突副本
        let a = sample();
        let b = other();
        let ab = serde_json::to_string(&merge_monthly(&a, &b)).unwrap();
        let ba = serde_json::to_string(&merge_monthly(&b, &a)).unwrap();
        assert_eq!(ab, ba);
    }

    #[test]
    fn three_way_convergence_matches_last_writer_goal() {
        // 综合场景：三台设备各写一部分，合并后
        // 字数不翻倍、会话不丢失、目标取最新
        let a = sample();
        let b = other();
        let mut c = MonthlyStats::new(&MonthKey::new(2026, 1).unwrap());
        c.day_mut(day(2026, 1, 15))
            .set_goal(Some(1500), ts(2026, 1, 15, 23, 30));

        let merged = merge_all(&[a, b, c]).unwrap();
        let d = merged.day(day(2026, 1, 15)).unwrap();

        assert_eq!(d.words(), 1520 + 980 + 400);
        assert_eq!(d.sessions.len(), 2);
        assert_eq!(d.goal, Some(1500), "23:30 的目标最新");
    }
}
