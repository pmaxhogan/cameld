import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DELETE_CONFIRM_PHRASE } from "@cameld/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { Gate } from "../src/auth/gate.ts";
import { migrate, openDatabase } from "../src/db.ts";
import { createLogger } from "../src/logging.ts";
import type { Backfill } from "../src/service/backfill.ts";
import { ReadBudget } from "../src/service/budget.ts";
import { PushService } from "../src/service/push.ts";
import { WebGate } from "../src/service/web-gate.ts";
import { FreezeStore } from "../src/state/freeze.ts";
import { type MergeMachine, NotRestorableError } from "../src/state/machine.ts";
import {
  appendEvent,
  beginWrite,
  insertGroup,
  patchGroup,
  upsertActivity,
} from "../src/state/repo.ts";
import { SettingsStore } from "../src/state/settings.ts";
import { RateLimiter } from "../src/strava/rate-limiter.ts";
import { type UiDeps, registerUiRoutes } from "../src/ui/routes.ts";
import { RecordingNotifier } from "./state-helpers.ts";

/** Synthetic owner, ids and timestamps only. */
const OWNER = "owner@example.com";
const T0 = Date.UTC(2020, 1, 2, 2, 2, 2);
const log = createLogger({ logLevel: "silent" });
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const gate: Gate = {
  identify: () => Promise.resolve(OWNER),
  hasSession: () => true,
  login: () => Promise.resolve({ ok: false, reason: "unconfigured" }),
  logoutCookie: () => "x",
};
const H = { "x-requested-with": "cameld", "content-type": "application/json" };

function activity(id: number, source: "app" | "fitbit") {
  return {
    id,
    name: source === "app" ? "Synthetic Run" : "Synthetic Wrist Run",
    sport_type: "Run",
    start_date: new Date(T0).toISOString(),
    elapsed_time: 600,
    device_name: source === "app" ? "Strava App" : "Fitbit Charge",
    external_id: `synthetic-${String(id)}`,
  };
}

function seed(db: DatabaseSync): void {
  upsertActivity(db, activity(101, "app") as never, T0);
  upsertActivity(db, activity(102, "fitbit") as never, T0);
  upsertActivity(db, activity(201, "app") as never, T0);
  upsertActivity(db, activity(202, "fitbit") as never, T0);
  insertGroup(
    db,
    {
      id: "g-review",
      appIds: [101],
      fitbitIds: [102],
      startMs: T0,
    },
    T0,
  );
  patchGroup(db, "g-review", { status: "review", match: { appIds: [101], metrics: null } }, T0);
  insertGroup(
    db,
    {
      id: "g-done",
      appIds: [201],
      fitbitIds: [202],
      startMs: T0 + 86_400_000,
    },
    T0,
  );
  patchGroup(db, "g-done", { status: "done", mergedActivityId: 999, hiddenAt: T0 }, T0);
  appendEvent(db, "g-done", T0, "hidden", "done", "confirmed", { gone: [201, 202] });
  beginWrite(db, { groupId: "g-done", kind: "delete", targetId: 201 }, T0);
}

interface Setup {
  app: FastifyInstance;
  db: DatabaseSync;
  settings: SettingsStore;
  freeze: FreezeStore;
  restores: string[];
  batches: number;
  backfillResets: number;
}

async function setup(
  overrides: Partial<UiDeps> = {},
  options: { strava?: boolean } = {},
): Promise<Setup> {
  const db = openDatabase(":memory:");
  migrate(db);
  seed(db);
  const notifier = new RecordingNotifier();
  const settings = new SettingsStore(db);
  const freeze = new FreezeStore(db, { notifier });
  const state = { restores: [] as string[], batches: 0, backfillResets: 0 };
  const strava = options.strava ?? true;
  const machine = {
    restoreGroup: (id: string, reason: string) => {
      state.restores.push(reason);
      if (id === "g-review") return Promise.reject(new NotRestorableError("not restorable"));
      if (id === "g-boom") return Promise.reject(new Error("synthetic crash"));
      return Promise.resolve({
        groupId: id,
        status: "restored",
        restored: [],
        unhidden: [201],
        flags: [],
      });
    },
  } as unknown as MergeMachine;
  const backfill = {
    progress: () => ({ activities: 3, cursorMs: T0, done: false, readsToday: 4 }),
    running: () => false,
    lastBatch: () => null,
    reset: () => {
      state.backfillResets += 1;
    },
    report: () => ({
      generatedAt: T0,
      progress: { activities: 3, cursorMs: T0, done: false, readsToday: 4 },
      groups: [],
    }),
  } as unknown as Backfill;
  const deps: UiDeps = {
    db,
    version: "9.9.9",
    mapStyleUrl: null,
    backupRoot: mkdtempSync(join(tmpdir(), "cameld-ui-")),
    settings,
    freeze,
    web: new WebGate({ session: null, notifier }),
    push: new PushService({
      db,
      vapid: { publicKey: "BSynthetic", privateKey: "p", subject: "mailto:owner@example.com" },
      send: () => Promise.resolve({ statusCode: 201 }),
    }),
    budget: new ReadBudget(db, () => settings.get().backfill),
    limiter: new RateLimiter(),
    machine: strava ? machine : null,
    backfill: strava ? backfill : null,
    runBackfill: strava
      ? () => {
          state.batches += 1;
        }
      : undefined,
    browserAvailable: true,
    polling: () => strava,
    now: () => T0,
    log,
    ...overrides,
  };
  const app = await buildApp({
    config: {
      version: "9.9.9",
      webDistDir: join(tmpdir(), "none"),
      publicUrl: "https://cameld.example.com",
    },
    log,
    gate,
    api: (api) => registerUiRoutes(api, deps),
  });
  apps.push(app);
  return {
    app,
    db,
    settings,
    freeze,
    get restores() {
      return state.restores;
    },
    get batches() {
      return state.batches;
    },
    get backfillResets() {
      return state.backfillResets;
    },
  };
}

function auditRows(db: DatabaseSync) {
  return db.prepare("SELECT actor, action, target, outcome FROM audit_log ORDER BY id").all();
}

describe("read routes", () => {
  it("serves status, settings, review, groups, details, backfill and the audit log", async () => {
    const { app } = await setup();
    const status = (await app.inject({ url: "/api/status" })).json();
    expect(status).toMatchObject({
      version: "9.9.9",
      identity: OWNER,
      frozen: { frozen: false },
      web: { healthy: false, reason: "no_browser" },
      browserAvailable: true,
      stravaConfigured: true,
      polling: true,
      counts: { review: 1, done: 1 },
      trial: { enabled: false, maxPairs: 3, used: 0 },
      push: { configured: true, publicKey: "BSynthetic", subscriptions: 0 },
      map: { styleUrl: null },
      backfill: { mode: "off", available: true, progress: { activities: 3 } },
    });
    expect(status.rate.read.day.limit).toBeGreaterThan(0);
    expect((await app.inject({ url: "/api/settings" })).json().switches.delete).toBe(false);
    const review = (await app.inject({ url: "/api/review" })).json();
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ id: "g-review", name: "Synthetic Run", sportType: "Run" });
    const groups = (await app.inject({ url: "/api/groups" })).json();
    expect(groups.map((g: { id: string }) => g.id)).toEqual(["g-done", "g-review"]);
    const done = (await app.inject({ url: "/api/groups?status=done,bogus&limit=1" })).json();
    expect(done.map((g: { id: string }) => g.id)).toEqual(["g-done"]);
    const detail = (await app.inject({ url: "/api/groups/g-done" })).json();
    expect(detail.restorable).toBe(true);
    expect(detail.members.map((m: { id: number }) => m.id)).toEqual([201, 202]);
    expect(detail.events.at(-1).event).toBe("confirmed");
    expect(detail.writes[0]).toMatchObject({
      kind: "delete",
      targetId: 201,
      externalId: null,
      status: "intent",
    });
    expect(detail.mergeBuilt).toBe(false);
    expect((await app.inject({ url: "/api/groups/nope" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/groups/nope/tracks" })).statusCode).toBe(404);
    const tracks = (await app.inject({ url: "/api/groups/g-review/tracks" })).json();
    expect(tracks.notes.length).toBeGreaterThan(0);
    expect((await app.inject({ url: "/api/backfill" })).json().budget).toEqual({
      dailyReads: 600,
      fifteenMinuteReads: 70,
      dailyUsed: 0,
      fifteenMinuteUsed: 0,
      remaining: 70,
      limitedBy: "fifteen_minute",
    });
    expect((await app.inject({ url: "/api/backfill/report" })).json().generatedAt).toBe(T0);
    expect((await app.inject({ url: "/api/audit?limit=5" })).json()).toEqual([]);
  });

  it("shows a member that is missing from the activity table as absent", async () => {
    const { app, db } = await setup();
    db.prepare("DELETE FROM activities WHERE id = 202").run();
    const detail = (await app.inject({ url: "/api/groups/g-done" })).json();
    expect(detail.members.map((m: { id: number }) => m.id)).toEqual([201]);
  });

  it("says when the merge is built and names an upload's external_id", async () => {
    const { app, db } = await setup();
    patchGroup(db, "g-done", { mergedPath: "merges/g-done/merged.fit" }, T0);
    beginWrite(
      db,
      { groupId: "g-done", kind: "upload", targetId: null, externalId: "cameld-merge-x" },
      T0,
    );
    const detail = (await app.inject({ url: "/api/groups/g-done" })).json();
    expect(detail.mergeBuilt).toBe(true);
    expect(detail.writes.at(-1)).toMatchObject({
      kind: "upload",
      targetId: null,
      externalId: "cameld-merge-x",
    });
  });

  it("works without Strava: no machine, no backfill", async () => {
    const { app } = await setup({ limiter: undefined }, { strava: false });
    const status = (await app.inject({ url: "/api/status" })).json();
    expect(status.stravaConfigured).toBe(false);
    expect(status.rate).toBeNull();
    expect(status.backfill).toMatchObject({
      available: false,
      running: false,
      progress: { activities: 0 },
    });
    expect((await app.inject({ url: "/api/backfill/report" })).json().groups).toEqual([]);
  });
});

describe("write routes", () => {
  it("updates settings, requiring the phrase to enable deletion or the trial", async () => {
    const { app, db } = await setup();
    const patch = (body: unknown) =>
      app.inject({
        method: "PATCH",
        url: "/api/settings",
        headers: H,
        payload: JSON.stringify(body),
      });
    expect(
      (await patch({ patch: { timing: { gracePeriodMs: 7_200_000 } } })).json().timing
        .gracePeriodMs,
    ).toBe(7_200_000);
    const refused = await patch({ patch: { switches: { delete: true } } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("confirm_required");
    expect((await patch({ patch: { trial: { enabled: true } }, confirm: "nope" })).statusCode).toBe(
      409,
    );
    const on = await patch({
      patch: { switches: { delete: true } },
      confirm: DELETE_CONFIRM_PHRASE,
    });
    expect(on.json().switches.delete).toBe(true);
    // Already on: no phrase needed to keep it, nor to turn it off.
    expect((await patch({ patch: { switches: { delete: true } } })).statusCode).toBe(200);
    expect((await patch({ patch: { switches: { delete: false } } })).json().switches.delete).toBe(
      false,
    );
    const invalid = await patch({ patch: { timing: { gracePeriodMs: -1 } } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_settings");
    expect((await patch({ nope: 1 })).json().error).toBe("invalid_request");
    expect(auditRows(db).map((r) => `${String(r.action)}:${String(r.outcome)}`)).toEqual([
      "settings.update:ok",
      "settings.update:refused",
      "settings.update:refused",
      "settings.update:ok",
      "settings.update:ok",
      "settings.update:ok",
      "settings.update:refused",
      "settings.update:refused",
    ]);
    expect((await app.inject({ url: "/api/audit" })).json()[0]).toMatchObject({
      actor: OWNER,
      outcome: "refused",
    });
  });

  it("unfreezes with a reason only when frozen", async () => {
    const { app, freeze } = await setup();
    const post = (body: unknown) =>
      app.inject({
        method: "POST",
        url: "/api/freeze/unfreeze",
        headers: H,
        payload: JSON.stringify(body),
      });
    expect((await post({ reason: "fixed it" })).statusCode).toBe(409);
    await freeze.freeze("synthetic failure", null);
    expect((await post({ reason: "x" })).statusCode).toBe(400);
    const ok = await post({ reason: "checked the evidence" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().frozen).toBe(false);
    expect(freeze.events().at(-1)?.reason).toBe(`checked the evidence (by ${OWNER})`);
  });

  it("approves and rejects review groups with a note", async () => {
    const { app, db } = await setup();
    const decide = (id: string, body: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/review/${id}`,
        headers: H,
        payload: JSON.stringify(body),
      });
    expect((await decide("nope", { decision: "approve", note: "" })).statusCode).toBe(404);
    expect((await decide("g-review", { decision: "maybe", note: "" })).statusCode).toBe(400);
    const approved = await decide("g-review", {
      decision: "approve",
      note: "looks right",
      offsetSeconds: 4,
    });
    expect(approved.json().status).toBe("scored");
    expect((await decide("g-review", { decision: "reject", note: "" })).statusCode).toBe(409);
    patchGroup(db, "g-review", { status: "review" }, T0);
    expect((await decide("g-review", { decision: "reject", note: "" })).json().status).toBe(
      "dissolved",
    );
    patchGroup(db, "g-review", { status: "review" }, T0);
    expect(
      (await decide("g-review", { decision: "reject", note: "different outings" })).statusCode,
    ).toBe(200);
    patchGroup(db, "g-review", { status: "review" }, T0);
    expect((await decide("g-review", { decision: "approve", note: "" })).statusCode).toBe(200);
    const events = db
      .prepare(
        "SELECT event, evidence FROM group_events WHERE group_id = 'g-review' AND event LIKE 'review_%' ORDER BY id",
      )
      .all()
      .map((e) => `${String(e.event)} ${String(e.evidence)}`);
    expect(events).toEqual([
      'review_approved {"offsetSeconds":4,"note":"looks right"}',
      "review_rejected null",
      'review_rejected {"note":"different outings"}',
      'review_approved {"offsetSeconds":0}',
    ]);
    expect(auditRows(db).at(0)).toMatchObject({
      action: "review.decide",
      target: "nope",
      outcome: "refused",
    });
  });

  it("restores through the machine, or says why it cannot", async () => {
    const s = await setup();
    const restore = (id: string, body: unknown = { reason: "synthetic restore" }) =>
      s.app.inject({
        method: "POST",
        url: `/api/groups/${id}/restore`,
        headers: H,
        payload: JSON.stringify(body),
      });
    expect((await restore("g-done")).json()).toMatchObject({ status: "restored", unhidden: [201] });
    expect(s.restores).toEqual([`synthetic restore (by ${OWNER})`]);
    expect((await restore("g-review")).json().error).toBe("not_restorable");
    expect((await restore("nope")).statusCode).toBe(404);
    expect((await restore("g-done", { reason: "" })).statusCode).toBe(400);
    insertGroup(s.db, { id: "g-boom", appIds: [201], fitbitIds: [202], startMs: T0 }, T0);
    const boom = await restore("g-boom");
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: "internal_error" });
    expect(auditRows(s.db).at(-1)).toMatchObject({ action: "group.restore", outcome: "failed" });

    const offline = await setup({}, { strava: false });
    const res = await offline.app.inject({
      method: "POST",
      url: "/api/groups/g-done/restore",
      headers: H,
      payload: JSON.stringify({ reason: "synthetic restore" }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("strava_unavailable");
  });

  it("controls the backfill: mode, budget, start, pause, resume and reset", async () => {
    const s = await setup();
    const control = (action: string) =>
      s.app.inject({
        method: "POST",
        url: "/api/backfill/control",
        headers: H,
        payload: JSON.stringify({ action }),
      });
    const update = (body: unknown) =>
      s.app.inject({
        method: "PATCH",
        url: "/api/backfill",
        headers: H,
        payload: JSON.stringify(body),
      });
    expect((await control("start")).json().error).toBe("backfill_off");
    const updated = await update({
      mode: "dry_run",
      dailyReads: 500,
      fifteenMinuteReads: 50,
      confirm: "",
    });
    expect(updated.json()).toMatchObject({
      mode: "dry_run",
      budget: { dailyReads: 500, fifteenMinuteReads: 50 },
    });
    expect((await update({ mode: "sideways" })).statusCode).toBe(400);
    expect((await control("pause")).json().paused).toBe(true);
    expect((await control("resume")).json().paused).toBe(false);
    await control("pause");
    expect((await control("start")).json().paused).toBe(false);
    expect(s.batches).toBe(1);
    await control("reset");
    expect(s.backfillResets).toBe(1);
    expect((await control("explode")).statusCode).toBe(400);

    const offline = await setup({}, { strava: false });
    for (const action of ["start", "reset"]) {
      const res = await offline.app.inject({
        method: "POST",
        url: "/api/backfill/control",
        headers: H,
        payload: JSON.stringify({ action }),
      });
      expect(res.statusCode).toBe(503);
    }
  });

  it("manages push subscriptions and sends a test push", async () => {
    const { app, db } = await setup();
    const post = (url: string, body?: unknown) =>
      app.inject({
        method: "POST",
        url,
        headers: { ...H, "user-agent": "Synthetic UA" },
        payload: JSON.stringify(body ?? {}),
      });
    const subscription = {
      endpoint: "https://push.example.com/send/abc",
      keys: { p256dh: "BSyntheticKey", auth: "c3ludGg" },
    };
    expect((await post("/api/push/subscribe", { endpoint: "nope" })).statusCode).toBe(400);
    expect((await post("/api/push/subscribe", subscription)).json()).toEqual({ ok: true });
    expect((await post("/api/push/test")).json()).toMatchObject({ total: 1, sent: 1 });
    expect(
      (await post("/api/push/unsubscribe", { endpoint: subscription.endpoint })).json(),
    ).toEqual({ removed: true });
    expect((await post("/api/push/unsubscribe", {})).statusCode).toBe(400);
    const rows = db
      .prepare(
        "SELECT action, target, details FROM audit_log WHERE action LIKE 'push.%' ORDER BY id",
      )
      .all();
    expect(JSON.stringify(rows)).not.toContain("push.example.com");

    const off = await setup({
      push: new PushService({ db: openDatabase(":memory:"), vapid: null }),
    });
    for (const url of ["/api/push/subscribe", "/api/push/test"]) {
      const res = await off.app.inject({
        method: "POST",
        url,
        headers: H,
        payload: JSON.stringify(subscription),
      });
      expect(res.statusCode).toBe(412);
    }
  });

  it("re-checks the web login", async () => {
    const { app, db } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/web/check",
      headers: H,
      payload: "{}",
    });
    expect(res.json()).toEqual({ healthy: false, reason: "no_browser" });
    expect(auditRows(db).at(-1)).toMatchObject({ action: "web.check", outcome: "ok" });
  });

  it("works with no logger and lists a group with no members", async () => {
    const { app, db } = await setup({ log: undefined, now: undefined });
    insertGroup(db, { id: "x", appIds: [], fitbitIds: [], startMs: T0 }, T0);
    const groups = (await app.inject({ url: "/api/groups" })).json();
    expect(groups.find((g: { id: string }) => g.id === "x")).toMatchObject({
      name: null,
      sportType: null,
    });
  });
});
