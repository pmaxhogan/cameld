import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { migrate, openDatabase } from "../src/db.ts";
import { Backfill } from "../src/service/backfill.ts";
import { BackupService } from "../src/service/backup.ts";
import { ReadBudget } from "../src/service/budget.ts";
import { Metrics } from "../src/service/metrics.ts";
import { Poller } from "../src/service/poller.ts";
import { WebGate } from "../src/service/web-gate.ts";
import { FreezeStore } from "../src/state/freeze.ts";
import { MergeMachine, type MachineOptions } from "../src/state/machine.ts";
import { parkedByReason } from "../src/state/repo.ts";
import { type SettingsPatch, SettingsStore } from "../src/state/settings.ts";
import { StravaClient } from "../src/strava/client.ts";
import { type Clock, RateLimiter } from "../src/strava/rate-limiter.ts";
import type { StravaWebSession } from "../src/web/session.ts";
import { type FakeStravaApi, startFakeStravaApi } from "./fake-strava-api/server.ts";
import { FakeWebSession } from "./fake-strava-api/web-session.ts";
import { FakeWorld } from "./fake-strava-api/world.ts";
import { FakeSnapshotter, RecordingNotifier } from "./state-helpers.ts";
import { fakeClock } from "./strava-helpers.ts";

/**
 * Wires the real state machine, backup service, poller and backfill to the
 * fake Strava API (over HTTP) and an in-memory fake web session. The
 * database is a file so `restart()` can reopen it like a new process.
 */

/** Decides, per request, whether to lose the response after the server handled it. */
export type Fault = (method: string, url: URL) => "lose_response" | "fail_before_send" | null;

export interface Harness {
  world: FakeWorld;
  api: FakeStravaApi;
  clock: ReturnType<typeof fakeClock>;
  dir: string;
  db: DatabaseSync;
  session: FakeWebSession;
  web: WebGate;
  notifier: RecordingNotifier;
  snapshotter: FakeSnapshotter;
  settings: SettingsStore;
  freeze: FreezeStore;
  client: StravaClient;
  backup: BackupService;
  machine: MergeMachine;
  poller: Poller;
  backfill: Backfill;
  budget: ReadBudget;
  metrics: Metrics;
  fault: Fault | null;
  /** Close the database and rebuild every service over it, as after a crash. */
  restart(extra?: Partial<MachineOptions>): void;
  close(): Promise<void>;
}

export interface HarnessOptions {
  settings?: SettingsPatch;
  machine?: Partial<MachineOptions>;
  /** Replace the fake web session (null = no browser configured). */
  session?: StravaWebSession | null;
  /** Build the web session from the harness clock (e.g. a real WebSession). */
  webSession?: (clock: Clock) => StravaWebSession;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const world = new FakeWorld();
  const api = await startFakeStravaApi(world);
  const clock = fakeClock("2020-02-02T12:00:00Z");
  const dir = mkdtempSync(join(tmpdir(), "cameld-machine-"));
  const notifier = new RecordingNotifier();
  const snapshotter = new FakeSnapshotter();
  const session = new FakeWebSession(world, () => clock.now());
  const h = { world, api, clock, dir, notifier, snapshotter, session, fault: null } as Harness;

  const faultyFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const fault = h.fault?.(init?.method ?? "GET", url) ?? null;
    if (fault === "fail_before_send") throw new TypeError("fetch failed");
    const response = await fetch(input, init);
    if (fault === "lose_response") {
      await response.body?.cancel();
      throw new TypeError("fetch failed");
    }
    return response;
  };

  const build = (extra: Partial<MachineOptions> = {}): void => {
    const db = openDatabase(join(dir, "cameld.db"));
    migrate(db);
    const settings = new SettingsStore(db, { now: () => clock.now() });
    const freeze = new FreezeStore(db, { notifier, now: () => clock.now() });
    const limiter = new RateLimiter({ clock, safetyMargin: 0 });
    const budget = new ReadBudget(
      db,
      () => settings.get().backfill,
      () => clock.now(),
    );
    const ref: { backup?: BackupService; backfill?: Backfill } = {};
    const metrics = new Metrics({
      defaultMetrics: false,
      sources: {
        parkedByReason: () => parkedByReason(db),
        frozen: () => freeze.isFrozen(),
        rateUsage: () => limiter.usage(),
        backupTotals: () => ref.backup?.totals() ?? { bytes: 0, files: 0 },
        backfill: () =>
          ref.backfill?.progress() ?? { activities: 0, cursorMs: null, done: false, readsToday: 0 },
      },
    });
    const web = new WebGate({
      session:
        options.webSession?.(clock) ?? (options.session === undefined ? session : options.session),
      notifier,
      metrics,
      now: () => clock.now(),
    });
    const client = new StravaClient({
      tokens: { getAccessToken: () => Promise.resolve("synthetic-token") },
      limiter,
      fetch: faultyFetch as typeof fetch,
      baseUrl: api.apiBase,
      clock,
    });
    const backup = new BackupService({
      db,
      api: client,
      web,
      root: join(dir, "backup"),
      now: () => clock.now(),
      metrics,
      fetchPhoto: async (url) => {
        const response = await faultyFetch(url);
        return {
          bytes: new Uint8Array(await response.arrayBuffer()),
          contentType: response.headers.get("content-type") ?? "image/png",
        };
      },
    });
    const machine = new MergeMachine({
      db,
      api: client,
      web,
      backup,
      snapshotter,
      notifier,
      freeze,
      settings,
      clock,
      metrics,
      uploadPoll: { intervalMs: 1000, timeoutMs: 10_000 },
      ...options.machine,
      ...extra,
    });
    const backfill = new Backfill({
      db,
      api: client,
      backup,
      machine,
      settings,
      budget,
      clock,
      reportPath: join(dir, "reports", "dry-run.json"),
    });
    ref.backup = backup;
    ref.backfill = backfill;
    const poller = new Poller({
      db,
      api: client,
      backup,
      machine,
      web,
      settings,
      clock,
      limiter,
      metrics,
    });
    Object.assign(h, {
      db,
      settings,
      freeze,
      client,
      backup,
      machine,
      poller,
      backfill,
      budget,
      metrics,
      web,
    });
  };

  build();
  if (options.settings !== undefined) h.settings.update(options.settings);
  h.restart = (extra) => {
    h.db.close();
    build(extra);
  };
  let closed = false;
  h.close = async () => {
    if (closed) return;
    closed = true;
    h.db.close();
    await api.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may hold a file briefly; the OS temp dir cleans up.
    }
  };
  return h;
}

/** Uploads the fake world received with this external id. */
export function uploadCount(h: Harness, externalId: string): number {
  return h.world.uploadsWithExternalId(externalId).length;
}
