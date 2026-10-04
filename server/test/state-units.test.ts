import { DEFAULT_MERGE_SETTINGS, type MatchResult } from "@cameld/shared";
import { describe, expect, it } from "vitest";
import { BudgetExhaustedError, dayKey, ReadBudget, windowKey } from "../src/service/budget.ts";
import { WebGate, WebPausedError } from "../src/service/web-gate.ts";
import {
  buildMerge,
  fitSport,
  MergeCheckError,
  mergeFigures,
  postUploadCheck,
} from "../src/state/build.ts";
import { summarizeMatch } from "../src/state/evaluate.ts";
import { isTransient } from "../src/state/machine.ts";
import {
  getActivity,
  getGroup,
  insertGroup,
  patchGroup,
  requireActivity,
  requireGroup,
  upsertActivity,
  withTransaction,
  writesFor,
} from "../src/state/repo.ts";
import { UploadTimeoutError } from "../src/strava/client.ts";
import { StravaAuthError } from "../src/strava/tokens.ts";
import { LoginRequiredError } from "../src/web/errors.ts";
import { FakeWebSession } from "./fake-strava-api/web-session.ts";
import { FakeWorld } from "./fake-strava-api/world.ts";
import { captureLogger, memoryDb, RecordingNotifier } from "./state-helpers.ts";

describe("repo", () => {
  it("handles unknown rows, null external ids, patches and transactions", () => {
    const db = memoryDb();
    expect(getActivity(db, 1)).toBeNull();
    expect(() => requireActivity(db, 1)).toThrow(/not known/);
    expect(getGroup(db, "g")).toBeNull();
    expect(() => requireGroup(db, "g")).toThrow(/does not exist/);
    upsertActivity(
      db,
      {
        id: 5,
        name: "Synthetic",
        sport_type: "Run",
        start_date: "2020-02-02T02:02:02Z",
        start_date_local: "2020-02-02T02:02:02Z",
        distance: 1,
        moving_time: 1,
        elapsed_time: 10,
      },
      0,
    );
    expect(requireActivity(db, 5)).toMatchObject({
      externalId: null,
      deviceName: null,
      source: "other",
    });
    insertGroup(db, { id: "g", appIds: [5], fitbitIds: [], startMs: 0 }, 0);
    patchGroup(db, "g", { match: null, trial: false, photosFlagged: true }, 1);
    expect(requireGroup(db, "g")).toMatchObject({ match: null, trial: false, photosFlagged: true });
    expect(writesFor(db, {})).toEqual([]);
    expect(() =>
      withTransaction(db, () => {
        patchGroup(db, "g", { status: "done" }, 2);
        throw new Error("rolled back");
      }),
    ).toThrow("rolled back");
    expect(requireGroup(db, "g").status).toBe("detected");
    expect(withTransaction(db, () => 42)).toBe(42);
  });
});

describe("build helpers", () => {
  it("maps sports to FIT names", () => {
    expect(fitSport("TrailRun")).toBe("running");
    expect(fitSport("Hike")).toBe("hiking");
    expect(fitSport("Walk")).toBe("walking");
    expect(fitSport("GravelRide")).toBe("cycling");
    expect(fitSport("Swim")).toBe("swimming");
    expect(fitSport("Yoga")).toBe("generic");
    expect(fitSport(null)).toBe("generic");
  });

  it("measures merge figures from recorded distance or the path", () => {
    expect(mergeFigures([])).toEqual({
      points: 0,
      distanceMeters: 0,
      elapsedSeconds: 0,
      startMs: 0,
      hasHeartRate: false,
    });
    const path = mergeFigures([
      { time: 0, source: "s", lat: 0.5, lng: 0.5 },
      { time: 1000, source: "s" },
      { time: 2000, source: "s", lat: 0.501, lng: 0.5, heartRate: 100 },
    ]);
    expect(path.distanceMeters).toBeGreaterThan(100);
    expect(path).toMatchObject({ points: 3, elapsedSeconds: 2, hasHeartRate: true });
    expect(mergeFigures([{ time: 0, source: "s", distance: 50 }]).distanceMeters).toBe(50);
  });

  it("checks every post-upload tolerance", () => {
    const expected = {
      points: 100,
      distanceMeters: 1000,
      elapsedSeconds: 100,
      startMs: 0,
      hasHeartRate: true,
    };
    const ok = postUploadCheck({
      expected,
      actual: { ...expected, points: 97, distanceMeters: 1040 },
      tolerance: 0.05,
      startToleranceSeconds: 2,
    });
    expect(ok).toEqual({ ok: true, failures: [] });
    const bad = postUploadCheck({
      expected,
      actual: {
        points: 50,
        distanceMeters: 10,
        elapsedSeconds: 10,
        startMs: 5000,
        hasHeartRate: false,
      },
      tolerance: 0.05,
      startToleranceSeconds: 2,
    });
    expect(bad.failures).toEqual(["points", "distance", "elapsed", "heart_rate", "start_time"]);
  });

  it("refuses an empty merge", () => {
    expect(() =>
      buildMerge({
        app: [],
        fitbit: [],
        offsetSeconds: 0,
        sport: null,
        settings: DEFAULT_MERGE_SETTINGS,
      }),
    ).toThrow(MergeCheckError);
  });
});

describe("summarizeMatch", () => {
  it("summarizes structural results without metrics or alignment", () => {
    const none: MatchResult = {
      decision: "review",
      reasons: ["more_than_two_sources"],
      memberIds: ["1", "2", "3"],
      app: null,
      fitbit: null,
      metrics: null,
    };
    expect(summarizeMatch(none)).toMatchObject({ appIds: [], fitbitIds: [], metrics: null });
  });
});

describe("ReadBudget", () => {
  it("spends per day and per 15 minutes and prunes old windows", () => {
    const db = memoryDb();
    let now = Date.parse("2030-01-01T00:00:00Z");
    const budget = new ReadBudget(
      db,
      () => ({ dailyReads: 3, fifteenMinuteReads: 2 }),
      () => now,
    );
    expect(budget.usage()).toEqual({
      dailyReads: 3,
      fifteenMinuteReads: 2,
      dailyUsed: 0,
      fifteenMinuteUsed: 0,
      remaining: 2,
      limitedBy: "fifteen_minute",
    });
    budget.beforeRead();
    budget.beforeRead();
    expect(budget.remaining()).toBe(0);
    expect(budget.readsThisWindow()).toBe(2);
    expect(() => budget.beforeRead()).toThrow(
      expect.objectContaining({
        window: "fifteen_minute",
        message: expect.stringMatching(/15-minute/),
      }),
    );
    now += 15 * 60_000;
    expect(budget.readsThisWindow()).toBe(0);
    budget.beforeRead();
    expect(budget.readsToday()).toBe(3);
    expect(() => budget.beforeRead()).toThrow(BudgetExhaustedError);
    expect(() => budget.beforeRead()).toThrow(
      expect.objectContaining({ window: "daily", message: expect.stringMatching(/daily/) }),
    );
    const keys = (
      db.prepare("SELECT window_key FROM backfill_budget").all() as { window_key: string }[]
    )
      .map((r) => r.window_key)
      .sort();
    expect(keys).toEqual([dayKey(now), windowKey(now)].sort());
    expect(new ReadBudget(db, () => ({ dailyReads: 1, fifteenMinuteReads: 1 })).readsToday()).toBe(
      0,
    );
  });
});

describe("WebGate", () => {
  function gate(loggedIn = true) {
    const world = new FakeWorld();
    const session = new FakeWebSession(world, () => 0);
    session.loggedIn = loggedIn;
    const notifier = new RecordingNotifier();
    const { log, lines } = captureLogger();
    const web = new WebGate({ session, notifier, log });
    return { session, notifier, web, lines };
  }

  it("is permanently closed without a browser", async () => {
    const web = new WebGate({ session: null, notifier: new RecordingNotifier() });
    expect(web.available()).toBe(false);
    expect(web.status()).toEqual({ healthy: false, reason: "no_browser" });
    await expect(web.run(() => Promise.resolve(1))).rejects.toThrow(/paused \(no_browser\)/);
    expect(await web.keepAlive()).toBeNull();
  });

  it("pauses on a login failure, notifies once, and resumes after a healthy check", async () => {
    const { session, notifier, web } = gate();
    expect(web.status()).toEqual({ healthy: true, reason: null });
    await expect(web.run(() => Promise.reject(new LoginRequiredError("expired")))).rejects.toThrow(
      LoginRequiredError,
    );
    await expect(web.run(() => Promise.resolve(1))).rejects.toThrow(WebPausedError);
    session.loggedIn = false;
    await web.keepAlive();
    expect(notifier.kinds()).toEqual(["login_unhealthy"]);
    expect(session.calls.map((c) => c.op)).toEqual(["health"]);
    session.loggedIn = true;
    expect(await web.keepAlive()).toMatchObject({ loggedIn: true });
    expect(web.available()).toBe(true);
    await expect(web.run(() => Promise.reject(new Error("other")))).rejects.toThrow("other");
    expect(web.available()).toBe(true);
  });

  it("tries one automatic login when the keepalive finds the session expired", async () => {
    const { session, web, notifier } = gate();
    session.loggedIn = false;
    session.loginWorks = true;
    expect(await web.keepAlive()).toMatchObject({ loggedIn: true, reason: null });
    expect(session.calls.map((c) => c.op)).toEqual(["keepalive", "health", "login"]);
    session.loggedIn = false;
    session.loginWorks = false;
    expect(await web.keepAlive()).toMatchObject({ loggedIn: false });
    expect(web.status()).toEqual({ healthy: false, reason: "login_required" });
    expect(notifier.kinds()).toEqual(["login_unhealthy"]);
  });

  it("goes unhealthy when the keepalive itself fails", async () => {
    const { session, web, lines } = gate();
    session.keepAlive = () => Promise.reject(new Error("cdp gone"));
    expect(await web.keepAlive()).toBeNull();
    expect(web.status().reason).toBe("keepalive_failed");
    expect(lines.join("")).toContain("web keepalive failed");
  });
});

describe("isTransient", () => {
  it("treats auth, budget and upload timeouts as transient", () => {
    expect(isTransient(new StravaAuthError("network"))).toBe(true);
    expect(isTransient(new BudgetExhaustedError("daily"))).toBe(true);
    expect(isTransient(new UploadTimeoutError(1))).toBe(true);
  });
});
