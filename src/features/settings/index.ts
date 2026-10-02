/**
 * 设置模块统一出口。
 *
 * 与 design/primitives、design/fonts 的约定一致：上层只从这个入口导入。
 * 这样将来把设置面板拆成独立窗口（Tauri 的多窗口）时，App 侧零改动。
 */

export {
  SettingsPanel,
  SETTINGS_TABS,
  SETTINGS_TAB_COUNT,
} from "./SettingsPanel";
export type { SettingsPanelProps } from "./SettingsPanel";

export {
  FirstRunWizard,
  hasCompletedOnboarding,
  markOnboardingDone,
  resetOnboarding,
  ONBOARDING_KEY,
} from "./FirstRunWizard";
export type { FirstRunWizardProps, WizardStep } from "./FirstRunWizard";

export { AboutPanel } from "./AboutPanel";
export { AppearancePanel } from "./AppearancePanel";
export { FontsPanel } from "./FontsPanel";
export { TypographyPanel } from "./TypographyPanel";
export { FontPreview } from "./FontPreview";
export { RangeField } from "./RangeField";
export { LevelToggle } from "./LevelToggle";
export type { SettingsLevel } from "./LevelToggle";
export { ScopePicker, scopeLabel, scopeHint } from "./ScopePicker";
export type { ScopePickerProps } from "./ScopePicker";
export type { RangeFieldProps } from "./RangeField";
export type { LevelToggleProps } from "./LevelToggle";

export { loadAboutInfo, buildChannel } from "./about-info";
export type { AboutInfo, LicenseEntry, FontAttribution } from "./about-info";

export { useAppearance } from "./use-appearance";
