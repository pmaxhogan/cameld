import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logging.ts";
import { type Notifier, notifySafely } from "../service/notifier.ts";

/**
 * The global write freeze (rule "freeze on failure", ARCHITECTURE.md
 * section 5). Any failed check or failed live merge freezes ALL Strava
 * writes. The freeze is persisted, so a restart stays frozen. Backups keep
 * running; restore writes are the only exception and run before freezing.
 *
 * Callers check `isFrozen()` immediately before every single write, not
 * once per tick, because another group may freeze the service mid-tick.
 * `unfreeze()` is only reachable through an explicit settings action.
 */

export interface FreezeState {
  frozen: boolean;
  reason: string | null;
  evidence: unknown;
  frozenAt: number | null;
}

export class FreezeStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #notifier: Notifier;
  readonly #log: Logger | undefined;

  constructor(db: DatabaseSync, options: { notifier: Notifier; now?: () => number; log?: Logger }) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#notifier = options.notifier;
    this.#log = options.log;
  }

  state(): FreezeState {
    const row = this.#db
      .prepare("SELECT frozen, reason, evidence, frozen_at FROM freeze WHERE id = 1")
      .get() as
      | { frozen: number; reason: string | null; evidence: string | null; frozen_at: number | null }
      | undefined;
    if (row === undefined || row.frozen === 0) {
      return { frozen: false, reason: null, evidence: null, frozenAt: null };
    }
    return {
      frozen: true,
      reason: row.reason,
      evidence: JSON.parse(row.evidence as string) as unknown,
      frozenAt: row.frozen_at,
    };
  }

  isFrozen(): boolean {
    return this.state().frozen;
  }

  #event(action: string, reason: string, evidence: unknown): void {
    this.#db
      .prepare("INSERT INTO freeze_events (at, action, reason, evidence) VALUES (?, ?, ?, ?)")
      .run(this.#now(), action, reason, JSON.stringify(evidence ?? null));
  }

  /**
   * Freeze all Strava writes. If already frozen the first reason is kept and
   * the new failure is still recorded and notified.
   */
  async freeze(reason: string, evidence: unknown): Promise<void> {
    const already = this.isFrozen();
    if (!already) {
      this.#db
        .prepare(
          `INSERT INTO freeze (id, frozen, reason, evidence, frozen_at) VALUES (1, 1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET frozen = 1, reason = excluded.reason,
             evidence = excluded.evidence, frozen_at = excluded.frozen_at`,
        )
        .run(reason, JSON.stringify(evidence ?? null), this.#now());
    }
    this.#event(already ? "freeze_again" : "freeze", reason, evidence);
    this.#log?.error({ reason, alreadyFrozen: already }, "strava writes frozen");
    await notifySafely(
      this.#notifier,
      {
        kind: "frozen",
        level: "critical",
        title: "cameld froze all Strava writes",
        body: reason,
      },
      this.#log,
    );
  }

  /** The explicit owner action that lifts the freeze. */
  async unfreeze(note: string): Promise<boolean> {
    if (!this.isFrozen()) return false;
    this.#db.prepare("UPDATE freeze SET frozen = 0 WHERE id = 1").run();
    this.#event("unfreeze", note, null);
    this.#log?.warn({ note }, "strava writes unfrozen by the owner");
    await notifySafely(
      this.#notifier,
      { kind: "unfrozen", level: "info", title: "Strava writes unfrozen", body: note },
      this.#log,
    );
    return true;
  }

  events(): { at: number; action: string; reason: string; evidence: unknown }[] {
    const rows = this.#db
      .prepare("SELECT at, action, reason, evidence FROM freeze_events ORDER BY id")
      .all() as { at: number; action: string; reason: string; evidence: string }[];
    return rows.map((row) => ({ ...row, evidence: JSON.parse(row.evidence) as unknown }));
  }
}
