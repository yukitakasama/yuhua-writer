/**
 * 全局级 / 工作区级切换（T9.4）。
 *
 * ## 为什么是二选一而不是一个「本书覆盖」开关
 *
 * 开关的语义是「这个值属于本书吗」，读起来像在问控件本身；
 * 二选一的语义是「我正在改哪一层」，读起来是在问用户意图。
 * 后者更接近用户脑子里的问题（「我想改这本书的字体」），
 * 而且选中项直接告诉用户「你现在改的东西会影响谁」。
 *
 * 选中「本书」时不会自动把当前全局值复制成覆盖值 —— 那样会让
 * 「本书已覆盖」这个标记在没有实际差异时就亮起来。
 * 真正的覆盖发生在用户动了某个控件之后。
 */

import { type JSX } from "solid-js";

import { hasOpenWorkspace } from "@/app/workspace-store";
import { t } from "@/strings";

/** 设置层级。 */
export type SettingsLevel = "global" | "workspace";

/** {@link LevelToggle} 的 props。 */
export interface LevelToggleProps {
  /** 当前层级。 */
  level: SettingsLevel;
  /** 层级变化回调。 */
  onChange: (level: SettingsLevel) => void;
}

/**
 * 层级切换。
 *
 * @example
 * <LevelToggle level={level()} onChange={setLevel} />
 */
export function LevelToggle(props: LevelToggleProps): JSX.Element {
  const canWorkspace = (): boolean => hasOpenWorkspace();

  const choose = (next: SettingsLevel): void => {
    if (next === "workspace" && !canWorkspace()) return;
    props.onChange(next);
  };

  return (
    <div class="level-toggle">
      <span class="level-toggle__label" id="yh-level-label">
        {t("settings.level.label")}
      </span>
      <div
        class="level-toggle__group"
        role="radiogroup"
        aria-labelledby="yh-level-label"
      >
        <button
          type="button"
          role="radio"
          data-level="global"
          class="level-toggle__item"
          aria-checked={props.level === "global" ? "true" : "false"}
          tabindex={props.level === "global" ? 0 : -1}
          onClick={() => choose("global")}
        >
          {t("settings.level.global")}
        </button>
        <button
          type="button"
          role="radio"
          data-level="workspace"
          class="level-toggle__item"
          aria-checked={props.level === "workspace" ? "true" : "false"}
          tabindex={props.level === "workspace" ? 0 : -1}
          // 未打开工作区时「本书」不可用。用 aria-disabled 而不是 disabled：
          // disabled 会让按钮移出 Tab 序，键盘用户就永远看不到「为什么不能选」，
          // 而 aria-disabled 保留可聚焦性，让提示能被读到。
          aria-disabled={canWorkspace() ? undefined : "true"}
          onClick={() => choose("workspace")}
        >
          {t("settings.level.workspace")}
        </button>
      </div>
      <p class="level-toggle__hint">
        {props.level === "global"
          ? t("settings.level.globalHint")
          : t("settings.level.workspaceHint")}
      </p>
      {!canWorkspace() && (
        <p class="level-toggle__note">{t("settings.level.noWorkspace")}</p>
      )}
    </div>
  );
}
