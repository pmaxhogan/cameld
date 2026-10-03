import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSrc = fileURLToPath(new URL("./shared/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@cameld/shared": sharedSrc } },
        test: {
          name: "shared",
          root: "./shared",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        resolve: { alias: { "@cameld/shared": sharedSrc } },
        test: {
          name: "server",
          root: "./server",
          environment: "node",
          include: ["test/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "relay",
          root: "./relay",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      "./web/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["shared/src/**/*.ts", "server/src/**/*.ts", "web/src/**/*.{ts,vue}"],
      exclude: [
        "**/*.d.ts",
        "**/dist/**",
        "**/node_modules/**",
        "shared/src/index.ts",
        // Process entrypoints: exercised by the e2e suite and the image smoke test.
        "server/src/index.ts",
        "web/src/main.ts",
        // Runs inside the browser via page.evaluate, so v8 never sees it execute in
        // Node. The web-session integration tests drive it in a real Chromium.
        "server/src/web/in-page.ts",
      ],
    },
  },
});
