import { describe, expect, it } from "vitest";

import { Metrics } from "../src/service/metrics.ts";
import { notificationUrl } from "../src/service/push.ts";
import { remediationNotification, remediationReporter, WebGate } from "../src/service/web-gate.ts";
import type { RemediationReport } from "../src/web/cdp-remediation.ts";
import type { HealthReason, StravaWebSession, WebHealth } from "../src/web/session.ts";
import { captureLogger, RecordingNotifier } from "./state-helpers.ts";

/**
 * Owner notifications for a persistent browser outage (once per outage, not
 * every keepalive) and for hung-tab remediations. Synthetic stand-ins only.
 */

function scriptedSession(): { session: StravaWebSession; set(reason: HealthReason | null): void } {
  let reason: HealthReason | null = null;
  const health = (): Promise<WebHealth> =>
    Promise.resolve({ loggedIn: reason === null, reason, checkedAt: 0 });
  const session = {
    health,
    keepAlive: health,
    login: () => Promise.reject(new Error("synthetic: no automated login")),
  } as unknown as StravaWebSession;
  return {
    session,
    set: (next) => {
      reason = next;
    },
  };
}

function metrics(): Metrics {
  return new Metrics({
    defaultMetrics: false,
    sources: {
      parkedByReason: () => ({}),
      frozen: () => false,
      rateUsage: () => null,
      backupTotals: () => ({ bytes: 0, files: 0 }),
      backfill: () => ({ activities: 0, cursorMs: null, done: false, readsToday: 0 }),
    },
  });
}

const report = (over: Partial<RemediationReport> = {}): RemediationReport => ({
  outcome: "recovered",
  probed: [{ id: "T1", url: "https://www.example.test/feed", result: "unresponsive" }],
  openedBlank: true,
  closed: [{ id: "T1", url: "https://www.example.test/feed", result: "unresponsive" }],
  stillListed: [],
  ...over,
});

describe("persistent browser outage", () => {
  it("raises one critical notification per outage, not one per keepalive", async () => {
    const { session, set } = scriptedSession();
    const notifier = new RecordingNotifier();
    const gate = new WebGate({ session, notifier });
    set("browser_unavailable");
    for (let hour = 0; hour < 14; hour += 1) await gate.keepAlive();
    expect(notifier.kinds()).toEqual(["browser_unavailable"]);
    expect(notifier.sent[0]?.level).toBe("critical");
    expect(notifier.sent[0]?.body).toContain("Restart the cameld-browser container");
    expect(gate.status()).toEqual({ healthy: false, reason: "browser_unavailable" });

    // Recovery ends the outage; the next one notifies again.
    set(null);
    await gate.keepAlive();
    set("browser_unavailable");
    await gate.keepAlive();
    expect(notifier.kinds()).toEqual(["browser_unavailable", "browser_unavailable"]);
  });

  it("notifies again when a login outage turns into a browser outage and back", async () => {
    const { session, set } = scriptedSession();
    const notifier = new RecordingNotifier();
    const { log } = captureLogger();
    const gate = new WebGate({ session, notifier, log });
    set("login_required");
    await gate.keepAlive();
    set("challenge");
    await gate.keepAlive();
    set("browser_unavailable");
    await gate.keepAlive();
    await gate.keepAlive();
    set("login_required");
    await gate.keepAlive();
    expect(notifier.kinds()).toEqual(["login_unhealthy", "browser_unavailable", "login_unhealthy"]);
  });
});

describe("remediation notifications", () => {
  it("says what was closed when it recovered and asks for a restart when it failed", () => {
    expect(remediationNotification(report())).toMatchObject({
      kind: "browser_remediated",
      level: "warning",
    });
    expect(remediationNotification(report()).body).toContain("closed 1 unresponsive tab ");
    const failed = remediationNotification(report({ outcome: "failed", closed: [] }));
    expect(failed).toMatchObject({ kind: "browser_restart_needed", level: "critical" });
    expect(failed.body).toContain("closed 0 unresponsive tabs");
    expect(failed.body).toContain("Restart the cameld-browser container");
    const two = report({
      closed: [
        { id: "T1", url: "x", result: "unresponsive" },
        { id: "T2", url: "x", result: "unresponsive" },
      ],
    });
    expect(remediationNotification(two).body).toContain("closed 2 unresponsive tabs");
  });

  it("counts every remediation and notifies the owner, even when the push fails", async () => {
    const notifier = new RecordingNotifier();
    const m = metrics();
    const { log, lines } = captureLogger();
    const reporter = remediationReporter({ notifier, metrics: m, log });
    await reporter(report());
    await reporter(report({ outcome: "failed" }));
    notifier.fail = true;
    await reporter(report({ outcome: "failed" }));
    const text = await m.render();
    expect(text).toContain('cameld_web_remediations_total{result="recovered"} 1');
    expect(text).toContain('cameld_web_remediations_total{result="failed"} 2');
    expect(notifier.kinds()).toEqual(["browser_remediated", "browser_restart_needed"]);
    expect(lines.join("")).toContain("notification failed");
    // Without metrics it still notifies.
    await remediationReporter({ notifier: new RecordingNotifier() })(report());
  });

  it("sends every browser notification to the browser panel", () => {
    for (const kind of [
      "browser_unavailable",
      "browser_remediated",
      "browser_restart_needed",
    ] as const)
      expect(notificationUrl({ kind, level: "critical", title: "t", body: "b" })).toBe(
        "/#/browser",
      );
  });
});
