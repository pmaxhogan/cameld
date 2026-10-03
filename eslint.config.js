import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat config. Type-aware linting is deliberately off: the repo spans four
 * workspaces with different module resolutions, and the tsc typecheck job
 * already covers what the typed rules would add.
 *
 * The em dash / en dash ban is enforced by scripts/check-ascii.mjs rather than
 * a lint rule, because it also has to cover Markdown, YAML, and the Dockerfile,
 * which ESLint never parses.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "tmp-data/**",
      "**/.wrangler/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      eqeqeq: ["error", "smart"],
      "no-console": "error",
      "no-implicit-coercion": "error",
      "object-shorthand": "error",
      "prefer-const": "error",
    },
  },
  {
    // DeletionAuthorization.mint is the state machine's alone (see
    // server/src/web/deletion-authorization.ts). Minting anywhere else is a lint error.
    files: ["**/*.{ts,js,vue}"],
    ignores: ["server/src/state/**", "server/test/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='mint'][callee.object.name='DeletionAuthorization']",
          message:
            "Only the merge state machine (server/src/state/) may mint a DeletionAuthorization.",
        },
      ],
    },
  },
  {
    // Vue SFCs need vue-eslint-parser with the TS parser for <script lang="ts">.
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: { ...globals.browser },
    },
  },
  {
    files: ["web/**/*.{ts,vue}"],
    languageOptions: { globals: { ...globals.browser } },
    // The UI may report real failures, but nothing routine.
    rules: { "no-console": ["error", { allow: ["error", "warn"] }] },
  },
  {
    // The Web Push service worker runs in a ServiceWorkerGlobalScope, not a page.
    files: ["web/public/sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  prettier,
);
