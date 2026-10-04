import { describe, expect, it } from "vitest";
import { Metrics, type MetricsSources } from "../src/service/metrics.ts";
import {
  HttpSnapshotter,
  SnapshotError,
  UnavailableSnapshotter,
} from "../src/service/snapshotter.ts";

function fetchReturning(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(respond(String(input), init ?? {}));
  };
  return { fetch: fn as typeof fetch, calls };
}

describe("HttpSnapshotter", () => {
  it("posts the label and returns the snapshot name", async () => {
    const { fetch, calls } = fetchReturning(() => Response.json({ snapshot: "tank/cameld@pre-1" }));
    const snap = new HttpSnapshotter({ url: "http://helper.invalid:9/", fetch });
    expect(await snap.snapshot("pre-delete-1")).toBe("tank/cameld@pre-1");
    expect(calls).toEqual([
      { url: "http://helper.invalid:9/snapshot", body: { label: "pre-delete-1" } },
    ]);
  });

  it("fails on bad labels, errors, bad bodies and unreachable helpers", async () => {
    const ok = fetchReturning(() => Response.json({ snapshot: "x@y" }));
    const snap = new HttpSnapshotter({ url: "http://h.invalid", fetch: ok.fetch, timeoutMs: 5 });
    await expect(snap.snapshot("Bad Label")).rejects.toThrow(SnapshotError);
    const status = new HttpSnapshotter({
      url: "http://h.invalid",
      fetch: fetchReturning(() => new Response("no", { status: 500 })).fetch,
    });
    await expect(status.snapshot("a")).rejects.toThrow(/answered 500/);
    for (const body of ["not json", JSON.stringify({ snapshot: "no-at-sign" }), "{}"]) {
      const bad = new HttpSnapshotter({
        url: "http://h.invalid",
        fetch: fetchReturning(() => new Response(body)).fetch,
      });
      await expect(bad.snapshot("a")).rejects.toThrow(/did not return/);
    }
    const down = new HttpSnapshotter({
      url: "http://h.invalid",
      fetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
    });
    await expect(down.snapshot("a")).rejects.toThrow(/unreachable: ECONNREFUSED/);
    await expect(new HttpSnapshotter({ url: "http://127.0.0.1:1" }).snapshot("a")).rejects.toThrow(
      SnapshotError,
    );
  });

  it("refuses everything when unconfigured", async () => {
    await expect(new UnavailableSnapshotter().snapshot("a")).rejects.toThrow(/no snapshot helper/);
  });
});

describe("Metrics", () => {
  const usage = {
    overall: { fifteenMinute: { limit: 200, usage: 7 }, day: { limit: 2000, usage: 70 } },
    read: { fifteenMinute: { limit: 100, usage: 5 }, day: { limit: 1000, usage: 50 } },
  };

  function sources(over: Partial<MetricsSources> = {}): MetricsSources {
    return {
      parkedByReason: () => ({ deletion_switch_off: 2 }),
      frozen: () => true,
      rateUsage: () => usage,
      backupTotals: () => ({ bytes: 1234, files: 5 }),
      backfill: () => ({ activities: 9, cursorMs: 2_000_000, done: false, readsToday: 33 }),
      originals: () => ({ present: 120, pending: 2, unavailable: 5, backingOff: 1 }),
      ...over,
    };
  }

  it("renders every documented metric", async () => {
    const metrics = new Metrics({ sources: sources() });
    metrics.merges.inc({ outcome: "merged" });
    metrics.setLastPoll(5000);
    metrics.setWebLogin(true);
    const text = await metrics.render();
    expect(metrics.contentType).toContain("text/plain");
    for (const line of [
      'cameld_merges_total{outcome="merged"} 1',
      'cameld_parked_pairs{reason="deletion_switch_off"} 2',
      "cameld_writes_frozen 1",
      'cameld_strava_rate_usage{bucket="read",window="day"} 50',
      'cameld_strava_rate_limit{bucket="overall",window="15m"} 200',
      "cameld_backup_bytes 1234",
      "cameld_backup_files 5",
      "cameld_last_successful_poll_timestamp_seconds 5",
      "cameld_web_login_healthy 1",
      "cameld_backfill_activities 9",
      "cameld_backfill_cursor_timestamp_seconds 2000",
      "cameld_backfill_done 0",
      "cameld_backfill_reads_today 33",
      'cameld_original_files{status="present"} 120',
      'cameld_original_files{status="pending"} 2',
      'cameld_original_files{status="unavailable"} 5',
      'cameld_original_files{status="backing_off"} 1',
      "cameld_process_cpu_user_seconds_total",
    ]) {
      expect(text).toContain(line);
    }
  });

  it("handles missing rate usage, no cursor and the inverse states", async () => {
    const metrics = new Metrics({
      defaultMetrics: false,
      sources: sources({
        frozen: () => false,
        rateUsage: () => null,
        backfill: () => ({ activities: 0, cursorMs: null, done: true, readsToday: 0 }),
      }),
    });
    metrics.setWebLogin(false);
    const text = await metrics.render();
    expect(text).toContain("cameld_writes_frozen 0");
    expect(text).toContain("cameld_web_login_healthy 0");
    expect(text).toContain("cameld_backfill_done 1");
    expect(text).not.toContain("cameld_strava_rate_usage{");
    expect(text).toMatch(/^cameld_backfill_cursor_timestamp_seconds 0$/m);
    expect(text).not.toContain("process_cpu");
  });
});
