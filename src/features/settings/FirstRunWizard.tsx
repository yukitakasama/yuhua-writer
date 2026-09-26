/**
 * 首次启动向导（T9.7）。
 *
 * ## 为什么「跳过」必须是一等公民
 *
 * 引导流程最常见的失败模式是**挡住用户本来想做的事**：一个新用户
 * 可能是被朋友推荐来试写两句话的，他要的是尽快看到编辑区，
 * 而不是先回答三个问题。因此：
 * - 「跳过引导」始终可见、始终可点、不藏在第二屏；
 * - 跳过与走完流程的效果**完全相同** —— 都只是写一个「已完成引导」的标记，
 *   所有设置项在设置面板里都能再改。跳过不该有任何惩罚。
 *
 * ## 为什么只问两件事
 *
 * 计划书要求「引导选择主题与字体」。字号、行距、段距这些**有合理默认值**
 * 且**用户在看到真实文本前无法判断**的项，问了也是白问。向导只问两件
 * 立刻能看出差别的事：亮还是暗（看屏幕就能定），以及字体（预览就能定）。
 *
 * ## 状态持久化
 *
 * 「是否已引导过」写在 localStorage，与外观设置分开一个键 ——
 * 用户将来点「重置外观」不该让向导再弹一次。
 */

import { For, Show, createMemo, createSignal, type JSX } from "solid-js";

import {
  FONT_SCOPES,
  setScopeTypography,
  setTheme,
  type FontScope,
  type ThemeChoice,
} from "@/app/appearance-store";
import { applyTheme, familiesFor } from "@/design/fonts";
import { readJson, writeJson } from "@/app/persistent";
import { Button, Dialog } from "@/design/primitives";
import { t } from "@/strings";
import { FontPreview } from "./FontPreview";
import { scopeLabel } from "./ScopePicker";

/** localStorage 键：是否已完成（或跳过）首次引导。 */
export const ONBOARDING_KEY = "onboarding.v1";

/** 已完成的标记值。用对象而不是布尔，方便将来加字段（例如完成时间）。 */
interface OnboardingRecord {
  /** 是否已看过引导。 */
  done: boolean;
}

/** 读取「是否已引导过」。读不到或坏了都当作没引导过。 */
export function hasCompletedOnboarding(): boolean {
  const record = readJson<Partial<OnboardingRecord>>(ONBOARDING_KEY, {}, (v) => typeof v === "object" && v !== null);
  return record.done === true;
}

/** 写入「已引导过」。 */
export function markOnboardingDone(): void {
  writeJson(ONBOARDING_KEY, { done: true } satisfies OnboardingRecord);
}

/** 清除标记（测试与「重新观看引导」用）。 */
export function resetOnboarding(): void {
  writeJson(ONBOARDING_KEY, { done: false });
}

/** 三步的定义。 */
const STEPS = ["theme", "font", "done"] as const;

/** 步骤类型。 */
export type WizardStep = (typeof STEPS)[number];

/** 主题选项与文案键。 */
const THEME_OPTIONS: readonly { value: ThemeChoice; key: "settings.theme.light" | "settings.theme.dark" | "settings.theme.system" }[] = [
  { value: "light", key: "settings.theme.light" },
  { value: "dark", key: "settings.theme.dark" },
  { value: "system", key: "settings.theme.system" },
];

/** {@link FirstRunWizard} 的 props。 */
export interface FirstRunWizardProps {
  /** 是否展示。 */
  open: boolean;
  /** 完成回调（走完或跳过都会调用）。 */
  onFinish: () => void;
}

/**
 * 首次启动向导。
 *
 * @example
 * <FirstRunWizard open={show()} onFinish={() => setShow(false)} />
 */
export function FirstRunWizard(props: FirstRunWizardProps): JSX.Element {
  const [stepIndex, setStepIndex] = createSignal(0);
  const [theme, setThemeChoice] = createSignal<ThemeChoice>("system");
  const [family, setFamily] = createSignal("yuhua-serif");

  const step = createMemo<WizardStep>(() => STEPS[stepIndex()] ?? "theme");
  const isFirst = (): boolean => stepIndex() === 0;
  const isLast = (): boolean => stepIndex() === STEPS.length - 1;

  /** 选主题立刻生效：向导里的选择就是真实设置，不是「待提交的草稿」。 */
  const chooseTheme = (value: ThemeChoice): void => {
    setThemeChoice(value);
    setTheme(value);
    // 立刻写 DOM，让向导里的选择当场可见（与 AppearancePanel 同一理由）
    applyTheme(value);
  };

  /** 选字体立刻作用于正文与标题两个作用域 —— 向导只问一次，但要让它看得见效果。 */
  const chooseFamily = (id: string): void => {
    setFamily(id);
    for (const scope of ["body", "heading"] as FontScope[]) {
      setScopeTypography(scope, { family: id });
    }
  };

  const finish = (): void => {
    markOnboardingDone();
    props.onFinish();
  };

  return (
    <Dialog
      open={props.open}
      onClose={finish}
      title={t("settings.wizard.title")}
      width={560}
      class="wizard-dialog"
      // 向导没有「危险操作」，遮罩点击关闭等同于跳过，是安全的默认
      closeOnOverlayClick={true}
      footer={
        <div class="wizard-footer">
          {/* 跳过：左侧、始终可见、不是次要的「取消」。 */}
          <button type="button" class="settings-link" onClick={finish}>
            {t("settings.wizard.skip")}
          </button>
          <div class="wizard-footer__nav">
            <Show when={!isFirst()}>
              <Button variant="ghost" onClick={() => setStepIndex((i) => Math.max(0, i - 1))}>
                {t("settings.wizard.back")}
              </Button>
            </Show>
            <Button
              variant="primary"
              onClick={() => {
                if (isLast()) finish();
                else setStepIndex((i) => i + 1);
              }}
            >
              {isLast() ? t("settings.wizard.finish") : t("settings.wizard.next")}
            </Button>
          </div>
        </div>
      }
    >
      <div class="wizard">
        {/* 进度：既显示点，也提供可朗读的文本。只靠圆点读屏用户完全无从知晓进度。 */}
        <div class="wizard__progress" aria-hidden="true">
          <For each={STEPS}>
            {(_, index) => (
              <span class="wizard__dot" data-active={index() === stepIndex() ? "true" : "false"} />
            )}
          </For>
        </div>
        <p class="wizard__indicator">
          {t("settings.wizard.stepIndicator", { current: stepIndex() + 1, total: STEPS.length })}
        </p>

        <Show when={step() === "theme"}>
          <section class="wizard__step" aria-labelledby="yh-wizard-theme">
            <h3 class="wizard__title" id="yh-wizard-theme">
              {t("settings.wizard.stepTheme")}
            </h3>
            <p class="wizard__body">{t("settings.wizard.stepThemeBody")}</p>
            <div class="wizard__choices" role="radiogroup" aria-label={t("settings.theme.label")}>
              <For each={THEME_OPTIONS}>
                {(option) => (
                  <button
                    type="button"
                    role="radio"
                    class="wizard__choice"
                    aria-checked={theme() === option.value ? "true" : "false"}
                    data-wizard-theme={option.value}
                    onClick={() => chooseTheme(option.value)}
                  >
                    {t(option.key)}
                  </button>
                )}
              </For>
            </div>
          </section>
        </Show>

        <Show when={step() === "font"}>
          <section class="wizard__step" aria-labelledby="yh-wizard-font">
            <h3 class="wizard__title" id="yh-wizard-font">
              {t("settings.wizard.stepFont")}
            </h3>
            <p class="wizard__body">{t("settings.wizard.stepFontBody")}</p>
            <div class="wizard__choices wizard__choices--fonts" role="radiogroup" aria-label={t("settings.font.label")}>
              <For each={familiesFor("body")}>
                {(item) => (
                  <button
                    type="button"
                    role="radio"
                    class="wizard__choice"
                    aria-checked={family() === item.id ? "true" : "false"}
                    data-wizard-family={item.id}
                    onClick={() => chooseFamily(item.id)}
                  >
                    <span class="wizard__choice-label">{item.label}</span>
                    <span class="wizard__choice-note">{item.note}</span>
                  </button>
                )}
              </For>
            </div>
            <FontPreview />
          </section>
        </Show>

        <Show when={step() === "done"}>
          <section class="wizard__step" aria-labelledby="yh-wizard-done">
            <h3 class="wizard__title" id="yh-wizard-done">
              {t("settings.wizard.stepDone")}
            </h3>
            <p class="wizard__body">{t("settings.wizard.stepDoneBody")}</p>
            <p class="wizard__hint">{t("settings.wizard.skipHint")}</p>
          </section>
        </Show>

        {/* 作用域标签列表：让用户知道「界面字体」也可以在设置里单独调，
            而向导只替他做了正文与标题的决定。 */}
        <ul class="wizard__scopes">
          <For each={FONT_SCOPES}>
            {(scope) => <li class="wizard__scope">{scopeLabel(scope)}</li>}
          </For>
        </ul>
      </div>
    </Dialog>
  );
}
