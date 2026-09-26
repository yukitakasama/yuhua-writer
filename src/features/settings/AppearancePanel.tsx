/**
 * 外观分区：主题三选一（T9.1 的界面入口）。
 *
 * ## 为什么用自绘的 radio 组而不是原生 <select>
 *
 * 主题只有三个选项，而且每个选项的视觉结果（亮 / 暗）用户需要**看到**才知道
 * 自己要哪个。下拉框会把两个没被选中的选项藏起来，用户得展开才知道有什么。
 * 三个平铺的按钮让选择集一直可见 —— 这是「选项少且需要对比」时的通行做法。
 *
 * 无障碍上用 `role="radiogroup"` + `role="radio"` + `aria-checked`，
 * 方向键在组内移动并选中（selection follows focus，与 Tabs 的约定一致）。
 * 不用原生 <input type="radio"> 是因为要控制选中态的描边与背景，
 * 覆盖原生外观在跨平台下反而更容易出问题。
 */

import { For, Match, Switch, type JSX } from "solid-js";

import {
  THEME_CHOICES,
  effectiveTheme,
  setTheme,
  type ThemeChoice,
} from "@/app/appearance-store";
import { applyTheme, resolveTheme } from "@/design/fonts";
import { IconMoon, IconSun } from "@/features/settings/icons";
import { t } from "@/strings";

/** 主题选项的文案键。 */
const LABEL_KEYS = {
  light: "settings.theme.light",
  dark: "settings.theme.dark",
  system: "settings.theme.system",
} as const;

/**
 * 主题选项的图形。跟随系统没有专属图形，复用太阳（并靠文案区分）。
 *
 * 用 `Switch` 而不是在函数体里 early return：Solid 组件**只运行一次**，
 * 提前 return 会让分支固定下来，之后 props 变化也不会重渲染
 * （eslint-plugin-solid 的 components-return-once）。这里虽然 theme 是常量，
 * 但把条件写进 JSX 是更安全的默认写法 —— 将来谁把它改成动态值都不会踩坑。
 */
function ThemeGlyph(props: { theme: ThemeChoice }): JSX.Element {
  return (
    <Switch fallback={<IconSun size={18} />}>
      <Match when={props.theme === "dark"}>
        <IconMoon size={18} />
      </Match>
    </Switch>
  );
}

/** 主题选择的显示文案。跟随系统时补上「当前为亮/暗」。 */
export function themeLabel(theme: ThemeChoice): string {
  if (theme !== "system") return t(LABEL_KEYS[theme]);
  return resolveTheme("system") === "dark"
    ? t("settings.theme.systemResolvedDark")
    : t("settings.theme.systemResolvedLight");
}

/**
 * 主题选择组。
 *
 * @example
 * <AppearancePanel />
 */
export function AppearancePanel(): JSX.Element {
  /**
   * 选主题：写 store + 立刻写 DOM。
   *
   * 为什么面板自己要 applyTheme，而不只依赖 useAppearance 的 effect：
   * 主题是**唯一**一个「用户期待点下去就变」的设置（字体至少还能靠预览块
   * 局部说明）。让效果不经过一层 effect 转发，行为更容易推理，
   * 也避免「hook 忘了挂」导致主题点了没反应。applyTheme 是幂等的，
   * 与 useAppearance 同时写不会冲突。
   */
  const choose = (choice: ThemeChoice): void => {
    setTheme(choice);
    applyTheme(choice);
  };

  /** 方向键在组内移动：与原生 radio group 的行为一致。 */
  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!forward && !backward) return;
    event.preventDefault();
    const delta = forward ? 1 : -1;
    const next = THEME_CHOICES[(index + delta + THEME_CHOICES.length) % THEME_CHOICES.length];
    if (next) {
      choose(next);
      // 焦点跟着选中项走，读屏才能把新的选中态念出来
      queueMicrotask(() => {
        document.querySelector<HTMLElement>('[data-theme-choice="' + next + '"]')?.focus();
      });
    }
  };

  return (
    <div class="settings-panel">
      <div class="settings-field">
        <span class="settings-field__label" id="yh-theme-label">
          {t("settings.theme.label")}
        </span>
        <div
          class="theme-choice"
          role="radiogroup"
          aria-labelledby="yh-theme-label"
          onKeyDown={(event) => {
            const index = THEME_CHOICES.indexOf(effectiveTheme());
            onKeyDown(event, index < 0 ? 0 : index);
          }}
        >
          <For each={THEME_CHOICES}>
            {(choice, index) => {
              const selected = (): boolean => effectiveTheme() === choice;
              return (
                <button
                  type="button"
                  role="radio"
                  data-theme-choice={choice}
                  class="theme-choice__item"
                  aria-checked={selected() ? "true" : "false"}
                  // roving tabindex：只有选中项进入 Tab 序
                  tabindex={selected() ? 0 : -1}
                  onClick={() => choose(choice)}
                  onKeyDown={(event) => onKeyDown(event, index())}
                >
                  <span class="theme-choice__glyph" aria-hidden="true">
                    <ThemeGlyph theme={choice} />
                  </span>
                  <span class="theme-choice__label">{themeLabel(choice)}</span>
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
