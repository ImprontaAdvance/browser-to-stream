import eslint from "@eslint/js";
import globals from "globals";
import typescriptEslint from "typescript-eslint";

const typescriptFiles = ["src/**/*.ts", "test/**/*.ts"];

export default typescriptEslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  {
    ...eslint.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  ...typescriptEslint.configs.strict.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    files: typescriptFiles,
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
