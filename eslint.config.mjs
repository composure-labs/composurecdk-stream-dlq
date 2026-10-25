// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import composurecdk from "@composurecdk/eslint-plugin";

export default defineConfig(
  {
    ignores: ["dist/", ".tshy/", ".tshy-build/", "node_modules/", "cdk.out/", "coverage/"],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "vitest.config.ts", "scripts/*.mjs"],
        },
      },
    },
  },
  {
    files: ["eslint.config.mjs", "vitest.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["scripts/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
  },
  {
    // The three tiers true of this package (ADR-0019): it writes builders
    // (`recommended`), publishes them for others to compile against
    // (`libraryAuthor`), and ships ESM + CommonJS from one source
    // (`dualPublishing`). `internal` is composureCDK's own and is not for us.
    files: ["src/**/*.ts"],
    extends: [
      composurecdk.configs.recommended,
      composurecdk.configs.libraryAuthor,
      composurecdk.configs.dualPublishing,
    ],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: {
      "@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
    },
  },
  eslintConfigPrettier,
);
