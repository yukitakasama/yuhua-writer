import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath, URL } from "node:url";

/**
 * Vite 配置。
 *
 * 要点：
 * - Tauri 开发服务器固定 1420 端口，且失败即报错（strictPort），
 *   避免 Tauri 窗口指向空白页。
 * - Tauri 会注入 TAURI_* 环境变量，据此决定是否启用 HMR 主机与 fs 放宽。
 * - 首屏优化：把体积较大的编辑器内核拆成独立 chunk（见 build.rollupOptions），
 *   使冷启动不加载编辑器代码，符合「内存占用最低」的要求②。
 */
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Tauri 期望一个固定端口的开发服务器
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // src-tauri 由 cargo 自己监听，避免重复触发
      ignored: ["**/src-tauri/**"],
    },
  },

  // 生产构建：Tauri 需要相对路径资源
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // 编辑器内核单独成 chunk：只在进入写作界面时加载
          if (id.includes("codemirror") || id.includes("@lezer")) return "editor";
          if (id.includes("node_modules/solid-js")) return "solid";
          return undefined;
        },
      },
    },
  },

  // vitest 复用同一份配置
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
  },
});
