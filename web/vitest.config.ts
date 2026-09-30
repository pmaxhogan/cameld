import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: "web",
      root: fileURLToPath(new URL("./", import.meta.url)),
      environment: "happy-dom",
      include: ["test/**/*.test.ts"],
    },
  }),
);
