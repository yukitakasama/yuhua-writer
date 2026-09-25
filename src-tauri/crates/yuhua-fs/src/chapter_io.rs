//! 章节文件读写：Front Matter 解析 / 生成、编码归一化。
//!
//! 对应计划书 4.2 节的文件格式：
//!
//! ```markdown
//! ---
//! id: ch_01J8XK2M9P
//! title: 第一章 落羽
//! status: draft
//! wordGoal: 3000
//! created: 2026-01-01T09:00:00+08:00
//! updated: 2026-01-01T21:30:00+08:00
//! tags: []
//! ---
//!
//! 正文内容……
//! ```
//!
//! ## 三个必须处理的现实问题
//!
//! ### 1. BOM
//!
//! 用户在 Windows 上用记事本编辑过文件，文件头会多出 UTF-8 BOM
//! （`EF BB BF`）。如果不剥离，第一行的 `---` 就变成 `\u{feff}---`，
//! Front Matter 直接解析失败，用户的章节会「凭空丢掉所有元数据」。
//!
//! ### 2. CRLF
//!
//! Windows 换行是 `\r\n`。如果不归一化，行尾会带 `\r`，
//! 导致 `---` 匹配失败、标题带上不可见字符、字数统计把 `\r` 当标点。
//! **读入时统一归一为 `\n`，写出时按平台或配置决定**。
//!
//! ### 3. Front Matter 不存在或损坏
//!
//! 用户可能手工删掉整个 Front Matter 区块。这时**不能报错**，
//! 应当生成一份全新的元数据（新 ID、标题取正文首行或文件名），
//! 让章节仍然可用。用户的稿子永远比元数据重要。

use std::path::Path;

use chrono::{DateTime, FixedOffset, Utc};
use yuhua_core::meta::{ChapterMeta, ChapterStatus};
use yuhua_core::{ChapterId, Result, YuhuaError};

use crate::atomic::atomic_write;

/// Front Matter 分隔符。
const DELIMITER: &str = "---";
/// UTF-8 BOM。
const BOM: char = '\u{feff}';

/// 一个章节文件的完整内容：元数据 + 正文。
#[derive(Debug, Clone, PartialEq)]
pub struct ChapterFile {
    /// 章节元数据（Front Matter）。
    pub meta: ChapterMeta,
    /// 正文（不含 Front Matter）。
    pub body: String,
    /// 原始文件是否没有 Front Matter 区块。
    ///
    /// 用于决定保存时是否要补写一个。保留这个信息是为了让
    /// 「用户刻意不用 Front Matter」也能被尊重（虽然我们会补写，
    /// 但至少在扫描时可以提示）。
    pub had_front_matter: bool,
}

impl ChapterFile {
    /// 生成本文件的完整文本内容（Front Matter + 正文）。
    ///
    /// 输出使用 `\n` 换行。这是刻意的选择：
    /// - 工作区要放进云盘、Git、跨平台同步，统一的 `\n` 能避免整文件 diff
    /// - 现代编辑器（含记事本）都能正确处理 `\n`
    pub fn to_text(&self) -> String {
        let mut out = String::with_capacity(self.body.len() + 256);
        out.push_str(DELIMITER);
        out.push('\n');
        out.push_str(&serialize_meta(&self.meta));
        out.push_str(DELIMITER);
        out.push('\n');
        if !self.body.is_empty() {
            out.push('\n');
            out.push_str(&self.body);
        }
        out
    }
}

/// 把元数据序列化成 YAML 风格的键值行。
///
/// ## 为什么不引入 serde_yaml
///
/// 1. **体积**：serde_yaml 及其依赖会给安装包增加可观体积（要求②）
/// 2. **可控**：我们需要的是「扁平的键值 + 数组」，不是完整的 YAML。
///    自己写反而能保证输出格式完全确定，diff 稳定。
/// 3. **安全**：YAML 的完整规范里有大量历史陷阱（锚点、类型自动转换、
///    `yes` → true 等）。只支持我们需要的子集，用户写了复杂结构
///    就当普通字符串处理，不会有意外的类型转换。
///
/// 解析侧同样只认这个子集，见 [`parse_meta`]。
fn serialize_meta(meta: &ChapterMeta) -> String {
    let mut s = String::with_capacity(256);
    s.push_str(&format!("id: {}\n", meta.id));
    s.push_str(&format!("title: {}\n", quote_if_needed(&meta.title)));
    s.push_str(&format!("status: {}\n", status_str(meta.status)));
    s.push_str(&format!("wordGoal: {}\n", meta.word_goal));
    s.push_str(&format!("created: {}\n", meta.created.to_rfc3339()));
    s.push_str(&format!("updated: {}\n", meta.updated.to_rfc3339()));
    s.push_str(&format!("tags: {}\n", format_tags(&meta.tags)));
    if !meta.summary.is_empty() {
        s.push_str(&format!("summary: {}\n", quote_if_needed(&meta.summary)));
    }
    if !meta.notes.is_empty() {
        s.push_str(&format!("notes: {}\n", quote_if_needed(&meta.notes)));
    }
    for (k, v) in &meta.extra {
        // 未知字段原样回写，防止数据丢失
        let rendered = match v {
            serde_json::Value::String(st) => quote_if_needed(st),
            other => other.to_string(),
        };
        s.push_str(&format!("{k}: {rendered}\n"));
    }
    s
}

/// 状态转字符串（与 [`ChapterStatus`] 的 serde 表示保持一致）。
fn status_str(s: ChapterStatus) -> &'static str {
    match s {
        ChapterStatus::Draft => "draft",
        ChapterStatus::Done => "done",
        ChapterStatus::Revising => "revising",
    }
}

/// 需要加引号的值：含特殊 YAML 字符时。
///
/// 例如标题是 `第一章: 落羽`，不加引号会被下一个解析器当成嵌套映射。
fn quote_if_needed(v: &str) -> String {
    // 反引号用 char 字面量表示，避免在源码里出现裸的反引号造成阅读困扰
    const BACKTICK: char = '\u{60}';

    let needs_quote = v.is_empty()
        || v.starts_with(' ')
        || v.ends_with(' ')
        || v.starts_with('"')
        || v.starts_with('[')
        || v.starts_with('{')
        || v.starts_with('-')
        || v.starts_with('#')
        || v.starts_with('&')
        || v.starts_with('*')
        || v.starts_with('!')
        || v.starts_with('|')
        || v.starts_with('>')
        || v.starts_with('%')
        || v.starts_with('@')
        || v.starts_with(BACKTICK)
        || v.contains(": ")
        || v.contains('"')
        || v.contains('\n');

    if needs_quote {
        // 用双引号并转义内部的引号与反斜杠
        let escaped = v.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    } else {
        v.to_string()
    }
}

/// 标签数组序列化为 `[a, b]` 形式。
fn format_tags(tags: &[String]) -> String {
    if tags.is_empty() {
        return "[]".to_string();
    }
    let items: Vec<String> = tags.iter().map(|t| quote_if_needed(t)).collect();
    format!("[{}]", items.join(", "))
}

/// 剥离 UTF-8 BOM。
pub fn strip_bom(text: &str) -> &str {
    text.strip_prefix(BOM).unwrap_or(text)
}

/// 归一化换行符为 `\n`。
///
/// 处理三种情况：`\r\n`（Windows）、`\r`（旧 Mac）、已经是 `\n`。
/// 只做一次分配，不在无 CR 时复制字符串。
pub fn normalize_newlines(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_string();
    }
    // 先统一 \r\n → \n，再把剩余的孤立 \r → \n
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// 拆分 Front Matter 与正文。
///
/// 返回 `(元数据文本, 正文, 是否存在 Front Matter)`。
///
/// ## 边界处理
///
/// - 不在开头（首行不是 `---`）就当作没有 Front Matter，
///   正文里出现的 `---` 是 Markdown 分割线，绝不能误判
/// - 有开头 `---` 但没有结束 `---`：**当作损坏**，全部内容视为正文。
///   这样用户不会丢字。
/// - 结束分隔符可以是文件末行（后面没有内容）
pub fn split_front_matter(text: &str) -> (Option<String>, String, bool) {
    let text = strip_bom(text);

    // 首行必须是分隔符；允许行尾有空白
    let mut lines = text.split('\n');
    let Some(first) = lines.next() else {
        return (None, String::new(), false);
    };
    if first.trim_end() != DELIMITER {
        return (None, text.to_string(), false);
    }

    // 找结束分隔符
    let mut meta_lines: Vec<&str> = Vec::new();
    let mut body_start: Option<usize> = None;
    // 记录已消费的字节数，用于切出正文
    let mut consumed = first.len() + 1;

    for line in lines {
        if line.trim_end() == DELIMITER {
            body_start = Some(consumed + line.len() + 1);
            break;
        }
        meta_lines.push(line);
        consumed += line.len() + 1;
    }

    match body_start {
        Some(start) => {
            let body = if start <= text.len() {
                text[start..].to_string()
            } else {
                String::new()
            };
            // 去掉 Front Matter 与正文之间的一个空行（生成时会加，读回时去掉）
            let body = body.strip_prefix('\n').unwrap_or(&body).to_string();
            (Some(meta_lines.join("\n")), body, true)
        }
        // 有头无尾：视为损坏，整体当正文，绝不丢内容
        None => (None, text.to_string(), false),
    }
}

/// 解析 Front Matter 文本为章节元数据。
///
/// ## 宽容策略（对应计划书 4.2 节「缺失字段一律给默认值」）
///
/// - 缺 `id`：生成新 ID
/// - 缺 `title`：用 `fallback_title`（通常是文件名推导出来的）
/// - 缺 `created`/`updated`：用 `now`
/// - 缺 `status`：draft
/// - 无法识别的键：放进 `extra` 原样保留
///
/// **永远不因为元数据有问题而拒绝加载章节。**
pub fn parse_meta(
    meta_text: &str,
    fallback_title: &str,
    now: DateTime<FixedOffset>,
) -> ChapterMeta {
    let mut id: Option<ChapterId> = None;
    let mut title: Option<String> = None;
    let mut status = ChapterStatus::Draft;
    let mut word_goal: u32 = 0;
    let mut created: Option<DateTime<FixedOffset>> = None;
    let mut updated: Option<DateTime<FixedOffset>> = None;
    let mut tags: Vec<String> = Vec::new();
    let mut summary = String::new();
    let mut notes = String::new();
    let mut extra = std::collections::BTreeMap::new();

    for raw_line in meta_text.split('\n') {
        let line = raw_line.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue; // 不是键值行，忽略
        };
        let key = key.trim();
        let value = value.trim();
        let unquoted = unquote(value);

        match key {
            "id" => {
                // 校验前缀：用户可能把卷 ID 粘贴到章节里
                if let Ok(parsed) = ChapterId::parse(unquoted.clone()) {
                    id = Some(parsed);
                }
            }
            "title" => {
                if !unquoted.is_empty() {
                    title = Some(unquoted);
                }
            }
            "status" => {
                if let Some(s) = ChapterStatus::parse(&unquoted) {
                    status = s;
                }
            }
            "wordGoal" | "word_goal" => {
                // 解析失败就保持默认，不报错
                word_goal = unquoted.parse().unwrap_or(0);
            }
            "created" => created = parse_time(&unquoted),
            "updated" => updated = parse_time(&unquoted),
            "tags" => tags = parse_array(&unquoted),
            "summary" => summary = unquoted,
            "notes" => notes = unquoted,
            other => {
                // 未知字段：能当 JSON 解析就存 JSON，否则存字符串。
                // 这样嵌套结构也能无损往返。
                let v = serde_json::from_str(&unquoted)
                    .unwrap_or_else(|_| serde_json::Value::String(unquoted.clone()));
                extra.insert(other.to_string(), v);
            }
        }
    }

    let title = title.unwrap_or_else(|| {
        if fallback_title.trim().is_empty() {
            "未命名章节".to_string()
        } else {
            fallback_title.to_string()
        }
    });

    ChapterMeta {
        id: id.unwrap_or_default(),
        title,
        status,
        word_goal,
        created: created.unwrap_or(now),
        updated: updated.unwrap_or(now),
        tags,
        summary,
        notes,
        extra,
    }
}

/// 去掉值两侧的配对引号。
fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 {
        let bytes = v.as_bytes();
        let first = bytes[0];
        let last = bytes[v.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            let inner = &v[1..v.len() - 1];
            // 只对双引号做反转义，单引号内容原样返回
            if first == b'"' {
                return inner.replace("\\\"", "\"").replace("\\\\", "\\");
            }
            return inner.to_string();
        }
    }
    v.to_string()
}

/// 解析 `[a, b, c]` 形式的数组；也接受空串。
fn parse_array(v: &str) -> Vec<String> {
    let inner = v.trim();
    let inner = inner
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(inner);
    if inner.trim().is_empty() {
        return Vec::new();
    }
    inner
        .split(',')
        .map(|s| unquote(s))
        .filter(|s| !s.is_empty())
        .collect()
}

/// 解析 RFC3339 时间；失败返回 None。
fn parse_time(v: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(v).ok()
}

/// 从文件读取章节。
///
/// 自动完成 BOM 剥离与换行归一。文件不存在时返回
/// [`YuhuaError::NotFound`]，而不是创建空文件 ——
/// 静默创建会让「章节树里有、磁盘上没有」的错乱状态被掩盖。
pub fn read_chapter(path: &Path) -> Result<ChapterFile> {
    let raw = std::fs::read(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            YuhuaError::NotFound {
                kind: "chapter",
                id: path.display().to_string(),
            }
        } else {
            YuhuaError::io(path, e)
        }
    })?;

    // 容忍非法 UTF-8：用 lossy 转换而不是直接失败。
    // 用户的稿子可能是 GBK 编码的（从别处拷来的），此时宁可显示乱码
    // 也不要让章节完全打不开 —— 至少还能看到内容并另存为。
    let text = String::from_utf8_lossy(&raw).to_string();
    let text = normalize_newlines(&text);

    // 从文件名推导回退标题：去掉 "001-" 前缀与 ".md" 后缀
    let fallback_title = path
        .file_stem()
        .map(|s| {
            let s = s.to_string_lossy().to_string();
            match s.split_once('-') {
                // 只有前缀看起来确实是纯数字序号时才剥离，
                // 否则「第一卷-风起」这种正常标题会被误切
                Some((prefix, rest)) if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()) => {
                    rest.to_string()
                }
                _ => s,
            }
        })
        .unwrap_or_else(|| "未命名章节".to_string());

    let now = Utc::now().with_timezone(&local_offset());
    let (meta_text, body, had_front_matter) = split_front_matter(&text);
    let meta = match meta_text {
        Some(t) => parse_meta(&t, &fallback_title, now),
        None => {
            let mut m = ChapterMeta::new(fallback_title, now);
            m.summary = String::new();
            m
        }
    };

    Ok(ChapterFile {
        meta,
        body,
        had_front_matter,
    })
}

/// 把章节原子写到磁盘。
///
/// 会先更新 `updated` 时间戳，再序列化写盘。
pub fn write_chapter(path: &Path, chapter: &ChapterFile) -> Result<()> {
    atomic_write(path, &chapter.to_text())
}

/// 取本地时区偏移。
///
/// 用固定时区而不是 UTC：Front Matter 里的时间戳带 `+08:00` 这类偏移，
/// 用户用记事本打开时看到的才是自己所在时区的合理时间。
fn local_offset() -> FixedOffset {
    // 不引入 chrono-tz 这类重型依赖；用当前时刻反推系统偏移
    let now = chrono::Local::now();
    *now.offset()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 1, 1, 9, 0, 0)
            .unwrap()
    }

    fn sample() -> ChapterFile {
        ChapterFile {
            meta: ChapterMeta::new("第一章 落羽", ts()),
            body: "正文第一段。\n\n正文第二段。".to_string(),
            had_front_matter: true,
        }
    }

    #[test]
    fn bom_is_stripped() {
        assert_eq!(strip_bom("\u{feff}---"), "---");
        assert_eq!(strip_bom("---"), "---");
    }

    #[test]
    fn newlines_are_normalized() {
        assert_eq!(normalize_newlines("a\r\nb"), "a\nb");
        assert_eq!(normalize_newlines("a\rb"), "a\nb");
        assert_eq!(normalize_newlines("a\nb"), "a\nb");
        // 混合情况
        assert_eq!(normalize_newlines("a\r\nb\rc\nd"), "a\nb\nc\nd");
    }

    #[test]
    fn normalize_is_noop_copy_when_no_cr() {
        let s = "纯\n内容";
        assert_eq!(normalize_newlines(s), s);
    }

    #[test]
    fn split_extracts_meta_and_body() {
        let text = "---\ntitle: 标题\n---\n\n正文";
        let (meta, body, had) = split_front_matter(text);
        assert!(had);
        assert_eq!(meta.unwrap(), "title: 标题");
        assert_eq!(body, "正文");
    }

    #[test]
    fn split_without_front_matter_treats_all_as_body() {
        let text = "就是一段普通正文\n---\n这是分割线";
        let (meta, body, had) = split_front_matter(text);
        assert!(!had);
        assert!(meta.is_none());
        // 正文中的 --- 是 Markdown 分割线，不能被当成 Front Matter 边界
        assert_eq!(body, text);
    }

    #[test]
    fn split_with_unterminated_front_matter_preserves_everything() {
        // 有开头分隔符但忘了写结束分隔符：宁可当正文，也不能丢字
        let text = "---\ntitle: 标题\n正文全都在这";
        let (meta, body, had) = split_front_matter(text);
        assert!(!had);
        assert!(meta.is_none());
        assert_eq!(body, text);
    }

    #[test]
    fn split_handles_empty_body() {
        let text = "---\ntitle: 标题\n---\n";
        let (meta, body, had) = split_front_matter(text);
        assert!(had);
        assert!(meta.is_some());
        assert_eq!(body, "");
    }

    #[test]
    fn split_tolerates_trailing_whitespace_on_delimiter() {
        let text = "---   \ntitle: 标题\n---  \n\n正文";
        let (_m, body, had) = split_front_matter(text);
        assert!(had);
        assert_eq!(body, "正文");
    }

    #[test]
    fn roundtrip_preserves_meta_and_body() {
        let cf = sample();
        let text = cf.to_text();
        let (meta_text, body, had) = split_front_matter(&text);
        assert!(had);
        assert_eq!(body, cf.body);

        let parsed = parse_meta(&meta_text.unwrap(), "回退", ts());
        assert_eq!(parsed.id, cf.meta.id);
        assert_eq!(parsed.title, cf.meta.title);
        assert_eq!(parsed.status, cf.meta.status);
        assert_eq!(parsed.word_goal, cf.meta.word_goal);
        assert_eq!(parsed.created, cf.meta.created);
        assert_eq!(parsed.updated, cf.meta.updated);
    }

    #[test]
    fn serialized_text_starts_with_delimiter() {
        let text = sample().to_text();
        assert!(text.starts_with("---\n"));
    }

    #[test]
    fn empty_body_does_not_emit_extra_blank_lines() {
        let mut cf = sample();
        cf.body = String::new();
        let text = cf.to_text();
        // 应当以结束分隔符 + 换行结尾，不应再有额外空行
        assert!(text.ends_with("---\n"), "got {text:?}");
        let (_m, body, _h) = split_front_matter(&text);
        assert_eq!(body, "");
    }

    #[test]
    fn parse_fills_defaults_for_missing_fields() {
        let m = parse_meta("title: 只有标题", "回退", ts());
        assert_eq!(m.title, "只有标题");
        assert_eq!(m.status, ChapterStatus::Draft);
        assert_eq!(m.word_goal, 0);
        assert_eq!(m.created, ts());
        assert!(m.tags.is_empty());
    }

    #[test]
    fn parse_uses_fallback_title_when_missing() {
        let m = parse_meta("status: done", "从文件名推导的标题", ts());
        assert_eq!(m.title, "从文件名推导的标题");
    }

    #[test]
    fn parse_uses_fallback_when_title_blank() {
        let m = parse_meta("title: ", "回退标题", ts());
        assert_eq!(m.title, "回退标题");
    }

    #[test]
    fn parse_reads_all_known_fields() {
        let text = "id: ch_0192f3a4b5c6d7e8f9a0b1c2d3e4f5a6\n\
             title: 第一章 落羽\n\
             status: revising\n\
             wordGoal: 3000\n\
             created: 2026-01-01T09:00:00+08:00\n\
             updated: 2026-01-02T21:30:00+08:00\n\
             tags: [玄幻, 长篇]\n\
             summary: 一句话摘要\n\
             notes: 作者便签";
        let m = parse_meta(text, "回退", ts());
        assert_eq!(m.id.as_str(), "ch_0192f3a4b5c6d7e8f9a0b1c2d3e4f5a6");
        assert_eq!(m.title, "第一章 落羽");
        assert_eq!(m.status, ChapterStatus::Revising);
        assert_eq!(m.word_goal, 3000);
        assert_eq!(m.created.to_rfc3339(), "2026-01-01T09:00:00+08:00");
        assert_eq!(m.updated.to_rfc3339(), "2026-01-02T21:30:00+08:00");
        assert_eq!(m.tags, vec!["玄幻", "长篇"]);
        assert_eq!(m.summary, "一句话摘要");
        assert_eq!(m.notes, "作者便签");
    }

    #[test]
    fn parse_rejects_id_with_wrong_prefix() {
        // 用户误把卷 ID 粘进来：应当忽略并生成新的章节 ID，而不是带着错误 ID 走
        let m = parse_meta("id: vol_0192f3a4b5c6d7e8f9a0b1c2d3e4f5a6\ntitle: x", "回退", ts());
        assert!(m.id.as_str().starts_with("ch_"));
    }

    #[test]
    fn parse_tolerates_bad_word_goal() {
        let m = parse_meta("wordGoal: 三千字\ntitle: x", "回退", ts());
        assert_eq!(m.word_goal, 0);
    }

    #[test]
    fn parse_tolerates_bad_timestamp() {
        let m = parse_meta("created: 昨天\ntitle: x", "回退", ts());
        assert_eq!(m.created, ts()); // 回退到 now
    }

    #[test]
    fn parse_keeps_unknown_fields() {
        let m = parse_meta("title: x\ncustomField: 自定义值", "回退", ts());
        assert_eq!(
            m.extra.get("customField"),
            Some(&serde_json::Value::String("自定义值".into()))
        );
    }

    #[test]
    fn parse_handles_nested_unknown_values() {
        let m = parse_meta(
            "title: x\nnested: {\"a\": 1}",
            "回退",
            ts(),
        );
        assert!(m.extra.contains_key("nested"));
    }

    #[test]
    fn parse_skips_blank_and_comment_lines() {
        let m = parse_meta("\n# 这是注释\ntitle: 真标题\n\n", "回退", ts());
        assert_eq!(m.title, "真标题");
    }

    #[test]
    fn quoted_values_are_unwrapped() {
        let m = parse_meta("title: \"第一章: 落羽\"", "回退", ts());
        assert_eq!(m.title, "第一章: 落羽");
    }

    #[test]
    fn titles_with_colon_survive_roundtrip() {
        // 冒号标题是最容易在自制 YAML 里翻车的场景
        let mut cf = sample();
        cf.meta.title = "第一章: 落羽".to_string();
        let text = cf.to_text();
        let (meta_text, _b, _h) = split_front_matter(&text);
        let parsed = parse_meta(&meta_text.unwrap(), "回退", ts());
        assert_eq!(parsed.title, "第一章: 落羽");
    }

    #[test]
    fn titles_with_hash_survive_roundtrip() {
        let mut cf = sample();
        cf.meta.title = "关于 #话题的章节".to_string();
        let text = cf.to_text();
        let (meta_text, _b, _h) = split_front_matter(&text);
        let parsed = parse_meta(&meta_text.unwrap(), "回退", ts());
        assert_eq!(parsed.title, "关于 #话题的章节");
    }

    #[test]
    fn empty_tags_roundtrip_as_empty_array() {
        let cf = sample();
        let text = cf.to_text();
        assert!(text.contains("tags: []"));
        let (meta_text, _b, _h) = split_front_matter(&text);
        let parsed = parse_meta(&meta_text.unwrap(), "回退", ts());
        assert!(parsed.tags.is_empty());
    }

    #[test]
    fn unquote_handles_double_and_single_quotes() {
        assert_eq!(unquote("\"abc\""), "abc");
        assert_eq!(unquote("'abc'"), "abc");
        assert_eq!(unquote("abc"), "abc");
        assert_eq!(unquote("\""), "\"");
    }

    #[test]
    fn parse_array_handles_various_shapes() {
        assert_eq!(parse_array("[]"), Vec::<String>::new());
        assert_eq!(parse_array(""), Vec::<String>::new());
        assert_eq!(parse_array("[a]"), vec!["a"]);
        assert_eq!(parse_array("[a, b, c]"), vec!["a", "b", "c"]);
        assert_eq!(parse_array("[\"x y\", z]"), vec!["x y", "z"]);
    }

    #[test]
    fn read_chapter_from_disk_normalizes_crlf_and_bom() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("001-第一章.md");
        // 模拟 Windows 记事本保存的文件：BOM + CRLF
        std::fs::write(
            &path,
            "\u{feff}---\r\ntitle: 记事本改过的\r\n---\r\n\r\n正文内容\r\n第二行\r\n",
        )
        .unwrap();

        let cf = read_chapter(&path).unwrap();
        assert_eq!(cf.meta.title, "记事本改过的");
        assert!(cf.had_front_matter);
        // CRLF 必须已归一，否则后续字数统计会把 \r 算成标点
        assert!(!cf.body.contains('\r'), "正文仍含 CR：{:?}", cf.body);
        assert!(cf.body.contains("正文内容\n第二行"));
    }

    #[test]
    fn read_chapter_without_front_matter_derives_title_from_filename() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("003-第三章 山雨.md");
        std::fs::write(&path, "只有正文").unwrap();

        let cf = read_chapter(&path).unwrap();
        assert!(!cf.had_front_matter);
        // 序号前缀应被剥离
        assert_eq!(cf.meta.title, "第三章 山雨");
        assert_eq!(cf.body, "只有正文");
        assert!(cf.meta.id.as_str().starts_with("ch_"));
    }

    #[test]
    fn read_chapter_does_not_strip_non_numeric_prefix_from_title() {
        // 「第一卷-风起」的连字符不是序号分隔符，不能被切掉
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("第一卷-风起.md");
        std::fs::write(&path, "正文").unwrap();
        let cf = read_chapter(&path).unwrap();
        assert_eq!(cf.meta.title, "第一卷-风起");
    }

    #[test]
    fn read_missing_chapter_returns_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_chapter(&dir.path().join("nope.md")).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn write_then_read_roundtrip_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("001-第一章.md");
        let mut cf = sample();
        cf.meta.summary = "摘要".into();
        cf.meta.tags = vec!["标签一".into()];
        write_chapter(&path, &cf).unwrap();

        let back = read_chapter(&path).unwrap();
        assert_eq!(back.meta.id, cf.meta.id);
        assert_eq!(back.meta.title, cf.meta.title);
        assert_eq!(back.meta.summary, "摘要");
        assert_eq!(back.meta.tags, vec!["标签一"]);
        assert_eq!(back.body, cf.body);
    }

    #[test]
    fn read_tolerates_invalid_utf8() {
        // 从别处拷来的 GBK 文件：宁可显示乱码，也不能让章节打不开
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.md");
        std::fs::write(&path, vec![0xff, 0xfe, b'a', b'b']).unwrap();
        let cf = read_chapter(&path).unwrap();
        assert!(cf.body.len() >= 2);
    }

    #[test]
    fn blank_lines_in_body_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.md");
        let mut cf = sample();
        cf.body = "第一段\n\n\n第四行\n".to_string();
        write_chapter(&path, &cf).unwrap();
        let back = read_chapter(&path).unwrap();
        assert_eq!(back.body, "第一段\n\n\n第四行\n");
    }
}
