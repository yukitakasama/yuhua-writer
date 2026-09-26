//! # 羽化写作 — Tauri 应用（命令层）
//!
//! 本 crate 是**薄壳**（计划书 3.1 节）：只做参数校验、权限边界、
//! 错误码翻译与事件推送，业务逻辑全部在 \`yuhua-*\` 领域 crate 里。
//!
//! ## 分层回顾
//!
//! \`\`\`text
//! 前端 SolidJS
//!      │ invoke（IPC）
//!      ▼
//! commands.rs      命令层（本 crate）—— 薄壳
//!      │ 普通函数调用
//!      ▼
//! yuhua-core / yuhua-fs / yuhua-store / yuhua-export / yuhua-stats
//! \`\`\`
//!
//! ## 模块地图
//!
//! | 模块 | 职责 |
//! | --- | --- |
//! | [\`commands\`] | Tauri 命令（IPC 边界） |
//! | [\`state\`]    | 应用运行时状态（当前工作区 + 文稿） |
//! | [\`error\`]    | 命令层错误类型与序列化形状 |
//! | [\`scan\`]     | 从磁盘目录树装配领域模型 |
//! | [\`recent\`]   | 最近打开的工作区列表 |
//! | [\`webview2\`] | WebView2 运行时探测与缺失兜底 |

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod commands;
pub mod error;
pub mod recent;
pub mod scan;
pub mod state;
pub mod webview2;

pub use error::CommandError;
pub use state::{AppState, WorkspaceSession};

/// 启动 Tauri 应用。
///
/// \`\`\`no_run
/// yuhua_writer_lib::run();
/// \`\`\`
pub fn run() {
    // WebView2 检查必须在任何窗口创建之前完成。
    // 缺失时这里会弹出原生对话框并返回 false，我们直接退出 ——
    // 继续下去只会得到一个空白窗口。
    if !webview2::ensure_available_or_exit() {
        std::process::exit(1);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // ---- 工作区 ----
            commands::create_workspace,
            commands::open_workspace,
            commands::close_workspace,
            commands::has_workspace,
            commands::inspect_workspace,
            commands::list_recent_workspaces,
            // ---- 文稿结构 ----
            commands::get_outline,
            commands::get_word_stats,
            commands::get_count_modes,
            commands::create_volume,
            commands::rename_volume,
            commands::delete_volume,
            commands::create_chapter,
            commands::rename_chapter,
            commands::delete_chapter,
            commands::reorder_chapters,
            commands::reorder_volumes,
            // ---- 章节内容 ----
            commands::read_chapter,
            commands::save_chapter,
            commands::update_chapter_meta,
            // ---- 检索 ----
            commands::search_chapters,
            // ---- 写作统计（M8）----
            commands::get_stats_summary,
            // ---- 数据安全 ----
            commands::rebuild_index,
            commands::rescan_workspace,
            commands::list_trash,
            commands::restore_trash,
            commands::purge_trash,
            commands::empty_trash,
            commands::list_conflicts,
        ])
        .run(tauri::generate_context!())
        .expect("启动羽化写作失败");
}
