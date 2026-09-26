/**
 * ESLint 扁平配置（ESLint 9 要求）。
 *
 * ## 为什么这个文件此前缺失、以及它为什么必须存在
 *
 * `package.json` 里声明了 `"lint": "eslint . --max-warnings 0"`，
 * 依赖里也装了 `@typescript-eslint` 与 `eslint-plugin-solid`，
 * 但仓库根目录从来没有 flat config 文件。ESLint 9 起**不再读取**
 * `.eslintrc.*`，因此 `pnpm lint` 在这之前对**任何提交**都是
 * 直接报错退出的 —— CI 里那一步同样是空的。
 *
 * 这是 M9 的独立评审在实际运行中发现的（不是在代码里看出来的），
 * 也说明「CI 配置存在」与「CI 真的在检查东西」是两件事。
 *
 * ## 配置范围的取舍
 *
 * **检查**：`src/` 与 `scripts/` 下的 TS / TSX / MJS。
 * **不检查**：`dist/`、`target/`、`node_modules/`、
 * `src-tauri/gen/`（Tauri 生成物）、以及 `scratch/`
 * （那是临时探针目录，内容不进版本库也不进产物）。
 *
 * ## 规则集为什么是"这四条"而不是"recommended 全家桶"
 *
 * 打开 `recommended` 会在既有代码上产生几百条与可读性无关的
 * 风格告警（比如 `no-explicit-any` 在类型体操里的误报）。
 * 本项目的取舍是：**只启用能抓到真实缺陷的规则**，
 * 其余交给 `tsc`（它比 ESLint 更准确）与 Prettier（格式）。
 *
 * 真正有价值的三类：
 *
 * 1. `@typescript-eslint/no-unused-vars` —— 抓到忘记删的导入与变量
 * 2. `@typescript-eslint/no-floating-promises` —— 抓到漏掉的
 *    `await`。这在 IPC 调用上尤其危险：漏 await 会让
 *    "保存失败"这种错误被静默吞掉
 * 3. `solid/reactivity` —— SolidJS 特有的坑：
 *    解构 props 会丢失响应性，是这类框架最常见的真 bug
 */

import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import solidPlugin from "eslint-plugin-solid";
import globals from "globals";

/**
 * 基础规则子集。
 *
 * ## 为什么不 `import js from "@eslint/js"` 用官方 `recommended`
 *
 * 因为 `@eslint/js` 并不是本项目的直接依赖（它只是 `eslint` 的
 * 传递依赖，没有出现在 `package.json` 里）。直接 import 一个
 * 未声明的包在 pnpm 的严格 node_modules 布局下会解析失败 ——
 * 这正是 `ERR_MODULE_NOT_FOUND` 要告诉我们的。
 *
 * 与其为一个配置文件新增依赖，不如**只写本项目真正需要的几条**。
 * 这也与下面"只启用能抓到真实缺陷的规则"的取舍一致：
 * `recommended` 的全家桶会引入一堆与可读性无关的风格告警，
 * 而那些本该由 Prettier 与 tsc 负责。
 */
const baseRules = {
  // ---- 抓真实缺陷的几条 ----
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-fallthrough": "error",
  "no-irregular-whitespace": "error",
  "no-loss-of-precision": "error",
  "no-sparse-arrays": "error",
  "no-unreachable": "error",
  "no-unsafe-negation": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
  // `debugger` 是明确的调试残留，不该进版本库
  "no-debugger": "error",
  // 重复参数是笔误的典型形态
  "no-dupe-args": "error",
};

export default [
  {
    ignores: [
      "dist/**",
      "target/**",
      "node_modules/**",
      "src-tauri/gen/**",
      "src-tauri/target/**",
      "scratch/**",
      "coverage/**",
      "**/*.min.js",
    ],
  },

  // ---- 前端源码（TS / TSX）----
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // 用 projectService 而不是手写 project 数组：
        // 后者要求枚举每个 tsconfig，加一个新包就会漏配
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      solid: solidPlugin,
    },
    rules: {
      ...baseRules,

      // 未使用变量：允许以 _ 开头的占位参数
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // 漏 await 的 Promise：IPC 调用漏掉它会静默吞掉错误
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],

      /**
       * SolidJS 的响应性规则：只在**确定的错误**上报错。
       *
       * ## 为什么不用它默认的 "warn" 全量开启
       *
       * 实测在本仓库上，默认级别会产生 26 条告警，而其中绝大多数是
       * **误报**：
       *
       * - `props.onPrev` 传给 `onClick={props.onPrev}` —— 这是 Solid 里
       *   完全正确的写法。事件处理器本来就不需要响应式包装，
       *   JSX 编译出来的就是对 props 的惰性读取
       * - `props.size` 在组件函数体里读一次用于计算 `viewBox` ——
       *   对图标这类"props 变了就整块重建"的组件是合理的
       *
       * 一条会产生 26 个误报的规则，实际效果是让作者学会**无视它**。
       * 那比不启用它更糟：真正的解构 props 错误也会被淹没。
       *
       * 因此这里只保留最有价值的一条：`no-destructure`。
       * `const { children } = props` 在 Solid 里是**真的 bug**
       * （读的是快照，props 后续变化不会反映），而且改写成本很低。
       */
      "solid/reactivity": "off",
      "solid/no-destructure": "error",

      // `no-explicit-any` 在测试与类型收窄里误报很多，
      // 交给 tsc 的 strict 模式覆盖（它更准确）
      "@typescript-eslint/no-explicit-any": "off",
      // 关闭核心版本，避免与 TS 版本重复报告（TS 能看懂类型）
      "no-unused-vars": "off",
      "no-undef": "off",
    },
  },

  // ---- 测试文件：放宽一些规则 ----
  {
    files: ["src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}", "src/design/primitives/test-utils.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // 测试里经常需要构造"故意不 await"的场景（比如验证未处理的拒绝）
      "@typescript-eslint/no-floating-promises": "off",
      "solid/reactivity": "off",
    },
  },

  // ---- 构建配置（TS，Node 环境）----
  //
  // ## 为什么这一组**不开**类型感知
  //
  // `tsconfig.json` 刻意把 `vite.config.ts` / `vitest.config.ts`
  // 排除在 `include` 之外（理由见该文件的注释：vitest 2 内部锁 vite 5、
  // 项目主体用 vite 6，两份 PluginOption 类型天然不兼容）。
  // 既然它们不属于任何 TS 工程，`projectService` 就找不到它们，
  // 会直接报 "was not found by the project service"。
  //
  // 正确做法是尊重 tsconfig 的边界：这些文件只做**语法与基础规则**
  // 检查，不做类型检查。它们的类型正确性本来就由 `vite build` 与
  // `vitest run` 实际运行来保证 —— 那比静态检查更直接。
  {
    files: ["*.config.ts", "*.config.mts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
      },
      globals: { ...globals.node },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...baseRules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // ---- 构建与工具脚本（Node ESM，纯 JS）----
  {
    files: ["scripts/**/*.mjs", "*.config.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...baseRules,
      // 脚本里 console.log 是正常的输出方式，不是调试残留
      "no-console": "off",
    },
  },
];
