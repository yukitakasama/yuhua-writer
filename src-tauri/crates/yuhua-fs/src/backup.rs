//! 轮转备份。
//!
//! 对应计划书 4.4 节：
//!
//! > **轮转备份**：保存前若距上次快照 > 5 分钟，旧版存入 `.yuhua/backup/`，
//! > 保留最近 20 份。解决的问题：误删、误改写可回溯。
//!
//! ## 为什么是「按时间轮转」而不是「每次保存都备份」
//!
//! 作者一天可能保存数百次（自动保存每 800ms 防抖一次）。每次备份会让
//! backup 目录迅速膨胀到几百 MB，而且绝大部分版本之间只差一两个字，
//! 保存它们的价值极低。
//!
//! 5 分钟的间隔意味着：**一次连续写作最多回溯到 5 分钟前的状态**，
//! 这对「手滑删了一段」的场景足够；同时备份总数被限制在 20 份，
//! 目录体积有明确上界。
//!
//! ## 备份文件的命名
//!
//! `{章文件名}__{时间戳}.bak.md`
//!
//! 时间戳用 `YYYYMMDD-HHMMSS` 形式：字典序 == 时间序，
//! 因此按文件名排序即是按时间排序，清理最旧的记录不需要读文件内容。
//!
//! ## 时区语义
//!
//! 时间戳在**写入前先归一到 UTC**，`snapshot_path` 负责转换；
//! `parse_timestamp_from_name` 也一律按 UTC 解释。
//!
//! 两侧必须用同一个时区，否则时间差会被偏移量污染：例如在 UTC+8 写入
//! `090000`、改到 UTC 环境后再按 UTC 解析成 09:00Z，与真实的 01:00Z
//! 相差 8 小时，间隔判断会得出「刚刚才备份过」的错误结论，把该备份的
//! 快照全部跳过。归一到 UTC 后，快照间隔不再受运行环境的时区影响，
//! 用户跨时区移动工作区目录也不会看到备份行为异常。
//!
//! 文件名里的数字只用于排序与求时间差，不用于向用户展示，因此归一到 UTC
//! 不影响可读性。

use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Utc};
use yuhua_core::{Result, YuhuaError};

/// 相邻两次快照的最小间隔（秒）。对应计划书「> 5 分钟」。
pub const MIN_SNAPSHOT_INTERVAL_SECS: i64 = 5 * 60;

/// 保留的备份份数上限。对应计划书「保留最近 20 份」。
pub const MAX_SNAPSHOTS: usize = 20;

/// 备份文件名中的分隔符。
const SEP: &str = "__";
/// 备份文件后缀。
const SUFFIX: &str = ".bak.md";

/// 一次备份的结果。
#[derive(Debug, Clone, PartialEq)]
pub enum SnapshotOutcome {
    /// 已创建一份新快照。
    Created {
        /// 快照文件路径。
        path: PathBuf,
        /// 同时清理掉的过期快照数。
        pruned: usize,
    },
    /// 距上次快照不足间隔，跳过。
    SkippedTooSoon {
        /// 还需等待多少秒。
        wait_secs: i64,
    },
    /// 源文件不存在或为空，无需备份。
    SkippedNoSource,
}

/// 备份管理器。
#[derive(Debug, Clone)]
pub struct BackupManager {
    dir: PathBuf,
}

impl BackupManager {
    /// 在给定目录建立备份管理器。
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// 备份目录。
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 在覆盖写入之前，按需为文件创建一份快照。
    ///
    /// `relative_path` 是相对于工作区的路径，用于在备份目录里
    /// 保持与正文相同的目录层级（避免不同卷的同名章节互相覆盖）。
    ///
    /// `now` 由调用方注入，便于测试与批量操作时保持时间基准一致。
    pub fn snapshot_if_due(
        &self,
        source: &Path,
        relative_path: &str,
        now: DateTime<FixedOffset>,
    ) -> Result<SnapshotOutcome> {
        // 源文件不存在（新建的章节）或为空：没有内容值得备份
        let Ok(meta) = std::fs::metadata(source) else {
            return Ok(SnapshotOutcome::SkippedNoSource);
        };
        if !meta.is_file() || meta.len() == 0 {
            return Ok(SnapshotOutcome::SkippedNoSource);
        }

        // 检查该文件最近一次快照的时间
        let existing = self.snapshots_of(relative_path);
        if let Some(latest) = existing.last() {
            if let Some(ts) = parse_timestamp_from_name(latest) {
                let elapsed = now.signed_duration_since(ts).num_seconds();
                if elapsed < MIN_SNAPSHOT_INTERVAL_SECS {
                    return Ok(SnapshotOutcome::SkippedTooSoon {
                        wait_secs: MIN_SNAPSHOT_INTERVAL_SECS - elapsed,
                    });
                }
            }
        }

        // 内容与最新快照相同则不重复备份。
        // 这一步很有价值：用户反复保存但没改内容时（例如只动了光标），
        // 不该产生一堆内容完全一样的快照。
        if let Some(latest) = existing.last() {
            if let (Ok(a), Ok(b)) = (std::fs::read(source), std::fs::read(latest)) {
                if a == b {
                    return Ok(SnapshotOutcome::SkippedNoSource);
                }
            }
        }

        // 写入快照
        let content = std::fs::read(source).map_err(|e| YuhuaError::io(source, e))?;
        let dest = self.snapshot_path(relative_path, now);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| YuhuaError::io(parent, e))?;
        }
        // 快照本身也用原子写：写入过程中崩溃不应留下半截备份
        crate::atomic::atomic_write_bytes(&dest, &content)?;

        let pruned = self.prune(relative_path)?;

        Ok(SnapshotOutcome::Created { path: dest, pruned })
    }

    /// 列出某个源文件的全部快照，按时间升序。
    ///
    /// 传入的 `relative_path` 不含备份后缀。
    pub fn snapshots_of(&self, relative_path: &str) -> Vec<PathBuf> {
        let dir = self.snapshot_dir_for(relative_path);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let prefix = format!("{}{SEP}", file_stem_of(relative_path));
        let mut out: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| {
                        let n = n.to_string_lossy();
                        n.starts_with(&prefix) && n.ends_with(SUFFIX)
                    })
                    .unwrap_or(false)
            })
            .collect();
        // 文件名里的时间戳是定宽且字典序等于时间序的，直接排序即可
        out.sort();
        out
    }

    /// 清理超出上限的旧快照，返回清理数量。
    pub fn prune(&self, relative_path: &str) -> Result<usize> {
        let snapshots = self.snapshots_of(relative_path);
        if snapshots.len() <= MAX_SNAPSHOTS {
            return Ok(0);
        }
        // 升序排列，删掉最前面的（最旧的）
        let excess = snapshots.len() - MAX_SNAPSHOTS;
        let mut removed = 0;
        for path in snapshots.into_iter().take(excess) {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// 清理整棵备份树中的孤儿目录（源文件已不存在的备份）。
    ///
    /// 返回清理的目录数。保守实现：只删除**完全为空**的目录，
    /// 绝不因为「源文件不在了」就删除备份内容 ——
    /// 用户删掉一章后，那章的备份恰恰是最有价值的东西。
    pub fn prune_empty_dirs(&self) -> Result<usize> {
        fn walk(dir: &Path) -> usize {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return 0;
            };
            let mut removed = 0;
            let mut subdirs = Vec::new();
            let mut has_file = false;
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    subdirs.push(p);
                } else {
                    has_file = true;
                }
            }
            for sub in subdirs {
                removed += walk(&sub);
            }
            // 重新检查：子目录可能刚刚被清空
            if !has_file {
                if let Ok(mut it) = std::fs::read_dir(dir) {
                    if it.next().is_none() && std::fs::remove_dir(dir).is_ok() {
                        removed += 1;
                    }
                }
            }
            removed
        }
        Ok(walk(&self.dir))
    }

    /// 某源文件对应的快照目录（与源文件同层级，便于人肉排查）。
    fn snapshot_dir_for(&self, relative_path: &str) -> PathBuf {
        match relative_path.rsplit_once('/') {
            Some((parent, _)) => self
                .dir
                .join(parent.replace('/', std::path::MAIN_SEPARATOR_STR)),
            None => self.dir.clone(),
        }
    }

    /// 生成快照文件路径。
    fn snapshot_path(&self, relative_path: &str, now: DateTime<FixedOffset>) -> PathBuf {
        let stem = file_stem_of(relative_path);
        // 时间戳统一归到 UTC 后再格式化，见模块文档「时区语义」。
        let name = format!(
            "{stem}{SEP}{}{SUFFIX}",
            now.with_timezone(&Utc).format("%Y%m%d-%H%M%S")
        );
        self.snapshot_dir_for(relative_path).join(name)
    }
}

/// 取路径的文件主名（不含扩展名）。
fn file_stem_of(relative_path: &str) -> String {
    let file_name = relative_path.rsplit('/').next().unwrap_or(relative_path);
    match file_name.strip_suffix(".md") {
        Some(s) => s.to_string(),
        None => file_name.to_string(),
    }
}

/// 从备份文件名里解析出时间戳。
fn parse_timestamp_from_name(path: &Path) -> Option<DateTime<Utc>> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let without_suffix = name.strip_suffix(SUFFIX)?;
    let idx = without_suffix.rfind(SEP)?;
    let ts = &without_suffix[idx + SEP.len()..];
    let parsed = chrono::NaiveDateTime::parse_from_str(ts, "%Y%m%d-%H%M%S").ok()?;
    // 同样按 UTC 解释：写入侧已归一到 UTC（见 snapshot_path）。
    // 两侧必须使用同一时区，否则算出的时间差会被偏移量污染。
    Some(parsed.and_utc())
}

/// 取本地时区偏移。
fn local_offset() -> FixedOffset {
    *chrono::Local::now().offset()
}

/// 当前时间（带本地时区）。
pub fn now_local() -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&local_offset())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(y, mo, d, h, mi, s)
            .unwrap()
    }

    fn setup() -> (tempfile::TempDir, BackupManager, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let bm = BackupManager::new(dir.path().join("backup"));
        let src = dir.path().join("manuscript/001-第一卷/001-第一章.md");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, "第一版内容").unwrap();
        (dir, bm, src)
    }

    const REL: &str = "manuscript/001-第一卷/001-第一章.md";

    #[test]
    fn first_snapshot_is_created() {
        let (_d, bm, src) = setup();
        let out = bm
            .snapshot_if_due(&src, REL, at(2026, 1, 1, 9, 0, 0))
            .unwrap();
        match out {
            SnapshotOutcome::Created { path, pruned } => {
                assert!(path.exists());
                assert_eq!(pruned, 0);
                assert_eq!(std::fs::read_to_string(&path).unwrap(), "第一版内容");
            }
            other => panic!("期望创建快照，实际 {other:?}"),
        }
    }

    #[test]
    fn second_snapshot_within_interval_is_skipped() {
        let (_d, bm, src) = setup();
        bm.snapshot_if_due(&src, REL, at(2026, 1, 1, 9, 0, 0))
            .unwrap();
        std::fs::write(&src, "改了内容").unwrap();

        // 1 分钟后：太近，跳过
        let out = bm
            .snapshot_if_due(&src, REL, at(2026, 1, 1, 9, 1, 0))
            .unwrap();
        match out {
            SnapshotOutcome::SkippedTooSoon { wait_secs } => {
                assert_eq!(wait_secs, MIN_SNAPSHOT_INTERVAL_SECS - 60);
            }
            other => panic!("期望跳过，实际 {other:?}"),
        }
        assert_eq!(bm.snapshots_of(REL).len(), 1);
    }

    #[test]
    fn snapshot_after_interval_is_created() {
        let (_d, bm, src) = setup();
        bm.snapshot_if_due(&src, REL, at(2026, 1, 1, 9, 0, 0))
            .unwrap();
        std::fs::write(&src, "十分钟后的内容").unwrap();

        let out = bm
            .snapshot_if_due(&src, REL, at(2026, 1, 1, 9, 10, 0))
            .unwrap();
        assert!(matches!(out, SnapshotOutcome::Created { .. }));
        assert_eq!(bm.snapshots_of(REL).len(), 2);
    }

    #[test]
    fn identical_content_is_not_snapshotted_again() {
        // 用户反复保存但内容没变（例如只移动了光标）：不应堆积重复快照
        let (_d, bm, src) = setup();
        bm.snapshot_if_due(&src, REL, at(2026, 1, 1, 9, 0, 0))
            .unwrap();
        let out = bm
            .snapshot_if_due(&src, REL, at(2026, 1, 1, 10, 0, 0))
            .unwrap();
        assert!(matches!(out, SnapshotOutcome::SkippedNoSource));
        assert_eq!(bm.snapshots_of(REL).len(), 1);
    }

    #[test]
    fn missing_source_is_skipped() {
        let (_d, bm, _src) = setup();
        let missing = _d.path().join("nope.md");
        let out = bm
            .snapshot_if_due(&missing, "nope.md", at(2026, 1, 1, 9, 0, 0))
            .unwrap();
        assert!(matches!(out, SnapshotOutcome::SkippedNoSource));
    }

    #[test]
    fn empty_source_is_skipped() {
        // 新建的空章节没有内容值得备份
        let (_d, bm, src) = setup();
        std::fs::write(&src, "").unwrap();
        let out = bm
            .snapshot_if_due(&src, REL, at(2026, 1, 1, 9, 0, 0))
            .unwrap();
        assert!(matches!(out, SnapshotOutcome::SkippedNoSource));
    }

    #[test]
    fn prunes_to_keep_only_twenty_snapshots() {
        let (_d, bm, src) = setup();
        // 造 25 份快照，每份间隔 10 分钟
        for i in 0..25 {
            std::fs::write(&src, format!("版本 {i}")).unwrap();
            let ts = at(2026, 1, 1, 9, 0, 0) + chrono::Duration::minutes(i * 10);
            bm.snapshot_if_due(&src, REL, ts).unwrap();
        }
        let snaps = bm.snapshots_of(REL);
        assert_eq!(snaps.len(), MAX_SNAPSHOTS, "应只保留 {MAX_SNAPSHOTS} 份");

        // 保留的必须是最新的 20 份（版本 5..24），最旧的（版本 0..4）已被清掉
        assert_eq!(std::fs::read_to_string(&snaps[0]).unwrap(), "版本 5");
        assert_eq!(std::fs::read_to_string(&snaps[19]).unwrap(), "版本 24");
    }

    #[test]
    fn snapshots_are_sorted_oldest_first() {
        let (_d, bm, src) = setup();
        for i in 0..3 {
            std::fs::write(&src, format!("v{i}")).unwrap();
            bm.snapshot_if_due(
                &src,
                REL,
                at(2026, 1, 1, 9, 0, 0) + chrono::Duration::minutes(i * 10),
            )
            .unwrap();
        }
        let snaps = bm.snapshots_of(REL);
        let contents: Vec<String> = snaps
            .iter()
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect();
        assert_eq!(contents, vec!["v0", "v1", "v2"]);
    }

    #[test]
    fn different_chapters_do_not_share_snapshots() {
        let (d, bm, src) = setup();
        bm.snapshot_if_due(&src, REL, at(2026, 1, 1, 9, 0, 0))
            .unwrap();

        let other = d.path().join("manuscript/001-第一卷/002-第二章.md");
        std::fs::write(&other, "第二章内容").unwrap();
        const REL2: &str = "manuscript/001-第一卷/002-第二章.md";
        bm.snapshot_if_due(&other, REL2, at(2026, 1, 1, 9, 0, 0))
            .unwrap();

        assert_eq!(bm.snapshots_of(REL).len(), 1);
        assert_eq!(bm.snapshots_of(REL2).len(), 1);
        // 内容不能串
        let s1 = std::fs::read_to_string(&bm.snapshots_of(REL)[0]).unwrap();
        assert_eq!(s1, "第一版内容");
    }

    #[test]
    fn same_chapter_name_in_different_volumes_stays_separate() {
        // 两个卷里都有「001-第一章.md」是很常见的，备份不能互相覆盖
        let (d, bm, _) = setup();
        let a = d.path().join("manuscript/001-第一卷/001-第一章.md");
        let b = d.path().join("manuscript/002-第二卷/001-第一章.md");
        std::fs::create_dir_all(b.parent().unwrap()).unwrap();
        std::fs::write(&a, "卷一第一章").unwrap();
        std::fs::write(&b, "卷二第一章").unwrap();

        bm.snapshot_if_due(
            &a,
            "manuscript/001-第一卷/001-第一章.md",
            at(2026, 1, 1, 9, 0, 0),
        )
        .unwrap();
        bm.snapshot_if_due(
            &b,
            "manuscript/002-第二卷/001-第一章.md",
            at(2026, 1, 1, 9, 0, 0),
        )
        .unwrap();

        let sa = bm.snapshots_of("manuscript/001-第一卷/001-第一章.md");
        let sb = bm.snapshots_of("manuscript/002-第二卷/001-第一章.md");
        assert_eq!(sa.len(), 1);
        assert_eq!(sb.len(), 1);
        assert_eq!(std::fs::read_to_string(&sa[0]).unwrap(), "卷一第一章");
        assert_eq!(std::fs::read_to_string(&sb[0]).unwrap(), "卷二第一章");
    }

    #[test]
    fn snapshot_name_is_timezone_independent() {
        // 回归测试：同一绝对时刻，用不同时区偏移构造的 DateTime 必须落成
        // 同一个文件名。此前写入端直接 format 本地时刻、解析端按 UTC 解释，
        // 在非 UTC 环境里间隔判断会凭空少掉一个时区偏移，把该备份的快照
        // 误判为「刚刚才备份过」而跳过。
        let (_d, bm, _src) = setup();
        let utc = FixedOffset::east_opt(0).unwrap();
        let plus8 = FixedOffset::east_opt(8 * 3600).unwrap();
        let instant = at(2026, 5, 1, 12, 0, 0);

        let a = bm.snapshot_path(REL, instant.with_timezone(&utc));
        let b = bm.snapshot_path(REL, instant.with_timezone(&plus8));
        assert_eq!(a, b, "同一时刻不应因时区不同而得到不同文件名");

        // 解析回来必须还原成同一绝对时刻
        assert_eq!(
            parse_timestamp_from_name(&a).unwrap(),
            instant.with_timezone(&Utc)
        );
    }

    #[test]
    fn parse_timestamp_roundtrips() {
        // 走一遍真实的写入路径：snapshot_path 会把时刻归一到 UTC，
        // 解析侧也按 UTC 解释，两侧必须严丝合缝。
        let (_d, bm, _src) = setup();
        let ts = at(2026, 3, 15, 14, 30, 45);
        let written = bm.snapshot_path(REL, ts);
        let parsed = parse_timestamp_from_name(&written).unwrap();
        assert_eq!(parsed, ts.with_timezone(&Utc));
    }

    #[test]
    fn prune_empty_dirs_removes_only_empty() {
        let (d, bm, src) = setup();
        bm.snapshot_if_due(&src, REL, at(2026, 1, 1, 9, 0, 0))
            .unwrap();
        // 造一个空目录
        let empty = bm.dir().join("manuscript/999-空卷");
        std::fs::create_dir_all(&empty).unwrap();

        bm.prune_empty_dirs().unwrap();
        assert!(!empty.exists(), "空目录应被清理");
        // 有快照的目录必须保留
        assert_eq!(bm.snapshots_of(REL).len(), 1);
        let _ = d;
    }

    #[test]
    fn file_stem_strips_md_extension() {
        assert_eq!(file_stem_of("a/b/001-第一章.md"), "001-第一章");
        assert_eq!(file_stem_of("001-第一章.md"), "001-第一章");
        assert_eq!(file_stem_of("noext"), "noext");
    }
}
