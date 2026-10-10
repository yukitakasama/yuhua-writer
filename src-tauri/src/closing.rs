//! 关闭屏障：让最后一次关窗等到在途的稿子落盘。
//!
//! ## 为什么必须有这道屏障
//!
//! 前端的自动保存有 1.5 秒防抖，而 `beforeunload` 里那句 flush 是
//! `void` 掉的 —— 不 await、也不阻断关闭。关掉最后一个窗口就意味着
//! 进程结束：在途的 invoke 和磁盘写都不会跑完。
//! 作者按窗口 X 或 Alt+F4 收尾时丢掉的正好是**最新那一段**，
//! 而这是一位写作者每天要做几十次的正常动作。
//! jsdom 里没有「窗口销毁」语义，所以这条路径在前端测试里永远是绿的。
//!
//! ## 机制
//!
//! ```text
//! CloseRequested ──▶ 拦下（prevent_close）并 emit `flush-and-close`
//!                         │
//!        前端刷完盘 ──────┤ notify_flush_done ──▶ 放行，真正关闭
//!        前端没有应答 ────┘ 超时兜底 ───────────▶ 同样放行
//! ```
//!
//! **超时兜底必须存在**：前端挂住（WebView 崩了、脚本死循环）时，
//! 窗口不能永远关不掉 —— 那比丢一段字更糟，作者只能去任务管理器杀进程。
//!
//! ## 为什么状态是一个原子字节而不是 Mutex<enum>
//!
//! 读写发生在两个线程（事件回调与超时兜底），而这里需要的只是一次
//! 「谁先到」的裁决：`compare_exchange` 保证放行只会被触发一次，
//! 不需要锁，也不会跨慢操作持锁。

use std::sync::atomic::{AtomicU8, Ordering};

/// 发给前端的事件名：请把在途的改动刷到磁盘，刷完调 `notify_flush_done`。
pub const FLUSH_EVENT: &str = "flush-and-close";

/// 等待前端应答的上限（毫秒）。
///
/// 比自动保存的 1.5 秒防抖宽一倍：正常路径上 flush 会直接抢占防抖，
/// 这一档余量留给「磁盘慢 / 文件被云盘占着」这类真的在等的情况。
pub const FLUSH_TIMEOUT_MS: u64 = 3_000;

/// 没拦过任何关闭请求。
const IDLE: u8 = 0;
/// 已拦下关闭，正在等前端把稿子刷到磁盘。
const WAITING: u8 = 1;
/// 已经放行（前端确认刷完，或超时兜底），不再拦截后续关闭。
const RELEASED: u8 = 2;

/// 一次关闭请求该怎么处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 第一次拦下：既要不放行，也要去通知前端刷盘。
    InterceptAndAsk,
    /// 等待期间作者又点了一次关闭：仍然拦下，但**不再重复通知**
    /// （上一次的通知还在前端手里，重发只会让它刷两遍）。
    InterceptSilently,
    /// 已经放行过了：不再拦截，让这次关闭真正发生。
    Allow,
}

/// 关闭屏障。作为 Tauri managed state 挂在整个应用上。
#[derive(Debug, Default)]
pub struct CloseBarrier {
    phase: AtomicU8,
}

impl CloseBarrier {
    /// 收到一次 `CloseRequested`，决定怎么处理。
    pub fn on_close_requested(&self) -> Decision {
        match self
            .phase
            .compare_exchange(IDLE, WAITING, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => Decision::InterceptAndAsk,
            Err(WAITING) => Decision::InterceptSilently,
            Err(_) => Decision::Allow,
        }
    }

    /// 放行关闭：前端确认刷完了，或超时兜底决定不再等。
    ///
    /// 返回 `true` 表示**这次**调用完成了从「等待」到「放行」的那一次翻转，
    /// 调用方应当去真正关闭窗口。两条路径（ack 与超时）都可能先到，
    /// 而窗口只能由先到者关一次 —— 后到的拿到 `false`，什么都不做。
    pub fn release(&self) -> bool {
        self.phase
            .compare_exchange(WAITING, RELEASED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// 当前是否还在等前端的应答（仅供测试与诊断）。
    #[cfg(test)]
    fn is_waiting(&self) -> bool {
        self.phase.load(Ordering::SeqCst) == WAITING
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_close_is_intercepted_and_the_frontend_is_asked_once() {
        // 等在前端手里，且只通知一次：重复通知会让它把同一份稿子刷两遍
        let b = CloseBarrier::default();

        assert_eq!(b.on_close_requested(), Decision::InterceptAndAsk);
        assert_eq!(
            b.on_close_requested(),
            Decision::InterceptSilently,
            "第二次仍要拦下（稿子还没落盘），但不该再发一次事件"
        );
        assert!(b.is_waiting(), "还没放行，窗口不能真的关掉");
    }

    #[test]
    fn release_lets_the_next_close_through() {
        let b = CloseBarrier::default();
        assert_eq!(b.on_close_requested(), Decision::InterceptAndAsk);

        assert!(b.release(), "ack 到了应当由它去关窗");
        assert_eq!(
            b.on_close_requested(),
            Decision::Allow,
            "放行之后再来的关闭必须真的关掉，否则窗口永远关不掉"
        );
        assert!(!b.release(), "ack 与超时都会调 release，窗口只能被关掉一次");
    }

    #[test]
    fn timeout_wins_if_the_frontend_never_answers() {
        // 超时兜底不是可选项：前端挂住时杀进程不该是作者唯一的出路
        let b = CloseBarrier::default();
        assert_eq!(b.on_close_requested(), Decision::InterceptAndAsk);

        assert!(b.release(), "超时方放行时应当由它关窗");
        assert!(!b.release(), "后到的前端 ack 不能再关一次");
    }

    #[test]
    fn release_without_an_intercepted_close_does_nothing() {
        // 没拦过关闭就收到 ack（例如上一次超时放行后的迟到应答）：
        // 不能因此把一个正常打开的窗口关掉
        let b = CloseBarrier::default();
        assert!(!b.release());
        assert_eq!(
            b.on_close_requested(),
            Decision::InterceptAndAsk,
            "迟到的 ack 不该把屏障提前进入放行态"
        );
    }
}
