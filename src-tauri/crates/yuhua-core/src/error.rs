//! 统一错误类型。
//!
//! 设计要点：
//!
//! 1. **可序列化**：Tauri 命令返回的错误必须能跨 IPC 到达前端，因此实现了
//!    Serialize。前端按 code 字段做分支，而不是去匹配人类可读的 message。
//! 2. **带上下文**：每种错误都携带出问题的那条路径 / ID，方便定位，
//!    而不是把信息都堆在 message 字符串里。
//! 3. **不吞错**：所有 io::Error 都保留 source，日志与错误页能拿到根因。

use std::path::PathBuf;

use serde::{Serialize, Serializer};

/// 领域层统一 Result 别名。
pub type Result<T, E = YuhuaError> = std::result::Result<T, E>;

/// 羽化写作统一错误类型。
///
/// 变体按「错误来源」划分，而不是按「调用位置」划分 —— 同一个变体
/// 会被命令层、索引层、导出层共同复用，避免错误类型爆炸。
#[derive(Debug, thiserror::Error)]
pub enum YuhuaError {
    /// 工作区不存在 / 不是合法工作区。
    #[error("工作区无效：{path}（{reason}）")]
    InvalidWorkspace {
        /// 出问题的工作区路径。
        path: PathBuf,
        /// 具体原因，例如「缺少 .yuhua/workspace.json」。
        reason: String,
    },

    /// 目标实体（书 / 卷 / 章）不存在。
    #[error("找不到 {kind}：{id}")]
    NotFound {
        /// 实体种类，如 chapter / volume / book。
        kind: &'static str,
        /// 实体 ID。
        id: String,
    },

    /// 违反领域不变量（例如把卷挂到别的书下）。
    #[error("不变量被破坏：{0}")]
    Invariant(String),

    /// 输入非法（用户可修正）。
    #[error("参数非法：{0}")]
    InvalidInput(String),

    /// 文件系统错误，保留原始 io 错误作为 source。
    #[error("文件操作失败：{path}")]
    Io {
        /// 相关路径。
        path: PathBuf,
        /// 底层原因。
        #[source]
        source: std::io::Error,
    },

    /// 序列化 / 反序列化失败（Front Matter、JSON 配置、统计文件）。
    #[error("解析失败（{context}）：{message}")]
    Parse {
        /// 解析的对象类型，如 front matter。
        context: &'static str,
        /// 具体解析错误信息。
        message: String,
    },

    /// 数据库（索引层）错误。
    #[error("索引库错误：{0}")]
    Database(String),

    /// 导出错误。
    #[error("导出失败：{0}")]
    Export(String),

    /// 当前阶段尚未实现的功能（明确暴露，而不是静默返回空数据）。
    #[error("功能尚未实现：{0}")]
    Unimplemented(&'static str),
}

impl YuhuaError {
    /// 构造一个带路径上下文的 IO 错误。
    ///
    /// 提供这个辅助函数是为了让调用点写成一行 map_err，
    /// 而不是每处都手写一遍结构体字面量。
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    /// 稳定的机器可读错误码。
    ///
    /// 前端据此决定 UI 表现（例如 WORKSPACE_INVALID 引导用户重新选择目录，
    /// 而 IO_ERROR 只弹一个 toast）。**这些字符串是对外契约，不要随意改名。**
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidWorkspace { .. } => "WORKSPACE_INVALID",
            Self::NotFound { .. } => "NOT_FOUND",
            Self::Invariant(_) => "INVARIANT_VIOLATION",
            Self::InvalidInput(_) => "INVALID_INPUT",
            Self::Io { .. } => "IO_ERROR",
            Self::Parse { .. } => "PARSE_ERROR",
            Self::Database(_) => "DATABASE_ERROR",
            Self::Export(_) => "EXPORT_ERROR",
            Self::Unimplemented(_) => "UNIMPLEMENTED",
        }
    }

    /// 该错误是否可能由用户修正后重试（UI 据此决定是否给出「重试」按钮）。
    pub fn is_recoverable(&self) -> bool {
        matches!(
            self,
            Self::InvalidInput(_) | Self::Io { .. } | Self::NotFound { .. }
        )
    }
}

/// 发往前端的 JSON 形状。
///
/// 手写 Serialize 而不派生，是因为 io::Error 本身不是 Serialize，
/// 需要摊平成字符串；同时这样能保持字段名稳定。
impl Serialize for YuhuaError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;

        let mut st = serializer.serialize_struct("YuhuaError", 4)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("recoverable", &self.is_recoverable())?;
        // 底层原因单独给出，前端可折叠展示，便于用户报 bug 时复制
        let detail = match self {
            Self::Io { source, .. } => Some(source.to_string()),
            Self::Parse { message, .. } => Some(message.clone()),
            _ => None,
        };
        st.serialize_field("detail", &detail)?;
        st.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_error_keeps_path_and_code() {
        let e = YuhuaError::io(
            "D:/ws/a.md",
            std::io::Error::new(std::io::ErrorKind::NotFound, "missing"),
        );
        assert_eq!(e.code(), "IO_ERROR");
        assert!(e.to_string().contains("a.md"));
        assert!(e.is_recoverable());
    }

    #[test]
    fn serializes_to_stable_shape() {
        let e = YuhuaError::InvalidInput("标题不能为空".into());
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], "INVALID_INPUT");
        assert_eq!(json["recoverable"], true);
        assert!(json["message"].as_str().unwrap().contains("标题不能为空"));
    }

    #[test]
    fn unimplemented_is_not_recoverable() {
        assert!(!YuhuaError::Unimplemented("pdf").is_recoverable());
    }
}
