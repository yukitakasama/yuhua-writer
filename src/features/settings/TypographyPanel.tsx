/**
 * 排版分区（T9.5）。
 *
 * ## 为什么只留两个全局项，作用域级的字号行距在「字体」分区
 *
 * 字号与行距天然属于某个作用域（标题 22px 与正文 17px 是两个决策），
 * 把它们也复制一份到这里会让用户面对「这里改了那边会不会变」的疑问。
 * 因此这个分区只放**跨作用域**的两项：段距与正文宽度，
 * 外加一块把三作用域合起来看的实时预览。
 *
 * 分工明确之后，用户找「正文宽度」只可能来这一个地方。
 */

import { Show, createEffect, type JSX } from "solid-js";

import {
  DEFAULT_APPEARANCE,
  effectiveTypography,
  isTypographyOverridden,
  setMeasure,
  setParagraphGap,
  setWorkspaceTypography,
  syncAppearanceWorkspace,
} from "@/app/appearance-store";
import { hasOpenWorkspace, workspaceState } from "@/app/workspace-store";
import { Button } from "@/design/primitives";
import { FontPreview } from "./FontPreview";
import { LevelToggle, type SettingsLevel } from "./LevelToggle";
import { RangeField } from "./RangeField";
import { t } from "@/strings";

/** {@link TypographyPanel} 的 props。 */
export interface TypographyPanelProps {
  /** 当前层级。 */
  level: SettingsLevel;
  /** 层级变化回调。 */
  onLevelChange: (level: SettingsLevel) => void;
}

/**
 * 排版分区。
 *
 * @example
 * <TypographyPanel level={level()} onLevelChange={setLevel} />
 */
export function TypographyPanel(props: TypographyPanelProps): JSX.Element {
  // 与 FontsPanel 同理：写工作区覆盖前先确认分桶指向当前工作区
  createEffect(() => {
    syncAppearanceWorkspace(workspaceState.root);
  });

  const typo = (): ReturnType<typeof effectiveTypography> => effectiveTypography();

  const write = (patch: { paragraphGap?: number; measure?: number }): void => {
    if (props.level === "workspace") {
      setWorkspaceTypography(patch);
      return;
    }
    if (patch.paragraphGap !== undefined) setParagraphGap(patch.paragraphGap);
    if (patch.measure !== undefined) setMeasure(patch.measure);
  };

  const inherit = (): void => {
    setWorkspaceTypography({ paragraphGap: undefined, measure: undefined });
  };

  // 本书覆盖标记：只在「本书」层级且确有覆盖时显示
  const overriddenGap = (): boolean => props.level === "workspace" && isTypographyOverridden();

  return (
    <div class="settings-panel">
      <LevelToggle level={props.level} onChange={props.onLevelChange} />

      <RangeField
        label={t("settings.typography.paragraphGap")}
        value={typo().paragraphGap}
        min={0}
        max={3}
        step={0.1}
        unit={t("settings.typography.em")}
        overridden={overriddenGap()}
        canOverride={hasOpenWorkspace()}
        onInherit={inherit}
        onChange={(value) => write({ paragraphGap: value })}
      />

      <RangeField
        label={t("settings.typography.measure")}
        value={typo().measure}
        min={480}
        max={1120}
        step={20}
        unit={t("settings.typography.px")}
        overridden={overriddenGap()}
        canOverride={hasOpenWorkspace()}
        onInherit={inherit}
        onChange={(value) => write({ measure: value })}
      />

      <p class="settings-note__body">{t("settings.typography.livePreview")}</p>

      <FontPreview />

      <Show when={props.level === "global"}>
        <div class="settings-actions">
          <Button
            variant="secondary"
            onClick={() => {
              setParagraphGap(DEFAULT_APPEARANCE.typography.paragraphGap);
              setMeasure(DEFAULT_APPEARANCE.typography.measure);
            }}
          >
            {t("settings.typography.reset")}
          </Button>
        </div>
      </Show>
    </div>
  );
}
