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
        // A loaded CI runner can leave Chromium slow to exit; escalate rather than hang.
        const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await exited;
        clearTimeout(killer);
      }
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows can hold profile files briefly after exit; the OS temp dir cleans up.
      }
    },
  };
}

/**
 * Await a teardown step but give up after `ms`, so one wedged resource (a CDP
 * connection or a keep-alive socket on a starved runner) cannot fail the suite.
 */
export async function settleWithin(step: Promise<unknown> | undefined, ms = 10_000): Promise<void> {
  if (step === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([step.catch(() => undefined), limit]);
  } finally {
    clearTimeout(timer);
  }
}
