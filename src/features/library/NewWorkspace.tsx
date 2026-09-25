/**
 * 新建工作区引导（T5.2 的「新建工作区」入口）。
 *
 * ## 为什么把这一步做得这么"啰嗦"
 *
 * 工作区是**用户会在文件管理器里长期看到的一个普通文件夹**，
 * 而且往往会被放进云盘。这一步选错位置的代价很高：
 * 放进系统临时目录会被清理，放进 C 盘根目录会杂乱，
 * 放进已有工作区会直接失败。
 *
 * 因此这里明确告诉用户三件事：文件夹在哪、里面会有什么、能不能移动。
 * 这些信息在别处没有地方讲（设置页里用户不会去看）。
 *
 * ## Tauri / 浏览器差异
 *
 * 目录选择在 Tauri 里走 dialog 插件，在浏览器里没有这个能力，
 * 因此退化为**手输路径 + 一份示例路径**。这不是妥协：
 * 浏览器模式本来就是开发预览，能走通流程就够了。
 */

import { Show, createSignal, type JSX } from "solid-js";

import { t } from "@/strings";
import { Button } from "@/app/ui/Button";
import { TextField } from "@/app/ui/TextField";
import { IconVolume } from "@/app/ui/icons";
import { isTauri } from "@/lib/ipc";

/** 新建工作区表单属性。 */
export interface NewWorkspaceProps {
  /** 提交。返回是否成功，失败时表单保留输入。 */
  onCreate: (root: string, title: string) => Promise<boolean>;
  /** 取消，回到书架。 */
  onCancel: () => void;
  /** 浏览器模式下预填的示例路径。 */
  defaultRoot?: string;
}

/** 新建工作区引导。 */
export function NewWorkspace(props: NewWorkspaceProps): JSX.Element {
  const [title, setTitle] = createSignal("");
  const [root, setRoot] = createSignal(props.defaultRoot ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  /** 目录名由书名推导，用户改书名时路径跟着变（除非已经手改过）。 */
  let rootTouched = false;

  const pickDirectory = async (): Promise<void> => {
    if (!isTauri()) return;
    try {
      // 动态 import：dialog 插件只在点了按钮时才需要，
      // 顶层 import 会把它打进首屏 chunk
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: t("library.openDirectory") });
      if (typeof picked === "string") {
        rootTouched = true;
        setRoot(picked);
      }
    } catch {
      setError(t("error.generic"));
    }
  };

  const submit = async (): Promise<void> => {
    const name = title().trim();
    const path = root().trim().replace(/[\\/]+$/, "");
    if (name.length === 0) {
      setError(t("error.generic"));
      return;
    }
    if (path.length === 0) {
      setError(t("error.generic"));
      return;
    }
    setBusy(true);
    setError(null);
    // 工作区根 = 用户选的目录 / 书名，与文件管理器里的习惯一致
    const ok = await props.onCreate(`${path}/${sanitize(name)}`, name);
    setBusy(false);
    if (!ok) setError(t("error.generic"));
  };

  return (
    <div class="guide">
      <div class="guide__art" aria-hidden="true">
        <IconVolume size={40} />
      </div>

      <h2 class="guide__title">{t("library.newWorkspace")}</h2>
      <p class="guide__body">{t("library.emptyBody")}</p>

      <div class="guide__form">
        <label class="guide__field">
          <span class="guide__label">{t("library.workspaceName")}</span>
          <TextField
            value={title()}
            placeholder={t("library.workspaceNamePlaceholder")}
            autofocus
            onInput={(event) => {
              setTitle(event.currentTarget.value);
              if (!rootTouched) {
                const base = props.defaultRoot ?? "";
                setRoot(base ? `${base}/${sanitize(event.currentTarget.value)}` : "");
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>

        <label class="guide__field">
          <span class="guide__label">{t("library.workspaceLocation")}</span>
          <div class="guide__path-row">
            <TextField
              value={root()}
              onInput={(event) => {
                rootTouched = true;
                setRoot(event.currentTarget.value);
              }}
            />
            <Show when={isTauri()}>
              <Button variant="outline" onClick={() => void pickDirectory()}>
                {t("library.openDirectory")}
              </Button>
            </Show>
          </div>
        </label>
      </div>

      <Show when={error() !== null}>
        <p class="guide__error" role="alert">
          {error()}
        </p>
      </Show>

      <div class="guide__actions">
        <Button variant="ghost" onClick={props.onCancel}>
          {t("action.cancel")}
        </Button>
        <Button variant="solid" disabled={busy()} onClick={() => void submit()}>
          {busy() ? t("saveState.saving") : t("library.createWorkspace")}
        </Button>
      </div>
    </div>
  );
}

/**
 * 把书名变成安全的目录名。
 *
 * Windows 的保留字符最多（`\\ / : * ? " < > |`），且工作区很可能
 * 就在 Windows 上。统一按最严格的一套过滤，跨平台结果一致 ——
 * 否则同一个书名在不同系统上会生成不同的目录名，工作区就搬不了家。
 */
export function sanitize(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .slice(0, 80) || "未命名";
}
