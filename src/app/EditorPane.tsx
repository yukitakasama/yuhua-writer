/**
 * 中间编辑区（占位）。
 *
 * ## 为什么即使只放占位也要做对结构
 *
 * M4 接入 CodeMirror 时，外面这层「正文容器 + 最大宽度 + 行高 +
 * 空状态」的骨架**完全复用** —— 计划书 5.1 节规定正文区
 * 最大宽度 720px、行高 1.8，这些是排版决策，与用什么编辑器无关。
 * 现在就按最终尺寸搭好，接入时不会因为字体度量变化而返工。
 */

import { Show, createSignal, onMount, type JSX } from "solid-js";

import { t } from "@/strings";
import { EmptyState } from "@/app/ui/EmptyState";
import { IllustrationEmptyEditor } from "@/app/ui/illustrations";
import { Button } from "@/app/ui/Button";
import { selectedChapter, editingChapter, loadChapterBody, createFirstChapter } from "./workspace-store";
import { EDITOR_HINT } from "./placeholders";

/**
 * 中间编辑区。
 *
 * 本阶段只渲染**只读正文预览**：IPC 的读写通道已经打通
 * （readChapter / saveChapter 都在 ipc 层就位），因此这不是假数据，
 * 是真的从后端读回来的正文。M4 只需要把 `<pre>` 换成编辑器实例。
 */
export function EditorPane(): JSX.Element {
  const [loading, setLoading] = createSignal(false);

  // 选中章节变化时自动载入正文。onMount 只是为了在首帧后触发，
  // 避免阻塞首次渲染
  onMount(() => {
    const first = selectedChapter();
    if (first && editingChapter()?.id !== first.id) {
      setLoading(true);
      void loadChapterBody(first.id).finally(() => setLoading(false));
    }
  });

  const chapter = () => selectedChapter();
  const body = () => {
    const current = chapter();
    const editing = editingChapter();
    if (!current || editing === null || editing.id !== current.id) return "";
    return editing.body;
  };

  return (
    <main class="editor" aria-label={t("a11y.mainRegion")}>
      <Show
        when={chapter()}
        fallback={
          <EmptyState
            illustration={<IllustrationEmptyEditor size={148} />}
            title={t("editor.noChapter")}
            body={EDITOR_HINT}
            action={
              <Button variant="outline" onClick={() => void createFirstChapter()}>
                {t("editor.selectHint")}
              </Button>
            }
          />
        }
      >
        {(current) => (
          <article class="editor__page">
            <h1 class="editor__title">{current().title}</h1>
            <Show when={loading()} fallback={<pre class="editor__body">{body() || t("editor.placeholderBody")}</pre>}>
              <p class="editor__loading">{t("app.booting")}</p>
            </Show>
            <p class="editor__hint">{EDITOR_HINT}</p>
          </article>
        )}
      </Show>
    </main>
  );
}
