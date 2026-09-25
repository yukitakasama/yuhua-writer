//! PDF 渲染器（占位，稍后实现）。
use crate::error::{ExportError, Result};
use crate::ir::Document;

/// 渲染 PDF。第一阶段未实现。
pub fn render_pdf(_document: &Document) -> Result<Vec<u8>> {
    Err(ExportError::Unimplemented("pdf"))
}
