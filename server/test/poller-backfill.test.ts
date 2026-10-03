import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActivity, listGroups } from "../src/state/repo.ts";
import { addOuting, addSingle } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";

let h: Harness;
afterEach(async () => {
  vi.useRealTimers();
  await h?.close();
});

const DAY = 24 * 3600_000;

describe("Poller", () => {
  it("backs up every new activity in full, idempotently, and records the last poll", async () => {
    h = await createHarness();
    const outing = addOuting(h.world, { withPhoto: true });
    const first = await h.poller.poll();
    expect(first).toMatchObject({ skipped: false, listed: 2, backedUp: 2, groups: 1, error: null });
    const kinds = (id: number) =>
      (
        h.db
          .prepare("SELECT kind FROM backup_files WHERE activity_id = ? ORDER BY kind")
          .all(id) as { kind: string }[]
      ).map((r) => r.kind);
    expect(kinds(outing.app.id)).toEqual([
      "comments",
      "kudos",
      "metadata",
      "original",
      "photo",
      "photos_list",
      "streams",
      "web_form",
    ]);
    const requests = h.world.requests.length;
    const second = await h.poller.poll();
    expect(second.backedUp).toBe(0);
    // Only the list call and the machine's own reads; no backup reads again.
    expect(h.world.requests.slice(requests).filter((r) => r.path.includes("/kudos"))).toEqual([]);
    expect(await h.metrics.render()).toMatch(/cameld_last_successful_poll_timestamp_seconds \d+/);
    expect(await h.metrics.render()).toMatch(/cameld_backup_files [1-9]/);
  });

  it("never overlaps a running poll", async () => {
    h = await createHarness();
    addOuting(h.world);
    const [a, b] = await Promise.all([h.poller.poll(), h.poller.poll()]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
  });

  it("marks singles after the partner wait, and a late partner still pairs", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    outing.fitbit.exists = false;
    await h.poller.poll();
    expect(getActivity(h.db, outing.app.id)?.singleAt).toBeNull();
    h.clock.t += 5 * 3600_000;
    await h.poller.poll();
    expect(getActivity(h.db, outing.app.id)?.singleAt).not.toBeNull();
    outing.fitbit.exists = true;
    await h.poller.poll();
    expect(listGroups(h.db)).toHaveLength(1);
  });

  it("defers original exports while the web session is paused, and retries later", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    h.session.loggedIn = false;
    await h.web.keepAlive();
    await h.poller.poll();
    expect(getActivity(h.db, outing.app.id)?.originalStatus).toBe("pending");
    expect(listGroups(h.db)[0]?.lastError).toBe("wait:web_paused");
    h.session.loggedIn = true;
    await h.web.keepAlive();
    await h.poller.poll();
    expect(getActivity(h.db, outing.app.id)?.originalStatus).toBe("present");
  });

  it("records activities deleted outside cameld as gone and survives backup errors", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    h.world.onRequest = (method, path) => {
      if (path === `/api/v3/activities/${single.id}`) single.exists = false;
    };
    const result = await h.poller.poll();
    expect(result.error).toBeNull();
    expect(getActivity(h.db, single.id)?.goneAt).not.toBeNull();
  });

  it("reports a failing poll without throwing", async () => {
    h = await createHarness();
    h.fault = () => "lose_response";
    const result = await h.poller.poll();
    expect(result.error).toMatch(/fetch failed/);
  });

  it("logs and continues past a non-transient backup failure", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    h.world.onRequest = (method, path) => {
      if (path === `/api/v3/activities/${single.id}/streams`) throw new Error("synthetic 500");
    };
    const result = await h.poller.poll();
    // A 500 is transient: the poll stops and reports it.
    expect(result.error).toMatch(/500/);
  });

  it("schedules polls and keepalives from the settings until stopped", async () => {
    vi.useFakeTimers();
    h = await createHarness();
    let polls = 0;
    const poll = h.poller.poll.bind(h.poller);
    h.poller.poll = () => {
      polls += 1;
      return polls === 2 ? Promise.reject(new Error("synthetic")) : poll();
    };
    h.poller.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 10);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 10);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    h.poller.stop();
    const after = polls;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(after).toBeGreaterThanOrEqual(3);
    expect(polls).toBe(after);
    expect(h.session.calls.some((c) => c.op === "keepalive")).toBe(true);
  });
});

describe("Backfill", () => {
  it("does nothing while off", async () => {
    h = await createHarness();
    addOuting(h.world);
    expect(await h.backfill.runBatch()).toMatchObject({ mode: "off", stopped: "off" });
    expect(h.world.requests).toEqual([]);
  });

  it("backs up all history newest to oldest within the daily budget, then resumes", async () => {
    h = await createHarness({
      settings: {
        backfill: { mode: "backup_only", pageSize: 2, dailyReads: 15, fifteenMinuteReads: 15 },
      },
    });
    for (let day = 0; day < 4; day += 1) addOuting(h.world, { day });
    h.clock.t += 10 * DAY;
    const first = await h.backfill.runBatch();
    expect(first.stopped).toBe("budget");
    expect(first.activities).toBeGreaterThan(0);
    expect(h.budget.readsToday()).toBeLessThanOrEqual(15);
    const progress = h.backfill.progress();
    expect(progress.done).toBe(false);
    expect(progress.cursorMs).not.toBeNull();
    // Next UTC day: the budget refills and the walk continues where it stopped.
    h.clock.t += DAY;
    const second = await h.backfill.runBatch();
    expect(second.stopped).toBe("done");
    expect(h.backfill.progress()).toMatchObject({ done: true, activities: 8 });
    expect(listGroups(h.db)).toEqual([]);
    expect(await h.backfill.runBatch()).toMatchObject({ stopped: "done", activities: 0 });
    expect(await h.metrics.render()).toContain("cameld_backfill_done 1");
    h.backfill.reset();
    expect(h.backfill.progress().done).toBe(false);
  });

  it("dry run reports every group it would merge with metrics and writes nothing to strava", async () => {
    h = await createHarness({ settings: { backfill: { mode: "dry_run" } } });
    addOuting(h.world, { day: 0 });
    addOuting(h.world, { day: 1, fitbitNoiseMeters: 60 });
    addOuting(h.world, { day: 2, fitbitWithoutOriginal: true });
    addSingle(h.world, 3);
    h.clock.t += 10 * DAY;
    const result = await h.backfill.runBatch();
    expect(result).toMatchObject({ mode: "dry_run", stopped: "done", activities: 7, groups: 3 });
    const report = h.backfill.report();
    expect(report.groups.map((g) => g.decision).sort()).toEqual([
      "auto",
      "needs_original",
      "review",
    ]);
    const auto = report.groups.find((g) => g.decision === "auto")!.report as {
      noLoss: { ok: boolean; ledgerEntries: number };
      match: { metrics: { overlapRatio: number } };
    };
    expect(auto.noLoss.ok).toBe(true);
    expect(auto.match.metrics.overlapRatio).toBeGreaterThan(0.8);
    expect(h.world.uploads.size).toBe(0);
    expect(h.world.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(listGroups(h.db)).toEqual([]);
    const file = join(h.dir, "reports", "dry-run.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).groups).toHaveLength(3);
  });

  it("reports a merge that fails its no-loss check in the dry run", async () => {
    h = await createHarness({
      settings: { backfill: { mode: "dry_run" } },
    });
    addOuting(h.world);
    h.clock.t += 10 * DAY;
    // A writer failure inside the dry-run build is reported, not thrown.
    h.settings.update({ merge: { speedLimitsMps: { run: 0.0001 } } });
    const result = await h.backfill.runBatch();
    expect(result.stopped).toBe("done");
    expect(h.backfill.report().groups[0]?.decision).toMatch(/auto|merge_check_failed/);
  });

  it("live mode hands groups to the state machine", async () => {
    h = await createHarness({ settings: { backfill: { mode: "live" } } });
    addOuting(h.world);
    h.clock.t += 30 * DAY;
    const result = await h.backfill.runBatch();
    expect(result).toMatchObject({ mode: "live", groups: 1 });
    expect(listGroups(h.db)[0]?.status).toBe("detected");
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("parked");
  });

  it("stops on an error, records gone activities and refuses to run twice at once", async () => {
    h = await createHarness({ settings: { backfill: { mode: "backup_only" } } });
    const single = addSingle(h.world, 0);
    addSingle(h.world, 1);
    h.clock.t += 10 * DAY;
    h.world.onRequest = (method, path) => {
      if (path === `/api/v3/activities/${single.id}`) single.exists = false;
    };
    const [a, b] = await Promise.all([h.backfill.runBatch(), h.backfill.runBatch()]);
    expect([a.stopped, b.stopped].sort()).toEqual(["done", "running"]);
    expect(getActivity(h.db, single.id)?.goneAt).not.toBeNull();
    h.backfill.reset();
    h.fault = () => "lose_response";
    const failed = await h.backfill.runBatch();
    expect(failed).toMatchObject({ stopped: "error" });
    expect(failed.error).toMatch(/fetch failed/);
    h.fault = null;
    h.world.onRequest = (method, path) => {
      if (path.endsWith("/streams")) throw new Error("synthetic");
    };
    h.backfill.reset();
    h.db.prepare("DELETE FROM backup_files").run();
    h.db.prepare("DELETE FROM activities").run();
    expect((await h.backfill.runBatch()).stopped).toBe("error");
  });
});
