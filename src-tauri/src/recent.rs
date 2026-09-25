//! 最近打开的工作区列表。
//!
//! 对应任务 T2.2 的「最近列表」。
//!
//! ## 存放位置
//!
//! **放在系统应用数据目录，不在工作区里**。最近列表记录的是
//! 「本机打开过哪些工作区」，属于设备本地偏好，不是作品数据：
//!
//! - 放进工作区会导致 A 机器上的打开记录同步到 B 机器（无意义且泄露路径）
//! - 工作区被删除后，那条记录仍应存在于列表中（可用 `available: false` 标示）
//!
//! ## 上限与去重
//!
//! 最多保留 [\`MAX_RECENT\`] 条，同一个路径只保留最新一次。
//! 排序依据是「最近打开时间」降序。

use std::path::PathBuf;

use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize};
use yuhua_fs::workspace::RecentWorkspace;
use yuhua_fs::Result;

use crate::error::CommandError;
use crate::state::AppState;

/// 最多保留的最近记录条数。
pub const MAX_RECENT: usize = 20;

/// 最近列表的文件名。
const FILE_NAME: &str = "recent-workspaces.json";

/// 磁盘上的列表形状。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentFile {
    /// 记录列表。
    #[serde(default)]
    items: Vec<RecentWorkspace>,
}

/// 取最近列表的存放路径。
///
/// 找不到系统应用数据目录时退回到「不持久化」：宁可这次会话里
/// 不显示最近列表，也不要因为目录不可写而让应用报错。
pub fn storage_path() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| {
            PathBuf::from(h)
                .join("Library")
                .join("Application Support")
        })
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
    }?;
    Some(base.join("YuhuaWriter").join(FILE_NAME))
}

/// 读取最近列表。
///
/// 读不到或解析失败一律返回空列表：最近列表是可抛的便利功能，
/// 不该因为它的文件损坏而让应用启动失败。
pub fn load(_state: &AppState) -> Vec<RecentWorkspace> {
    let Some(path) = storage_path() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<RecentFile>(&text)
        .map(|f| f.items)
        .unwrap_or_default()
}

/// 记录一次打开。
///
/// 由 [\`AppState::open\`] 成功后调用。写失败不报错 ——
/// 记录最近列表失败不应该让用户「打不开工作区」。
pub fn record(root: &std::path::Path, title: &str) -> Result<()> {
    let Some(path) = storage_path() else {
        return Ok(());
    };
    let mut items = load_raw(&path);

    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    // 去重：同一路径只保留最新一次
    items.retain(|i| i.root != canonical);

    items.insert(
        0,
        RecentWorkspace {
            root: canonical,
            title: title.to_string(),
            last_opened: Utc::now().with_timezone(&local_offset()),
        },
    );
    items.truncate(MAX_RECENT);

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&RecentFile { items }) {
        Ok(json) => {
            // 复用原子写，避免半截 JSON
            let _ = yuhua_fs::atomic_write(&path, &json);
        }
        Err(_) => {}
    }
    Ok(())
}

/// 从磁盘读原始列表。
fn load_raw(path: &std::path::Path) -> Vec<RecentWorkspace> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<RecentFile>(&t).ok())
        .map(|f| f.items)
        .unwrap_or_default()
}

/// 移除一个记录。
pub fn forget(root: &std::path::Path) {
    let Some(path) = storage_path() else {
        return;
    };
    let mut items = load_raw(&path);
    items.retain(|i| i.root != root);
    if let Ok(json) = serde_json::to_string_pretty(&RecentFile { items }) {
        let _ = yuhua_fs::atomic_write(&path, &json);
    }
}

/// 清空列表。
pub fn clear() {
    if let Some(path) = storage_path() {
        let _ = std::fs::remove_file(path);
    }
}

/// 取本地时区偏移。
fn local_offset() -> FixedOffset {
    *chrono::Local::now().offset()
}

/// 供测试与诊断：把列表写到指定路径。
#[doc(hidden)]
pub fn record_to(path: &std::path::Path, items: &[RecentWorkspace]) -> Result<()> {
    let json = serde_json::to_string_pretty(&RecentFile {
        items: items.to_vec(),
    })
    .map_err(|e| yuhua_core::YuhuaError::Parse {
        context: "recent workspaces",
        message: e.to_string(),
    })?;
    yuhua_fs::atomic_write(path, &json)
}

/// 供测试与诊断：读取指定路径的列表。
#[doc(hidden)]
pub fn load_from(path: &std::path::Path) -> Vec<RecentWorkspace> {
    load_raw(path)
}

/// 把命令层错误转成领域错误（本模块内部用）。
#[allow(dead_code)]
fn to_domain(e: CommandError) -> yuhua_core::YuhuaError {
    match e {
        CommandError::Domain(d) => d,
        CommandError::NoWorkspace => yuhua_core::YuhuaError::InvalidInput("未打开工作区".into()),
        CommandError::Internal(m) => yuhua_core::YuhuaError::InvalidInput(m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts(n: i64) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .timestamp_opt(1_800_000_000 + n, 0)
            .unwrap()
    }

    fn item(name: &str, n: i64) -> RecentWorkspace {
        RecentWorkspace {
            root: PathBuf::from(format!("D:/{name}")),
            title: name.to_string(),
            last_opened: ts(n),
        }
    }

    #[test]
    fn roundtrips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("recent.json");
        let items = vec![item("a", 1), item("b", 2)];
        record_to(&p, &items).unwrap();
        let back = load_from(&p);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].root, PathBuf::from("D:/a"));
    }

    #[test]
    fn missing_file_yields_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_from(&dir.path().join("nope.json")).is_empty());
    }

    #[test]
    fn corrupt_file_yields_empty_list_not_error() {
        // 最近列表损坏不该让应用启动失败
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("recent.json");
        std::fs::write(&p, "{ 这不是合法 JSON").unwrap();
        assert!(load_from(&p).is_empty());
    }

    #[test]
    fn empty_json_object_is_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("recent.json");
        std::fs::write(&p, "{}").unwrap();
        assert!(load_from(&p).is_empty(), "缺少 items 字段应回退为空列表");
    }

    #[test]
    fn max_recent_is_reasonable() {
        assert_eq!(MAX_RECENT, 20);
    }

    #[test]
    fn storage_path_is_under_app_data_dir() {
        // 不能放在工作区里，也不该放在临时目录
        if let Some(p) = storage_path() {
            let s = p.to_string_lossy().replace('\\', "/");
            assert!(s.contains("YuhuaWriter"), "路径应含应用名：{s}");
            assert!(s.ends_with(FILE_NAME));
        }
    }

    #[test]
    fn items_carry_available_flag_via_summarize() {
        // 最近列表里的工作区可能已被删除，Workspace::summarize 会标注
        let dir = tempfile::tempdir().unwrap();
        let sum = yuhua_fs::workspace::Workspace::summarize(&dir.path().join("已删除"));
        assert!(!sum.available);
    }
}
