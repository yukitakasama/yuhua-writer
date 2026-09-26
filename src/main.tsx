/**
 * 应用入口。
 *
 * ## 为什么在这里 import 样式
 *
 * `app.css` 必须在 Solid 挂载之前被 Vite 处理，否则首帧会是无样式的
 * HTML（FOUC）。放在 main.tsx 顶部的 import 会被提升到模块求值最前，
 * 但 CSS 的注入是异步的，因此 index.html 里还写了首屏骨架样式兜底。
 *
 * ## 挂载失败的处理
 *
 * 如果 `#root` 不存在（HTML 被改坏了），直接抛错比静默失败好，
 * 但要在控制台留下明确信息，而不是一个空白的白屏。
 */

import { render } from "solid-js/web";

// 设计令牌必须**先于** app.css 导入。
// app.css 里的令牌定义包在 @layer fallback 中（未分层样式优先级更高），
// 因此这一行会让 tokens.css 的真值自动覆盖那些兜底值 ——
// 不需要删掉 app.css 里的兜底定义，它们只在令牌缺失时才有意义。
import "./design/tokens.css";
import "./styles/app.css";
import "./styles/settings.css";
import { App } from "./App";

/** 挂载点。 */
const root = document.getElementById("root");

if (root === null) {
  // 这种情况说明 index.html 被改坏了，属于构建配置错误，
  // 明确报出来比让用户面对白屏更容易定位
  throw new Error("找不到挂载点 #root，请检查 index.html");
}

/**
 * 是否渲染组件预览页（T1.9）。
 *
 * ## 为什么用查询参数而不是路由
 *
 * 与 App.tsx 中"书架 / 写作台用 switch 不用路由"是同一个理由：
 * 这一页是**开发期内部工具**，不是产品的一部分。为它引入
 * 路由库（以及它的 history 抽象、链接语义）不划算，
 * 而 Tauri 里本来也没有 URL 语义。
 *
 * `?kit=1` 的形式还有个好处：可以只用一个书签直达，
 * 评审时不需要在界面里点三层菜单找入口。
 *
 * ## 为什么要检查 import.meta.env.DEV
 *
 * 生产构建里 **不应** 让 `?kit=1` 生效 —— 那是把内部工具暴露给了
 * 用户。Vite 会在生产构建时把 `DEV` 静态替换成 `false`，
 * 于是这个函数恒返回 `false`，`mount` 里那个分支永远不会执行。
 *
 * 注意：仅靠这一条**不足以**把预览页排除出产物 —— 见 `mount` 的说明。
 */
function isDevKit(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("kit") === "1";
}

/**
 * 挂载。
 *
 * ## 为什么 DevKit 必须用动态 import
 *
 * 第一版写的是顶层的 `import { DevKit } from ...`，再用
 * `import.meta.env.DEV` 把渲染分支折掉 —— **那是不够的**。
 * 静态 import 会让打包器把整个组件（连同它的样式与依赖）
 * 拉进主包，因为"这个模块被引用了"是编译期事实，
 * 而 `if (false)` 只是运行期死分支。
 *
 * 实测确认：生产产物里能找到 `kit-section`、`重放动效` 这些
 * 只属于预览页的字符串 —— 也就是说这一页**真的被发出去了**，
 * 与"只在开发环境可达"的承诺不符。
 *
 * 动态 `import()` 才会真的产生一个独立 chunk，且因为
 * `isDevKit()` 在 `DEV === false` 时恒为假，该 chunk 不会被
 * 任何代码路径引用，打包器直接不产出它。
 *
 * ## 验证方式（不是靠"我觉得应该没问题"）
 *
 * `pnpm build` 之后检查 `dist/index.html` 里**没有** DevKit 那个
 * chunk 的引用，且主 chunk 里搜不到 `kit-section` 这类只属于
 * 预览页的字符串。这条检查由 `scripts/check-devkit-excluded.mjs`
 * 固化下来，可以挂进 CI。
 */
async function mount(): Promise<void> {
  if (isDevKit()) {
    // 样式也一起动态加载：它同样不该进生产产物
    await import("./styles/devkit.css");
    const { DevKit } = await import("./features/devkit/DevKit");
    render(() => <DevKit />, root!);
    return;
  }
  render(() => <App />, root!);
}

void mount();
