import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import type { RateLimitUsage } from "../strava/rate-limiter.ts";

/**
 * Prometheus metrics (ARCHITECTURE.md section 8). Each instance owns its own
 * Registry so tests never collide on the global one. Values that live in
 * SQLite (parked pairs, backup totals, backfill progress, frozen) are read
 * at scrape time through MetricsSources rather than mirrored in memory.
 */

export type MergeOutcome =
  "merged" | "parked" | "review" | "failed" | "restored" | "restore_flagged" | "dissolved";

export interface BackfillProgress {
  activities: number;
  /** Epoch ms of the oldest activity reached, null before the first batch. */
  cursorMs: number | null;
  done: boolean;
  readsToday: number;
}

export interface MetricsSources {
  parkedByReason(): Record<string, number>;
  frozen(): boolean;
  rateUsage(): RateLimitUsage | null;
  backupTotals(): { bytes: number; files: number };
  backfill(): BackfillProgress;
  /** Original-file status counts (see repo.originalCounts). */
  originals?(): { present: number; pending: number; unavailable: number; backingOff: number };
}

export interface MetricsOptions {
  sources: MetricsSources;
  /** Process metrics (cpu, memory, event loop). Default true. */
  defaultMetrics?: boolean;
}

export class Metrics {
  readonly registry = new Registry();
  readonly merges: Counter<"outcome">;
  readonly lastPoll: Gauge;
  readonly webLoginHealthy: Gauge;
  readonly backups: Counter<"result">;
  readonly originalExports: Counter<"result">;

  constructor(options: MetricsOptions) {
    const { sources } = options;
    const registers = [this.registry];
    if (options.defaultMetrics ?? true) {
      collectDefaultMetrics({ register: this.registry, prefix: "cameld_" });
    }
    this.merges = new Counter({
      name: "cameld_merges_total",
      help: "Merge groups that reached an outcome",
      labelNames: ["outcome"],
      registers,
    });
    this.backups = new Counter({
      name: "cameld_activity_backups_total",
      help: "Activity backups by result",
      labelNames: ["result"],
      registers,
    });
    this.originalExports = new Counter({
      name: "cameld_original_exports_total",
      help: "Original-file export outcomes: present, unavailable, failed (backing off) or capped",
      labelNames: ["result"],
      registers,
    });
    new Gauge({
      name: "cameld_original_files",
      help: "Activities by original-file status (unavailable: Strava has none, never deleted)",
      labelNames: ["status"],
      registers,
      collect() {
        const counts = sources.originals?.();
        if (counts === undefined) return;
        this.set({ status: "present" }, counts.present);
        this.set({ status: "pending" }, counts.pending);
        this.set({ status: "unavailable" }, counts.unavailable);
        this.set({ status: "backing_off" }, counts.backingOff);
      },
    });
    this.lastPoll = new Gauge({
      name: "cameld_last_successful_poll_timestamp_seconds",
      help: "Unix time of the last poll that finished without error",
      registers,
    });
    this.webLoginHealthy = new Gauge({
      name: "cameld_web_login_healthy",
      help: "1 when the strava.com web session is logged in, else 0",
      registers,
    });
    new Gauge({
      name: "cameld_parked_pairs",
      help: "Merge groups currently parked, by reason",
      labelNames: ["reason"],
      registers,
      collect() {
        this.reset();
        for (const [reason, count] of Object.entries(sources.parkedByReason())) {
          this.set({ reason }, count);
        }
      },
    });
    new Gauge({
      name: "cameld_writes_frozen",
      help: "1 while all Strava writes are frozen",
      registers,
      collect() {
        this.set(sources.frozen() ? 1 : 0);
      },
    });
    const rate = (name: string, help: string, pick: "usage" | "limit"): void => {
      new Gauge({
        name,
        help,
        labelNames: ["bucket", "window"],
        registers,
        collect() {
          const usage = sources.rateUsage();
          if (usage === null) return;
          for (const bucket of ["overall", "read"] as const) {
            this.set({ bucket, window: "15m" }, usage[bucket].fifteenMinute[pick]);
            this.set({ bucket, window: "day" }, usage[bucket].day[pick]);
          }
        },
      });
    };
    rate("cameld_strava_rate_usage", "Strava API requests used in the current window", "usage");
    rate("cameld_strava_rate_limit", "Strava API request limit of the current window", "limit");
    new Gauge({
      name: "cameld_backup_bytes",
      help: "Bytes in recorded backup files",
      registers,
      collect() {
        this.set(sources.backupTotals().bytes);
      },
    });
    new Gauge({
      name: "cameld_backup_files",
      help: "Recorded backup files",
      registers,
      collect() {
        this.set(sources.backupTotals().files);
      },
    });
    new Gauge({
      name: "cameld_backfill_activities",
      help: "Activities the backfill has processed",
      registers,
      collect() {
        this.set(sources.backfill().activities);
      },
    });
    new Gauge({
      name: "cameld_backfill_cursor_timestamp_seconds",
      help: "Start time of the oldest activity the backfill has reached",
      registers,
      collect() {
        const cursor = sources.backfill().cursorMs;
        if (cursor !== null) this.set(cursor / 1000);
      },
    });
    new Gauge({
      name: "cameld_backfill_done",
      help: "1 once the backfill reached the oldest activity",
      registers,
      collect() {
        this.set(sources.backfill().done ? 1 : 0);
      },
    });
    new Gauge({
      name: "cameld_backfill_reads_today",
      help: "API reads the backfill spent today (UTC)",
      registers,
      collect() {
        this.set(sources.backfill().readsToday);
      },
    });
  }

  setLastPoll(epochMs: number): void {
    this.lastPoll.set(epochMs / 1000);
  }

  setWebLogin(healthy: boolean): void {
    this.webLoginHealthy.set(healthy ? 1 : 0);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
