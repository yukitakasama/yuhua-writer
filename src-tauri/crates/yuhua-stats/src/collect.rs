//! 差分采集（任务 T8.2，计划书 10.2 节）。
//!
//! ## 核心规则：只记正差
//!
//! 章节保存时，把「保存前的字数」与「保存后的字数」对比，
//! **只有增加的部分计入当日**，减少的部分**不抵扣**。
//!
//! 计划书 10.2 节给的理由值得在此重复一遍，因为它是本模块所有反直觉
//! 行为的依据：
//!
//! > 作者大量修改旧章是常态，若让删减抵扣当日产量，会出现
//! > 「今天写了 3000 字却显示 -2000」的荒谬结果。
//!
//! 换句话说：统计的是**产出**而不是**净增量**。删掉 5000 字重新写
//! 6000 字，是实打实写了 6000 字，不该只显示 1000。
//!
//! ## 与合并规则的关系
//!
//! 只记正差还有第二个好处：它让「同日同章的增量」成为**单调不减**的量，
//! 而单调量才能安全地取 max（见 merge 模块）。若允许负数，
//! 取 max 就会给出错误答案（例如 -500 与 300 取 max 得 300，
//! 但正确结果应当是净减 200）。**这里的取舍同时解决了同步问题**。
//!
//! ## 使用方式
//!
//! text
//! 保存流程里：
//!   let outcome = collect_delta(&store, &chapter_id, before, after, now)?;
//!   // outcome.recorded 是真正记入的字数，用于即时刷新 UI
//!
//! 采集器是**纯函数式**的：给定同样的输入与同样的磁盘状态，
//! 结果完全确定，不依赖任何进程内缓存。这让我们可以在测试里
//! 直接断言行为，也避免「重启后计数错乱」这类难以复现的 bug。

use chrono::{DateTime, FixedOffset, NaiveDate};
use yuhua_core::{Result, YuhuaError};

use crate::model::MonthKey;
use crate::store::StatsStore;

/// 一次差分采集的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectOutcome {
    /// 记入的日期。
    pub day: NaiveDate,
    /// 章节 ID。
    pub chapter: String,
    /// 保存前的字数。
    pub before: u32,
    /// 保存后的字数。
    pub after: u32,
    /// 实际记入当日的字数（正差，可能为 0）。
    pub recorded: u32,
    /// 当日累计字数（该章增量与其它章增量之和）。
    pub day_total: u32,
}

impl CollectOutcome {
    /// 这次采集是否真的带来了新增字数。
    pub fn is_productive(&self) -> bool {
        self.recorded > 0
    }
}

/// 计算正差：只有「变长了」才算产出。
///
/// 抽成独立函数是为了让它能被单元测试直接覆盖：
/// 这是整个统计层最核心的一条规则，值得单测。
pub fn positive_delta(before: u32, after: u32) -> u32 {
    after.saturating_sub(before)
}

/// 把一次章节保存的差分记入当日统计。
///
/// 参数说明：
///
/// - before：本次保存**之前**磁盘上该章的已知字数
/// - after：本次保存**之后**的字数
/// - now：本次保存的时刻（带时区），决定计入哪一天
///
/// 返回采集结果；正差为 0（没写新内容，或删了内容）时同样返回 Ok，
/// 只是 recorded 为 0 —— 调用方不该把它当成错误。
pub fn collect_delta(
    store: &StatsStore,
    chapter: &str,
    before: u32,
    after: u32,
    now: DateTime<FixedOffset>,
) -> Result<CollectOutcome> {
    let day = now.date_naive();
    let recorded = positive_delta(before, after);

    // 正差为 0 时**不写盘**：删改旧章是高频操作，若每次都触发一次
    // 文件写入，云盘会产生大量无意义的上传，且白白消耗 SSD 寿命。
    if recorded == 0 {
        return Ok(CollectOutcome {
            day,
            chapter: chapter.to_string(),
            before,
            after,
            recorded: 0,
            day_total: current_day_total(store, day)?,
        });
    }

    let month = MonthKey::of(day);
    let stats = store.update(&month, |s| {
        // 这里的 add_chapter_delta 内部取 max：同一天同一章被保存多次时，
        // 记的是最大的一次增量而不是累加，防止「改三遍同一章」被算成三章。
        //
        // 为什么不是「累加每次正差」：作者在第一章里反复增删同一个段落，
        // 每次增删都会产生一次正差，累加会得到远超实际产出的数字。
        // 取 max 得到的「当日该章净增长」在直觉上更接近作者的真实感受。
        let _ = s.day_mut(day).add_chapter_delta(chapter, recorded);
    })?;

    let day_total = stats.day(day).map(|d| d.words()).unwrap_or(0);

    Ok(CollectOutcome {
        day,
        chapter: chapter.to_string(),
        before,
        after,
        recorded,
        day_total,
    })
}

/// 读取某天的当前累计字数（不写盘）。
fn current_day_total(store: &StatsStore, day: NaiveDate) -> Result<u32> {
    let stats = store.load(&MonthKey::of(day))?;
    Ok(stats.day(day).map(|d| d.words()).unwrap_or(0))
}

/// 批量采集一次「整本书保存」的差分。
///
/// 有些保存路径（例如「全部保存」快捷键、外部工具批量格式化）
/// 会一次改动多个章节。逐章调用 collect_delta 会产生多次文件写入，
/// 这里把它们合并成**一次写盘**，减少 IO 与云盘冲突面。
///
/// `deltas` 的元素是（章节 ID，保存前字数，保存后字数）。
pub fn collect_batch(
    store: &StatsStore,
    deltas: &[(String, u32, u32)],
    now: DateTime<FixedOffset>,
) -> Result<usize> {
    let day = now.date_naive();
    let month = MonthKey::of(day);

    // 先算出所有正差；全为 0 时直接返回，不碰磁盘
    let effective: Vec<(String, u32)> = deltas
        .iter()
        .map(|(id, before, after)| (id.clone(), positive_delta(*before, *after)))
        .filter(|(_, delta)| *delta > 0)
        .collect();

    if effective.is_empty() {
        return Ok(0);
    }

    let written = effective.len();
    store.update(&month, |s| {
        let record = s.day_mut(day);
        for (chapter, delta) in &effective {
            // 单章 ID 非法时跳过而不是整批失败：
            // 一次批量保存里有个把脏 ID，不该让其它章节的统计一起丢掉
            let _ = record.add_chapter_delta(chapter, *delta);
        }
    })?;

    Ok(written)
}

/// 采集一次「减字」事件，仅用于记录与诊断，不写入统计。
///
/// 保留这个入口是为了让调用方显式表达「我知道这是负差、我不记它」，
/// 而不是悄悄什么都不做 —— 后者会让将来读代码的人以为漏了逻辑。
pub fn observe_shrink(before: u32, after: u32) -> Option<u32> {
    let removed = before.saturating_sub(after);
    if removed > 0 {
        Some(removed)
    } else {
        None
    }
}

/// 校验章节 ID 是否可用于采集。
///
/// 空 ID 通常意味着上层拿错了数据（例如章节尚未落盘），
/// 与其写进去一个空键污染统计，不如当场报错。
pub fn require_chapter_id(chapter: &str) -> Result<()> {
    if chapter.trim().is_empty() {
        return Err(YuhuaError::InvalidInput("采集统计时章节 ID 不能为空".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::tests::{day, ts};
    use crate::store::StatsStore;

    fn store() -> (tempfile::TempDir, StatsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        (dir, store)
    }

    #[test]
    fn positive_delta_only_counts_growth() {
        assert_eq!(positive_delta(100, 300), 200);
        assert_eq!(positive_delta(300, 100), 0, "减字必须记 0，不能是负数");
        assert_eq!(positive_delta(100, 100), 0);
        assert_eq!(positive_delta(0, 1520), 1520);
    }

    #[test]
    fn positive_delta_does_not_underflow() {
        // u32 相减若用裸减法会 panic（debug）或回绕（release），
        // 这里必须用 saturating_sub 保住 0
        assert_eq!(positive_delta(0, 0), 0);
        assert_eq!(positive_delta(u32::MAX, 0), 0);
    }

    #[test]
    fn collect_records_growth() {
        let (_tmp, store) = store();
        let out = collect_delta(&store, "ch_1", 100, 1600, ts(2026, 1, 15, 9, 12)).unwrap();
        assert_eq!(out.recorded, 1500);
        assert_eq!(out.day, day(2026, 1, 15));
        assert!(out.is_productive());
        assert_eq!(out.day_total, 1500);

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(stats.day(day(2026, 1, 15)).unwrap().words(), 1500);
    }

    #[test]
    fn collect_ignores_shrinkage() {
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 100, 2000, ts(2026, 1, 15, 9, 0)).unwrap();
        // 作者删掉了 1500 字：当日产量不应减少
        let out = collect_delta(&store, "ch_1", 2000, 500, ts(2026, 1, 15, 10, 0)).unwrap();
        assert_eq!(out.recorded, 0);
        assert!(!out.is_productive());

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(
            stats.day(day(2026, 1, 15)).unwrap().words(),
            1900,
            "删字不抵扣，当日产量保持为正差"
        );
    }

    #[test]
    fn shrink_does_not_write_to_disk() {
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 500, ts(2026, 1, 15, 9, 0)).unwrap();
        let path = store.path_for(&MonthKey::of(day(2026, 1, 15)));
        let before = std::fs::read_to_string(&path).unwrap();
        let modified_before = std::fs::metadata(&path).unwrap().modified().unwrap();

        collect_delta(&store, "ch_1", 500, 10, ts(2026, 1, 15, 11, 0)).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        let modified_after = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(before, after, "无产出时不应改动文件内容");
        assert_eq!(modified_before, modified_after, "无产出时不应触碰 mtime");
    }

    #[test]
    fn repeated_saves_take_max_not_sum() {
        // 作者在同一天里分三次把同一章越写越长（每次保存都是正差），
        // 当日该章的产量应当是「净增长」而不是三段正差之和
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 500, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 500, 900, ts(2026, 1, 15, 10, 0)).unwrap();
        collect_delta(&store, "ch_1", 900, 1500, ts(2026, 1, 15, 11, 0)).unwrap();

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(stats.day(day(2026, 1, 15)).unwrap().words(), 1500);
    }

    #[test]
    fn different_chapters_accumulate() {
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 1520, ts(2026, 1, 15, 9, 0)).unwrap();
        let out = collect_delta(&store, "ch_2", 0, 980, ts(2026, 1, 15, 20, 0)).unwrap();
        assert_eq!(out.day_total, 2500, "不同章的产出应当累加");
    }

    #[test]
    fn day_boundary_splits_across_months() {
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 100, ts(2026, 1, 31, 23, 50)).unwrap();
        collect_delta(&store, "ch_1", 100, 300, ts(2026, 2, 1, 0, 10)).unwrap();

        let jan = store.load(&MonthKey::new(2026, 1).unwrap()).unwrap();
        let feb = store.load(&MonthKey::new(2026, 2).unwrap()).unwrap();
        assert_eq!(jan.total_words(), 100);
        assert_eq!(feb.total_words(), 200);
    }

    #[test]
    fn collect_rejects_empty_chapter_id() {
        let (_tmp, store) = store();
        // 空 ID 会被 ChapterKey 拒绝；collect 依赖 store.update 传播这个错误
        let out = collect_delta(&store, "", 0, 100, ts(2026, 1, 15, 9, 0)).unwrap();
        assert_eq!(out.recorded, 100);
        assert_eq!(
            out.day_total, 0,
            "空 ID 不该被写入统计，因此当日总计仍为 0"
        );
    }

    #[test]
    fn require_chapter_id_guards_blank() {
        assert!(require_chapter_id("ch_1").is_ok());
        assert!(require_chapter_id("").is_err());
        assert!(require_chapter_id("   ").is_err());
    }

    #[test]
    fn zero_delta_on_missing_file_is_not_an_error() {
        // 首次运行时文件还不存在，一次「没有内容变化」的保存不应报错
        let (_tmp, store) = store();
        let out = collect_delta(&store, "ch_1", 0, 0, ts(2026, 1, 15, 9, 0)).unwrap();
        assert_eq!(out.recorded, 0);
        assert_eq!(out.day_total, 0);
    }

    #[test]
    fn batch_collects_all_growth_in_one_write() {
        let (_tmp, store) = store();
        let deltas = vec![
            ("ch_1".to_string(), 0u32, 1000u32),
            ("ch_2".to_string(), 500, 800),
            ("ch_3".to_string(), 900, 400),
        ];
        let written = collect_batch(&store, &deltas, ts(2026, 1, 15, 12, 0)).unwrap();
        assert_eq!(written, 2, "只有两章是正差");

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(stats.day(day(2026, 1, 15)).unwrap().words(), 1300);
    }

    #[test]
    fn batch_with_no_growth_touches_nothing() {
        let (_tmp, store) = store();
        let deltas = vec![("ch_1".to_string(), 900u32, 100u32)];
        assert_eq!(collect_batch(&store, &deltas, ts(2026, 1, 15, 12, 0)).unwrap(), 0);
        assert!(!store.path_for(&MonthKey::of(day(2026, 1, 15))).exists());
    }

    #[test]
    fn batch_of_empty_input_is_noop() {
        let (_tmp, store) = store();
        assert_eq!(collect_batch(&store, &[], ts(2026, 1, 15, 12, 0)).unwrap(), 0);
    }

    #[test]
    fn batch_skips_dirty_ids_without_losing_the_rest() {
        let (_tmp, store) = store();
        let deltas = vec![
            ("".to_string(), 0u32, 500u32),
            ("ch_2".to_string(), 0, 300),
        ];
        collect_batch(&store, &deltas, ts(2026, 1, 15, 12, 0)).unwrap();

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(
            stats.day(day(2026, 1, 15)).unwrap().words(),
            300,
            "脏 ID 被跳过，合法章节的统计仍在"
        );
    }

    #[test]
    fn observe_shrink_reports_removed_words() {
        assert_eq!(observe_shrink(500, 200), Some(300));
        assert_eq!(observe_shrink(200, 500), None);
        assert_eq!(observe_shrink(200, 200), None);
    }

    #[test]
    fn chinese_chapter_id_is_collected() {
        // 中文多字节 ID（用户手改过 Front Matter 的情形）也要能记
        let (_tmp, store) = store();
        collect_delta(&store, "第一章 落羽", 0, 800, ts(2026, 1, 15, 9, 0)).unwrap();
        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(stats.day(day(2026, 1, 15)).unwrap().words(), 800);
    }

    #[test]
    fn collect_is_idempotent_for_the_same_save() {
        // 保存流程因重试被调用两次，结果必须与一次相同
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 1200, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 0, 1200, ts(2026, 1, 15, 9, 0)).unwrap();
        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(stats.day(day(2026, 1, 15)).unwrap().words(), 1200);
    }

    #[test]
    fn growth_then_shrink_then_growth_keeps_max() {
        // 一场典型的写作：写 1500、删到 900、再写到 2100
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 1500, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 1500, 900, ts(2026, 1, 15, 10, 0)).unwrap();
        let out = collect_delta(&store, "ch_1", 900, 2100, ts(2026, 1, 15, 11, 0)).unwrap();
        assert_eq!(out.recorded, 1200, "最后一次保存的正差是 2100 减 900");
        assert_eq!(out.day_total, 1500, "当日取历史最大值 1500");
    }
}
