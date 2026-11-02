// ESLint 扁平配置（ESLint 9+）
// 本仓库自带门禁，脱离宿主脚手架也能跑；规则与 ai-dev-spec 保持一致：
// 把「禁止 console.log 做生产日志」这类口头约定变成 error，靠机器守门而不是自觉。
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/*.config.js",
      "**/*.config.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: tsparser,
      sourceType: "module",
      ecmaVersion: 2022,
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      // —— 把软规则变成硬错误 ——
      // 注意：no-console 是 ESLint 核心规则，不可加 @typescript-eslint/ 前缀
      // （加了会让整份配置加载崩溃，门禁静默失效）。
      "no-console": [
        "error",
        { allow: ["warn", "error"] }, // 仅允许 console.warn/error 兜底；生产日志必须走本包 logger
      ],
      "no-debugger": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      eqeqeq: ["error", "always"],
      "no-duplicate-imports": "error",
    },
  },
];
