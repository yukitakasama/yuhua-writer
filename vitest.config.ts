import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { fileURLToPath, URL } from "node:url";

/**
 * Vitest 独立配置。
 *
 * 为什么不复用 vite.config.ts：vite.config.ts 里带 Tauri 专用 dev server 参数，
 * 测试进程不需要也不应启动该服务器；这里只保留测试真正需要的插件与别名。
 */
export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
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
