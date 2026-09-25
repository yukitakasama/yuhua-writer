//! 桌面应用入口。
//!
//! 所有逻辑都在 \`yuhua_writer_lib\` 里，这里只是一个转发。
//! 这样安排是 Tauri 2 的约定：应用逻辑放在 lib 中，
//! 便于移动端复用同一份代码，也让集成测试可以直接链接它。

// Windows 发布版不弹控制台窗口；调试版保留控制台以便看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    yuhua_writer_lib::run()
}
