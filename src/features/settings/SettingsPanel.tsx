/**
 * 设置面板（M9 的主入口）。
 *
 * ## 用 Dialog 而不是 Drawer
 *
 * 设置是「改完就走」的一次性任务，不是需要与正文并排对照的工作区。
 * Dialog 的模态语义（焦点陷阱 + Esc 关闭）能让用户明确知道
 * 「现在处于设置模式」，离开时不会留下半开的侧栏。
 *
 * ## 分区用 Tabs，但状态由本组件持有
 *
 * {@link Tabs} 原语接受受控 `value`。把 tab 状态放在这里而不是面板内部，
 * 是因为「层级（全局 / 本书）」要在字体分区与排版分区之间共享 ——
 * 用户在字体页选了「本书」，切到排版页时这个意图不该被重置。
 *
 * ## 关闭时不做「保存」
 *
 * 所有设置**即时生效**（主题、字体、排版全部如此）。因此底部没有「保存」按钮，
 * 只有一个「完成」。这是刻意的：设置项里加一个保存按钮会诱使用户以为
 * 「不点保存就没事」，而实际改动早就生效了。
 */

import { Match, Switch, createEffect, createSignal, type JSX } from "solid-js";

import { Dialog, Tabs } from "@/design/primitives";
import { t } from "@/strings";
import { AboutPanel } from "./AboutPanel";
import { AppearancePanel } from "./AppearancePanel";
import { DataSafetyPanel } from "./DataSafetyPanel";
import { FontsPanel } from "./FontsPanel";
import { TypographyPanel } from "./TypographyPanel";
import type { SettingsLevel } from "./LevelToggle";

/** {@link SettingsPanel} 的 props。 */
export interface SettingsPanelProps {
  /** 是否打开。 */
  open: boolean;
  /** 关闭请求。 */
  onClose: () => void;
  /**
   * 打开时要定位到的分区（深链，例如命令面板里的「打开回收站」）。
   *
   * 只在每次打开的那一刻生效；之后由用户自己的点击驱动 ——
   * 否则用户在本页内切到别的分区后，任何一次父组件重渲染都会把他弹回来。
   */
  initialTab?: string;
}

/** 分区定义。value 同时是测试选择器用的稳定钩子。 */
const TAB_ITEMS = [
  { value: "appearance", key: "settings.tabs.appearance" },
  { value: "fonts", key: "settings.tabs.fonts" },
  { value: "typography", key: "settings.tabs.typography" },
  { value: "data", key: "settings.tabs.data" },
  { value: "about", key: "settings.tabs.about" },
] as const;

/**
 * 设置面板。
 *
 * @example
 * <SettingsPanel open={open()} onClose={() => setOpen(false)} />
 */
export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const [tab, setTab] = createSignal<string>(props.initialTab ?? "appearance");
  // 层级的持有者是面板本身，跨分区保持（见文件头注释）
  const [level, setLevel] = createSignal<SettingsLevel>("global");

  // 深链：每次「打开」时定位到请求的分区。不传 initialTab 时什么都不做，
  // 因此「关不掉用户自己选的分区」这条既有行为不变。
  createEffect(() => {
    const target = props.initialTab;
    if (props.open && target) setTab(target);
  });

  const items = (): { value: string; label: JSX.Element }[] =>
    TAB_ITEMS.map((entry) => ({ value: entry.value, label: t(entry.key) }));

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("settings.title")}
      description={t("settings.typography.livePreview")}
      width={640}
      class="settings-dialog"
      footer={
        <div class="settings-footer">
          <button
            type="button"
            class="settings-link"
            onClick={() => props.onClose()}
          >
            {t("action.close")}
          </button>
        </div>
      }
    >
      <Tabs
        items={items()}
        value={tab()}
        onChange={setTab}
        label={t("settings.panelLabel")}
      >
        {(value) => (
          <Switch>
            <Match when={value === "appearance"}>
              <AppearancePanel />
            </Match>
            <Match when={value === "fonts"}>
              <FontsPanel level={level()} onLevelChange={setLevel} />
            </Match>
            <Match when={value === "typography"}>
              <TypographyPanel level={level()} onLevelChange={setLevel} />
            </Match>
            <Match when={value === "data"}>
              <DataSafetyPanel />
            </Match>
            <Match when={value === "about"}>
              <AboutPanel />
            </Match>
          </Switch>
        )}
      </Tabs>
    </Dialog>
  );
}

/** 分区数量，供测试断言。 */
export const SETTINGS_TAB_COUNT = TAB_ITEMS.length;

/** 分区值的完整列表。 */
export const SETTINGS_TABS: readonly string[] = TAB_ITEMS.map(
  (entry) => entry.value,
);
