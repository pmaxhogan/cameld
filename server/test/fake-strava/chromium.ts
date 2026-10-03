import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

/**
 * Launch a real Chromium the way the cameld-browser sidecar runs: a separate
 * process with its own profile, exposing CDP on a port. Playwright's own
 * launch() refuses remote-debugging flags, so the binary is spawned directly.
 * CI installs it with `npx playwright install --with-deps chromium`.
 */
export interface CdpChromium {
  cdpUrl: string;
  process: ChildProcess;
  close(): Promise<void>;
}

export async function launchCdpChromium(): Promise<CdpChromium> {
  const profile = mkdtempSync(join(tmpdir(), "cameld-chromium-"));
  const child = spawn(
    chromium.executablePath(),
    [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`chromium did not start:\n${stderr}`)), 20_000);
    child.once("error", reject);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1] as string);
      }
    });
  });
  return {
    cdpUrl: `http://127.0.0.1:${new URL(wsUrl).port}`,
    process: child,
    async close() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows can hold profile files briefly after exit; the OS temp dir cleans up.
      }
    },
  };
}
