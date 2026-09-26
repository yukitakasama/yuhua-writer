/**
 * 字体分区（T9.2 / T9.3 / T9.4）。
 *
 * ## 一个面板要同时回答三个问题
 *
 * 1. **三个作用域分别用什么字体** —— 三个 {@link ScopePicker} 并排；
 * 2. **我看到的效果对不对** —— 每个作用域下面挂一块 {@link FontPreview}，
 *    选择即预览（T9.3），不需要切回编辑区；
 * 3. **改的是全局还是这本书** —— 顶部的 {@link LevelToggle}（T9.4）。
 *
 * ## 层级切换时控件不重建
 *
 * 无论改哪一层，控件读的都是「生效值」（全局 + 本书合并后的结果），
 * 只是**写入**的目标不同。这样切换层级时界面不会跳一下 ——
 * 用户看到的值始终是他屏幕上真实在用的值。
 */

import { For, Show, createEffect, createSignal, type JSX } from "solid-js";

import {
  FONT_SCOPES,
  appearanceSettings,
  effectiveTypography,
  isScopeOverridden,
  setScopeTypography,
  setWorkspaceScope,
  syncAppearanceWorkspace,
  workspaceAppearance,
  type FontScope,
} from "@/app/appearance-store";
import { familiesFor } from "@/design/fonts";
import { hasOpenWorkspace, workspaceState } from "@/app/workspace-store";
import { FontPreview } from "./FontPreview";
import { LevelToggle, type SettingsLevel } from "./LevelToggle";
import { RangeField } from "./RangeField";
import { ScopePicker, scopeLabel } from "./ScopePicker";
import { t } from "@/strings";

/** {@link FontsPanel} 的 props。 */
export interface FontsPanelProps {
  /** 当前层级，由外层面板持有，切换分区时保持。 */
  level: SettingsLevel;
  /** 层级变化回调。 */
  onLevelChange: (level: SettingsLevel) => void;
}

/** 作用域对应的字号区间键（供 RangeField 取上下限）。 */
function sizeRange(scope: FontScope): { min: number; max: number } {
  if (scope === "heading") return { min: 16, max: 40 };
  if (scope === "ui") return { min: 12, max: 18 };
  return { min: 14, max: 24 };
}

/**
 * 字体分区。
 *
 * @example
 * <FontsPanel level={level()} onLevelChange={setLevel} />
 */
export function FontsPanel(props: FontsPanelProps): JSX.Element {
  /** 当前聚焦预览的作用域。默认全部展示。 */
  const [focus, setFocus] = createSignal<FontScope | "all">("all");

  // 写「本书」设置之前先确保分桶指向当前工作区。
  // 幂等，因此即使 useAppearance 已经同步过也没有额外代价（见 store 里的说明）。
  createEffect(() => {
    syncAppearanceWorkspace(workspaceState.root);
  });

  const typo = (): ReturnType<typeof effectiveTypography> => effectiveTypography();

  const canOverride = (): boolean => hasOpenWorkspace();

  /** 写入：按当前层级落到全局或本书。 */
  const writeScope = (scope: FontScope, patch: { family?: string }): void => {
    if (props.level === "workspace") setWorkspaceScope(scope, patch);
    else setScopeTypography(scope, patch);
  };

  /** 某个作用域在当前层级下是否处于「已被本书覆盖」状态。 */
  const overridden = (scope: FontScope): boolean =>
    props.level === "workspace" ? isScopeOverridden(scope) : false;

  /** 取消本书覆盖。 */
  const inherit = (scope: FontScope): void => {
    setWorkspaceScope(scope, { family: undefined, size: undefined, lineHeight: undefined });
  };

  return (
    <div class="settings-panel">
      <LevelToggle level={props.level} onChange={props.onLevelChange} />

      {/* 预览聚焦：三个作用域全看，还是只看一个。
          用 tablist 语义会与顶层设置分区冲突（tablist 嵌套），
          因此这里用一组 aria-pressed 的切换按钮，语义更准确。 */}
      <div class="font-focus" role="group" aria-label={t("settings.font.previewTitle")}>
        <button
          type="button"
          class="font-focus__item"
          aria-pressed={focus() === "all" ? "true" : "false"}
          onClick={() => setFocus("all")}
        >
          {t("settings.font.previewTitle")}
        </button>
        <For each={FONT_SCOPES}>
          {(scope) => (
            <button
              type="button"
              class="font-focus__item"
              aria-pressed={focus() === scope ? "true" : "false"}
              onClick={() => setFocus(scope)}
            >
              {scopeLabel(scope)}
            </button>
          )}
        </For>
      </div>

      <Show when={focus() === "all"} fallback={<FontPreview focus={focus() as FontScope} />}>
        <FontPreview />
      </Show>

      <div class="settings-scopes">
        <For each={FONT_SCOPES}>
          {(scope) => (
            <ScopePicker
              scope={scope}
              family={typo()[scope].family}
              overridden={overridden(scope)}
              onInherit={() => inherit(scope)}
              canOverride={canOverride()}
              onChange={(familyId) => writeScope(scope, { family: familyId })}
            >
              {/* 字号与行距放在作用域块内：它们与字体族是同一个决策的一部分 */}
              <RangeField
                label={t("settings.typography.size")}
                value={typo()[scope].size}
                min={sizeRange(scope).min}
                max={sizeRange(scope).max}
                step={1}
                unit={t("settings.typography.px")}
                onChange={(value) =>
                  props.level === "workspace"
                    ? setWorkspaceScope(scope, { size: value })
                    : setScopeTypography(scope, { size: value })
                }
              />
              <RangeField
                label={t("settings.typography.lineHeight")}
                value={typo()[scope].lineHeight}
                min={1.2}
                max={2.4}
                step={0.05}
                onChange={(value) =>
                  props.level === "workspace"
                    ? setWorkspaceScope(scope, { lineHeight: value })
                    : setScopeTypography(scope, { lineHeight: value })
                }
              />
            </ScopePicker>
          )}
        </For>
      </div>

      {/* 内置字体清单：让「有哪些内置字体」这件事可查，
          也顺便说明它们随包分发、不联网。 */}
      <section class="settings-note" aria-label={t("settings.font.bundledGroup")}>
        <p class="settings-note__body">{t("settings.font.bundledNote")}</p>
        <p class="settings-note__body">
          {familiesFor("body")
            .filter((f) => f.bundled)
            .map((f) => f.label)
            .join(" · ")}
        </p>
      </section>

      {/* 供测试与调试读取的隐藏状态：确认面板确实读的是生效值 */}
      <Show when={appearanceSettings.theme !== undefined && workspaceAppearance.root !== ""}>
        <span class="yh-visually-hidden" data-testid="font-panel-workspace">
          {workspaceAppearance.root}
        </span>
      </Show>
    </div>
  );
}
