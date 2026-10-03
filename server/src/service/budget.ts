import type { DatabaseSync } from "node:sqlite";

/**
 * The backfill's own read budget, on top of the RateLimiter's view of
 * Strava's limits. Another consumer shares the same Strava app, so the
 * backfill spends at most `dailyReads` per UTC day and `fifteenMinuteReads`
 * per 15-minute window (defaults 600 and 70 of Strava's 1000 and 100).
 * Counters are persisted so a crash loop cannot burn the other consumer's
 * headroom.
 */

export class BudgetExhaustedError extends Error {
  override readonly name = "BudgetExhaustedError";
}

/** Called before every API read made on behalf of a budgeted job. */
export interface ReadGate {
  beforeRead(): void;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

export function dayKey(nowMs: number): string {
  return `day:${new Date(nowMs).toISOString().slice(0, 10)}`;
}

export function windowKey(nowMs: number): string {
  return `15m:${Math.floor(nowMs / FIFTEEN_MIN_MS)}`;
}

export class ReadBudget implements ReadGate {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #limits: () => { dailyReads: number; fifteenMinuteReads: number };

  constructor(
    db: DatabaseSync,
    limits: () => { dailyReads: number; fifteenMinuteReads: number },
    now: () => number = Date.now,
  ) {
    this.#db = db;
    this.#limits = limits;
    this.#now = now;
  }

  #reads(key: string): number {
    const row = this.#db
      .prepare("SELECT reads FROM backfill_budget WHERE window_key = ?")
      .get(key) as { reads: number } | undefined;
    return row?.reads ?? 0;
  }

  readsToday(): number {
    return this.#reads(dayKey(this.#now()));
  }

  /** Reads still allowed now (the smaller of the two windows). */
  remaining(): number {
    const now = this.#now();
    const limits = this.#limits();
    return Math.max(
      0,
      Math.min(
        limits.dailyReads - this.#reads(dayKey(now)),
        limits.fifteenMinuteReads - this.#reads(windowKey(now)),
      ),
    );
  }

  /** Spend one read, or throw BudgetExhaustedError without spending. */
  beforeRead(): void {
    if (this.remaining() <= 0) throw new BudgetExhaustedError("backfill read budget exhausted");
    const now = this.#now();
    const bump = this.#db.prepare(
      `INSERT INTO backfill_budget (window_key, reads) VALUES (?, 1)
       ON CONFLICT(window_key) DO UPDATE SET reads = reads + 1`,
    );
    const window = windowKey(now);
    this.#db
      .prepare("DELETE FROM backfill_budget WHERE window_key LIKE '15m:%' AND window_key <> ?")
      .run(window);
    bump.run(dayKey(now));
    bump.run(window);
  }
}
