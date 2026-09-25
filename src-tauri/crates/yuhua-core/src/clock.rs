//! 本机时钟：本地时区偏移与「当前本地时间」的唯一来源。
//!
//! ## 为什么要单独成一个模块
//!
//! 全仓有 8 处需要「当前时间」。在此之前，`local_offset` / `now_local`
//! 这一对函数在 fs 层与命令层被逐字复制了 13 份 —— 它们是**同一段语义**，
//! 复制多份的代价是：任何一处修改（例如将来要支持可注入的时钟以便测试）
//! 都必须记得同步其余 12 处，漏一处就会产生难以察觉的时间口径不一致。
//!
//! ## 为什么放在 yuhua-core
//!
//! `yuhua-core` 是所有其它 crate 的公共下游（fs / store / export / stats
//! 都依赖它），把时钟放这里可以让每个领域层共享同一实现而**不引入新的依赖**。
//! 本模块只依赖已经存在的 `chrono`。
//!
//! ## 为什么返回 `DateTime<FixedOffset>` 而不是 `DateTime<Local>`
//!
//! 领域模型里的时间字段都是 `DateTime<FixedOffset>`：它把「偏移量」固化成
//! 值的一部分，因此可以安全地序列化（RFC3339）并在任何时区还原，
//! 而 `DateTime<Local>` 的时区是**读取时**才解析的，序列化后会丢失。
//! 这也是为什么不能直接写 `chrono::Local::now()`。

use chrono::{DateTime, FixedOffset, Utc};

/// 取本机当前的时区偏移。
///
/// 直接用 `chrono::Local::now()` 反推偏移，避免引入 `chrono-tz` 这类
/// 需要携带完整时区数据库的重型依赖。
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
