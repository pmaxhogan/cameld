import { chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Metrics } from "../src/service/metrics.ts";
import { remediationReporter, WebGate } from "../src/service/web-gate.ts";
import { type CdpTarget, probeTarget, type RemediationReport } from "../src/web/cdp-remediation.ts";
import { WebSession, type WebSessionOptions } from "../src/web/session.ts";
import { type CdpChromium, launchCdpChromium, settleWithin } from "./fake-strava/chromium.ts";
import { type FakeStrava, startFakeStrava } from "./fake-strava/server.ts";
import { captureLogger, RecordingNotifier } from "./state-helpers.ts";

/**
 * A wedged tab after a (synthetic) sidecar restart: the page's renderer
 * spins, so connectOverCDP hangs attaching to it while /json/* still
 * answers. This suite gets its OWN Chromium: a hung tab poisons any
 * Playwright connection that attaches to it, so the shared observer used by
 * the other web-session tests must never see one. All data is synthetic.
 */

let chrome: CdpChromium;
let fake: FakeStrava;
const sessions: WebSession[] = [];

async function devtools<T>(path: string, method = "GET"): Promise<T> {
  const response = await fetch(`${chrome.cdpUrl}/${path}`, { method });
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

const list = () => devtools<CdpTarget[]>("json/list");

/** Open a tab over plain HTTP (Playwright would hang attaching to it) and wait until it is wedged. */
async function openHungTab(): Promise<CdpTarget> {
  const target = await devtools<CdpTarget>(`json/new?${fake.hangUrl}`, "PUT");
  await expect
    .poll(() => probeTarget(target.webSocketDebuggerUrl, 1000), { timeout: 20_000 })
    .toBe("unresponsive");
  return target;
}

function open(extra: Partial<WebSessionOptions>): WebSession {
  const session = new WebSession(
    {
      cdpUrl: chrome.cdpUrl,
      baseUrl: fake.baseUrl,
      navigationTimeoutMs: 4000,
      operationTimeoutMs: 60_000,
      probeTimeoutMs: 1500,
      ...extra,
    },
    120_000,
  );
  sessions.push(session);
  return session;
}

function metricsFor(): Metrics {
  return new Metrics(
    {
      defaultMetrics: false,
      sources: {
        parkedByReason: () => ({}),
        frozen: () => false,
        rateUsage: () => null,
        backupTotals: () => ({ bytes: 0, files: 0 }),
        backfill: () => ({ activities: 0, cursorMs: null, done: false, readsToday: 0 }),
      },
    },
    120_000,
  );
}

beforeAll(async () => {
  chrome = await launchCdpChromium();
  fake = await startFakeStrava();
  // Log in and leave an ordinary strava.com tab open, then let go of the browser.
  const setup = await chromium.connectOverCDP(chrome.cdpUrl);
  const context = setup.contexts()[0];
  if (context === undefined) throw new Error("no default context");
  const login = await context.newPage();
  await login.goto(fake.sessionUrl);
  await login.close();
  const keep = await context.newPage();
  await keep.goto(`${fake.baseUrl}/dashboard`);
  await setup.close();
}, 120_000);

afterAll(async () => {
  for (const session of sessions.splice(0)) await settleWithin(session.disconnect());
  await settleWithin(fake?.close());
  await chrome?.close();
}, 120_000);

afterEach(async () => {
  for (const session of sessions.splice(0)) await settleWithin(session.disconnect());
});

describe("hung tab remediation", () => {
  it("closes only the hung tab, keeps the rest, reconnects with the login intact", async () => {
    const hung = await openHungTab();
    const before = await list();
    const others = before.filter((t) => t.id !== hung.id);
    expect(others.some((t) => t.url === `${fake.baseUrl}/dashboard`)).toBe(true);

    // A probe that sees nothing hung closes nothing, and the retried attach still hangs:
    // the tab really wedges CDP.
    const reports: RemediationReport[] = [];
    const blind = open({
      probe: () => Promise.resolve("responsive"),
      onRemediation: (r) => {
        reports.push(r);
      },
    });
    expect((await blind.health()).reason).toBe("browser_unavailable");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "failed", closed: [], openedBlank: false });
    expect((await list()).some((t) => t.id === hung.id)).toBe(true);

    const notifier = new RecordingNotifier();
    const metrics = metricsFor();
    const { log, lines } = captureLogger();
    const report = remediationReporter({ notifier, metrics, log });
    const session = open({
      logger: log,
      onRemediation: (r) => {
        reports.push(r);
        return report(r);
      },
    });
    const gate = new WebGate({ session, notifier, log, metrics });

    // The hourly keepalive is what finds it: one call remediates and reopens the gate.
    const health = await gate.keepAlive();
    expect(health).toMatchObject({ loggedIn: true, reason: null });
    expect(gate.status()).toEqual({ healthy: true, reason: null });
    const text = await metrics.render();
    expect(text).toContain("cameld_web_login_healthy 1");
    expect(text).toContain('cameld_web_remediations_total{result="recovered"} 1');
    expect(notifier.kinds()).toEqual(["browser_remediated"]);

    const after = await list();
    expect(after.some((t) => t.id === hung.id)).toBe(false);
    // Every other target (tabs, browser UI, workers) is still there, plus one blank tab.
    for (const target of others) expect(after.some((t) => t.id === target.id)).toBe(true);
    const added = after.filter((t) => t.type === "page" && !before.some((b) => b.id === t.id));
    expect(added).toEqual([expect.objectContaining({ type: "page", url: "about:blank" })]);
    expect(chrome.process.exitCode).toBeNull();

    expect(reports[1]).toMatchObject({ outcome: "recovered", openedBlank: true, stillListed: [] });
    expect(reports[1]?.closed.map((t) => t.id)).toEqual([hung.id]);
    expect(reports[1]?.probed.find((p) => p.id === hung.id)?.result).toBe("unresponsive");
    const warned = lines.join("");
    expect(warned).toContain("closed an unresponsive browser tab");
    expect(warned).toContain(hung.id);
  }, 120_000);

  it("does not remediate again within the interval", async () => {
    const hung = await openHungTab();
    const reports: RemediationReport[] = [];
    const session = open({
      remediationIntervalMs: 60 * 60_000,
      onRemediation: (r) => {
        reports.push(r);
      },
    });
    expect((await session.health()).loggedIn).toBe(true);
    await session.disconnect();
    expect(reports.map((r) => r.outcome)).toEqual(["recovered"]);

    const second = await openHungTab();
    expect((await session.health()).reason).toBe("browser_unavailable");
    expect(reports).toHaveLength(1);
    const ids = (await list()).map((t) => t.id);
    expect(ids).not.toContain(hung.id);
    expect(ids).toContain(second.id);

    // A fresh session (no recent remediation) clears it.
    expect((await open({}).health()).loggedIn).toBe(true);
    expect((await list()).map((t) => t.id)).not.toContain(second.id);
  }, 120_000);
});
