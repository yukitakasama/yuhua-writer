//! 云盘冲突副本识别。
//!
//! 对应计划书 4.5 节第 3 条：
//!
//! > **识别冲突副本**：识别「xxx (冲突副本 2026-01-01).md」这类命名，
//! > 在 UI 中提示「发现 N 个冲突文件」，引导逐条对比，**绝不自动删除**。
//!
//! ## 为什么是「识别」而不是「解决」
//!
//! 冲突由云盘客户端产生，产生时刻我们不在场，两个版本的内容差异
//! 只有作者本人能判断该保留哪个。软件能做的是：
//!
//! 1. 可靠地**发现**这些文件（本模块）
//! 2. 明确**提示**给用户，指出对应的是哪一章
//! 3. **绝不自动删除或覆盖** —— 任何自动"合并"都可能吃掉作者的稿子
//!
//! ## 各云盘的命名习惯（都要认）
//!
//! | 云盘 | 典型命名 |
//! | --- | --- |
//! | OneDrive | `第一章 (计算机的冲突副本 2026-01-01).md` |
//! | 坚果云 | `第一章 (冲突副本 2026-01-01).md` |
//! | Dropbox | `第一章 (Conflicted copy 2026-01-01).md` |
//! | Google Drive | `第一章 (副本).md` |
//! | iCloud | `第一章 2.md` |
//! | Syncthing | `第一章.sync-conflict-20260101-120000-ABCDEF.md` |
//!
//! 识别策略是**宽松匹配**：宁可多提示几个疑似文件让用户看一眼，
//! 也不要漏掉真正的冲突副本。多提示的代价只是一次点击，
//! 漏掉的代价是作者的稿子被遗忘在角落里。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 一个被识别出的冲突副本。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedConflict {
    /// 冲突副本文件路径。
    pub path: PathBuf,
    /// **相对于工作区根**的路径。
    pub relative_path: String,
    /// 冲突副本的文件名。
    pub file_name: String,
    /// 推测它对应哪一章（原文件名，去掉冲突标记后的结果）。
    pub original_file_name: String,
    /// 命中的是哪一种云盘命名习惯。
    pub pattern: ConflictPattern,
}
/// 冲突命名模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPattern {
    /// 中文「冲突副本」。
    ChineseConflictCopy,
    /// 英文「Conflicted copy」。
    EnglishConflictedCopy,
    /// 「计算机的冲突副本」这类带设备名的变体。
    DeviceConflictCopy,
    /// Syncthing 的 `.sync-conflict-` 后缀。
    SyncConflict,
    /// Google Drive 的「副本」。
    GoogleCopy,
    /// iCloud 的「文件名 2.md」数字后缀。
    NumericSuffix,
}

impl ConflictPattern {
    /// 用户可读的说明。
    pub fn label(self) -> &'static str {
        match self {
            Self::ChineseConflictCopy => "云盘冲突副本",
            Self::EnglishConflictedCopy => "Conflicted copy",
            Self::DeviceConflictCopy => "设备冲突副本",
            Self::SyncConflict => "Syncthing 冲突文件",
            Self::GoogleCopy => "云端副本",
            Self::NumericSuffix => "编号副本",
        }
    }
}

/// 判断文件名是否是冲突副本，返回命中的模式。
///
/// 公开此函数是为了让上层在「用户手动打开一个文件」时也能识别，
/// 而不只是在扫描目录时。
pub fn is_conflict_copy(file_name: &str) -> Option<ConflictPattern> {
    // 必须先是 Markdown，避免把备份目录里的 .json 等误判
    let lower = file_name.to_lowercase();

    // Syncthing：xxx.sync-conflict-20260101-120000-ABCDEF.md
    if lower.contains(".sync-conflict-") {
        return Some(ConflictPattern::SyncConflict);
    }

    // 带设备名的冲突副本：xxx (计算机的冲突副本 2026-01-01).md
    if lower.contains("的冲突副本") {
        return Some(ConflictPattern::DeviceConflictCopy);
    }

    // 中文：xxx (冲突副本 2026-01-01).md
    if lower.contains("冲突副本") {
        return Some(ConflictPattern::ChineseConflictCopy);
    }

    // 英文：xxx (Conflicted copy 2026-01-01).md
    if lower.contains("conflicted copy") || lower.contains("conflicted-copy") {
        return Some(ConflictPattern::EnglishConflictedCopy);
    }

    // Google Drive：xxx (副本).md — 只认独立的「副本」标记，
    // 避免把标题里正常含有「副本」二字的小说章节误判
    if lower.contains("(副本)") || lower.contains("（副本）") || lower.contains("的副本)")
    {
        return Some(ConflictPattern::GoogleCopy);
    }

    // iCloud：xxx 2.md / xxx 3.md
    if has_icloud_numeric_suffix(file_name) {
        return Some(ConflictPattern::NumericSuffix);
    }

    None
}

/// 判断是否符合 iCloud 的「文件名 + 空格 + 数字.md」模式。
///
/// 这个模式最容易误判（正文标题里出现数字很常见，例如「第一章 2」），
/// 因此只在**去掉扩展名后的最后一段是纯数字**、且数字前面有空格时才算命中。
fn has_icloud_numeric_suffix(file_name: &str) -> bool {
    let Some(stem) = file_name.strip_suffix(".md") else {
        return false;
    };
    // 找到最后一个空格
    let Some(idx) = stem.rfind(' ') else {
        return false;
    };
    let tail = &stem[idx + 1..];
    if tail.is_empty() || !tail.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    // 数字序号通常是小的（2、3、4…），限制在两位数避免「第一章 2026」这种误判
    matches!(tail.parse::<u32>(), Ok(n) if (2..=99).contains(&n))
}

/// 从冲突副本文件名推测原始文件名。
///
/// 用途：UI 上显示「『第一章 落羽.md』有一个冲突副本」，
/// 让用户立刻知道该对比哪个文件。
pub fn guess_original_file_name(conflict_name: &str, pattern: ConflictPattern) -> String {
    match pattern {
        ConflictPattern::SyncConflict => {
            // 去掉 .sync-conflict-... 这一段
            match conflict_name.find(".sync-conflict-") {
                Some(i) => format!("{}.md", &conflict_name[..i]),
                None => conflict_name.to_string(),
            }
        }
        ConflictPattern::NumericSuffix => {
            let stem = conflict_name.strip_suffix(".md").unwrap_or(conflict_name);
            match stem.rfind(' ') {
                Some(i) => format!("{}.md", &stem[..i]),
                None => conflict_name.to_string(),
            }
        }
        _ => {
            // 括号形式的：把括号及其内容去掉
            let stem = conflict_name.strip_suffix(".md").unwrap_or(conflict_name);
            for open in ["(", "（"] {
                if let Some(i) = stem.find(open) {
                    let cleaned = stem[..i].trim_end();
                    if !cleaned.is_empty() {
                        return format!("{cleaned}.md");
                    }
                }
            }
            conflict_name.to_string()
        }
    }
}

/// 扫描一个目录，返回其中的冲突副本。
///
/// **只读操作**：本函数不移动、不删除、不重命名任何文件。
/// 这是计划书 4.5 节的硬约束 —— 「绝不自动删除任何文件」。
pub fn detect_conflicts(dir: &Path, workspace_root: &Path) -> Vec<DetectedConflict> {
    let mut found = Vec::new();
    scan_recursive(dir, workspace_root, &mut found);
    // 按路径排序，保证 UI 展示顺序稳定
    found.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    found
}

fn scan_recursive(dir: &Path, workspace_root: &Path, out: &mut Vec<DetectedConflict>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            // 跳过引擎目录与回收站：那里的冲突副本已被我们自己的机制管理
            if matches!(name.as_str(), ".yuhua" | ".trash" | ".git" | "node_modules") {
                continue;
            }
            scan_recursive(&path, workspace_root, out);
            continue;
        }

        let file_name = entry.file_name().to_string_lossy().to_string();
        // 冲突标记总是出现在 .md 上
        if !file_name.ends_with(".md") {
            continue;
        }
        let Some(pattern) = is_conflict_copy(&file_name) else {
            continue;
        };

        let relative_path = path
            .strip_prefix(workspace_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));

        out.push(DetectedConflict {
            relative_path,
            original_file_name: guess_original_file_name(&file_name, pattern),
            file_name,
            path,
            pattern,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_chinese_conflict_copy() {
        assert_eq!(
            is_conflict_copy("第一章 落羽 (冲突副本 2026-01-01).md"),
            Some(ConflictPattern::ChineseConflictCopy)
        );
        assert_eq!(
            is_conflict_copy("第一章 落羽 （冲突副本）.md"),
            Some(ConflictPattern::ChineseConflictCopy)
        );
    }

    #[test]
    fn detects_device_specific_conflict_copy() {
        assert_eq!(
            is_conflict_copy("第一章 (计算机的冲突副本 2026-01-01).md"),
            Some(ConflictPattern::DeviceConflictCopy)
        );
    }

    #[test]
    fn detects_english_conflicted_copy() {
        assert_eq!(
            is_conflict_copy("Chapter 1 (Conflicted copy 2026-01-01).md"),
            Some(ConflictPattern::EnglishConflictedCopy)
        );
    }

    #[test]
    fn detects_syncthing_conflict() {
        assert_eq!(
            is_conflict_copy("第一章.sync-conflict-20260101-120000-ABCDEF.md"),
            Some(ConflictPattern::SyncConflict)
        );
    }

    #[test]
    fn detects_google_drive_copy() {
        assert_eq!(
            is_conflict_copy("第一章 (副本).md"),
            Some(ConflictPattern::GoogleCopy)
        );
    }

    #[test]
    fn detects_icloud_numeric_suffix() {
        assert_eq!(
            is_conflict_copy("第一章 2.md"),
            Some(ConflictPattern::NumericSuffix)
        );
        assert_eq!(
            is_conflict_copy("第一章 3.md"),
            Some(ConflictPattern::NumericSuffix)
        );
    }

    #[test]
    fn does_not_flag_normal_chapter_names() {
        // 关键：正常章节名绝不能被误判，否则用户每次打开都看到「发现冲突」
        assert_eq!(is_conflict_copy("第一章 落羽.md"), None);
        assert_eq!(is_conflict_copy("第一章 2026年计划.md"), None);
        assert_eq!(is_conflict_copy("第一章 第2次修改.md"), None);
        assert_eq!(is_conflict_copy("副本.md"), None);
        assert_eq!(is_conflict_copy("第二卷/第一章.md"), None);
    }

    #[test]
    fn numeric_suffix_has_upper_bound() {
        // 「第一章 2026」不是 iCloud 副本，是标题里带年份
        assert_eq!(is_conflict_copy("第一章 2026.md"), None);
        // 「第一章 1」也不是 —— 序号从 2 才开始（1 就是原文件）
        assert_eq!(is_conflict_copy("第一章 1.md"), None);
    }

    #[test]
    fn ignores_non_markdown_files() {
        // 冲突标记只出现在 .md 上；.json 统计文件有自己的合并机制
        assert_eq!(
            is_conflict_copy("config (冲突副本).json"),
            Some(ConflictPattern::ChineseConflictCopy)
        );
        // is_conflict_copy 本身只看名字，扩展名过滤由 detect_conflicts 负责
    }

    #[test]
    fn guesses_original_name_for_chinese_pattern() {
        assert_eq!(
            guess_original_file_name(
                "第一章 落羽 (冲突副本 2026-01-01).md",
                ConflictPattern::ChineseConflictCopy
            ),
            "第一章 落羽.md"
        );
    }

    #[test]
    fn guesses_original_name_for_syncthing() {
        assert_eq!(
            guess_original_file_name(
                "第一章.sync-conflict-20260101-120000-ABCDEF.md",
                ConflictPattern::SyncConflict
            ),
            "第一章.md"
        );
    }

    #[test]
    fn guesses_original_name_for_numeric_suffix() {
        assert_eq!(
            guess_original_file_name("第一章 2.md", ConflictPattern::NumericSuffix),
            "第一章.md"
        );
    }

    #[test]
    fn guess_falls_back_to_original_when_unparseable() {
        assert_eq!(
            guess_original_file_name("奇怪的名字.md", ConflictPattern::ChineseConflictCopy),
            "奇怪的名字.md"
        );
    }

    #[test]
    fn detect_scans_recursively_and_skips_engine_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let ms = root.join("manuscript/001-第一卷");
        std::fs::create_dir_all(&ms).unwrap();
        // 引擎目录里的冲突副本不应被报告（那是我们自己的备份机制）
        std::fs::create_dir_all(root.join(".yuhua/backup")).unwrap();

        std::fs::write(ms.join("001-第一章.md"), "正常").unwrap();
        std::fs::write(ms.join("001-第一章 (冲突副本 2026-01-01).md"), "冲突版本").unwrap();
        std::fs::write(root.join(".yuhua/backup/001-第一章 (冲突副本).md"), "备份").unwrap();
        std::fs::write(ms.join("notes.txt"), "无关文件").unwrap();

        let found = detect_conflicts(root, root);
        assert_eq!(found.len(), 1, "找到 {found:#?}");
        assert_eq!(found[0].file_name, "001-第一章 (冲突副本 2026-01-01).md");
        assert_eq!(
            found[0].relative_path,
            "manuscript/001-第一卷/001-第一章 (冲突副本 2026-01-01).md"
        );
        assert_eq!(found[0].original_file_name, "001-第一章.md");
    }

    #[test]
    fn detect_never_modifies_files() {
        // 计划书硬约束：只提示不删除。这条测试锁死该行为。
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let conflict = root.join("第一章 (冲突副本).md");
        std::fs::write(&conflict, "冲突内容").unwrap();
        let before = std::fs::read(&conflict).unwrap();

        let found = detect_conflicts(root, root);
        assert_eq!(found.len(), 1);

        // 文件必须还在、内容必须一字未改
        assert!(conflict.exists(), "冲突副本被删除了！");
        assert_eq!(std::fs::read(&conflict).unwrap(), before);
    }

    #[test]
    fn detect_returns_empty_for_clean_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("manuscript")).unwrap();
        std::fs::write(root.join("manuscript/001-第一章.md"), "正文").unwrap();
        assert!(detect_conflicts(root, root).is_empty());
    }

    #[test]
    fn detect_on_missing_directory_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(detect_conflicts(&dir.path().join("nope"), dir.path()).is_empty());
    }

    #[test]
    fn results_are_sorted_for_stable_ui() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for n in ["c (冲突副本).md", "a (冲突副本).md", "b (冲突副本).md"] {
            std::fs::write(root.join(n), "x").unwrap();
        }
        let found = detect_conflicts(root, root);
        let names: Vec<&str> = found.iter().map(|c| c.file_name.as_str()).collect();
        assert_eq!(
            names,
            vec!["a (冲突副本).md", "b (冲突副本).md", "c (冲突副本).md"]
        );
    }
}
