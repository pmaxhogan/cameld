import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logging.ts";
import { buildMerge, type MergeCheckError, type NoLossCheck } from "../state/build.ts";
import {
  candidateComponents,
  groupIdFor,
  poolBetween,
  SampleCache,
  summarizeMatch,
} from "../state/evaluate.ts";
import { isTransient, type MergeMachine } from "../state/machine.ts";
import { requireActivity, setActivityFields, upsertActivity } from "../state/repo.ts";
import { type BackfillMode, matchSettingsOf, type SettingsStore } from "../state/settings.ts";
import { StravaApiError, type StravaClient } from "../strava/client.ts";
import type { Clock } from "../strava/rate-limiter.ts";
import type { BackupService } from "./backup.ts";
import { BudgetExhaustedError, type ReadBudget } from "./budget.ts";
import type { BackfillProgress } from "./metrics.ts";

/**
 * Backfill (ARCHITECTURE.md section 6): walks the whole history newest to
 * oldest in daily batches inside its own read budget (service/budget.ts),
 * backing up every activity. Modes:
 *
 * - backup_only: back up, nothing else;
 * - dry_run: also score every candidate group and build its merge with the
 *   exact no-loss check, and REPORT it; nothing is written to Strava and no
 *   group enters the state machine;
 * - live: candidate groups are handed to the state machine, which applies
 *   every switch, the freeze and the deletion guard as usual.
 *
 * The cursor (start time of the oldest activity reached) is persisted after
 * every activity, so a crash resumes where it stopped.
 */

const DAY_MS = 24 * 3600 * 1000;

export interface BackfillOptions {
  db: DatabaseSync;
  api: Pick<StravaClient, "listActivities">;
  backup: BackupService;
  machine: MergeMachine;
  settings: SettingsStore;
  budget: ReadBudget;
  clock: Clock;
  /** Where the dry-run report JSON is written. */
  reportPath: string;
  log?: Logger;
  /** Injection point for tests; defaults to the real exact check. */
  noLossCheck?: NoLossCheck;
}

export interface BatchResult {
  mode: BackfillMode;
  stopped: "off" | "paused" | "budget" | "done" | "error" | "running";
  activities: number;
  groups: number;
  error: string | null;
}

export interface DryRunEntry {
  groupKey: string;
  startMs: number;
  decision: string;
  report: unknown;
}

/** Every dry-run report entry, newest first. Read-only; needs no Strava connection. */
export function dryRunEntries(db: DatabaseSync): DryRunEntry[] {
  const rows = db
    .prepare(
      "SELECT group_key, start_ms, decision, report FROM dry_run_report ORDER BY start_ms DESC",
    )
    .all() as { group_key: string; start_ms: number; decision: string; report: string }[];
  return rows.map((row) => ({
    groupKey: row.group_key,
    startMs: row.start_ms,
    decision: row.decision,
    report: JSON.parse(row.report) as unknown,
  }));
}

export class Backfill {
  readonly #o: BackfillOptions;
  readonly #log: Logger | undefined;
  #running = false;
  #last: (BatchResult & { finishedAt: number }) | null = null;

  constructor(options: BackfillOptions) {
    this.#o = options;
    this.#log = options.log?.child({ mod: "backfill" });
  }

  progress(): BackfillProgress {
    const row = this.#o.db
      .prepare("SELECT cursor_before, done, activities FROM backfill_state WHERE id = 1")
      .get() as { cursor_before: number | null; done: number; activities: number } | undefined;
    return {
      activities: row?.activities ?? 0,
      cursorMs: row?.cursor_before ?? null,
      done: row?.done === 1,
      readsToday: this.#o.budget.readsToday(),
    };
  }

  #save(cursorMs: number, done: boolean, added: number): void {
    this.#o.db
      .prepare(
        `INSERT INTO backfill_state (id, cursor_before, done, activities, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cursor_before = excluded.cursor_before,
           done = excluded.done, activities = activities + ?, updated_at = excluded.updated_at`,
      )
      .run(cursorMs, done ? 1 : 0, added, this.#o.clock.now(), added);
  }

  /** True while a batch is in progress. */
  running(): boolean {
    return this.#running;
  }

  /** The most recent finished batch since the process started. */
  lastBatch(): (BatchResult & { finishedAt: number }) | null {
    return this.#last;
  }

  /** Start over from the newest activity (for example after switching mode). */
  reset(): void {
    this.#o.db.prepare("DELETE FROM backfill_state").run();
  }

  /** Run one batch: as much history as today's budget allows. */
  async runBatch(): Promise<BatchResult> {
    const settings = this.#o.settings.get().backfill;
    const mode = settings.mode;
    const result: BatchResult = { mode, stopped: "off", activities: 0, groups: 0, error: null };
    if (mode === "off") return result;
    if (settings.paused) return { ...result, stopped: "paused" };
    if (this.#running) return { ...result, stopped: "running" };
    this.#running = true;
    const { db, api, backup, budget, clock } = this.#o;
    try {
      for (;;) {
        const progress = this.progress();
        if (progress.done) {
          result.stopped = "done";
          break;
        }
        const cursor = progress.cursorMs ?? clock.now() + DAY_MS;
        budget.beforeRead();
        const page = await api.listActivities({
          before: Math.ceil(cursor / 1000),
          per_page: settings.pageSize,
        });
        const fresh = page.filter((a) => Date.parse(a.start_date) < cursor);
        if (fresh.length === 0) {
          this.#save(cursor, true, 0);
          result.stopped = "done";
          break;
        }
        let oldest = cursor;
        let newest = 0;
        for (const activity of fresh) {
          if (this.#o.settings.get().backfill.paused) break;
          upsertActivity(db, activity, clock.now());
          try {
            await backup.backupActivity(activity.id, { gate: budget });
          } catch (error) {
            if (error instanceof StravaApiError && error.status === 404) {
              setActivityFields(db, activity.id, { gone_at: clock.now() });
            } else {
              throw error;
            }
          }
          const start = requireActivity(db, activity.id).startMs;
          oldest = Math.min(oldest, start);
          newest = Math.max(newest, start);
          this.#save(oldest, false, 1);
          result.activities += 1;
        }
        if (newest > 0) {
          result.groups += await this.#afterPage(mode, oldest - DAY_MS, newest + DAY_MS);
        }
        if (this.#o.settings.get().backfill.paused) {
          result.stopped = "paused";
          break;
        }
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        result.stopped = "budget";
      } else {
        result.stopped = "error";
        result.error = (error as Error).message;
        if (!isTransient(error)) this.#log?.error({ err: error }, "backfill batch failed");
      }
    } finally {
      this.#running = false;
    }
    if (mode === "dry_run") await this.writeReport();
    this.#log?.info({ ...result }, "backfill batch finished");
    this.#last = { ...result, finishedAt: clock.now() };
    return result;
  }

  async #afterPage(mode: BackfillMode, fromMs: number, toMs: number): Promise<number> {
    if (mode === "live") return this.#o.machine.detectGroups(fromMs, toMs).length;
    if (mode === "dry_run") return this.dryRun(fromMs, toMs);
    return 0;
  }

  /** Score and build every candidate group in the window; report, never write to Strava. */
  async dryRun(fromMs: number, toMs: number): Promise<number> {
    const { db, backup, clock } = this.#o;
    const settings = this.#o.settings.get();
    const match = matchSettingsOf(settings);
    const cache = new SampleCache(db, backup);
    let count = 0;
    for (const ids of candidateComponents(poolBetween(db, fromMs, toMs), match)) {
      const activities = ids.map((id) => requireActivity(db, id));
      const startMs = Math.min(...activities.map((a) => a.startMs));
      const members = activities.map((a) => ({
        id: a.id,
        source: a.source,
        sportType: a.sportType,
        startMs: a.startMs,
        endMs: a.endMs,
        original: a.originalStatus,
      }));
      let decision: string;
      let report: Record<string, unknown> = { members };
      if (activities.some((a) => a.originalStatus !== "present")) {
        decision = "needs_original";
      } else {
        const result = await cache.evaluate(ids, match);
        decision = result.decision;
        report = { ...report, match: summarizeMatch(result) };
        if (result.decision === "auto" && result.app !== null && result.fitbit !== null) {
          const app = await cache.concat(result.app.members.map((m) => Number(m.id)));
          const fitbit = await cache.concat(result.fitbit.members.map((m) => Number(m.id)));
          try {
            const built = buildMerge(
              {
                app,
                fitbit,
                offsetSeconds: result.metrics?.alignment?.offsetSeconds ?? 0,
                sport: activities[0]!.sportType,
                settings: settings.merge,
              },
              this.#o.noLossCheck,
            );
            report.noLoss = {
              ok: true,
              checkedValues: built.noLoss.checkedValues,
              ledgerEntries: built.ledger.length,
              points: built.samples.length,
              bytes: built.fit.byteLength,
            };
          } catch (error) {
            decision = "merge_check_failed";
            report.noLoss = {
              ok: false,
              error: (error as Error).message,
              evidence: (error as MergeCheckError).evidence,
            };
          }
        }
      }
      db.prepare(
        `INSERT INTO dry_run_report (group_key, start_ms, decision, report, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(group_key) DO UPDATE SET decision = excluded.decision,
           report = excluded.report, created_at = excluded.created_at`,
      ).run(groupIdFor(startMs, ids), startMs, decision, JSON.stringify(report), clock.now());
      count += 1;
    }
    return count;
  }

  report(): { generatedAt: number; progress: BackfillProgress; groups: DryRunEntry[] } {
    return {
      generatedAt: this.#o.clock.now(),
      progress: this.progress(),
      groups: dryRunEntries(this.#o.db),
    };
  }

  /** Write the dry-run report JSON atomically (temp file, then rename). */
  async writeReport(): Promise<string> {
    const path = this.#o.reportPath;
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.report(), null, 2)}\n`, "utf8");
    await rename(temp, path);
    return path;
  }
}
