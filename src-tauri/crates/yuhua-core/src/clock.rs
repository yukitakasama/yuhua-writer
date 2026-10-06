//! 本机时钟：本地时区偏移与「当前本地时间」的唯一来源。
//!
//! ## 为什么要单独成一个模块
//!
//! 「取当前时间」这件事在 fs 层（备份 / 章节读写 / 恢复日志 / 回收站 / 工作区）、
//! 索引层和命令层一共被写了 9 遍，而且全是同一句
//! `Utc::now().with_timezone(&本地偏移)`。复制多份的代价不是行数，是**口径**：
//! 任何一处改动（例如将来换成可注入的时钟以便测试）都必须同步其余八处，
//! 漏掉的那处不会报错，只会让不同文件里的时间戳差出一个时区。
//!
//! ## 为什么放在 yuhua-core
//!
//! `yuhua-core` 是所有其它 crate 的公共下游（fs / store / export / stats
//! 都依赖它），把时钟放这里可以让每个领域层共享同一实现而**不引入新的依赖边**。
//! 本模块只依赖已经存在的 `chrono`。
//!
//! ## 为什么返回 `DateTime<FixedOffset>` 而不是 `DateTime<Local>`
//!
//! 领域模型里的时间字段都是 `DateTime<FixedOffset>`：它把「偏移量」固化成
//! 值的一部分，因此可以安全地序列化（RFC3339）并在任何时区还原，
//! 而 `DateTime<Local>` 的时区是**读取时**才解析的，序列化后会丢失。
//! 这也是为什么不能直接写 `chrono::Local::now()`。
//!
//! ## 唯一的例外：备份文件名里的时间戳用 UTC
//!
//! 本模块管的是**写进文件内容与元数据里的时间**（Front Matter、回收站条目、
//! 最近打开列表……），这些要给人读，所以带本地偏移。
//!
//! `.yuhua/backup/` 的快照文件名不属于这一类：那里的时间戳只做两件事 ——
//! 排序和求相邻快照的间隔，而这两件事都要求「写入」与「解析」两侧用同一个
//! 时区。若按本地时区写入，工作区目录被复制到另一台不同时区的机器后，
//! 间隔判断会被偏移量污染（例如把 8 小时算成「刚刚才备份过」，从而跳过
//! 本该生成的快照）。所以 `yuhua_fs::backup` 在写入前统一
//! `with_timezone(&Utc)`，解析时也一律按 UTC 解释。
//! **这不是漏改，改动它会让跨时区的备份静默失效。**

use chrono::{DateTime, FixedOffset, Utc};

/// 取本机当前的时区偏移。
///
/// 用当前时刻反推偏移，避免引入 `chrono-tz` 这类需要携带完整时区数据库的
/// 重型依赖。
pub fn local_offset() -> FixedOffset {
    *chrono::Local::now().offset()
}

/// 当前本地时间（带本地时区偏移）。
pub fn now_local() -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&local_offset())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_is_within_real_world_range() {
        // 真实时区偏移不会超过 UTC-12 ~ UTC+14
        let secs = local_offset().local_minus_utc();
        assert!(
            (-12 * 3600..=14 * 3600).contains(&secs),
            "偏移量超出真实时区范围：{secs} 秒"
        );
    }

    #[test]
    fn now_local_carries_the_local_offset() {
        let now = now_local();
        assert_eq!(now.offset(), &local_offset());
    }

    #[test]
    fn now_local_is_close_to_utc_now() {
        // 两个函数必须描述同一时刻，不能因为实现改动而漂移
        let delta = (now_local().with_timezone(&Utc) - Utc::now())
            .num_seconds()
            .abs();
        assert!(delta < 5, "本地时间与 UTC 相差 {delta} 秒，实现可能有问题");
    }

    #[test]
    fn now_local_is_timezone_stable_across_calls() {
        // 连续两次取值只应前进，不应因时区解析而回退
        let a = now_local();
        let b = now_local();
        assert!(b >= a);
    }
}
