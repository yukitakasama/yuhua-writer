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

use crate::model::{ChapterKey, MonthKey};
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
/// - before：本次保存**之前**该章的已知字数
/// - after：本次保存**之后**的字数
/// - now：本次保存的时刻（带时区），决定计入哪一天
///
/// 引擎把 before 与当日已记字数比对，决定本次正差是**累加**到当日
/// 还是仅仅作为上限（详见函数体注释）。无论哪种情形，**同一章当天的
/// 最后一次采集结果就是该章当天的产出**。因此调用方的约定是：
///
/// 1. 每章维护一个 last_known（初始值从章节目录的字数读取）
/// 2. 保存流程把 last_known 作为 before，保存成功后令 last_known = after
/// 3. 统计页展示「今日」时，应当再加上「本次会话内已写但尚未入库的部分」
///    （即已写量减已入库量），否则刚敲下的字要等下次保存才出现
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

    // 章节 ID 非法（例如上层拿到一个尚未落盘的章节）时直接跳过：
    // 统计是辅助数据，不该因为一个脏 ID 让保存流程报错。
    // 这里在进入闭包之前就拦住，是因为闭包内部无法优雅地失败。
    if ChapterKey::new(chapter).is_err() {
        return Ok(CollectOutcome {
            day,
            chapter: chapter.to_string(),
            before,
            after,
            recorded: 0,
            day_total: current_day_total(store, day)?,
        });
    }


    // 基准（base）的语义是「该章**当日的峰值字数**」——注意是**字数**，
    // 不是增量。之所以要把峰值也存下来，是为了让「跌了再涨」能被正确记账：
    //
    //     0    -> 1500   涨，记 1500，峰值抬到 1500
    //     1500 -> 900    跌，不记；峰值**保持 1500 不下调**
    //     900  -> 2100   涨过峰值 600，记 600；当日累计 1500 + 600 = 2100
    //
    // 如果只用「当日已记增量」当基准，第三段就无从判断作者是接着哪一版
    // 往下写的，于是要么少记（把 600 当成重复）要么多记（把 1200 全加）。
    // 峰值基线把这件事变得没有歧义。
    //
    // 采集到的 before 比峰值**还大**时，说明外层保存流程的基线里混进了
    // 当日已记的部分（见 load_peak 的说明），此时以作者实际推动的
    // after - before 为准。
    let baseline = Baseline::new(load_peak(store, day, chapter)?, before);
    let recorded = baseline.growth(after);

    // 完全没有增长时**不写盘**：一是删改旧章是高频操作，无谓的写入会
    // 产生大量云盘流量并磨损 SSD；二是保持文件 mtime 不变，让外部同步
    // 工具不会因为「统计文件没变却变了」而反复上传。
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

    // 新增量 = 当日的最大字数减去当日的起点字数，于是「当日的最大字数就是
    // 该章当日的产出」这一定义被直接搬进了实现：同一批采集无论以什么顺序
    // 折叠，结果都收敛到同一个值。
    let month = MonthKey::of(day);
    let chapter_owned = chapter.to_string();
    let new_peak = baseline.after_growth(after);
    let delta = recorded;

    let stats = store.update(&month, |s| {
        let record = s.day_mut(day);
        // 这里必须**累加**而不是取 max：delta 是「相对峰值新增的产出」，
        // 既然是相对峰值算出来的，同一份输入重复采集时 delta 必然为 0
        // （见上面的 recorded == 0 早返回），因此累加本身就已经幂等。
        //
        // 若这里改成取 max，作者分多轮写作时后面的小增量就会被吃掉
        // （例如先写 500，隔一会儿又写 100，取 max 只剩 500）。
        if let Ok(key) = ChapterKey::new(chapter_owned.clone()) {
            let entry = record.chapters.entry(key).or_insert(0);
            *entry = entry.saturating_add(delta);
        }
        let _ = record.set_peak(&chapter_owned, new_peak);
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

/// 单章在当日的记账基准。
///
/// 这一对数值（峰值字数、本次观测到的字数）足以判定「涨了多少」，
/// 而且判定过程**只依赖当日已记的数据与本次调用的入参**，
/// 不依赖任何进程内状态：崩溃重启、重复采集、乱序采集都不会算错。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Baseline {
    /// 该章当日已观察到的**最大字数**（不是增量）。
    peak: u32,
    /// 本次保存前调用方给出的字数。
    observed: u32,
}

impl Baseline {
    /// 用当日峰值与本次观测值构造基准。
    pub fn new(peak: u32, observed: u32) -> Self {
        Self { peak, observed }
    }

    /// 本次保存带来的**新增产出**。
    ///
    /// 基线取「峰值」与「观测值」中较大者：
    ///
    /// - 正常情况下观测值不会超过峰值（作者接着当日最高的一版往下写）
    /// - 观测值超过峰值时，说明 before 里混进了当日已记的部分
    ///   （例如调用方传入的是「未保存字数 + 当日已记」），
    ///   此时应当只算作者本次实际推动的部分 after - before
    ///
    /// 无论哪种情形都满足「峰值就是当日产出」这一不变量。
    pub fn growth(&self, after: u32) -> u32 {
        let base = self.peak.max(self.observed);
        after.saturating_sub(base)
    }

    /// 写入新峰值。
    ///
    /// **峰值只会上升，永不下调** —— 这正是「负差不抵扣」的落地方式：
    /// 作者把 1500 字删到 900 后，峰值仍记 1500，之后必须重新写回
    /// 1500 以上才开始产生新的产出。
    pub fn after_growth(&self, after: u32) -> u32 {
        self.peak.max(self.observed).max(after)
    }
}

/// 读取某章当日在统计文件里记录的峰值字数。
///
/// 与「当日已记增量」分开存：增量是**产出**（喂给日历与热力图），
/// 峰值是**基线**（用于判断下一次增长）。两者数值不同但都是必需的。
/// 统计文件里没有峰值时（旧文件或用户手改过的文件）退回到「当日增量」，
/// 这在绝大多数情况下是一致的，是安全的近似。
pub fn load_peak(store: &StatsStore, day: NaiveDate, chapter: &str) -> Result<u32> {
    let stats = store.load(&MonthKey::of(day))?;
    let Some(record) = stats.day(day) else {
        return Ok(0);
    };
    let key = match ChapterKey::new(chapter) {
        Ok(key) => key,
        Err(_) => return Ok(0),
    };
    Ok(record
        .peaks
        .get(&key)
        .copied()
        .unwrap_or_else(|| record.chapters.get(&key).copied().unwrap_or(0)))
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

    // 按与 collect_delta 完全相同的规则逐章算新增量（峰值基线、只记正差）。
    // 复用同一套语义是必要的：否则「保存一章」与「保存全部」这两条路径
    // 会对同样的写作给出不同的数字，用户一眼就能看出统计不可信。
    let existing = store.load(&month)?;
    let day_record = existing.day(day).cloned().unwrap_or_default();

    let mut effective: Vec<(String, u32, u32)> = Vec::new();
    for (chapter, before, after) in deltas {
        let peak = day_record.peak_of(chapter);
        let baseline = Baseline::new(peak, *before);
        let growth = baseline.growth(*after);
        if growth > 0 {
            effective.push((chapter.clone(), growth, baseline.after_growth(*after)));
        }
    }

    if effective.is_empty() {
        return Ok(0);
    }

    let written = effective.len();
    store.update(&month, |s| {
        let record = s.day_mut(day);
        for (chapter, delta, peak) in &effective {
            // 单章 ID 非法时跳过而不是整批失败：
            // 一次批量保存里有个把脏 ID，不该让其它章节的统计一起丢掉
            if let Ok(key) = ChapterKey::new(chapter.clone()) {
                let entry = record.chapters.entry(key).or_insert(0);
                *entry = entry.saturating_add(*delta);
            }
            let _ = record.set_peak(chapter, *peak);
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
    fn repeated_saves_accumulate_exact_growth() {
        // 作者在同一天里分三次把同一章越写越长（0 到 500、再到 900、再到 1500）。
        // 当日该章的产出就是这一天写出来的总量 1500，
        // 既不是三段正差简单相加（那也正是 1500，因为基线连续），
        // 也不会因为重复处理而翻倍。
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 500, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 500, 900, ts(2026, 1, 15, 10, 0)).unwrap();
        collect_delta(&store, "ch_1", 900, 1500, ts(2026, 1, 15, 11, 0)).unwrap();

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(stats.day(day(2026, 1, 15)).unwrap().words(), 1500);
    }

    #[test]
    fn upstream_regression_grow_shrink_grow() {
        // 计划书 10.2 节规定「只记增长，负差不抵扣」，这个三段式是最容易
        // 写错的场景（峰值的语义必须只升不降）：
        //
        //     0    -> 1500   记 1500，当日累计 1500
        //     1500 -> 900    跌，不记、峰值不下调，当日累计仍 1500
        //     900  -> 2100   涨过峰值 600，记 600，当日累计 2100
        let (_tmp, store) = store();
        let first = collect_delta(&store, "ch_3", 0, 1500, ts(2026, 1, 15, 9, 0)).unwrap();
        assert_eq!(first.recorded, 1500);
        assert_eq!(first.day_total, 1500);

        let shrink = collect_delta(&store, "ch_3", 1500, 900, ts(2026, 1, 15, 10, 0)).unwrap();
        assert_eq!(shrink.recorded, 0, "负差不记，也不去抵扣当日产量");
        assert_eq!(shrink.day_total, 1500, "删字后当日产量不应减少");

        let regrow = collect_delta(&store, "ch_3", 900, 2100, ts(2026, 1, 15, 11, 0)).unwrap();
        assert_eq!(regrow.recorded, 600, "只记写回峰值以上的部分");
        assert_eq!(regrow.day_total, 2100, "当日累计是 1500 加 600");

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(stats.day(day(2026, 1, 15)).unwrap().words(), 2100);
    }

    #[test]
    fn shrink_alone_never_reduces_the_day_total() {
        // 反复删字：当日产量一动不动，且全程不写盘
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 900, ts(2026, 1, 15, 9, 0)).unwrap();
        for after in [800, 500, 100, 0] {
            let out = collect_delta(&store, "ch_1", 900, after, ts(2026, 1, 15, 10, 0)).unwrap();
            assert_eq!(out.recorded, 0);
            assert_eq!(out.day_total, 900, "删字不能抵扣当日产量");
        }
    }

    #[test]
    fn peak_never_goes_down() {
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 1500, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 1500, 200, ts(2026, 1, 15, 10, 0)).unwrap();
        assert_eq!(
            load_peak(&store, day(2026, 1, 15), "ch_1").unwrap(),
            1500,
            "删到 200 之后峰值仍然记 1500"
        );
        // 再写回 1000（仍未超过峰值）不产生任何新增产出
        let out = collect_delta(&store, "ch_1", 200, 1000, ts(2026, 1, 15, 11, 0)).unwrap();
        assert_eq!(out.recorded, 0);
    }
    #[test]
    fn repeated_collect_of_the_same_save_does_not_double() {
        // 同一份数据被采集两次时，峰值基线使它天然幂等：
        // 第二次的 after（1200）没有超过峰值，因此新增量为 0。
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 1200, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 0, 1200, ts(2026, 1, 15, 9, 0)).unwrap();
        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(stats.day(day(2026, 1, 15)).unwrap().words(), 1200);
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
        // 空 ID 在入口就被拦住：不写盘、不报错、也不产生脏键
        let out = collect_delta(&store, "", 0, 100, ts(2026, 1, 15, 9, 0)).unwrap();
        assert_eq!(out.recorded, 0, "脏 ID 不记入任何数字");
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
    fn repeated_collect_from_the_same_baseline_is_bounded() {
        // 同一次保存因重试被采集两次时，当日数字至多翻一倍而不是无限增长；
        // 真正保证「不重复计数」的是上层按 last_known 传参（见
        // repeated_saves_take_max_not_sum），这里只守住「有界」。
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 1200, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 0, 1200, ts(2026, 1, 15, 9, 0)).unwrap();
        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        let words = stats.day(day(2026, 1, 15)).unwrap().words();
        assert!(words <= 2400, "重复采集不该无界增长，实际 {words}");
    }

    #[test]
    fn growth_then_shrink_then_growth_accumulates() {
        // 一场典型的写作：写 1500、删到 900、再写成 2100（相对最大版本净增 600）。
        // 第二次保存是负差（不记），第三次保存时 before（900）不等于当日已记的
        // 1500，说明作者这一轮是在**更大的版本上做的删改再补写**，
        // 此时以本轮净增（600）为准，当日累计 1500 + 600 = 2100。
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 1500, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 1500, 900, ts(2026, 1, 15, 10, 0)).unwrap();
        let out = collect_delta(&store, "ch_1", 900, 2100, ts(2026, 1, 15, 11, 0)).unwrap();
        assert_eq!(out.recorded, 600, "本轮只记写回峰值以上的部分");
        assert_eq!(out.day_total, 2100, "当日累计是 1500 加上本轮净增 600");

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(stats.day(day(2026, 1, 15)).unwrap().words(), 2100);
    }

    #[test]
    fn linear_session_accumulates_exactly() {
        // 一次不间断的写作：基线一路跟着当日已记往前走
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 500, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 500, 900, ts(2026, 1, 15, 9, 30)).unwrap();
        collect_delta(&store, "ch_1", 900, 2000, ts(2026, 1, 15, 10, 0)).unwrap();

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(
            stats.day(day(2026, 1, 15)).unwrap().words(),
            2000,
            "当日累计应当等于该章当天的总增长"
        );
    }

    #[test]
    fn foreign_baseline_only_contributes_its_own_growth() {
        // 外层保存流程可能传入一个与当日已记无关的 before（例如该书的总字数）。
        // 此时只把作者本次实际推动的部分（after - before = 300）计入，
        // 绝不把 before 里的绝对量当成当日产出。
        let (_tmp, store) = store();
        collect_delta(&store, "ch_1", 0, 1000, ts(2026, 1, 15, 9, 0)).unwrap();
        collect_delta(&store, "ch_1", 40_000, 40_300, ts(2026, 1, 15, 10, 0)).unwrap();

        let stats = store.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(
            stats.day(day(2026, 1, 15)).unwrap().words(),
            1300,
            "当日累计 = 1000 加本轮实际推动的 300"
        );
    }

    #[test]
    fn batch_collection_converges_in_any_order() {
        // 与 merge 模块同一条性质：同一批采集按任意顺序折叠应当收敛到
        // 同一个结果，这样重复处理或重放都不会让数字翻倍。
        let deltas = vec![
            ("ch_1".to_string(), 0u32, 500u32),
            ("ch_1".to_string(), 500, 900),
            ("ch_1".to_string(), 900, 2000),
        ];

        let dir_a = tempfile::tempdir().unwrap();
        let forward = StatsStore::at(dir_a.path());
        collect_batch(&forward, &deltas, ts(2026, 1, 15, 12, 0)).unwrap();

        let dir_b = tempfile::tempdir().unwrap();
        let reversed = StatsStore::at(dir_b.path());
        let mut back = deltas.clone();
        back.reverse();
        collect_batch(&reversed, &back, ts(2026, 1, 15, 12, 0)).unwrap();

        let a = forward.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        let b = reversed.load(&MonthKey::of(day(2026, 1, 15))).unwrap();
        assert_eq!(a, b, "乱序采集必须收敛到同一结果");
    }
}
