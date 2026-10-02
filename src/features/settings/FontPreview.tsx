/**
 * 字体与排版的实时预览（T9.3 / T9.5）。
 *
 * ## 为什么需要预览，而不是「选完直接看正文」
 *
 * 正文里当前可能只有三百字，其中没有任何生僻字，也没有章节标题 ——
 * 用户在设置里选了楷体标题，切回编辑区发现「看不出区别」，
 * 只能反复来回切。预览块把**三个作用域同时**展示在一屏里，
 * 而且刻意混入生僻字与数字，让回退链、字宽、行距的差异都暴露出来。
 *
 * ## 为什么预览不写内联 font-family
 *
 * 预览块用 `.yh-body` / `.yh-heading` 三个作用域类，读的就是
 * `var(--font-body)` 这些变量。这样预览和真实编辑区**走的是同一条路径** ——
 * 如果预览看起来对而正文不对，那一定是变量写错了，而不是「预览用了另一套逻辑」。
 * 这份一致性比省一次样式重算值钱得多。
 *
 * 预览块的宽度用 `--measure-body` 限死，这样拖「正文宽度」滑块时
 * 预览会跟着变窄变宽，用户能立刻看到「一行多少字」的变化。
 */

import { type JSX } from "solid-js";

import { t } from "@/strings";

/** {@link FontPreview} 的 props。 */
export interface FontPreviewProps {
  /** 预览的正文文本，不传用内置样例。 */
  body?: string;
  /** 预览的标题文本。 */
  heading?: string;
  /** 预览的界面文本。 */
  ui?: string;
  /** 只预览某一个作用域（字体面板里按作用域聚焦时用）。 */
  focus?: "body" | "heading" | "ui";
}

/**
 * 三个作用域并排的样例文本。
 *
 * @example
 * <FontPreview />
 */
export function FontPreview(props: FontPreviewProps): JSX.Element {
  const show = (scope: "body" | "heading" | "ui"): boolean =>
    props.focus === undefined || props.focus === scope;

  return (
    <div
      class="font-preview"
      aria-label={t("settings.font.previewTitle")}
      role="group"
    >
      <p class="font-preview__label">{t("settings.font.previewTitle")}</p>

      {/* 标题作用域：用 .yh-heading 拿到 --font-heading 与 --lh-heading */}
      {show("heading") && (
        <h3 class="yh-heading font-preview__heading">
          {props.heading ?? t("settings.font.previewHeading")}
        </h3>
      )}

      {/* 正文作用域：.yh-body 拿到 --font-body / --lh-body / --measure-body */}
      {show("body") && (
        <div class="yh-body font-preview__body">
          <p>{props.body ?? t("settings.font.previewBody")}</p>
          {/* 第二段用来展示段距设置的效果 */}
          <p>{t("settings.font.previewBody")}</p>
        </div>
      )}

      {/* 界面作用域：用 .yh-num 让数字走 tabular-nums，
          用户能顺便看到「字数变化时数字不会左右跳」这条规范是否生效。 */}
      {show("ui") && (
        <p class="font-preview__ui yh-num">
          {props.ui ?? t("settings.font.previewUi")}
        </p>
      )}

      <p class="font-preview__note">{t("settings.font.fallbackNote")}</p>
    </div>
  );
}
