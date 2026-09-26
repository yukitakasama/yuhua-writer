//! 导出层的错误类型。
//!
//! ## 为什么不直接用 `yuhua_core::YuhuaError`
//!
//! 因为导出失败的原因**绝大多数对用户不可修正**：磁盘满了、目标路径被占用、
//! 章节里的图片读不出来。`YuhuaError::is_recoverable` 是给 UI 决定
//! 「要不要显示重试按钮」用的，如果导出错误统统塞进 `YuhuaError::Export(String)`，
//! 前端就只能拿到一个字符串，没法判断该提示用户改参数还是让他换条路径。
//!
//! 所以这里定义一个**领域专属**的错误枚举，用 `#[from]` 与 `YuhuaError`
//! 双向打通：本层内部按细分原因分支，出了本层仍然统一收敛回 `YuhuaError`，
//! 不破坏「统一错误类型」这条全仓约定。

use std::path::PathBuf;

use yuhua_core::YuhuaError;

/// 导出层 Result 别名。
pub type Result<T, E = ExportError> = std::result::Result<T, E>;

/// 导出过程中的细分错误。
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    /// 输入参数非法（范围选择为空、宽度为负等用户可修正的问题）。
    #[error("导出参数非法：{0}")]
    InvalidInput(String),

    /// 装配 IR 时发现数据不自洽（例如章节引用了不存在的卷）。
    #[error("导出内容不完整：{0}")]
    Incomplete(String),

    /// Markdown 解析失败。
    #[error("解析失败（{context}）：{message}")]
    Parse {
        /// 出错的环节，例如「第 3 章 Markdown」。
        context: String,
        /// 具体原因。
        message: String,
    },

    /// 文件系统错误，保留原始 io 错误作为 source。
    #[error("导出写盘失败：{path}")]
    Io {
        /// 相关路径。
        path: PathBuf,
        /// 底层原因。
        #[source]
        source: std::io::Error,
    },

    /// 打包（DOCX / EPUB 的 zip 容器）失败。
    #[error("打包失败：{0}")]
    Package(String),

    /// 找不到或无法使用 PDF 需要的内嵌字体。
    ///
    /// ## 为什么单列一个变体而不是复用 `Io`
    ///
    /// 「找不到中文字体」是**用户可修正**的问题：装一个字体、
    /// 把字体文件丢进 assets/fonts/、或设一个环境变量即可。
    /// 而 `Io` 的语义是「磁盘出问题了」，前端只会提示「重试」。
    /// 单列之后错误码是 FONT_UNAVAILABLE，前端可以据此给出
    /// 「请安装中文字体」这类**带操作指引**的提示。
    ///
    /// 更关键的是：它保证了「绝不静默产出乱码 PDF」这条约束
    /// 在类型层面就成立 —— 没有字体就走这个分支，产不出字节。
    #[error("找不到可用的中文字体：{hint}")]
    FontUnavailable {
        /// 依次尝试过的路径（按搜索顺序）。
        searched: Vec<String>,
        /// 给用户的可操作提示。
        hint: String,
    },

    /// 字体文件存在但无法使用（损坏、被截断、是 CFF/OTF 轮廓）。
    #[error("字体文件不可用：{path}（{detail}）")]
    Font {
        /// 字体路径。
        path: String,
        /// 具体原因。
        detail: String,
    },

    /// 目标格式尚未实现。
    #[error("功能尚未实现：{0}")]
    Unimplemented(&'static str),
}

impl ExportError {
    /// 构造一个参数非法错误。
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::InvalidInput(msg.into())
    }

    /// 构造一个带路径上下文的 IO 错误。
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    /// 稳定的机器可读错误码。
    ///
    /// 前缀刻意与 `YuhuaError::code` 的取值保持同一词汇表：
    /// 前端只需要认识一套错误码，不必区分错误是从哪一层冒出来的。
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "INVALID_INPUT",
            Self::Incomplete(_) => "EXPORT_INCOMPLETE",
            Self::Parse { .. } => "PARSE_ERROR",
            Self::Io { .. } => "IO_ERROR",
            Self::Package(_) => "EXPORT_ERROR",
            // 字体缺失是独立错误码：它是唯一一个「换个环境就能修好」的
            // 导出失败，前端要能把它和磁盘错误区分开。
            Self::FontUnavailable { .. } | Self::Font { .. } => "FONT_UNAVAILABLE",
            Self::Unimplemented(_) => "UNIMPLEMENTED",
        }
    }
}

impl From<ExportError> for YuhuaError {
    fn from(value: ExportError) -> Self {
        match value {
            ExportError::InvalidInput(msg) => YuhuaError::InvalidInput(msg),
            ExportError::Incomplete(msg) => YuhuaError::Invariant(msg),
            ExportError::Parse { context, message } => YuhuaError::Parse {
                // YuhuaError::Parse 的 context 是 'static，导出层的上下文是动态字符串，
                // 统一归入 export 这个固定标签，细节留在 message 里不丢。
                context: "export",
                message: format!("{context}：{message}"),
            },
            ExportError::Io { path, source } => YuhuaError::Io { path, source },
            ExportError::Package(msg) => YuhuaError::Export(msg),
            // 收敛成 YuhuaError::Export(String) 而不是 Unimplemented：
            // YuhuaError 这一层没有「字体」这个细分，而 Export 的分类是
            // 「环境/资源问题，用户可干预」，语义比 Unimplemented 准确得多
            // （PDF 已经不是未实现了，是这台机器上没有中文字体）。
            ExportError::FontUnavailable { searched, hint } => {
                YuhuaError::Export(format!("{}（已尝试 {} 个路径）", hint, searched.len()))
            }
            ExportError::Font { path, detail } => {
                YuhuaError::Export(format!("字体不可用 {path}：{detail}"))
            }
            ExportError::Unimplemented(what) => YuhuaError::Unimplemented(what),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_error_keeps_path() {
        let err = ExportError::io(
            "D:/out/book.docx",
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"),
        );
        assert_eq!(err.code(), "IO_ERROR");
        assert!(err.to_string().contains("book.docx"));
    }

    #[test]
    fn converts_to_core_error_with_matching_code() {
        let err = ExportError::invalid("宽度不能为负");
        let core: YuhuaError = err.into();
        assert_eq!(core.code(), "INVALID_INPUT");
        assert!(core.is_recoverable());
    }

    #[test]
    fn parse_error_keeps_detail_after_conversion() {
        let err = ExportError::Parse {
            context: "第 2 章".into(),
            message: "表格语法错误".into(),
        };
        let core: YuhuaError = err.into();
        assert_eq!(core.code(), "PARSE_ERROR");
        assert!(core.to_string().contains("表格语法错误"));
    }

    #[test]
    fn unimplemented_maps_to_unimplemented() {
        let core: YuhuaError = ExportError::Unimplemented("pdf").into();
        assert_eq!(core.code(), "UNIMPLEMENTED");
    }

    #[test]
    fn package_error_keeps_message() {
        let err = ExportError::Package("zip 中央目录写入失败".into());
        assert_eq!(err.code(), "EXPORT_ERROR");
        assert!(err.to_string().contains("中央目录"));
    }
}
