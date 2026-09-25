//! 按月分片的统计存储（任务 T8.1，计划书 10.3 节）。
//!
//! ## 为什么按月分片
//!
//! 计划书 10.3 节给了三条理由，这里把它们落到实现上：
//!
//! 1. **单文件小**：一年 12 个文件，每个几 KB。整份统计只存增量不求累计，
//!    所以文件大小基本只与「写了多少天」有关，不会随书变长而膨胀。
//! 2. **写入局部**：今天写第三章，只会重写本月这一个文件的某一天，
//!    不会连着改 2024 年的历史数据，这直接减少了云盘的冲突面。
//! 3. **冲突面窄**：两台设备即使同一天写，也只在**同一个月**的文件里有交集。
//!
//! ## 复用原子写
//!
//! 写文件走 yuhua_fs 的 atomic_write（临时文件加 fsync 再加 rename），
//! 而不是 fs::write。理由与章节文件相同：工作区在云盘里，
//! 半截 JSON 会让下一次读取直接失败，而统计文件损坏会让热力图整月空白。
//! 更糟的是，云端会把正在被写入的半截文件也同步出去。
//!
//! ## 读取容错
//!
//! 统计是**可抛弃数据**（丢了可以重新攒，不影响稿子），所以读取策略是
//! 「尽量猜到对的部分」而不是「一有毛病就报错」：
//!
//! - 文件不存在：返回空月份，不是错误（第一次运行必然如此）
//! - 文件为半截 JSON：作为解析错误上报，由上层决定是否备份后重建
//! - 文件里 month 字段缺失或与文件名不符：以**文件名**为准修正

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use yuhua_core::{Result, YuhuaError};
use yuhua_fs::WorkspaceLayout;

use crate::merge::merge_monthly;
use crate::model::{DayRecord, MonthKey, MonthlyStats, STATS_SCHEMA};

/// 统计文件的公共前缀，形如 daily-。
pub const STATS_FILE_PREFIX: &str = "daily-";

/// 统计文件的公共后缀。
pub const STATS_FILE_SUFFIX: &str = ".json";

/// 按月分片的统计仓库。
///
/// 持有工作区布局而不是裸路径：所有路径拼装都委托给
/// yuhua_fs::WorkspaceLayout，避免统计层自己拼出 .yuhua/stats 这种
/// 与布局定义重复的常量（重复就意味着将来改了布局会漏改一处）。
#[derive(Debug, Clone)]
pub struct StatsStore {
    layout: WorkspaceLayout,
}

impl StatsStore {
    /// 以工作区布局建立仓库。
    pub fn new(layout: WorkspaceLayout) -> Self {
        Self { layout }
    }

    /// 以工作区根目录建立仓库。
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self::new(WorkspaceLayout::new(root))
    }

    /// 统计目录（.yuhua/stats/）。
    pub fn dir(&self) -> PathBuf {
        self.layout.stats_dir()
    }

    /// 某个月的分片路径。
    pub fn path_for(&self, month: &MonthKey) -> PathBuf {
        self.dir().join(month.file_name())
    }

    /// 读取某个月的统计。
    ///
    /// 文件不存在时返回**空月份**而不是错误：第一次运行、或者用户刚删掉
    /// 统计文件时，「这个月还没有数据」是正常状态，不该让 UI 弹错误框。
    pub fn load(&self, month: &MonthKey) -> Result<MonthlyStats> {
        let path = self.path_for(month);
        if !path.exists() {
            return Ok(MonthlyStats::new(month));
        }
        let raw = fs::read_to_string(&path).map_err(|e| YuhuaError::io(&path, e))?;
        parse_month(&raw, month, &path)
    }

    /// 原子地写入某个月的统计。
    ///
    /// 写入前先清理空记录：空壳没有任何信息量，却会让文件膨胀、
    /// 让云盘产生无意义的 diff。
    pub fn save(&self, stats: &MonthlyStats) -> Result<()> {
        let month = MonthKey::parse(&stats.month).map_err(|e| {
            YuhuaError::Invariant(format!(
                "无法写入统计文件：{e}（月份字段为 {:?}）",
                stats.month
            ))
        })?;

        let mut cleaned = stats.clone();
        cleaned.schema = STATS_SCHEMA;
        cleaned.prune_empty_days();

        // 手写 pretty 序列化而不是 to_string：统计文件是纯文本、
        // 用户可以直接打开看，缩进能让它保持可读；同时也让云盘 diff
        // 落在具体的行上，而不是整文件一行。
        let json = serde_json::to_string_pretty(&cleaned).map_err(|e| YuhuaError::Parse {
            context: "统计文件",
            message: e.to_string(),
        })?;

        yuhua_fs::atomic_write(&self.path_for(&month), &json)
    }

    /// 读入、就地修改、原子写回。
    ///
    /// 提供这个便捷方法是为了让调用方（命令层、采集器）不必自己
    /// 重复「load 改 save」三步，也避免漏掉中间任何一步。
    pub fn update<F>(&self, month: &MonthKey, edit: F) -> Result<MonthlyStats>
    where
        F: FnOnce(&mut MonthlyStats),
    {
        let mut stats = self.load(month)?;
        edit(&mut stats);
        self.save(&stats)?;
        Ok(stats)
    }

    /// 列出统计目录里所有的月份分片（按月份升序）。
    ///
    /// 只认符合 daily-YYYY-MM.json 命名的文件，其余一律忽略。
    /// **不**尝试读取冲突副本：它们的文件名不符合规则，
    /// 由 load_merged 专门处理。
    pub fn months(&self) -> Result<Vec<MonthKey>> {
        let dir = self.dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let entries = fs::read_dir(&dir).map_err(|e| YuhuaError::io(&dir, e))?;

        let mut months = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(month) = parse_month_file_name(&name) {
                months.push(month);
            }
        }
        months.sort();
        months.dedup();
        Ok(months)
    }

    /// 读取统计目录里所有分片并合并成一份（按日期组织）。
    ///
    /// 返回的是「日期到单日记录」的映射，而不是 MonthlyStats，
    /// 因为跨月数据无法用一个 month 字段表达，硬塞会有歧义。
    pub fn load_all_days(&self) -> Result<BTreeMap<NaiveDate, DayRecord>> {
        let mut days: BTreeMap<NaiveDate, DayRecord> = BTreeMap::new();
        for month in self.months()? {
            let stats = self.load(&month)?;
            for (date, record) in stats.days {
                days.entry(date)
                    .and_modify(|existing| {
                        *existing = crate::merge::merge_day(existing, &record);
                    })
                    .or_insert(record);
            }
        }
        Ok(days)
    }

    /// 读取某个月，并把该月的**所有冲突副本**一并合并进来。
    ///
    /// 云盘造成的冲突副本（OneDrive 的「(计算机的冲突副本 日期)」、
    /// 坚果云的「(冲突副本 日期)」、Syncthing 的 .sync-conflict- 后缀等）
    /// 文件名里含有 YYYY-MM，内容仍是合法的统计。我们只做**读时合并**，
    /// **绝不删除**这些文件，与 4.5 节对章节文件的态度一致：
    /// 自动删除别人的文件是绝对不可以的。
    pub fn load_merged(&self, month: &MonthKey) -> Result<MonthlyStats> {
        let mut merged = self.load(month)?;
        for candidate in self.conflict_copies_of(month)? {
            let raw = match fs::read_to_string(&candidate) {
                Ok(raw) => raw,
                // 单个冲突副本读不出来不应让整次加载失败：
                // 它可能是云盘正在写入的半截文件，下次就好了
                Err(_) => continue,
            };
            let Ok(copy) = parse_month(&raw, month, &candidate) else {
                continue;
            };
            merged = merge_monthly(&merged, &copy);
        }
        Ok(merged)
    }

    /// 找出某个月的冲突副本文件路径。
    ///
    /// 判定条件是「文件名里含有 daily-YYYY-MM 但不等于标准文件名，
    /// 且以 .json 结尾」。这个规则比 yuhua_fs 的冲突识别宽松，
    /// 因为统计文件的冲突形态更杂（用户手工复制的副本没有统一命名），
    /// 而多读一个合法 JSON 的代价只是几毫秒。
    pub fn conflict_copies_of(&self, month: &MonthKey) -> Result<Vec<PathBuf>> {
        let dir = self.dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let canonical = month.file_name();
        let needle = format!("{}{}", STATS_FILE_PREFIX, month);
        let entries = fs::read_dir(&dir).map_err(|e| YuhuaError::io(&dir, e))?;

        let mut found = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == canonical || !name.ends_with(STATS_FILE_SUFFIX) {
                continue;
            }
            if name.contains(&needle) {
                found.push(entry.path());
            }
        }
        found.sort();
        Ok(found)
    }

    /// 统计目录里一共有多少个冲突副本（供 UI 提示发现 N 个统计冲突文件）。
    pub fn conflict_copy_count(&self) -> Result<usize> {
        let dir = self.dir();
        if !dir.exists() {
            return Ok(0);
        }
        let entries = fs::read_dir(&dir).map_err(|e| YuhuaError::io(&dir, e))?;
        Ok(entries
            .flatten()
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.ends_with(STATS_FILE_SUFFIX) && parse_month_file_name(&name).is_none()
            })
            .count())
    }
}

/// 解析统计文件内容。
///
/// 容错策略见模块文档。特别地：**文件名是月份的权威来源**，
/// 文件里的 month 字段只用于自描述展示，两者不符时以文件名修正，
/// 否则一份被用户改名（例如把 1 月的文件复制成 2 月）的文件
/// 会把数据写到错误的月份去。
fn parse_month(raw: &str, month: &MonthKey, path: &Path) -> Result<MonthlyStats> {
    let mut stats: MonthlyStats = serde_json::from_str(raw).map_err(|e| YuhuaError::Parse {
        context: "统计文件",
        message: format!("{}：{e}", path.display()),
    })?;

    // 月份不符时以调用方给出的月份为准
    stats.month = month.to_string();

    // schema 缺失（手写或截断的文件）时补上当前版本：统计文件是自描述的，
    // 一个连 schema 都没有的文件只可能是「同步到一半」或用户手搓的，
    // 按当前版本对待比留在 0 更不容易让上层误判为需要降级迁移。
    if stats.schema == 0 {
        stats.schema = STATS_SCHEMA;
    }

    // 越界的日期键（例如手改成 2026-02-30 的非法值）在 serde 阶段就会失败；
    // 这里不再按月份过滤日期，因为合并规则是并集，丢弃数据比多留一条更危险。
    Ok(stats)
}

/// 从统计文件名解析月份，形如 daily-2026-01.json。
///
/// 文件名不匹配时返回 None（可能是冲突副本，或用户放进来的无关文件）。
pub fn parse_month_file_name(name: &str) -> Option<MonthKey> {
    let stem = name
        .strip_prefix(STATS_FILE_PREFIX)?
        .strip_suffix(STATS_FILE_SUFFIX)?;
    MonthKey::parse(stem).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::tests::{day, ts};
    use crate::model::Session;

    /// 建一个临时工作区并返回仓库。
    fn store() -> (tempfile::TempDir, StatsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        (dir, store)
    }

    fn jan() -> MonthKey {
        MonthKey::new(2026, 1).unwrap()
    }

    fn sample() -> MonthlyStats {
        let mut s = MonthlyStats::new(&jan());
        {
            let d = s.day_mut(day(2026, 1, 15));
            d.add_chapter_delta("ch_1", 1520).unwrap();
            d.push_session(Session::new(ts(2026, 1, 15, 9, 12), 47, 1520, &[]));
            d.set_goal(Some(3000), ts(2026, 1, 15, 9, 12));
        }
        s
    }

    #[test]
    fn path_is_under_engine_stats_dir() {
        let (_tmp, store) = store();
        let p = store.path_for(&jan());
        assert!(p.ends_with("daily-2026-01.json"), "{}", p.display());
        assert!(p.to_string_lossy().contains(".yuhua"));
        assert!(p.to_string_lossy().contains("stats"));
    }

    #[test]
    fn load_missing_file_returns_empty_month() {
        let (_tmp, store) = store();
        let stats = store.load(&jan()).unwrap();
        assert_eq!(stats.month, "2026-01");
        assert_eq!(stats.schema, STATS_SCHEMA);
        assert!(stats.days.is_empty(), "首次运行不该报错");
    }

    #[test]
    fn save_then_load_roundtrips() {
        let (_tmp, store) = store();
        let stats = sample();
        store.save(&stats).unwrap();
        let back = store.load(&jan()).unwrap();
        assert_eq!(back, stats);
    }

    #[test]
    fn save_creates_parent_directory() {
        let (_tmp, store) = store();
        assert!(!store.dir().exists());
        store.save(&sample()).unwrap();
        assert!(store.dir().exists(), "保存时应自动建目录");
    }

    #[test]
    fn save_writes_pretty_json_and_leaves_no_temp_files() {
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();
        let raw = fs::read_to_string(store.path_for(&jan())).unwrap();
        assert!(raw.contains('\n'), "统计文件应当是缩进过的可读 JSON");
        assert!(raw.contains("\"schema\": 1"), "实际：{raw}");

        // 原子写的临时文件必须被清理干净，否则会被云盘同步出去
        let leftovers: Vec<_> = fs::read_dir(store.dir())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn save_prunes_empty_days_before_writing() {
        let (_tmp, store) = store();
        let mut stats = sample();
        stats.day_mut(day(2026, 1, 1)); // 空壳
        store.save(&stats).unwrap();

        let back = store.load(&jan()).unwrap();
        assert!(
            back.day(day(2026, 1, 1)).is_none(),
            "空壳记录不该被写进文件"
        );
        assert!(back.day(day(2026, 1, 15)).is_some());
    }

    #[test]
    fn save_rejects_unparsable_month_field() {
        let (_tmp, store) = store();
        let mut stats = sample();
        stats.month = "2026-13".into();
        let err = store.save(&stats).unwrap_err();
        assert_eq!(err.code(), "INVARIANT_VIOLATION");
    }

    #[test]
    fn save_normalizes_schema_version() {
        let (_tmp, store) = store();
        let mut stats = sample();
        stats.schema = 99;
        store.save(&stats).unwrap();
        let back = store.load(&jan()).unwrap();
        assert_eq!(
            back.schema, STATS_SCHEMA,
            "当前版本写出的文件应当标当前版本"
        );
    }

    #[test]
    fn load_reports_corrupt_json_as_parse_error() {
        let (_tmp, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.path_for(&jan()), "{ 这不是 JSON").unwrap();

        let err = store.load(&jan()).unwrap_err();
        assert_eq!(err.code(), "PARSE_ERROR");
        assert!(err.to_string().contains("daily-2026-01.json"));
    }

    #[test]
    fn load_overrides_month_field_with_file_name() {
        // 用户把 2 月的文件复制成了 1 月的名字：以文件名为准
        let (_tmp, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        let raw = r#"{"schema":1,"month":"2026-02","days":{}}"#;
        fs::write(store.path_for(&jan()), raw).unwrap();

        let stats = store.load(&jan()).unwrap();
        assert_eq!(stats.month, "2026-01");
    }

    #[test]
    fn load_allows_degenerate_document() {
        let (_tmp, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.path_for(&jan()), "{}").unwrap();

        // schema 与 month 缺失都不应崩：给可用的兜底值即可
        let stats = store.load(&jan()).unwrap();
        assert_eq!(stats.schema, STATS_SCHEMA);
        assert_eq!(stats.month, "2026-01");
        assert!(stats.days.is_empty());
    }

    #[test]
    fn update_reads_modifies_and_persists() {
        let (_tmp, store) = store();
        let summary = store
            .update(&jan(), |s| {
                s.day_mut(day(2026, 1, 15))
                    .add_chapter_delta("ch_1", 500)
                    .unwrap();
            })
            .unwrap();
        assert_eq!(summary.total_words(), 500);
        assert_eq!(store.load(&jan()).unwrap().total_words(), 500);

        // 再来一次：增量取 max，不会翻倍
        store
            .update(&jan(), |s| {
                s.day_mut(day(2026, 1, 15))
                    .add_chapter_delta("ch_1", 300)
                    .unwrap();
            })
            .unwrap();
        assert_eq!(store.load(&jan()).unwrap().total_words(), 500);
    }

    #[test]
    fn update_on_missing_file_starts_from_empty() {
        let (_tmp, store) = store();
        store
            .update(&jan(), |s| {
                s.day_mut(day(2026, 1, 2))
                    .add_chapter_delta("ch_1", 42)
                    .unwrap();
            })
            .unwrap();
        assert_eq!(store.load(&jan()).unwrap().total_words(), 42);
    }

    #[test]
    fn months_lists_only_canonical_files() {
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();
        store
            .save(&MonthlyStats::new(&MonthKey::new(2026, 2).unwrap()))
            .unwrap();

        // 塞几个干扰文件
        fs::write(store.dir().join("daily-2026-03.json.bak"), "{}").unwrap();
        fs::write(store.dir().join("readme.txt"), "hello").unwrap();
        fs::write(store.dir().join("daily-坏月份.json"), "{}").unwrap();

        let months = store.months().unwrap();
        assert_eq!(months, vec![jan(), MonthKey::new(2026, 2).unwrap()]);
    }

    #[test]
    fn months_is_empty_before_first_write() {
        let (_tmp, store) = store();
        assert!(store.months().unwrap().is_empty());
    }

    #[test]
    fn load_all_days_merges_across_months() {
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();

        let mut feb = MonthlyStats::new(&MonthKey::new(2026, 2).unwrap());
        feb.day_mut(day(2026, 2, 3))
            .add_chapter_delta("ch_9", 800)
            .unwrap();
        store.save(&feb).unwrap();

        let days = store.load_all_days().unwrap();
        assert_eq!(days.len(), 2);
        assert_eq!(days[&day(2026, 1, 15)].words(), 1520);
        assert_eq!(days[&day(2026, 2, 3)].words(), 800);
    }

    #[test]
    fn load_merged_includes_conflict_copy() {
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();

        // 模拟坚果云产生的冲突副本
        let mut copy = MonthlyStats::new(&jan());
        copy.day_mut(day(2026, 1, 15))
            .add_chapter_delta("ch_2", 700)
            .unwrap();
        copy.day_mut(day(2026, 1, 16))
            .add_chapter_delta("ch_3", 100)
            .unwrap();
        let name = "daily-2026-01 (冲突副本 2026-01-16).json";
        fs::write(
            store.dir().join(name),
            serde_json::to_string(&copy).unwrap(),
        )
        .unwrap();

        let merged = store.load_merged(&jan()).unwrap();
        assert_eq!(merged.day(day(2026, 1, 15)).unwrap().words(), 1520 + 700);
        assert_eq!(merged.day(day(2026, 1, 16)).unwrap().words(), 100);
        // 原始文件必须原封不动躺在那里
        assert!(store.dir().join(name).exists(), "冲突副本绝不能被删除");
    }

    #[test]
    fn load_merged_handles_syncthing_suffix() {
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();

        let mut copy = MonthlyStats::new(&jan());
        copy.day_mut(day(2026, 1, 15))
            .add_chapter_delta("ch_2", 300)
            .unwrap();
        let name = "daily-2026-01.sync-conflict-20260116-090000-ABCDEF.json";
        fs::write(
            store.dir().join(name),
            serde_json::to_string(&copy).unwrap(),
        )
        .unwrap();

        let merged = store.load_merged(&jan()).unwrap();
        assert_eq!(merged.day(day(2026, 1, 15)).unwrap().words(), 1820);
        assert_eq!(store.conflict_copy_count().unwrap(), 1);
    }

    #[test]
    fn load_merged_ignores_corrupt_conflict_copy() {
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();
        // 云盘可能同步到半截文件，不能让整次加载失败
        fs::write(
            store.dir().join("daily-2026-01 (冲突副本 2026-01-16).json"),
            "{半截",
        )
        .unwrap();

        let merged = store.load_merged(&jan()).unwrap();
        assert_eq!(merged.day(day(2026, 1, 15)).unwrap().words(), 1520);
    }

    #[test]
    fn load_merged_never_deletes_anything() {
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();
        let name = "daily-2026-01 (副本).json";
        fs::write(store.dir().join(name), "{}").unwrap();

        let before: Vec<_> = fs::read_dir(store.dir())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        store.load_merged(&jan()).unwrap();
        let after: Vec<_> = fs::read_dir(store.dir())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(before, after, "读取操作绝不能改动磁盘");
    }

    #[test]
    fn conflict_copies_of_ignores_other_months() {
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();
        fs::write(store.dir().join("daily-2026-02 (副本).json"), "{}").unwrap();

        let found = store.conflict_copies_of(&jan()).unwrap();
        assert!(found.is_empty(), "不该把别的月份当成 1 月的冲突副本");
    }

    #[test]
    fn conflict_copies_of_when_dir_missing() {
        let (_tmp, store) = store();
        assert!(store.conflict_copies_of(&jan()).unwrap().is_empty());
        assert_eq!(store.conflict_copy_count().unwrap(), 0);
    }

    #[test]
    fn parse_month_file_name_accepts_canonical_only() {
        assert_eq!(parse_month_file_name("daily-2026-01.json"), Some(jan()));
        assert_eq!(parse_month_file_name("daily-2026-1.json"), None);
        assert_eq!(parse_month_file_name("daily-2026-01.JSON"), None);
        assert_eq!(parse_month_file_name("2026-01.json"), None);
        assert_eq!(parse_month_file_name("daily-2026-01.json.bak"), None);
        assert_eq!(parse_month_file_name("daily-坏.json"), None);
    }

    #[test]
    fn saving_two_months_does_not_touch_each_other() {
        // 计划书 10.4 节：跨月文件按文件名分片，互不影响
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();
        let feb_key = MonthKey::new(2026, 2).unwrap();
        store
            .update(&feb_key, |s| {
                s.day_mut(day(2026, 2, 1))
                    .add_chapter_delta("ch_9", 5)
                    .unwrap();
            })
            .unwrap();

        let jan_after = store.load(&jan()).unwrap();
        assert_eq!(jan_after, sample(), "写 2 月不该改动 1 月的数据");
    }

    #[test]
    fn repeated_saves_produce_identical_bytes() {
        // 同一份数据反复保存，文件内容必须逐字节相同，
        // 否则云盘会把每次保存都当成一次真实的修改
        let (_tmp, store) = store();
        store.save(&sample()).unwrap();
        let first = fs::read_to_string(store.path_for(&jan())).unwrap();
        store.save(&sample()).unwrap();
        let second = fs::read_to_string(store.path_for(&jan())).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn chinese_content_survives_roundtrip() {
        // 中文多字节：章节 ID 被用户改成中文、文件名带中文，
        // 都不能导致写入失败或读回乱码
        let (_tmp, store) = store();
        let mut stats = MonthlyStats::new(&jan());
        stats
            .day_mut(day(2026, 1, 5))
            .add_chapter_delta("第一章", 1234)
            .unwrap();
        store.save(&stats).unwrap();

        let back = store.load(&jan()).unwrap();
        assert_eq!(back.day(day(2026, 1, 5)).unwrap().words(), 1234);
        let raw = fs::read_to_string(store.path_for(&jan())).unwrap();
        assert!(
            raw.contains("第一章") || raw.contains("\\u7b2c"),
            "实际：{raw}"
        );
    }
}
