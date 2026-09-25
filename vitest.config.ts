import { defineConfig } from "vitest/config";
import type { PluginOption } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath, URL } from "node:url";

/**
 * Vitest 独立配置。
 *
 * 为什么不复用 vite.config.ts：vite.config.ts 里带 Tauri 专用 dev server 参数，
 * 测试进程不需要也不应启动该服务器；这里只保留测试真正需要的插件与别名。
 */
export default defineConfig({
  // vitest 2 内部依赖 vite 5，而项目主体用 vite 6，两者的 PluginOption
  // 类型定义不兼容。这里做一次断言把插件类型对齐 —— 运行时完全正常，
  // 纯粹是两份 vite 类型声明之间的结构差异。
  plugins: [solid() as unknown as PluginOption],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // solid-js 的 exports 映射带 "node" 条件分支，指向 dist/server.js。
    // vitest 跑在 Node 下会命中该分支，导致 JSX 运行时拿到 Solid 的
    // **服务端**构建（createComponent / insert 全是 notSup 桩），
    // 于是任何 .tsx 测试都会报 "Client-only API called on the server side"。
    //
    // 显式把 browser 条件排在 node 之前，强制解析到客户端构建。
    conditions: ["browser", "development", "import", "default"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  },
});
