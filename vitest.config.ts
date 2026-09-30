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
      ],
    },
  },
});
