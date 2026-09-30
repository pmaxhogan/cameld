import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke suite for the real, built server (which also serves the built web
 * app). Every run gets a fresh DATA_DIR so a database left over from an
 * earlier run can never make a test pass that should have failed.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.CAMELD_E2E_PORT ?? 8099);
const baseURL = process.env.CAMELD_E2E_BASE_URL ?? `http://127.0.0.1:${String(port)}`;
const dataDir = process.env.CAMELD_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "cameld-e2e-"));

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node server/dist/index.js",
    cwd: repoRoot,
    url: `${baseURL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_URL: baseURL,
      LOG_LEVEL: "warn",
    },
  },
});
