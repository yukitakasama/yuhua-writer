/**
 * 导出对话框（M7 的最后一公里）。
 *
 * ## 为什么需要它
 *
 * 后端 `export_document` / `list_export_formats` 早就通了，前端绑定与
 * mock 也齐备，`pnpm check:ipc` 全绿 —— 但界面上没有任何入口，
 * 作者点不到导出。契约一致性与「功能可用」之间隔着的就是这一层。
 *
 * ## 三件必须做对的事
 *
 * 1. **不可用的格式要显式标出来**。可用性只由后端的 `available` 字段决定，
 *    前端不硬编码任何格式名单 —— 后端说不可用，界面就在点之前让人看见，
 *    而不是点了才报错。（今天六种格式都可用，这条规则是为「将来某个格式
 *    因缺依赖而不可用」准备的，PDF 是最可能的一个。）
 * 2. **降级记录必须展示**。Markdown→IR 有九种降级（表格、脚注、
 *    数学式……），后端把它们连同 `chapterTitle` 一起返回。
 *    导出「成功」但内容被悄悄改写，比失败更糟。
 * 3. **范围要能退化**。整本书永远可用；「当前卷 / 当前章」在没有
 *    选中章时是无效选项，要禁用而不是让用户选完再报错。
 * 4. **署名要填得进来、记得住**。作者是这本书的属性，存在
 *    `.yuhua/workspace.json`：这里预填已存的值，改了就在导出前写回，
 *    下次打开还是它。（入口放在导出面板的理由见 `metaLabel` 那条文案的注释。）
 */

import {
  Show,
  For,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
} from "solid-js";

import { t } from "@/strings";
import { Button } from "@/design/primitives";
import { Dialog } from "@/design/primitives";
import {
  exportDocument,
  listExportFormats,
  isTauri,
  toFailure,
  type ExportFormat,
  type ExportFormatInfo,
  type ExportResult,
  type ExportScope,
} from "@/lib/ipc";
import {
  currentBook,
  hasOpenWorkspace,
  saveBookMeta,
  selectedChapter,
} from "@/app/workspace-store";

export interface ExportDialogProps {
  /** 是否打开。 */
  open: boolean;
  /** 关闭请求。 */
  onClose: () => void;
  /**
   * 把编辑器里未落盘的改动刷到磁盘；**刷不成要抛**。导出在它成功之前不许开始。
   *
   * ## 为什么这件事必须有
   *
   * 自动保存有 1.5 秒防抖，作者刚敲完的最后一段大概率还在防抖里；
   * 而后端装配时按章读的是**磁盘**上的正文。少了这一步，那次导出交出去的
   * 就是上一版，而且全程没有任何提示 —— 交稿缺内容是最贵的一类静默失败。
   *
   * ## 为什么是必填而不是可选
   *
   * 这个句柄上一版就是可选的，于是生产调用点根本没传，缺陷就藏在
   * 「传不传都行」里。类型上做成必填，漏传直接编译不过。
   */
  flushEditor: () => Promise<void>;
}

/** 三种可选范围。「选中若干章」暂不开放：树里没有多选交互。 */
type ScopeKind = "whole" | "volume" | "single";

const SCOPE_KINDS: readonly ScopeKind[] = ["whole", "volume", "single"];

/**
 * 范围的显示名。
 *
 * 写成显式分支而不是 `` t(`export.scope${…}`) ``：`t` 的参数是
 * 由字典推导出的字面量联合类型，拼出来的模板字符串不在其中，
 * 编译期就查不出「打错了一个键」。
 */
function scopeLabel(kind: ScopeKind): string {
  if (kind === "whole") return t("export.scopeWhole");
  if (kind === "volume") return t("export.scopeVolume");
  return t("export.scopeSingle");
}

/** 把字节数压成人能一眼读懂的量级。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return t("export.sizeBytes", { count: bytes });
  if (bytes < 1024 * 1024)
    return t("export.sizeKb", {
      count: (bytes / 1024).toFixed(1),
    });
  return t("export.sizeMb", {
    count: (bytes / (1024 * 1024)).toFixed(2),
  });
}

/** 导出对话框。 */
export function ExportDialog(props: ExportDialogProps): JSX.Element {
  const [formats, setFormats] = createSignal<ExportFormatInfo[]>([]);
  const [format, setFormat] = createSignal<ExportFormat>("txt");
  const [scopeKind, setScopeKind] = createSignal<ScopeKind>("whole");
  const [path, setPath] = createSignal("");
  const [author, setAuthor] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<ExportResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /** 有没有选中章 —— 决定「当前卷 / 当前章」是否可选。 */
  const hasChapter = createMemo(() => selectedChapter() !== null);

  /** 默认文件名用书名，没有书名时退回「导出」。 */
  const bookName = createMemo(() => {
    const name = currentBook()?.title?.trim();
    return name === undefined || name === "" ? "导出" : name;
  });

  /** 当前选中格式的扩展名，用于拼默认文件名与对话框过滤器。 */
  const activeExtension = createMemo(() => {
    const id = format();
    return formats().find((f) => f.id === id)?.extension ?? "";
  });

  /**
   * 署名与简介相对已存的值有没有改动。
   *
   * 后端 `update_book_meta` 每次都会重写 `workspace.json`（trim 之后落盘），
   * 所以没改就别发：导出是高频动作，没必要每次动一次配置文件。
   * 比对的是 trim 后的值 —— 后端存的就是 trim 后的。
   */
  const metaDirty = createMemo(() => {
    const book = currentBook();
    return (
      (book?.author ?? "") !== author().trim() ||
      (book?.description ?? "") !== description().trim()
    );
  });

  /**
   * 把界面选择翻成后端的 `ExportScope`。
   *
   * 返回 `null` 表示「这个范围现在没有意义」（比如没选中章却选了
   * 「当前章」）。调用方据此给出提示，而不是把空 ID 发给后端。
   */
  const resolveScope = (): ExportScope | null => {
    const kind = scopeKind();
    if (kind === "whole") return { type: "whole" };
    const chapter = selectedChapter();
    if (chapter === null) return null;
    return kind === "volume"
      ? { type: "volume", volumeId: chapter.volumeId }
      : { type: "single", chapterId: chapter.id };
  };

  /**
   * 每次打开都重新拉一次格式表。
   *
   * 不缓存到模块级：可用性取决于**当前构建**（PDF 就是典型的
   * 「代码在但这个构建没启用」），而一次会话里不会变，
   * 但跨会话/跨版本会变，所以以每次打开为准最省心。
   */
  createEffect(() => {
    if (!props.open) return;
    setResult(null);
    setError(null);
    setBusy(false);
    // 预填成**已经存着的那一份**：作者是填一次就记住的属性，
    // 每次打开都从空框开始等于让作者每次重想一遍署名，
    // 而他很可能以为空着就是"沿用上次"。
    const book = currentBook();
    setAuthor(book?.author ?? "");
    setDescription(book?.description ?? "");
    void listExportFormats()
      .then((list) => {
        setFormats(list);
        // 默认落在第一个**可用**格式上，不要选中一个点不动的项
        const first = list.find((f) => f.available);
        if (first !== undefined) setFormat(first.id as ExportFormat);
      })
      .catch((err: unknown) => {
        setError(toFailure(err).error.message);
      });
  });

  /** 选中的格式变成不可用时（理论上不会），把错误提示清掉重选。 */
  const formatAvailable = (id: string): boolean =>
    formats().find((f) => f.id === id)?.available ?? false;

  const pickPath = async (): Promise<void> => {
    // 浏览器降级模式没有原生对话框；此时输入框仍可手填，
    // mock 后端会接受任意路径，方便开发时走完整流程。
    if (!isTauri()) return;
    try {
      // 动态 import：dialog 插件只在点了按钮才需要，
      // 顶层 import 会把它打进首屏 chunk（与 NewWorkspace 一致）
      const { save } = await import("@tauri-apps/plugin-dialog");
      const ext = activeExtension();
      const picked = await save({
        title: t("export.title"),
        defaultPath: `${bookName()}${ext === "" ? "" : `.${ext}`}`,
        filters:
          ext === ""
            ? undefined
            : [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (typeof picked === "string") setPath(picked);
    } catch (err) {
      setError(toFailure(err).error.message);
    }
  };

  const submit = async (): Promise<void> => {
    if (busy()) return;
    const target = path().trim();
    if (target === "") {
      setError(t("export.needPath"));
      return;
    }
    const scope = resolveScope();
    if (scope === null) {
      setError(t("export.needChapter"));
      return;
    }
    if (!formatAvailable(format())) {
      setError(t("export.formatUnavailable"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // 先落盘再导出（见 props.flushEditor）。抛出来的就是「没能存下」，
      // 下面那句 exportDocument 因此根本不会执行 —— 宁可什么都不交，
      // 也不交一份看着完整、实际少了最后一段的稿子。
      await props.flushEditor();
      // 署名同理，且必须排在导出**之前**：后端装配时读的是内存文稿里的
      // 作者，而内存只在写回成功之后才更新（见 store 的 saveBookMeta）。
      // 写回失败还继续导，交出去的文件署的还是旧名字，界面上填的却是新的。
      if (metaDirty() && !(await saveBookMeta(author(), description()))) {
        setError(t("export.metaNeedsSaved"));
        return;
      }
      setResult(await exportDocument(format(), scope, target));
    } catch (err) {
      setError(toFailure(err).error.message);
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (): Promise<void> => {
    const produced = result();
    if (produced === null || !isTauri()) return;
    try {
      // `revealItemInDir` 而不是 `openPath`：文案承诺的是「打开所在
      // 文件夹」，后者会用默认程序直接打开文件（EPUB/DOCX 会拉起
      // 别的软件），不是用户以为的那个动作。
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(produced.path);
    } catch (err) {
      setError(toFailure(err).error.message);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("export.title")}
      description={t("export.description")}
      width={560}
      class="export-dialog"
      footer={
        <Show
          when={result() === null}
          fallback={
            <Button variant="primary" onClick={props.onClose}>
              {t("export.done")}
            </Button>
          }
        >
          <div class="export-dialog__footer">
            <Button variant="ghost" onClick={props.onClose} disabled={busy()}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={busy() || !hasOpenWorkspace()}
            >
              {busy() ? t("export.exporting") : t("export.submit")}
            </Button>
          </div>
        </Show>
      }
    >
      <Show
        when={result() === null}
        fallback={
          <div class="export-result" role="status">
            <h3 class="export-result__title">{t("export.successTitle")}</h3>
            <p class="export-result__path">{result()?.path}</p>
            <p class="export-result__size">
              {t("export.successSize", {
                size: formatSize(result()?.bytes ?? 0),
              })}
            </p>
            <Show when={isTauri()}>
              <Button variant="secondary" onClick={() => void openFolder()}>
                {t("export.openFolder")}
              </Button>
            </Show>

            <Show
              when={(result()?.degradations.length ?? 0) > 0}
              fallback={
                <p class="export-result__clean">{t("export.noDegradation")}</p>
              }
            >
              <section class="export-degraded" aria-live="polite">
                <h4 class="export-degraded__title">
                  {t("export.degradationsTitle", {
                    count: result()?.degradations.length ?? 0,
                  })}
                </h4>
                <p class="export-degraded__hint">
                  {t("export.degradationsHint")}
                </p>
                <ul class="export-degraded__list">
                  <For each={result()?.degradations ?? []}>
                    {(d) => (
                      <li>
                        {t("export.degradationItem", {
                          chapter: d.chapterTitle,
                          detail: d.detail,
                        })}
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          </div>
        }
      >
        <div class="export-form">
          <Show when={!hasOpenWorkspace()}>
            <p class="export-form__notice">{t("export.needWorkspace")}</p>
          </Show>

          {/* ---- 格式 ---- */}
          <fieldset class="export-field" disabled={busy()}>
            <legend class="export-field__label">
              {t("export.formatLabel")}
            </legend>
            <div
              class="export-formats"
              role="radiogroup"
              aria-label={t("export.formatLabel")}
            >
              <For each={formats()}>
                {(f) => (
                  <label
                    class={[
                      "export-format",
                      format() === f.id ? "is-checked" : "",
                      f.available ? "" : "is-unavailable",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <input
                      type="radio"
                      name="export-format"
                      value={f.id}
                      checked={format() === f.id}
                      disabled={!f.available}
                      onChange={() => setFormat(f.id as ExportFormat)}
                    />
                    <span class="export-format__name">{f.displayName}</span>
                    <Show when={!f.available}>
                      <span class="export-format__flag">
                        {t("export.formatUnavailable")}
                      </span>
                    </Show>
                  </label>
                )}
              </For>
            </div>
          </fieldset>

          {/* ---- 范围 ---- */}
          <fieldset class="export-field" disabled={busy()}>
            <legend class="export-field__label">
              {t("export.scopeLabel")}
            </legend>
            <div
              class="export-scopes"
              role="radiogroup"
              aria-label={t("export.scopeLabel")}
            >
              <For each={SCOPE_KINDS}>
                {(kind) => {
                  // 「当前卷 / 当前章」在没有选中章时无意义，禁用而不是
                  // 让人选完再报错
                  const enabled = kind === "whole" || hasChapter();
                  return (
                    <label
                      class={[
                        "export-scope",
                        scopeKind() === kind ? "is-checked" : "",
                        enabled ? "" : "is-disabled",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <input
                        type="radio"
                        name="export-scope"
                        value={kind}
                        checked={scopeKind() === kind}
                        disabled={!enabled}
                        onChange={() => setScopeKind(kind)}
                      />
                      <span>{scopeLabel(kind)}</span>
                    </label>
                  );
                }}
              </For>
            </div>
          </fieldset>

          {/* ---- 本书信息 ---- */}
          <fieldset class="export-field" disabled={busy()}>
            <legend class="export-field__label">{t("export.metaLabel")}</legend>
            <div class="export-meta">
              <label class="export-meta__label" for="export-author">
                {t("export.authorLabel")}
              </label>
              <input
                id="export-author"
                class="export-meta__input"
                type="text"
                value={author()}
                placeholder={t("export.authorPlaceholder")}
                disabled={busy()}
                onInput={(event) => setAuthor(event.currentTarget.value)}
              />
              <label class="export-meta__label" for="export-description">
                {t("export.descriptionLabel")}
              </label>
              <textarea
                id="export-description"
                class="export-meta__input export-meta__textarea"
                rows={2}
                value={description()}
                placeholder={t("export.descriptionPlaceholder")}
                disabled={busy()}
                onInput={(event) => setDescription(event.currentTarget.value)}
              />
            </div>
          </fieldset>

          {/* ---- 保存位置 ---- */}
          <div class="export-field">
            <label class="export-field__label" for="export-path">
              {t("export.pathLabel")}
            </label>
            <div class="export-path">
              <input
                id="export-path"
                class="export-path__input"
                type="text"
                value={path()}
                placeholder={t("export.pathPlaceholder")}
                disabled={busy()}
                onInput={(event) => setPath(event.currentTarget.value)}
              />
              <Button
                variant="secondary"
                onClick={() => void pickPath()}
                disabled={busy() || !isTauri()}
              >
                {t("export.pickPath")}
              </Button>
            </div>
          </div>

          <Show when={error() !== null}>
            <p class="export-error" role="alert">
              {error()}
            </p>
          </Show>
        </div>
      </Show>
    </Dialog>
  );
}
