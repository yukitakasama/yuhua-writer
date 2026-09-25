//! 命令层错误类型。
//!
//! 命令层**不发明新的错误语义**，而是把 [`yuhua_core::YuhuaError`] 包一层，
//! 补上「还没打开工作区」这类**只属于命令层**的错误。
//!
//! 序列化形状与前端约定一致（`{ code, message, recoverable, detail }`），
//! 前端按 `code` 分支处理，不解析 message 文本。

use serde::{Serialize, Serializer};
use yuhua_core::YuhuaError;

/// 命令层错误。
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    /// 领域层错误（透传）。
    #[error("{0}")]
    Domain(#[from] YuhuaError),

    /// 尚未打开工作区。
    #[error("尚未打开工作区，请先新建或打开一个工作区")]
    NoWorkspace,

    /// 命令层内部错误（状态锁被污染等）。
    ///
    /// 这类错误属于**程序缺陷**，不应出现在正常路径上。
    /// 单列一个变体便于在日志里一眼区分。
    #[error("内部错误：{0}")]
    Internal(String),
}

impl CommandError {
    /// 构造「未打开工作区」错误。
    pub fn not_opened() -> Self {
        Self::NoWorkspace
    }

    /// 构造内部错误。
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }

    /// 稳定的机器可读错误码。
    ///
    /// **这些字符串是对外契约**：前端与用户文档都依赖它，不要随意改名。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Domain(e) => e.code(),
            Self::NoWorkspace => "NO_WORKSPACE",
            Self::Internal(_) => "INTERNAL",
        }
    }

    /// 用户是否可以采取行动后重试。
    pub fn is_recoverable(&self) -> bool {
        match self {
            Self::Domain(e) => e.is_recoverable(),
            // 打开一个工作区后就能重试，因此算可恢复
            Self::NoWorkspace => true,
            Self::Internal(_) => false,
        }
    }

    /// 附加细节（供用户报 bug 时复制）。
    pub fn detail(&self) -> Option<String> {
        match self {
            Self::Domain(YuhuaError::Io { source, .. }) => Some(source.to_string()),
            Self::Domain(YuhuaError::Parse { message, .. }) => Some(message.clone()),
            Self::Internal(m) => Some(m.clone()),
            _ => None,
        }
    }
}

/// 手工实现 Serialize 以保持字段名稳定。
impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = serializer.serialize_struct("CommandError", 4)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("recoverable", &self.is_recoverable())?;
        st.serialize_field("detail", &self.detail())?;
        st.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_workspace_has_its_own_code() {
        let e = CommandError::not_opened();
        assert_eq!(e.code(), "NO_WORKSPACE");
        assert!(e.is_recoverable(), "打开工作区后即可重试");
    }

    #[test]
    fn domain_errors_pass_through_codes() {
        let e = CommandError::Domain(YuhuaError::InvalidInput("标题为空".into()));
        assert_eq!(e.code(), "INVALID_INPUT");
        assert!(e.is_recoverable());
    }

    #[test]
    fn internal_errors_are_not_recoverable() {
        let e = CommandError::internal("锁被污染");
        assert_eq!(e.code(), "INTERNAL");
        assert!(!e.is_recoverable());
    }

    #[test]
    fn serializes_to_stable_shape() {
        let e = CommandError::not_opened();
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "NO_WORKSPACE");
        assert_eq!(v["recoverable"], true);
        assert!(v["message"].as_str().unwrap().contains("工作区"));
    }

    #[test]
    fn io_detail_is_exposed() {
        let e = CommandError::Domain(YuhuaError::io(
            "D:/x.md",
            std::io::Error::new(std::io::ErrorKind::NotFound, "missing"),
        ));
        assert_eq!(e.code(), "IO_ERROR");
        assert!(e.detail().unwrap().contains("missing"));
    }
}
