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

import "./styles/app.css";
import { App } from "./App";

/** 挂载点。 */
const root = document.getElementById("root");

if (root === null) {
  // 这种情况说明 index.html 被改坏了，属于构建配置错误，
  // 明确报出来比让用户面对白屏更容易定位
  throw new Error("找不到挂载点 #root，请检查 index.html");
}

render(() => <App />, root);
