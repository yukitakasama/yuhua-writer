//! DOCX 渲染器（占位，稍后实现）。
use crate::error::Result;
use crate::ir::Document;
use crate::render::{ExportFormat, Renderer};

/// DOCX 渲染器。
#[derive(Debug, Clone, Default)]
pub struct DocxRenderer;

impl<'a> Renderer<'a> for DocxRenderer {
    fn format(&self) -> ExportFormat {
        ExportFormat::Docx
    }
    fn render(&self, _document: &'a Document) -> Result<Vec<u8>> {
        Ok(Vec::new())
    }
}
