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
      // The Strava login view embeds an iframe; never let happy-dom fetch it.
      environmentOptions: {
        happyDOM: { settings: { navigation: { disableChildFrameNavigation: true } } },
      },
      include: ["test/**/*.test.ts"],
    },
  }),
);
