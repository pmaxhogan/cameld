import { mkdtempSync } from "node:fs";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { AUD, OWNER, PASSWORD, VNC_PASSWORD, VNC_USER } from "./support/constants.ts";

/**
 * Suite for the real, built server (which also serves the built web app),
 * with synthetic seeded data and test doubles for Cloudflare Access and the
 * browser sidecar (support/access-double.ts). Every run gets a fresh
 * DATA_DIR, seeded before the server starts, so a database left over from an
 * earlier run can never make a test pass that should have failed.
 *
 * The config is evaluated again in every worker, so values the workers need
 * (ports) are fixed or passed through the environment.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.CAMELD_E2E_PORT ?? 8099);
const doublePort = Number(process.env.CAMELD_E2E_DOUBLE_PORT ?? 8098);
const baseURL = process.env.CAMELD_E2E_BASE_URL ?? `http://127.0.0.1:${String(port)}`;
process.env.CAMELD_E2E_DOUBLE_URL = `http://127.0.0.1:${String(doublePort)}`;
const dataDir = process.env.CAMELD_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "cameld-e2e-"));

const salt = randomBytes(16);
const passwordHash = `pbkdf2$sha256$100000$${salt.toString("base64url")}$${pbkdf2Sync(PASSWORD, salt, 100_000, 32, "sha256").toString("base64url")}`;

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
  webServer: [
    {
      command: `node e2e/support/access-double.ts ${String(doublePort)}`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${String(doublePort)}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `node e2e/support/seed.ts "${dataDir}" && node server/dist/index.js`,
      cwd: repoRoot,
      url: `${baseURL}/healthz`,
      reuseExistingServer: false,
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
        CF_ACCESS_TEAM_DOMAIN: `http://127.0.0.1:${String(doublePort)}`,
        CF_ACCESS_AUD: AUD,
        ALLOWED_EMAIL: OWNER,
        UI_PASSWORD_HASH: passwordHash,
        SESSION_SECRET: randomBytes(32).toString("hex"),
        MAP_STYLE_URL: "none",
        BROWSER_VNC_URL: `http://127.0.0.1:${String(doublePort)}/vnc/`,
        BROWSER_VNC_USER: VNC_USER,
        BROWSER_VNC_PASSWORD: VNC_PASSWORD,
      },
    },
  ],
});
