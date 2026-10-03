import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const API_TARGET = process.env.CAMELD_DEV_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@cameld/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/healthz": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // MapLibre alone is roughly 250 kB gzipped and is the honest floor for a
    // map UI, so the limit is raised so a real regression still trips it.
    chunkSizeWarningLimit: 1500,
    // MapLibre gets its own chunk so the app chunk's size stays a useful signal.
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: "maplibre", test: /node_modules[\\/]maplibre-gl/ }] },
      },
    },
  },
});
