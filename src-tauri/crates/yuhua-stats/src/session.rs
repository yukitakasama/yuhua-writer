//! 写作会话记录（任务 T8.3，计划书 10.1 节的「写作记录」）。
//!
//! ## 会话解决什么问题
//!
//! 日历与热力图回答「哪天写了多少字」，但它们回答不了
//! 「我是怎么写出这些字的」—— 是每天雷打不动写两小时，
//! 还是周末突击十小时？只有会话数据能回答，因为会话带**时长**。
//!
//! ## 记录方式
//!
//! 上层（编辑器命令层）在以下时刻调用本模块：
//!
//! - 用户开始编辑：SessionTracker::begin
//! - 每次保存后：SessionTracker::add_words
//! - 失焦、切章、关闭：SessionTracker::end
//!
//! ## 与差分采集的关系（计划书 10.2 节）
//!
//! 两者**都记**，用途不同：
//!
//! | 数据 | 来源 | 用途 | 特点 |
//! | --- | --- | --- | --- |
//! | 差分 | collect 模块 | 日历、热力图 | 稳定，不受重启影响 |
//! | 会话 | 本模块 | 写作记录、时长统计 | 能体现时长，但崩溃会丢 |
//!
//! 计划书明确指出「日历与热力图用差分数据」。因此本模块写入的 words
//! **不参与**日历显示，避免两套数字互相矛盾。
//!
//! ## 判定会话结束
//!
//! 空闲超过 IDLE_TIMEOUT 就结束当前会话并开一段新的。
//! 这个阈值定成 5 分钟：
//!
//! - 太短（例如 30 秒）会把「想一会儿再写」切成几十段碎会话，
//!   写作记录页会变成一堆「1 分钟」的噪音
//! - 太长（例如 1 小时）会把「上午写一段、下午写一段」合并成一段
//!   虚假的五小时会话，时长统计直接失真

use chrono::{DateTime, FixedOffset, Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use yuhua_core::{Result, YuhuaError};

use crate::model::{MonthKey, Session, new_session_token};
use crate::store::StatsStore;

/// 判定会话结束的空闲阈值（秒）。
pub const IDLE_TIMEOUT_SECS: i64 = 300;

/// 一次会话最长持续时间（小时）的合理上限。
///
/// 单次会话超过 12 小时基本可以断定是「忘了关软件」，
/// 这种数据进了「累计写作时长」会把统计彻底带偏。
pub const MAX_SESSION_HOURS: i64 = 12;

/// 正在进行的会话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSession {
    /// 会话令牌，用于上层在多个窗口间配对同一次会话。
    pub token: String,
    /// 会话开始时间。
    pub start: DateTime<FixedOffset>,
    /// 最近一次活动时间（用于空闲判定）。
    pub last_activity: DateTime<FixedOffset>,
    /// 到目前为止累计的码字量。
    pub words: u32,
    /// 涉及的章节 ID。
    pub chapters: Vec<String>,
}

impl ActiveSession {
    /// 已经开始多久（分钟，向上取整并至少为 0）。
    pub fn elapsed_minutes(&self) -> u32 {
        let secs = (self.last_activity - self.start).num_seconds().max(0);
        ((secs + 59) / 60) as u32
    }

    /// 从上次活动到现在是否已经算空闲。
    pub fn is_idle(&self, now: DateTime<FixedOffset>) -> bool {
        (now - self.last_activity).num_seconds() > IDLE_TIMEOUT_SECS
    }

    /// 是否已经超过单次会话的合理上限。
    pub fn is_overlong(&self) -> bool {
        (self.last_activity - self.start).num_hours() >= MAX_SESSION_HOURS
    }

    /// 转成可落盘的会话记录。
    pub fn to_record(&self) -> Session {
        Session::new(
            self.start,
            self.elapsed_minutes(),
            self.words,
            &self.chapters,
        )
    }
}

/// 会话记录器。
///
/// 这是一个**纯内存**对象：它不持有文件句柄，也不自己写盘。
/// 落盘由 finish/suspend 显式触发。这样设计的原因：
///
/// - 每秒都在变化的字数不该每秒写盘（SSD 寿命与云盘流量都受不了）
/// - 崩溃时丢掉的只是「当前这一段的会话记录」，差分数据不受影响
#[derive(Debug, Clone, Default)]
pub struct SessionTracker {
    active: Option<ActiveSession>,
}

impl SessionTracker {
    /// 建立一个空闲的记录器。
    pub fn new() -> Self {
        Self { active: None }
    }

    /// 当前是否有会话在进行。
    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    /// 当前会话的只读视图。
    pub fn current(&self) -> Option<&ActiveSession> {
        self.active.as_ref()
    }

    /// 开始一次会话。
    ///
    /// 若已有会话在进行：
    ///
    /// - 未空闲：返回已有会话（同一个写作动作被重复触发，例如切章又切回）
    /// - 已空闲：先结束旧会话并返回它，再由调用方决定是否开新的
    ///
    /// 返回 `(本次活动的会话, 被挤出去的已完成会话)`。
    pub fn begin(
        &mut self,
        now: DateTime<FixedOffset>,
    ) -> (ActiveSession, Option<Session>) {
        if let Some(current) = self.active.as_ref() {
            if !current.is_idle(now) && !current.is_overlong() {
                // 会话仍在进行：把它交给调用方，避免同一段写作被切成多段
                return (current.clone(), None);
            }
        }

        let finished = self.active.take().map(|a| a.to_record());
        let session = ActiveSession {
            token: new_session_token(),
            start: now,
            last_activity: now,
            words: 0,
            chapters: Vec::new(),
        };
        self.active = Some(session.clone());
        (session, finished)
    }

    /// 向当前会话追加字数。
    ///
    /// 没有进行中的会话时会**自动开启**一段（作者可能直接开始打字，
    /// 没有经过任何显式的「开始写作」动作）。
    pub fn add_words(&mut self, chapter: &str, words: u32, now: DateTime<FixedOffset>) {
        let (session, _) = self.begin(now);
        let mut session = session;
        session.words = session.words.saturating_add(words);
        session.last_activity = now;
        if !chapter.trim().is_empty()
            && !session.chapters.iter().any(|c| c == chapter)
        {
            session.chapters.push(chapter.to_string());
            session.chapters.sort();
        }
        self.active = Some(session);
    }

    /// 记录一次活动（不增加字数，例如敲了退格键）。
    ///
    /// 刷新 last_activity 是必要的：作者在斟酌措辞时也在写作，
    /// 不该因为「这段时间没加字数」就把他判为离开。
    pub fn touch(&mut self, now: DateTime<FixedOffset>) {
        if let Some(session) = self.active.as_mut() {
            session.last_activity = now;
        }
    }

    /// 结束当前会话并返回它的记录。
    ///
    /// 空会话（0 字 0 分钟）返回 None：
    /// 点了两下编辑器就切走不该在写作记录里留一条记录。
    pub fn end(&mut self) -> Option<Session> {
        let active = self.active.take()?;
        let record = active.to_record();
        if record.is_empty() {
            None
        } else {
            Some(record)
        }
    }

    /// 结束会话并写入统计。
    ///
    /// 返回写入的会话（None 表示没有值得记录的内容）。
    /// 空记录不会触发任何磁盘写入。
    pub fn finish_and_store(&mut self, store: &StatsStore) -> Result<Option<Session>> {
        match self.end() {
            Some(record) => {
                store_session(store, &record)?;
                Ok(Some(record))
            }
            None => Ok(None),
        }
    }
}

/// 把一条会话记录写入它所归属的月份分片。
///
/// **归日规则：算在会话开始的那一天**（见 Session::day 的文档）。
/// 若一次会话跨越了月份边界（作者从 1 月 31 日写到 2 月 1 日），
/// 它整体归入开始那个月，不做拆分 —— 拆分会让它变成两条各半小时的
/// 会话，反而失真。
pub fn store_session(store: &StatsStore, record: &Session) -> Result<()> {
    if record.is_empty() {
        return Err(YuhuaError::InvalidInput(
            "空会话不该写入统计（0 字 0 分钟）".into(),
        ));
    }
    let day = record.day();
    let month = MonthKey::of(day);
    let record = record.clone();
    store.update(&month, |s| {
        s.day_mut(day).push_session(record);
    })?;
    Ok(())
}

/// 取某一天的会话列表（按开始时间升序）。
pub fn sessions_on(store: &StatsStore, day: NaiveDate) -> Result<Vec<Session>> {
    let stats = store.load(&MonthKey::of(day))?;
    Ok(stats.day(day).map(|d| d.sessions.clone()).unwrap_or_default())
}

/// 把一段时长（秒）转成分钟，**向上取整**。
///
/// 向上取整的理由：写了 61 秒记为 2 分钟，比记为 1 分钟更符合
/// 「我确实坐下来写了会儿」的感受；而若向下取整，写 59 秒会变成 0 分钟，
/// 整条会话的记录就看起来像是空的了。
pub fn secs_to_minutes_ceil(secs: i64) -> u32 {
    let secs = secs.max(0);
    ((secs + 59) / 60) as u32
}

/// 计算两个时刻之间的时长（分钟，向上取整）。
pub fn minutes_between(start: DateTime<FixedOffset>, end: DateTime<FixedOffset>) -> u32 {
    secs_to_minutes_ceil((end - start).num_seconds())
}

/// 判断两次活动之间是否需要断开成两段会话。
pub fn should_split(last: DateTime<FixedOffset>, now: DateTime<FixedOffset>) -> bool {
    let gap: Duration = now - last;
    gap.num_seconds() > IDLE_TIMEOUT_SECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::tests::{day, ts};

    fn store() -> (tempfile::TempDir, StatsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = StatsStore::at(dir.path());
        (dir, store)
    }

    #[test]
    fn begin_starts_a_new_session() {
        let mut tracker = SessionTracker::new();
        assert!(!tracker.is_active());
        let (session, finished) = tracker.begin(ts(2026, 1, 15, 9, 0));
        assert!(finished.is_none());
        assert_eq!(session.words, 0);
        assert!(tracker.is_active());
        assert_eq!(session.start, ts(2026, 1, 15, 9, 0));
    }

    #[test]
    fn begin_twice_without_idle_reuses_the_session() {
        // 切章又切回来不该把一段写作切成两段
        let mut tracker = SessionTracker::new();
        let (a, _) = tracker.begin(ts(2026, 1, 15, 9, 0));
        let (b, finished) = tracker.begin(ts(2026, 1, 15, 9, 1));
        assert!(finished.is_none());
        assert_eq!(a.token, b.token, "同一段写作应当复用同一个会话");
    }

    #[test]
    fn long_idle_gap_splits_the_session() {
        let mut tracker = SessionTracker::new();
        let (first, _) = tracker.begin(ts(2026, 1, 15, 9, 0));
        tracker.add_words("ch_1", 500, ts(2026, 1, 15, 9, 10));

        // 过了 10 分钟才再次动笔：上一段应当被结算
        let (second, finished) = tracker.begin(ts(2026, 1, 15, 9, 20));
        let finished = finished.expect("空闲超时后应当结算上一段会话");
        assert_eq!(finished.words, 500);
        assert_eq!(finished.minutes, 10);
        assert_ne!(first.token, second.token);
    }

    #[test]
    fn add_words_auto_starts_a_session() {
        // 作者可能直接开始打字，没有显式的「开始写作」动作
        let mut tracker = SessionTracker::new();
        tracker.add_words("ch_1", 300, ts(2026, 1, 15, 9, 0));
        assert!(tracker.is_active());
        assert_eq!(tracker.current().unwrap().words, 300);
    }

    #[test]
    fn add_words_accumulates_and_tracks_chapters() {
        let mut tracker = SessionTracker::new();
        tracker.add_words("ch_1", 300, ts(2026, 1, 15, 9, 0));
        tracker.add_words("ch_1", 200, ts(2026, 1, 15, 9, 5));
        tracker.add_words("ch_2", 100, ts(2026, 1, 15, 9, 8));
        tracker.add_words("ch_1", 50, ts(2026, 1, 15, 9, 9));

        let current = tracker.current().unwrap();
        assert_eq!(current.words, 650);
        assert_eq!(current.chapters, vec!["ch_1", "ch_2"], "章节要排序去重");
    }

    #[test]
    fn add_words_ignores_blank_chapter_id() {
        let mut tracker = SessionTracker::new();
        tracker.add_words("   ", 100, ts(2026, 1, 15, 9, 0));
        assert_eq!(tracker.current().unwrap().words, 100);
        assert!(tracker.current().unwrap().chapters.is_empty());
    }

    #[test]
    fn touch_updates_activity_without_adding_words() {
        // 斟酌措辞时也在写作，不该被判为离开
        let mut tracker = SessionTracker::new();
        tracker.add_words("ch_1", 100, ts(2026, 1, 15, 9, 0));
        tracker.touch(ts(2026, 1, 15, 9, 4));
        assert_eq!(tracker.current().unwrap().words, 100);
        assert_eq!(tracker.current().unwrap().last_activity, ts(2026, 1, 15, 9, 4));
    }

    #[test]
    fn touch_without_session_is_noop() {
        let mut tracker = SessionTracker::new();
        tracker.touch(ts(2026, 1, 15, 9, 0));
        assert!(!tracker.is_active());
    }

    #[test]
    fn end_returns_none_for_empty_session() {
        let mut tracker = SessionTracker::new();
        tracker.begin(ts(2026, 1, 15, 9, 0));
        assert!(tracker.end().is_none(), "点两下就切走不该留下记录");
        assert!(!tracker.is_active());
    }

    #[test]
    fn end_produces_a_record_with_duration() {
        let mut tracker = SessionTracker::new();
        tracker.begin(ts(2026, 1, 15, 9, 12));
        tracker.add_words("ch_1", 1520, ts(2026, 1, 15, 9, 59));
        let record = tracker.end().unwrap();
        assert_eq!(record.start, ts(2026, 1, 15, 9, 12));
        assert_eq!(record.minutes, 47);
        assert_eq!(record.words, 1520);
        assert_eq!(record.chapters, vec!["ch_1"]);
    }

    #[test]
    fn end_without_session_returns_none() {
        let mut tracker = SessionTracker::new();
        assert!(tracker.end().is_none());
    }

    #[test]
    fn finish_and_store_writes_to_the_right_month() {
        let (_tmp, store) = store();
        let mut tracker = SessionTracker::new();
        tracker.begin(ts(2026, 1, 15, 9, 0));
        tracker.add_words("ch_1", 900, ts(2026, 1, 15, 9, 30));

        let written = tracker.finish_and_store(&store).unwrap().unwrap();
        assert_eq!(written.words, 900);

        let sessions = sessions_on(&store, day(2026, 1, 15)).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].words, 900);
        assert_eq!(sessions[0].minutes, 30);
    }

    #[test]
    fn finish_and_store_skips_empty_session() {
        let (_tmp, store) = store();
        let mut tracker = SessionTracker::new();
        tracker.begin(ts(2026, 1, 15, 9, 0));
        assert!(tracker.finish_and_store(&store).unwrap().is_none());
        assert!(!store.path_for(&MonthKey::of(day(2026, 1, 15))).exists());
    }

    #[test]
    fn sessions_are_deduped_across_repeated_writes() {
        // 同一个会话被写两次（例如重试），只应留一条
        let (_tmp, store) = store();
        let record = Session::new(ts(2026, 1, 15, 9, 0), 30, 900, &["ch_1".into()]);
        store_session(&store, &record).unwrap();
        store_session(&store, &record).unwrap();

        let sessions = sessions_on(&store, day(2026, 1, 15)).unwrap();
        assert_eq!(sessions.len(), 1);
        let day_record = store
            .load(&MonthKey::of(day(2026, 1, 15)))
            .unwrap()
            .day(day(2026, 1, 15))
            .unwrap()
            .clone();
        assert_eq!(day_record.minutes(), 30, "时长不能翻倍");
    }

    #[test]
    fn store_session_rejects_empty_record() {
        let (_tmp, store) = store();
        let record = Session::new(ts(2026, 1, 15, 9, 0), 0, 0, &[]);
        let err = store_session(&store, &record).unwrap_err();
        assert_eq!(err.code(), "INVALID_INPUT");
    }

    #[test]
    fn sessions_on_missing_day_is_empty() {
        let (_tmp, store) = store();
        assert!(sessions_on(&store, day(2026, 1, 15)).unwrap().is_empty());
    }

    #[test]
    fn sessions_keep_chronological_order() {
        let (_tmp, store) = store();
        store_session(&store, &Session::new(ts(2026, 1, 15, 21, 0), 20, 300, &[])).unwrap();
        store_session(&store, &Session::new(ts(2026, 1, 15, 9, 0), 47, 1520, &[])).unwrap();
        let sessions = sessions_on(&store, day(2026, 1, 15)).unwrap();
        assert_eq!(sessions[0].start, ts(2026, 1, 15, 9, 0));
        assert_eq!(sessions[1].start, ts(2026, 1, 15, 21, 0));
    }

    #[test]
    fn midnight_crossing_session_lands_on_start_day() {
        // 从 1 月 15 日 23:40 写到 1 月 16 日 00:20
        let (_tmp, store) = store();
        let record = Session::new(ts(2026, 1, 15, 23, 40), 40, 700, &[]);
        store_session(&store, &record).unwrap();

        assert_eq!(sessions_on(&store, day(2026, 1, 15)).unwrap().len(), 1);
        assert!(sessions_on(&store, day(2026, 1, 16)).unwrap().is_empty());
    }

    #[test]
    fn month_crossing_session_lands_on_start_month() {
        let (_tmp, store) = store();
        let record = Session::new(ts(2026, 1, 31, 23, 50), 30, 500, &[]);
        store_session(&store, &record).unwrap();

        let jan = store.load(&MonthKey::new(2026, 1).unwrap()).unwrap();
        assert_eq!(jan.total_minutes(), 30);
        assert!(!store.path_for(&MonthKey::new(2026, 2).unwrap()).exists());
    }

    #[test]
    fn secs_to_minutes_ceils_and_clamps() {
        assert_eq!(secs_to_minutes_ceil(0), 0);
        assert_eq!(secs_to_minutes_ceil(1), 1, "写了 1 秒也要记 1 分钟");
        assert_eq!(secs_to_minutes_ceil(60), 1);
        assert_eq!(secs_to_minutes_ceil(61), 2);
        assert_eq!(secs_to_minutes_ceil(-100), 0, "负时长按 0 处理，不能回绕");
    }

    #[test]
    fn minutes_between_matches_duration() {
        assert_eq!(minutes_between(ts(2026, 1, 15, 9, 0), ts(2026, 1, 15, 9, 47)), 47);
        assert_eq!(minutes_between(ts(2026, 1, 15, 9, 0), ts(2026, 1, 15, 9, 0)), 0);
    }

    #[test]
    fn should_split_respects_idle_threshold() {
        assert!(!should_split(ts(2026, 1, 15, 9, 0), ts(2026, 1, 15, 9, 5)));
        assert!(should_split(ts(2026, 1, 15, 9, 0), ts(2026, 1, 15, 9, 6)));
        assert!(should_split(ts(2026, 1, 15, 9, 0), ts(2026, 1, 15, 10, 0)));
    }

    #[test]
    fn is_idle_uses_the_same_threshold() {
        let mut tracker = SessionTracker::new();
        tracker.begin(ts(2026, 1, 15, 9, 0));
        let session = tracker.current().unwrap().clone();
        assert!(!session.is_idle(ts(2026, 1, 15, 9, 5)));
        assert!(session.is_idle(ts(2026, 1, 15, 9, 6)));
    }

    #[test]
    fn overlong_session_is_split_even_without_idle() {
        // 忘了关软件：13 小时后回来，不该把它算成一次 13 小时会话
        let mut tracker = SessionTracker::new();
        tracker.begin(ts(2026, 1, 15, 8, 0));
        tracker.touch(ts(2026, 1, 15, 8, 30));
        let session = tracker.current().unwrap().clone();
        assert!(session.is_overlong() == false, "半小时还不算超长");

        tracker.touch(ts(2026, 1, 15, 21, 0));
        let session = tracker.current().unwrap().clone();
        assert!(session.is_overlong(), "13 小时必须判为超长");

        let (_, finished) = tracker.begin(ts(2026, 1, 15, 21, 0));
        assert!(finished.is_some(), "超长会话应当被结算掉");
    }

    #[test]
    fn elapsed_minutes_is_never_negative() {
        let session = ActiveSession {
            token: "t".into(),
            start: ts(2026, 1, 15, 10, 0),
            last_activity: ts(2026, 1, 15, 9, 0),
            words: 0,
            chapters: Vec::new(),
        };
        assert_eq!(session.elapsed_minutes(), 0, "时钟回拨不该产生巨大时长");
    }

    #[test]
    fn token_is_unique_per_session() {
        let mut tracker = SessionTracker::new();
        let (first, _) = tracker.begin(ts(2026, 1, 15, 9, 0));
        tracker.add_words("ch_1", 1, ts(2026, 1, 15, 9, 1));
        let (second, _) = tracker.begin(ts(2026, 1, 15, 10, 0));
        assert_ne!(first.token, second.token);
    }

    #[test]
    fn active_session_roundtrips_through_json() {
        let mut tracker = SessionTracker::new();
        tracker.begin(ts(2026, 1, 15, 9, 0));
        tracker.add_words("ch_1", 100, ts(2026, 1, 15, 9, 1));
        let session = tracker.current().unwrap().clone();

        let json = serde_json::to_string(&session).unwrap();
        assert!(json.contains("lastActivity"), "实际：{json}");
        let back: ActiveSession = serde_json::from_str(&json).unwrap();
        assert_eq!(back, session);
    }

    #[test]
    fn default_tracker_is_idle() {
        let tracker = SessionTracker::default();
        assert!(!tracker.is_active());
        assert!(tracker.current().is_none());
    }
}
