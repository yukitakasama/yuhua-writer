/**
 * 单个字体作用域的选择块（T9.2）。
 *
 * ## 为什么把「作用域 + 覆盖来源」做成一个复合控件
 *
 * 三个作用域各自有「字体族」「字号」「行距」「是否被本书覆盖」四件事，
 * 如果全部平铺在面板上就是 12 行控件，用户会迷路。
 * 这里把一份作用域的全部信息收进一个带标题的块里，
 * 块内再分「选择」与「数值」两组 —— 视觉上有层次，读屏上也有层次
 * （用 role="group" + aria-label 表达，等价于 fieldset 的语义）。
 *
 * ## 为什么「跟随全局」是一个显式按钮而不是隐藏的默认值
 *
 * 用户先为某本书调了字体，后来想让它回到全局设置，
 * 如果只能手动把值改回「和全局一样」，就永远不知道自己有没有同步上。
 * 一个显式的「跟随全局」按钮把这件事变成一次可验证的操作。
 */

import { Show, type JSX } from "solid-js";

import { isScopeOverridden, type FontScope } from "@/app/appearance-store";
import { familiesFor, fontFamilyById } from "@/design/fonts";
import { Select } from "@/design/primitives";
import { t } from "@/strings";

/** 作用域显示名的文案键。 */
const SCOPE_LABEL_KEYS = {
  body: "settings.scope.body",
  heading: "settings.scope.heading",
  ui: "settings.scope.ui",
} as const;

/** 作用域说明的文案键。 */
const SCOPE_HINT_KEYS = {
  body: "settings.scope.bodyHint",
  heading: "settings.scope.headingHint",
  ui: "settings.scope.uiHint",
} as const;

/** 作用域的显示名。导出以便其它面板（排版）复用同一份术语。 */
export function scopeLabel(scope: FontScope): string {
  return t(SCOPE_LABEL_KEYS[scope]);
}

/** 作用域的说明文字。 */
export function scopeHint(scope: FontScope): string {
  return t(SCOPE_HINT_KEYS[scope]);
}

/** {@link ScopePicker} 的 props。 */
export interface ScopePickerProps {
  /** 当前作用域。 */
  scope: FontScope;
  /** 当前生效的字体族标识。 */
  family: string;
  /** 选择回调。 */
  onChange: (familyId: string) => void;
  /** 是否被本书单独覆盖（显示标记与「跟随全局」按钮）。 */
  overridden: boolean;
  /** 取消本书覆盖，回到跟随全局。 */
  onInherit: () => void;
  /** 是否允许本书级操作（未打开工作区时为 false）。 */
  canOverride: boolean;
  /** 额外插槽：字号 / 行距等数值控件由调用方渲染在字体选择之后。 */
  children?: JSX.Element;
}

/**
 * 一个作用域的字体族选择器。
 *
 * @example
 * <ScopePicker scope="body" family={typo.body.family} onChange={setBodyFamily} overridden={false} onInherit={() => {}} canOverride={false} />
 */
export function ScopePicker(props: ScopePickerProps): JSX.Element {
  /**
   * 候选选项：内置字体在前、系统字体在后，各自按「是否适合本作用域」排序。
   * 标签里带一句话说明 —— 设置项的光靠名字不足以让人分辨「系统宋体」和「宋体」。
   */
  const options = (): { value: string; label: string }[] =>
    familiesFor(props.scope).map((family) => ({
      value: family.id,
      label: `${family.label} · ${family.note}`,
    }));

  const currentStack = (): string => fontFamilyById(props.family).stack;

  return (
    <section class="settings-scope" role="group" aria-label={scopeLabel(props.scope)}>
      <header class="settings-scope__head">
        <div class="settings-scope__titles">
          <h4 class="settings-scope__title">{scopeLabel(props.scope)}</h4>
          <p class="settings-scope__hint">{scopeHint(props.scope)}</p>
        </div>
        <Show when={props.overridden && props.canOverride}>
          <span class="settings-badge">{t("settings.level.overridden")}</span>
        </Show>
      </header>

      <Select
        label={t("settings.font.label")}
        value={props.family}
        options={options()}
        onChange={(value) => props.onChange(value)}
      />

      {/* 回退链只读展示：让「生僻字会落到哪个字体」对用户可见，
          而不是一句只写在文档里的承诺。用 code 而不是 input，
          它是说明，不可编辑，也不该进入 Tab 序。 */}
      <p class="settings-scope__chain">
        <span class="settings-scope__chain-label">{t("settings.font.fallbackChain")}</span>
        <code>{currentStack()}</code>
      </p>

      <Show when={props.children}>
        <div class="settings-scope__nums">{props.children}</div>
      </Show>

      <Show when={props.canOverride && props.overridden}>
        <button type="button" class="settings-link" onClick={() => props.onInherit()}>
          {t("settings.level.inherit")}
        </button>
      </Show>
    </section>
  );
}

/** 判定某个作用域是否被覆盖的再导出，省得调用方多 import 一处。 */
export { isScopeOverridden };
