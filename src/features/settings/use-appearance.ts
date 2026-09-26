/**
 * 外观设置的「应用」层（T9.3 / T9.5 / T1.12）。
 *
 * ## 为什么把「改设置」和「写 CSS 变量」分成两层
 *
 * store 只管数据（可测、无副作用），这里只管副作用（写 DOM）。
 * 合成在 {@link useAppearance} 里，挂在应用根部一次。
 * 这样做的好处是设置面板本身**完全不需要知道 CSS 变量叫什么** ——
 * 它调 `setMeasure(760)`，界面就会变；换一套变量命名不动面板一行代码。
 *
 * ## 加载时序为什么是「先字形、后排版」
 *
 * 计划书 T1.12 要求「字体切换不闪动」。闪动的成因有两个：
 *
 * 1. **FOUT**（先渲染回退字体再跳成内置字体）。消除办法是在切换
 *    `--font-*` **之前**等 FontFace 就绪。因此 {@link useAppearance}
 *    里的 effect 会先 `await fontLoader.preload(ids)`，再 applyTypography。
 *    等待期间界面保持旧字体，而旧字体已经是可用字形，所以看不到跳变。
 * 2. **布局位移**。字号 / 行距 / 宽度变化必然改变文本的排版位置，
 *    这是用户**想要**的效果（他在调排版），不属于「闪动」。
 *    要保证的是它不被动画化 —— 自定义属性不可过渡，天然满足。
 *
 * 失败路径：`preload` 超时或失败都会正常返回（返回 false 而不是抛），
 * 随后 applyTypography 仍然执行，CSS 回退链接管，界面可读。
 */

import { createEffect, createMemo, onCleanup, onMount } from "solid-js";

import {
  effectiveTheme,
  effectiveTypography,
  setAppearanceWorkspace,
  workspaceAppearance,
} from "@/app/appearance-store";
import { workspaceState } from "@/app/workspace-store";
import { applyTheme, applyTypography, fontLoader, resolveTheme } from "@/design/fonts";

/**
 * 把生效的外观设置同步到 DOM。
 *
 * 在应用根部调用一次即可。组件树里**不要**重复调用：
 * 多个 effect 争相写同一批变量，最后写入的赢，行为不确定。
 */
export function useAppearance(): void {
  // ------------------------------------------------------------------
  // 工作区级设置的装载：打开 / 关闭工作区时切换分桶
  // ------------------------------------------------------------------
  onMount(() => {
    setAppearanceWorkspace(workspaceState.root);
  });

  createEffect(() => {
    const root = workspaceState.root;
    setAppearanceWorkspace(root);
  });

  // ------------------------------------------------------------------
  // 主题
  // ------------------------------------------------------------------
  createEffect(() => {
    applyTheme(effectiveTheme());
  });

  // 跟随系统时，系统切换要立刻反映。监听只在这一种模式下需要，
  // 因此放在 memo 里按需注册 / 注销，避免常驻监听器。
  const followSystem = createMemo(() => effectiveTheme() === "system");
  createEffect(() => {
    if (!followSystem()) return undefined;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;

    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return undefined;
    }

    const onChange = (): void => {
      // 重新解析一次即可：applyTheme("system") 是幂等的（只会 removeAttribute），
      // 真正的颜色由 tokens.css 的媒体查询负责，这里不需要额外动作。
      applyTheme(effectiveTheme());
    };
    query.addEventListener("change", onChange);
    onCleanup(() => query.removeEventListener("change", onChange));
    return undefined;
  });

  // ------------------------------------------------------------------
  // 字体与排版
  // ------------------------------------------------------------------
  createEffect(() => {
    const typo = effectiveTypography();
    const ids = [typo.body.family, typo.heading.family, typo.ui.family];

    // 先确保字形就绪再写变量，消除 FOUT 式的跳变（T1.12）。
    void fontLoader
      .preload(ids)
      .catch(() => undefined)
      .then(() => {
        applyTypography(typo);
      });
  });
}

/** 当前实际生效的亮 / 暗（跟随系统时是解析后的结果），供界面显示。 */
export function currentResolvedTheme(): "light" | "dark" {
  return resolveTheme(effectiveTheme());
}

/** 当前工作区是否持有外观覆盖（设置面板据此显示「本书已自定义」）。 */
export function hasWorkspaceOverride(): boolean {
  const value = workspaceAppearance.value;
  return value.theme !== undefined || value.typography !== undefined;
}
