import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logging.ts";
import type { MergeMachine } from "../state/machine.ts";
import { isTransient } from "../state/machine.ts";
import { setActivityFields, upsertActivity } from "../state/repo.ts";
import type { SettingsStore } from "../state/settings.ts";
import { StravaApiError, type StravaClient } from "../strava/client.ts";
import type { Clock, RateLimiter } from "../strava/rate-limiter.ts";
import type { BackupService } from "./backup.ts";
import type { Metrics } from "./metrics.ts";
import type { WebGate } from "./web-gate.ts";

/**
 * The poll loop (ARCHITECTURE.md section 8, "Trigger"): every poll interval
 * (default 10 minutes) list recent activities, back up every new one
 * incrementally, retry backups still missing their original file, detect
 * candidate groups and drive the state machine. A poll never overlaps the
 * previous one. A separate hourly keepalive keeps the web session alive.
 *
 * The list window looks back LOOKBACK_MS before the newest known start,
 * because a second copy of an outing can arrive days after the first.
 */

export const LOOKBACK_MS = 7 * 24 * 3600 * 1000;
/** Daily reads kept back from the poll's optional work (retrying old backups). */
export const READ_RESERVE = 50;
const RETRY_LIMIT = 20;

export interface PollerOptions {
  db: DatabaseSync;
  api: Pick<StravaClient, "listActivities">;
  backup: BackupService;
  machine: MergeMachine;
  web: WebGate;
  settings: SettingsStore;
  clock: Clock;
  limiter?: RateLimiter;
  metrics?: Metrics;
  log?: Logger;
}

export interface PollResult {
  skipped: boolean;
  listed: number;
  backedUp: number;
  groups: number;
  error: string | null;
}

export class Poller {
  readonly #o: PollerOptions;
  readonly #log: Logger | undefined;
  #running = false;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #stopped = true;

  constructor(options: PollerOptions) {
    this.#o = options;
    this.#log = options.log?.child({ mod: "poller" });
  }

  #readsLeftToday(): number {
    const usage = this.#o.limiter?.usage();
    if (usage === undefined) return Number.POSITIVE_INFINITY;
    return usage.read.day.limit - usage.read.day.usage;
  }

  async poll(): Promise<PollResult> {
    if (this.#running) return { skipped: true, listed: 0, backedUp: 0, groups: 0, error: null };
    this.#running = true;
    const { db, api, backup, machine, clock } = this.#o;
    let listed = 0;
    let backedUp = 0;
    let groups = 0;
    try {
      const now = clock.now();
      const newest = db.prepare("SELECT max(start_ms) AS m FROM activities").get() as {
        m: number | null;
      };
      const after = Math.floor(((newest.m ?? now) - LOOKBACK_MS) / 1000);
      const ids: number[] = [];
      for (let page = 1; ; page += 1) {
        const batch = await api.listActivities({ after, page, per_page: 100 });
        for (const activity of batch) {
          upsertActivity(db, activity, clock.now());
          ids.push(activity.id);
        }
        listed += batch.length;
        if (batch.length < 100) break;
      }
      // New activities get a full backup; known ones only what is still missing.
      const incomplete = db
        .prepare(
          `SELECT id FROM activities WHERE gone_at IS NULL AND is_merge_output = 0
           AND (backed_up_at IS NULL OR original_status = 'pending' OR web_form_saved = 0)
           ORDER BY start_ms DESC`,
        )
        .all() as { id: number }[];
      const listedIds = new Set(ids);
      let retries = 0;
      for (const { id } of incomplete) {
        const isListed = listedIds.has(id);
        if (!isListed) {
          if (retries >= RETRY_LIMIT || this.#readsLeftToday() < READ_RESERVE) continue;
          retries += 1;
        }
        try {
          await backup.backupActivity(id);
          backedUp += 1;
        } catch (error) {
          if (error instanceof StravaApiError && error.status === 404) {
            // Deleted on Strava outside cameld: its backup (if any) stays.
            setActivityFields(db, id, { gone_at: clock.now() });
            continue;
          }
          this.#o.metrics?.backups.inc({ result: "error" });
          if (isTransient(error)) throw error;
          this.#log?.error({ err: error, activityId: id }, "activity backup failed");
        }
      }
      groups = machine.detectGroups(clock.now() - 2 * LOOKBACK_MS, clock.now()).length;
      machine.markSingles();
      await machine.tick();
      this.#o.metrics?.setLastPoll(clock.now());
      return { skipped: false, listed, backedUp, groups, error: null };
    } catch (error) {
      this.#log?.error({ err: error }, "poll failed");
      return {
        skipped: false,
        listed,
        backedUp,
        groups,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.#running = false;
    }
  }

  /** Start the poll loop and the web keepalive. Intervals come from the settings. */
  start(): void {
    this.#stopped = false;
    const loop = (name: string, job: () => Promise<unknown>, interval: () => number): void => {
      const timer = setTimeout(() => {
        void job()
          .catch((error: unknown) =>
            this.#log?.error({ err: error, job: name }, "scheduled job failed"),
          )
          .finally(() => {
            if (!this.#stopped) loop(name, job, interval);
          });
      }, interval());
      this.#timers.set(name, timer);
    };
    const timing = () => this.#o.settings.get().timing;
    void this.poll();
    loop(
      "poll",
      () => this.poll(),
      () => timing().pollIntervalMs,
    );
    loop(
      "keepalive",
      () => this.#o.web.keepAlive(),
      () => timing().keepaliveIntervalMs,
    );
  }

  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}
