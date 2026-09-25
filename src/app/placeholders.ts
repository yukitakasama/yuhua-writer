/**
 * 占位内容集中管理。
 *
 * ## 为什么要有一个单独的文件放"还没实现"的说明
 *
 * 本阶段（M5）的界面里有若干区域是为后续里程碑留的骨架：
 * 编辑器（M4）、大纲（M6）、导出进度（M7）、统计图表（M8）、设置（M9）。
 *
 * 把它们集中在这里的好处是**上线前可以一次性 grep 出来**，
 * 确认没有把占位文字漏到正式版本里。散在各个组件里的
 * "TODO" 是没法这样审计的。
 *
 * ## 与 `src/strings/` 的分工
 *
 * 这里只放**尚未接线的骨架文案**；已经进入正式字典的文案（如
 * `editor.placeholderBody`）一律从 `src/strings` 取，避免同一句话
 * 在字典与本文件里各存一份、改一处漏一处的漂移。
 */

import { t } from "@/strings";

/** 编辑器占位说明。与字典里的 `editor.placeholderBody` 是同一句话。 */
export const EDITOR_HINT: string = t("editor.placeholderBody");

/** 字数图表占位说明。 */
export const CHART_HINT = "进度环与趋势图将在 M8 里程碑接入。";

/** 设置页占位说明。 */
export const SETTINGS_HINT = "外观、字号、保存间隔等设置将在 M9 里程碑提供。";

/** 搜索面板占位说明。 */
export const SEARCH_HINT = "全文检索的结果列表将在 M6 里程碑接入，检索内核已完成。";
