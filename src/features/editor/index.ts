/**
 * 编辑器内核（M4）对外出口。
 *
 * 外面的人（App、EditorPane、命令面板）只从这里 import，
 * 不直接摸 CodeMirror 的类型 —— 这样将来换编辑器实现时，
 * 改动被限制在这个目录里。
 */

export { MarkdownEditor, createEditorExtensions, fontCompartmentExtension, type EditorHandle, type MarkdownEditorProps } from "./MarkdownEditor";
export { MARKDOWN_SUBSET, FIRST_CLASS_SYNTAXES, DEGRADED_SYNTAXES, isMarkdownMarker, type SubsetRule } from "./markdown-subset";
export { hiddenRangesForLine } from "./instant-render";
export { AutosaveScheduler, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS, isUserEdit, type AutosaveOptions } from "./autosave";
export { isComposing, compositionSettled, compositionStart, imeCompositionGuard, type CompositionListener } from "./ime";
export { captureCursor, resolveCursor, isCursorResolvable, rememberCursor, recallCursor, CURSOR_STORE_LIMIT, type ChapterCursor, type CursorStore } from "./cursor-memory";
export { DEFAULT_BINDINGS, eventToChord, findConflicts, applyOverrides, bindingById, detectMac, displayChord, type KeyBinding } from "./shortcuts";
export { normalizePastedText, htmlToMarkdown, isSafeHref, isSafeSrc, pickPastedText } from "./paste";
export { focusMode, toggleFocusMode, enterFocusMode, exitFocusMode, focusModeClass } from "./focus";
