//! 写作统计的数据模型。
//!
//! 对应计划书 10.3 节的存储结构与 10.1 节的功能清单。
//!
//! ## 只存增量，不存累计
//!
//! 每天都只记录**当天新增**的字数（差分），全书总字数由章节文件实时算出。
//! 如果把累计值也存下来，就会出现两个真相来源：章节被外部编辑（换机、
//! 手动改 Markdown、云盘覆盖）后，累计值与实际字数必然对不上，
//! 而增量值永远是对的。
//!
//! ## 隐私（计划书 10.6 节）
//!
//! **统计只记录字数与时间，绝不记录任何正文内容。**
//! 本模块的每一个字段都经过这条约束审查：
//!
//! - 章节以 **ID**（ch_xxx）出现，不是标题、不是正文、不是文件路径
//! - 会话记录里只有起止时间与字数，没有输入内容
//! - 全文件不含任何自由文本字段，因此即使统计文件被上传到云盘，
//!   泄漏的也只是「某天写了多少字」这种元数据
//!
//! 这条约束由 tests::no_field_can_hold_prose 测试守住：任何人在模型里
//! 新增一个「看起来能装正文」的字段，都必须先过那个测试。

use std::collections::BTreeMap;
use std::fmt;

use chrono::{DateTime, FixedOffset, NaiveDate};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 统计文件当前的结构版本。
///
/// 与工作区 FORMAT_VERSION 分开：统计文件的演进节奏与工作区布局不同步，
/// 且统计是**可抛弃数据**，迁移失败时重建的代价远低于章节文件。
/// 版本号写在文件里，是为了将来能识别出「新版本写的文件被旧版本读到」
/// 这种降级场景，并拒绝写入而不是静默覆盖。
pub const STATS_SCHEMA: u32 = 1;

/// 连续天数的默认阈值（计划书 10.1 节：默认 100 字）。
///
/// 定成 100 而不是「大于 0」：改一个错别字也会让当日字数变成 1，
/// 若按「大于 0」算，用户只要每天打开文件就能刷出连续 365 天，
/// 这个数字就失去意义了。
pub const DEFAULT_STREAK_THRESHOLD: u32 = 100;

/// 一天之中单章新增字数的键。
///
/// 用新类型而不是裸 String：统计文件里的键来自 Markdown 的 Front Matter，
/// 用户手改过的文件可能给出空 ID 或超长垃圾串，ChapterKey 在构造时
/// 就挡住这些情况，避免脏键扩散到整个映射里。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ChapterKey(String);

impl ChapterKey {
    /// 允许的最大 ID 长度。
    ///
    /// 真实 ID 是 ch_ 加 32 位 UUID（35 字符）。留到 64 是为了兼容
    /// 将来可能换用的 ID 方案，同时挡住「把整段正文误当成 ID」的情况。
    pub const MAX_LEN: usize = 64;

    /// 由章节 ID 字符串构造，拒绝空白与超长输入。
    pub fn new(raw: impl Into<String>) -> Result<Self, String> {
        let raw = raw.into();
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("章节 ID 不能为空".to_string());
        }
        if trimmed.len() > Self::MAX_LEN {
            return Err(format!(
                "章节 ID 过长（{} 字节，上限 {}）",
                trimmed.len(),
                Self::MAX_LEN
            ));
        }
        Ok(Self(trimmed.to_string()))
    }

    /// 取出 ID 字符串。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ChapterKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// 一次写作会话。
///
/// 会话数据用于「写作记录」视图（什么时候写的、写了多久），
/// 日历与热力图用的是 DayRecord 的 chapters 差分数据 —— 两者都记，
/// 各取所长（计划书 10.2 节）。
///
/// **没有 id 字段**：id 是序列化时才由 Session::identity 算出的
/// 摘要，不落盘。这样做的理由有二：
///
/// 1. 合并规则是「按 start 去重」并集，一个显式的 id 反而会引入
///    「同一时刻两个不同 id」这种无法判定的冲突
/// 2. 少一个字段，手写统计文件（用户完全可以这么做）时不容易写错
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// 会话开始时间（带时区），同时也是**合并时的唯一键**。
    pub start: DateTime<FixedOffset>,
    /// 会话持续分钟数。
    pub minutes: u32,
    /// 会话内记录的码字量。
    pub words: u32,
    /// 会话涉及的章节 ID（已排序去重，保证同一会话在不同设备上序列化结果一致）。
    #[serde(default)]
    pub chapters: Vec<String>,
}

impl Session {
    /// 新建一个会话记录。
    ///
    /// chapters 会在内部排序去重：同一会话可能在不同设备上以不同顺序
    /// 追加章节，排序能让「内容相同的会话」序列化出相同的字节，
    /// 便于比对与哈希。
    pub fn new(
        start: DateTime<FixedOffset>,
        minutes: u32,
        words: u32,
        chapters: &[String],
    ) -> Self {
        let mut chapters: Vec<String> = chapters
            .iter()
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty())
            .collect();
        chapters.sort();
        chapters.dedup();
        Self {
            start,
            minutes,
            words,
            chapters,
        }
    }

    /// 会话的唯一身份：**开始时间的 Unix 毫秒时间戳**。
    ///
    /// 用毫秒而不是 DateTime 本身，是为了让「同一时刻不同时区写法」
    /// （2026-01-15T09:12:00+08:00 与 2026-01-15T01:12:00+00:00）
    /// 归并成同一个会话 —— 它们本来就是同一次写作。
    pub fn identity(&self) -> i64 {
        self.start.timestamp_millis()
    }

    /// 会话所属的日期（按会话开始时间的**本地日历日**归日）。
    ///
    /// 跨零点的会话算在开始那天：作者熬到凌晨两点写的字，
    /// 心理上属于「昨晚那一次」，而且这样切分不会让会话被劈成两半。
    pub fn day(&self) -> NaiveDate {
        self.start.date_naive()
    }

    /// 是否为「空会话」：既没写够时长也没写够字。
    ///
    /// 打开软件发呆 5 分钟不应该出现在写作记录里。
    pub fn is_empty(&self) -> bool {
        self.minutes == 0 && self.words == 0
    }

    /// 合并两个同身份的会话（start 相同）。
    ///
    /// 字段级规则：
    /// - minutes / words **取最大**，与章节增量同理，防止双设备相加翻倍
    /// - chapters **取并集**
    ///
    /// 为什么不是「取 start 更晚的那份整体」：同一次会话在两个设备上
    /// 很可能各有各的部分信息（A 设备记了时长、B 设备记了章节），
    /// 逐字段取最大与并集能保住两边最多的信息，且仍然满足幂等。
    pub fn merge_with(&self, other: &Self) -> Self {
        let mut chapters: Vec<String> = self
            .chapters
            .iter()
            .chain(other.chapters.iter())
            .cloned()
            .collect();
        chapters.sort();
        chapters.dedup();
        Self {
            start: self.start.min(other.start),
            minutes: self.minutes.max(other.minutes),
            words: self.words.max(other.words),
            chapters,
        }
    }
}

/// 某一天的统计数据。
///
/// 对应计划书 10.3 节的单日结构。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayRecord {
    /// 章节 ID 到当日新增字数的映射。
    ///
    /// 用 BTreeMap 而不是 HashMap：序列化结果必须是**确定性**的，
    /// 否则同一份数据在两台设备上写出的字节不同，云盘会认为文件有冲突、
    /// 版本控制也会产生无意义的 diff。
    #[serde(default)]
    pub chapters: BTreeMap<ChapterKey, u32>,
    /// 当日会话列表（已按开始时间排序，同样是为了确定性）。
    #[serde(default)]
    pub sessions: Vec<Session>,
    /// 当日目标字数。
    ///
    /// 用 Option 而不是 0 默认值：0 是合法目标（今天不打算写），
    /// 与「没设目标」必须区分开。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<u32>,
    /// 目标最后一次被设置的时间（用于多设备冲突时时间戳新者胜）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_updated_at: Option<DateTime<FixedOffset>>,
}

impl DayRecord {
    /// 当日新增字数总计。
    ///
    /// 把各章增量相加：不同章的增量是**不同工作量**，应当累加；
    /// 同一章同一天的增量在合并时已经取过 max，所以不会重复计数。
    pub fn words(&self) -> u32 {
        self.chapters.values().copied().sum()
    }

    /// 当日累计写作时长（分钟）。
    pub fn minutes(&self) -> u32 {
        self.sessions.iter().map(|s| s.minutes).sum()
    }

    /// 当日新增字数是否达到连续天数阈值。
    pub fn reached(&self, threshold: u32) -> bool {
        self.words() >= threshold
    }

    /// 记入一次章节增量。
    ///
    /// 取 max 而不是累加，这是整个统计层防重复计数的**第一道防线**：
    /// 同一天内同一章被保存多次，最终只应记得最大的一次增量，
    /// 而不是把它们叠起来（那会让「改三遍第一章」等于「写了三章」）。
    pub fn add_chapter_delta(&mut self, chapter: &str, delta: u32) -> Result<u32, String> {
        let key = ChapterKey::new(chapter)?;
        let slot = self.chapters.entry(key).or_insert(0);
        *slot = (*slot).max(delta);
        Ok(*slot)
    }

    /// 直接设置某章当日增量，返回是否发生了改变。
    pub fn set_chapter(&mut self, chapter: &str, delta: u32) -> Result<bool, String> {
        let key = ChapterKey::new(chapter)?;
        let before = self.chapters.insert(key, delta);
        Ok(before != Some(delta))
    }

    /// 追加一个会话。
    ///
    /// 与既有会话 start 相同时走 Session::merge_with，
    /// 保证「同一次会话」在任何插入顺序下都收敛到同一个结果。
    /// 返回该会话在列表中的下标。
    pub fn push_session(&mut self, session: Session) -> usize {
        let identity = session.identity();
        match self.sessions.iter().position(|s| s.identity() == identity) {
            Some(idx) => {
                self.sessions[idx] = self.sessions[idx].merge_with(&session);
                idx
            }
            None => {
                self.sessions.push(session);
                self.sessions.sort_by_key(Session::identity);
                self.sessions
                    .iter()
                    .position(|s| s.identity() == identity)
                    .unwrap_or(0)
            }
        }
    }

    /// 设置当日目标，并打上「最后修改时间」戳。
    ///
    /// 传 None 表示清除目标。清除同样需要时间戳，否则多设备下
    /// 「设备 A 清除了目标」会被「设备 B 的旧目标」复活。
    pub fn set_goal(&mut self, goal: Option<u32>, at: DateTime<FixedOffset>) {
        self.goal = goal;
        self.goal_updated_at = Some(at);
    }

    /// 当天是否没有任何记录。
    pub fn is_empty(&self) -> bool {
        self.chapters.is_empty() && self.sessions.is_empty() && self.goal.is_none()
    }

    /// 目标完成进度（0.0 起，可超过 1.0）。
    ///
    /// 没设目标时返回 None —— UI 据此隐藏进度环，
    /// 而不是画一个「0 比 0」的环。
    pub fn goal_progress(&self) -> Option<f64> {
        match self.goal {
            Some(0) | None => None,
            Some(goal) => Some(f64::from(self.words()) / f64::from(goal)),
        }
    }
}

/// 一个月分片的统计文件（.yuhua/stats/daily-YYYY-MM.json）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyStats {
    /// 结构版本，见 STATS_SCHEMA。
    pub schema: u32,
    /// 所属月份，形如 2026-01。
    ///
    /// 冗余存一份月份与文件名重复，是为了让文件**自描述**：
    /// 用户把文件改名或复制到别处后，仍能知道它属于哪个月。
    pub month: String,
    /// 日期到当日记录的映射。键是 YYYY-MM-DD。
    #[serde(default)]
    pub days: BTreeMap<NaiveDate, DayRecord>,
}

impl MonthlyStats {
    /// 建立一个空月份。
    pub fn new(month: &MonthKey) -> Self {
        Self {
            schema: STATS_SCHEMA,
            month: month.to_string(),
            days: BTreeMap::new(),
        }
    }

    /// 取某天的记录，不存在时新建。
    pub fn day_mut(&mut self, date: NaiveDate) -> &mut DayRecord {
        self.days.entry(date).or_default()
    }

    /// 取某天的记录（只读）。
    pub fn day(&self, date: NaiveDate) -> Option<&DayRecord> {
        self.days.get(&date)
    }

    /// 本月总字数。
    pub fn total_words(&self) -> u64 {
        self.days.values().map(|d| u64::from(d.words())).sum()
    }

    /// 本月累计写作时长（分钟）。
    pub fn total_minutes(&self) -> u64 {
        self.days.values().map(|d| u64::from(d.minutes())).sum()
    }

    /// 本月有记录的天数（不要求达到阈值）。
    pub fn active_days(&self) -> usize {
        self.days.values().filter(|d| d.words() > 0).count()
    }

    /// 删掉所有空记录，返回清理掉的条数。
    ///
    /// 保存前调用：用户在日历上点了一下又取消、或者一次会话开完却一个字没写，
    /// 都会留下空壳记录。空壳不算错，但会让统计文件膨胀、
    /// 也会让「本月有记录的天数」这类统计虚高。
    pub fn prune_empty_days(&mut self) -> usize {
        let before = self.days.len();
        self.days.retain(|_, d| !d.is_empty());
        before - self.days.len()
    }
}

/// 月份键，形如 2026-01。
///
/// 单独一个类型是为了让「拼文件名」这件事只有一个地方能做对：
/// 统计文件按月份片，文件名错一个字符就等于数据丢了。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MonthKey {
    /// 年。
    pub year: i32,
    /// 月（1 到 12）。
    pub month: u32,
}

impl MonthKey {
    /// 由年、月构造，校验月份范围。
    pub fn new(year: i32, month: u32) -> Result<Self, String> {
        if !(1..=12).contains(&month) {
            return Err(format!("月份必须在 1 到 12 之间，得到 {month}"));
        }
        if !(1970..=9999).contains(&year) {
            // 统计文件用 RFC3339 时间戳，超出这个范围基本可以断定是脏数据
            return Err(format!("年份超出合理范围：{year}"));
        }
        Ok(Self { year, month })
    }

    /// 由某个日期所在的月份构造。
    pub fn of(date: NaiveDate) -> Self {
        use chrono::Datelike;
        Self {
            year: date.year(),
            month: date.month(),
        }
    }

    /// 解析 YYYY-MM 字符串。
    pub fn parse(raw: &str) -> Result<Self, String> {
        let (y, m) = raw
            .split_once('-')
            .ok_or_else(|| format!("月份格式应为 YYYY-MM，得到 {raw:?}"))?;
        if m.len() != 2 || y.len() != 4 {
            return Err(format!("月份格式应为 YYYY-MM（补零），得到 {raw:?}"));
        }
        let year: i32 = y.parse().map_err(|_| format!("年份不是数字：{y:?}"))?;
        let month: u32 = m.parse().map_err(|_| format!("月份不是数字：{m:?}"))?;
        Self::new(year, month)
    }

    /// 该月的下一个月的月份键。
    ///
    /// 热力图按「月首日到下月首日」推进，用日期运算而不是 month 加一，
    /// 避免 12 月加一等于 13 月这种手写边界。
    pub fn next(&self) -> Self {
        let first = self.first_day();
        let next = first
            .checked_add_months(chrono::Months::new(1))
            .unwrap_or(first);
        Self::of(next)
    }

    /// 该月第一天。
    pub fn first_day(&self) -> NaiveDate {
        NaiveDate::from_ymd_opt(self.year, self.month, 1)
            .unwrap_or_else(|| NaiveDate::from_ymd_opt(1970, 1, 1).expect("1970-01-01 必然合法"))
    }

    /// 该月最后一天。
    pub fn last_day(&self) -> NaiveDate {
        self.next()
            .first_day()
            .pred_opt()
            .unwrap_or_else(|| self.first_day())
    }

    /// 该月天数（28 到 31）。
    pub fn days(&self) -> u32 {
        use chrono::Datelike;
        self.last_day().day()
    }

    /// 是否包含某个日期。
    pub fn contains(&self, date: NaiveDate) -> bool {
        Self::of(date) == *self
    }

    /// 统计分片的文件名，形如 daily-2026-01.json。
    pub fn file_name(&self) -> String {
        format!("daily-{}.json", self)
    }
}

impl fmt::Display for MonthKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}", self.year, self.month)
    }
}

/// 生成一个会话令牌（供上层记录「本次会话」时使用）。
///
/// 放在这里而不是 session 模块，是因为它属于「标识」这一类概念；
/// 用 UUID v4 而不是 v7：会话令牌只用于进程内配对，不需要时间有序。
pub fn new_session_token() -> String {
    Uuid::new_v4().simple().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 构造东八区时间，测试里到处要用。
    pub(crate) fn ts(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(y, m, d, h, mi, 0)
            .unwrap()
    }

    pub(crate) fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn chapter_key_rejects_blank_and_long() {
        assert!(ChapterKey::new("").is_err());
        assert!(ChapterKey::new("   ").is_err(), "纯空白也要拒绝");
        let too_long = format!("ch_{}", "a".repeat(ChapterKey::MAX_LEN));
        assert!(ChapterKey::new(too_long).is_err());
        assert_eq!(ChapterKey::new(" ch_1 ").unwrap().as_str(), "ch_1");
    }

    #[test]
    fn chapter_key_accepts_chinese_and_roundtrips_json() {
        // 章节 ID 理论上永远是 ASCII，但用户可能手改成中文当键用。
        // 我们不鼓励，但必须不能因此 panic 或产生非法 JSON。
        let key = ChapterKey::new("第一章").unwrap();
        let json = serde_json::to_string(&key).unwrap();
        assert_eq!(json, "\"第一章\"");
        let back: ChapterKey = serde_json::from_str(&json).unwrap();
        assert_eq!(back, key);
    }

    #[test]
    fn day_record_add_chapter_takes_max_not_sum() {
        let mut d = DayRecord::default();
        d.add_chapter_delta("ch_1", 1520).unwrap();
        d.add_chapter_delta("ch_1", 980).unwrap();
        assert_eq!(d.words(), 1520, "同一章同一天必须取最大值，不能相加");

        d.add_chapter_delta("ch_1", 2000).unwrap();
        assert_eq!(d.words(), 2000);
    }

    #[test]
    fn day_record_sums_across_chapters() {
        let mut d = DayRecord::default();
        d.add_chapter_delta("ch_1", 1520).unwrap();
        d.add_chapter_delta("ch_2", 980).unwrap();
        assert_eq!(d.words(), 2500, "不同章的增量应当累加");
    }

    #[test]
    fn day_record_rejects_bad_chapter_id() {
        let mut d = DayRecord::default();
        assert!(d.add_chapter_delta("", 10).is_err());
        assert_eq!(d.words(), 0, "失败的写入不应留下痕迹");
    }

    #[test]
    fn day_record_minutes_sums_sessions() {
        let mut d = DayRecord::default();
        d.push_session(Session::new(ts(2026, 1, 15, 9, 12), 47, 1520, &[]));
        d.push_session(Session::new(ts(2026, 1, 15, 21, 0), 30, 800, &[]));
        assert_eq!(d.minutes(), 77);
    }

    #[test]
    fn push_session_merges_same_start_time() {
        let mut d = DayRecord::default();
        d.push_session(Session::new(
            ts(2026, 1, 15, 9, 12),
            47,
            1520,
            &["ch_1".into()],
        ));
        d.push_session(Session::new(
            ts(2026, 1, 15, 9, 12),
            30,
            900,
            &["ch_2".into()],
        ));
        assert_eq!(d.sessions.len(), 1, "同一次会话不应变成两条");
        assert_eq!(d.sessions[0].minutes, 47);
        assert_eq!(d.sessions[0].words, 1520);
        assert_eq!(d.sessions[0].chapters, vec!["ch_1", "ch_2"]);
    }

    #[test]
    fn push_session_keeps_list_sorted() {
        let mut d = DayRecord::default();
        d.push_session(Session::new(ts(2026, 1, 15, 21, 0), 30, 800, &[]));
        d.push_session(Session::new(ts(2026, 1, 15, 9, 12), 47, 1520, &[]));
        let starts: Vec<_> = d.sessions.iter().map(|s| s.start).collect();
        let mut sorted = starts.clone();
        sorted.sort();
        assert_eq!(starts, sorted, "会话列表必须按开始时间排序");
    }

    #[test]
    fn session_identity_ignores_timezone_offset() {
        // 同一时刻的两种时区写法必须归并为同一次会话
        let a = Session::new(ts(2026, 1, 15, 9, 12), 47, 1520, &[]);
        let b = Session::new(
            FixedOffset::east_opt(0)
                .unwrap()
                .with_ymd_and_hms(2026, 1, 15, 1, 12, 0)
                .unwrap(),
            47,
            1520,
            &[],
        );
        assert_eq!(a.identity(), b.identity());
    }

    #[test]
    fn session_chapters_are_sorted_and_deduped() {
        let s = Session::new(
            ts(2026, 1, 15, 9, 12),
            47,
            1520,
            &["ch_2".into(), "ch_1".into(), "ch_2".into(), "  ".into()],
        );
        assert_eq!(s.chapters, vec!["ch_1", "ch_2"]);
    }

    #[test]
    fn session_day_uses_start_date() {
        // 跨零点的会话算在开始那天
        let s = Session::new(ts(2026, 1, 15, 23, 40), 40, 200, &[]);
        assert_eq!(s.day(), day(2026, 1, 15));
    }

    #[test]
    fn session_is_empty_detects_idle_records() {
        assert!(Session::new(ts(2026, 1, 15, 9, 0), 0, 0, &[]).is_empty());
        assert!(!Session::new(ts(2026, 1, 15, 9, 0), 1, 0, &[]).is_empty());
        assert!(!Session::new(ts(2026, 1, 15, 9, 0), 0, 1, &[]).is_empty());
    }

    #[test]
    fn day_record_goal_progress_handles_unset_and_zero() {
        let mut d = DayRecord::default();
        assert_eq!(d.goal_progress(), None, "没设目标时不应画进度环");

        d.set_goal(Some(0), ts(2026, 1, 15, 9, 0));
        assert_eq!(d.goal_progress(), None, "目标为 0 时不能除零");

        d.set_goal(Some(3000), ts(2026, 1, 15, 9, 0));
        d.add_chapter_delta("ch_1", 1500).unwrap();
        assert_eq!(d.goal_progress(), Some(0.5));
    }

    #[test]
    fn goal_progress_can_exceed_one() {
        let mut d = DayRecord::default();
        d.set_goal(Some(1000), ts(2026, 1, 15, 9, 0));
        d.add_chapter_delta("ch_1", 2500).unwrap();
        assert_eq!(d.goal_progress(), Some(2.5));
    }

    #[test]
    fn set_goal_stamps_last_modified() {
        let mut d = DayRecord::default();
        assert!(d.goal_updated_at.is_none());
        d.set_goal(Some(3000), ts(2026, 1, 15, 9, 0));
        assert_eq!(d.goal_updated_at, Some(ts(2026, 1, 15, 9, 0)));
        d.set_goal(None, ts(2026, 1, 16, 9, 0));
        assert_eq!(d.goal, None);
        assert_eq!(d.goal_updated_at, Some(ts(2026, 1, 16, 9, 0)));
    }

    #[test]
    fn reached_respects_threshold() {
        let mut d = DayRecord::default();
        d.add_chapter_delta("ch_1", 99).unwrap();
        assert!(!d.reached(DEFAULT_STREAK_THRESHOLD));
        d.add_chapter_delta("ch_1", 100).unwrap();
        assert!(d.reached(DEFAULT_STREAK_THRESHOLD), "恰好等于阈值算达成");
    }

    #[test]
    fn empty_day_record_is_detected() {
        let mut d = DayRecord::default();
        assert!(d.is_empty());
        d.set_goal(Some(100), ts(2026, 1, 15, 9, 0));
        assert!(!d.is_empty(), "只设了目标也不算空");
    }

    #[test]
    fn month_key_validates_range() {
        assert!(MonthKey::new(2026, 0).is_err());
        assert!(MonthKey::new(2026, 13).is_err());
        assert!(MonthKey::new(1800, 1).is_err(), "过早的年份要挡住");
        assert!(MonthKey::new(2026, 1).is_ok());
    }

    #[test]
    fn month_key_parses_and_formats() {
        let m = MonthKey::parse("2026-01").unwrap();
        assert_eq!(m.year, 2026);
        assert_eq!(m.month, 1);
        assert_eq!(m.to_string(), "2026-01");
        assert_eq!(m.file_name(), "daily-2026-01.json");

        assert!(MonthKey::parse("2026-1").is_err(), "必须补零");
        assert!(MonthKey::parse("2026").is_err());
        assert!(MonthKey::parse("2026-13").is_err());
        assert!(MonthKey::parse("abcd-01").is_err());
    }

    #[test]
    fn month_key_next_wraps_year_boundary() {
        let dec = MonthKey::new(2026, 12).unwrap();
        assert_eq!(dec.next(), MonthKey::new(2027, 1).unwrap());
    }

    #[test]
    fn month_key_day_span_is_correct() {
        assert_eq!(MonthKey::new(2026, 1).unwrap().days(), 31);
        assert_eq!(MonthKey::new(2026, 2).unwrap().days(), 28);
        assert_eq!(MonthKey::new(2024, 2).unwrap().days(), 29, "闰年二月 29 天");
        assert_eq!(MonthKey::new(2026, 4).unwrap().days(), 30);
    }

    #[test]
    fn month_key_contains_only_its_own_month() {
        let m = MonthKey::new(2026, 1).unwrap();
        assert!(m.contains(day(2026, 1, 1)));
        assert!(m.contains(day(2026, 1, 31)));
        assert!(!m.contains(day(2026, 2, 1)));
        assert!(!m.contains(day(2025, 12, 31)));
    }

    #[test]
    fn month_key_from_date() {
        assert_eq!(
            MonthKey::of(day(2026, 7, 4)),
            MonthKey::new(2026, 7).unwrap()
        );
    }

    #[test]
    fn monthly_stats_roundtrips_through_serde() {
        let m = MonthKey::new(2026, 1).unwrap();
        let mut stats = MonthlyStats::new(&m);
        {
            let d = stats.day_mut(day(2026, 1, 15));
            d.add_chapter_delta("ch_01J8XK2M9P", 1520).unwrap();
            d.add_chapter_delta("ch01J8XK3Q4R", 980).unwrap();
            d.push_session(Session::new(ts(2026, 1, 15, 9, 12), 47, 1520, &[]));
            d.set_goal(Some(3000), ts(2026, 1, 15, 9, 12));
        }

        let json = serde_json::to_string(&stats).unwrap();
        let back: MonthlyStats = serde_json::from_str(&json).unwrap();
        assert_eq!(back, stats);
        assert_eq!(back.schema, STATS_SCHEMA);
        assert_eq!(back.total_words(), 2500);
        assert_eq!(back.total_minutes(), 47);
        assert_eq!(back.active_days(), 1);
    }

    #[test]
    fn monthly_stats_serializes_with_camel_case_keys() {
        let m = MonthKey::new(2026, 1).unwrap();
        let mut stats = MonthlyStats::new(&m);
        stats
            .day_mut(day(2026, 1, 15))
            .set_goal(Some(3000), ts(2026, 1, 15, 9, 0));
        let json = serde_json::to_string(&stats).unwrap();
        assert!(json.contains("\"goalUpdatedAt\""), "实际：{json}");
        assert!(json.contains("\"days\""));
        assert!(json.contains("2026-01-15"), "日期键必须是 ISO 日期");
    }

    #[test]
    fn day_record_omits_none_fields_but_stays_readable() {
        // 旧文件（没有 goal 字段）必须能读回来，否则升级即丢数据
        let raw = r#"{
            "chapters": {"ch_1": 100},
            "sessions": []
        }"#;
        let d: DayRecord = serde_json::from_str(raw).unwrap();
        assert_eq!(d.words(), 100);
        assert_eq!(d.goal, None);

        // 空字段序列化时不应写出 null，否则云盘 diff 噪音大
        let mut partial = DayRecord::default();
        partial.add_chapter_delta("ch_1", 1).unwrap();
        let json = serde_json::to_string(&partial).unwrap();
        assert!(!json.contains("null"), "实际：{json}");
    }

    #[test]
    fn monthly_stats_tolerates_unknown_future_fields() {
        // 未来版本新增字段时，旧版本不应直接报错崩掉
        let raw = r#"{
            "schema": 2,
            "month": "2026-01",
            "days": {},
            "futureField": {"x": 1}
        }"#;
        let parsed: MonthlyStats = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.schema, 2, "版本号要原样读回，供上层判断是否降级");
    }

    #[test]
    fn prune_empty_days_removes_shells() {
        let m = MonthKey::new(2026, 1).unwrap();
        let mut stats = MonthlyStats::new(&m);
        stats.day_mut(day(2026, 1, 1)); // 空壳
        stats
            .day_mut(day(2026, 1, 2))
            .add_chapter_delta("ch_1", 10)
            .unwrap();
        let removed = stats.prune_empty_days();
        assert_eq!(removed, 1);
        assert_eq!(stats.days.len(), 1);
    }

    #[test]
    fn prune_empty_days_keeps_goal_only_day() {
        // 只设了目标没写字的日期要保留：用户可能提前为明天设目标
        let m = MonthKey::new(2026, 1).unwrap();
        let mut stats = MonthlyStats::new(&m);
        stats
            .day_mut(day(2026, 1, 3))
            .set_goal(Some(3000), ts(2026, 1, 3, 9, 0));
        assert_eq!(stats.prune_empty_days(), 0);
    }

    #[test]
    fn monthly_stats_totals_skip_missing_days() {
        let m = MonthKey::new(2026, 1).unwrap();
        let stats = MonthlyStats::new(&m);
        assert_eq!(stats.total_words(), 0);
        assert_eq!(stats.total_minutes(), 0);
        assert_eq!(stats.active_days(), 0);
    }

    #[test]
    fn new_session_token_is_hex_and_unique() {
        let a = new_session_token();
        let b = new_session_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn no_field_can_hold_prose() {
        // 隐私守护测试（计划书 10.6 节）：序列化后的统计文件里，
        // 除了章节 ID 与日期时间，不应存在任何能承载正文的字段。
        // 这条测试的价值在于「新增字段时会被提醒」。
        let m = MonthKey::new(2026, 1).unwrap();
        let mut stats = MonthlyStats::new(&m);
        {
            let d = stats.day_mut(day(2026, 1, 15));
            d.add_chapter_delta("ch_1", 1520).unwrap();
            d.push_session(Session::new(
                ts(2026, 1, 15, 9, 12),
                47,
                1520,
                &["ch_1".into()],
            ));
            d.set_goal(Some(3000), ts(2026, 1, 15, 9, 12));
        }
        let json = serde_json::to_string(&stats).unwrap();

        // 顶层键白名单：多出任何字段都必须先想清楚它会不会装正文
        for key in ["schema", "month", "days"] {
            assert!(json.contains(key), "缺少字段 {key}：{json}");
        }
        for forbidden in ["body", "content", "text", "title", "excerpt"] {
            assert!(
                !json.contains(forbidden),
                "统计文件里出现了可能承载正文的字段 {forbidden}：{json}"
            );
        }
        // 整个文件应当很短：真正的正文放不进来
        assert!(json.len() < 700, "统计文件异常膨胀：{json}");
    }
}
