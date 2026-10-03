import { describe, expect, it } from "vitest";
import { LogNotifier, notifySafely } from "../src/service/notifier.ts";
import { FreezeStore } from "../src/state/freeze.ts";
import {
  DEFAULT_SETTINGS,
  deepMerge,
  matchSettingsOf,
  SettingsError,
  SettingsStore,
} from "../src/state/settings.ts";
import { captureLogger, memoryDb, RecordingNotifier } from "./state-helpers.ts";

describe("SettingsStore", () => {
  it("returns typed defaults with the safe switches", () => {
    const store = new SettingsStore(memoryDb());
    const settings = store.get();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.switches).toEqual({ hide: true, delete: false, upload: true });
    expect(settings.trial).toEqual({ enabled: false, maxPairs: 3 });
    expect(settings.backfill).toMatchObject({
      mode: "off",
      dailyReads: 600,
      fifteenMinuteReads: 70,
    });
    expect(settings.timing.gracePeriodMs).toBe(24 * 3600_000);
    expect(settings.timing.partnerWaitMs).toBe(4 * 3600_000);
    expect(matchSettingsOf(settings).partnerWaitMs).toBe(4 * 3600_000);
    expect(matchSettingsOf(settings).gpsAutoMaxMedianMeters).toBe(25);
  });

  it("persists a validated deep patch", () => {
    const db = memoryDb();
    const { log, lines } = captureLogger();
    const store = new SettingsStore(db, { log, now: () => 1000 });
    const next = store.update({
      switches: { delete: true },
      match: { alignment: { maxResidualMeters: 3 } },
    });
    expect(next.switches).toEqual({ hide: true, delete: true, upload: true });
    expect(new SettingsStore(db).get().match.alignment.maxResidualMeters).toBe(3);
    expect(new SettingsStore(db).get().switches.delete).toBe(true);
    expect(lines.join("")).toContain("settings updated");
    const row = db
      .prepare("SELECT updated_at FROM settings WHERE key = ?")
      .get("settings.switches");
    expect(row).toEqual({ updated_at: new Date(1000).toISOString() });
  });

  it("refuses invalid values and unknown sections, writing nothing", () => {
    const db = memoryDb();
    const store = new SettingsStore(db);
    expect(() => store.update({ trial: { maxPairs: 4 } })).toThrow(SettingsError);
    expect(() => store.update({ match: { gpsAutoMaxMedianMeters: 500 } })).toThrow(
      /must not exceed/,
    );
    expect(() => store.update({ nope: {} } as never)).toThrow(/unknown section nope/);
    expect(db.prepare("SELECT count(*) AS n FROM settings").get()).toEqual({ n: 0 });
  });

  it("falls back to defaults for a corrupt or invalid stored section", () => {
    const db = memoryDb();
    const { log, lines } = captureLogger();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "settings.switches",
      "{not json",
      "x",
    );
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "settings.trial",
      JSON.stringify({ maxPairs: 99 }),
      "x",
    );
    const store = new SettingsStore(db, { log });
    expect(store.get().switches).toEqual(DEFAULT_SETTINGS.switches);
    expect(store.get().trial).toEqual(DEFAULT_SETTINGS.trial);
    expect(lines.join("")).toContain("invalid");
  });

  it("rolls back when a write fails", () => {
    const db = memoryDb();
    const store = new SettingsStore(db);
    db.exec(
      "CREATE TRIGGER no_writes BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'x'); END",
    );
    expect(() => store.update({ switches: { hide: false } })).toThrow();
    expect(store.get().switches.hide).toBe(true);
  });

  it("deep merges objects and replaces everything else", () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] })).toEqual({
      a: { b: 1, c: 3 },
      d: [2],
    });
    expect(deepMerge(1, undefined)).toBe(1);
    expect(deepMerge({ a: 1 }, null)).toBeNull();
  });
});

describe("FreezeStore", () => {
  it("freezes persistently, keeps the first reason and notifies every failure", async () => {
    const db = memoryDb();
    const notifier = new RecordingNotifier();
    const { log } = captureLogger();
    let t = 10;
    const store = new FreezeStore(db, { notifier, now: () => t, log });
    expect(store.state()).toEqual({ frozen: false, reason: null, evidence: null, frozenAt: null });
    await store.freeze("no-loss check failed", { group: "g1" });
    t = 20;
    await store.freeze("second failure", null);
    const again = new FreezeStore(db, { notifier });
    expect(again.state()).toEqual({
      frozen: true,
      reason: "no-loss check failed",
      evidence: { group: "g1" },
      frozenAt: 10,
    });
    expect(notifier.kinds()).toEqual(["frozen", "frozen"]);
    expect(store.events().map((e) => e.action)).toEqual(["freeze", "freeze_again"]);
  });

  it("unfreezes only when frozen", async () => {
    const db = memoryDb();
    const notifier = new RecordingNotifier();
    const store = new FreezeStore(db, { notifier });
    expect(await store.unfreeze("nothing to do")).toBe(false);
    await store.freeze("x", undefined);
    expect(store.state().evidence).toBeNull();
    expect(await store.unfreeze("fixed forward")).toBe(true);
    expect(store.isFrozen()).toBe(false);
    expect(notifier.kinds()).toEqual(["frozen", "unfrozen"]);
    await store.freeze("again", 1);
    expect(store.state()).toMatchObject({ frozen: true, reason: "again", evidence: 1 });
  });
});

describe("notifiers", () => {
  it("logs notifications by level", async () => {
    const { log, lines } = captureLogger();
    const notifier = new LogNotifier(log);
    await notifier.notify({ kind: "merged", level: "info", title: "merged one", body: "b" });
    await notifier.notify({ kind: "frozen", level: "critical", title: "froze", body: "b" });
    expect(lines[0]).toContain('"level":30');
    expect(lines[1]).toContain('"level":40');
  });

  it("never throws from a failing notifier", async () => {
    const { log, lines } = captureLogger();
    const notifier = new RecordingNotifier();
    notifier.fail = true;
    await notifySafely(notifier, { kind: "parked", level: "warning", title: "t", body: "b" }, log);
    await notifySafely(notifier, { kind: "parked", level: "warning", title: "t", body: "b" });
    expect(lines.join("")).toContain("notification failed");
  });
});
