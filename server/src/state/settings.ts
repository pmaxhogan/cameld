import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_MATCH_SETTINGS,
  DEFAULT_MERGE_SETTINGS,
  type MatchSettings,
  type MergeSettings,
} from "@cameld/shared";
import { z } from "zod";
import type { Logger } from "../logging.ts";

/**
 * Owner settings, stored in the `settings` table as one JSON value per
 * section. Every field has a typed default; a stored section that no longer
 * validates falls back to the defaults (which are the safe values: deletion
 * OFF, trial OFF, backfill OFF) and is logged.
 *
 * Switches: upload and hide default ON, delete OFF. No Strava write happens
 * while writes are frozen whatever the switches say (state/freeze.ts).
 *
 * There is deliberately no HTTP route that writes settings yet: the server
 * has no authentication until the UI wave, and an open route could turn
 * deletion on. The UI will call `update()` behind auth.
 */

const HOUR = 60 * 60 * 1000;

/** Hard cap on trial pairs (ARCHITECTURE.md section 6: a trial of three pairs). */
export const MAX_TRIAL_PAIRS = 3;

const positive = z.number().int().positive();
const fraction = z.number().gt(0).lte(1);

const timingSchema = z
  .object({
    pollIntervalMs: positive.min(60_000),
    keepaliveIntervalMs: positive.min(60_000),
    partnerWaitMs: z.number().int().min(0),
    gracePeriodMs: z.number().int().min(0),
  })
  .strict();

const alignmentSchema = z
  .object({
    searchRangeSeconds: positive,
    stepSeconds: positive,
    sharpnessDeltaSeconds: positive,
    sharpnessRatio: z.number().positive(),
    maxResidualMeters: z.number().positive(),
    maxAutoOffsetSeconds: z.number().min(0),
    minAlignedPoints: positive,
  })
  .strict();

const matchSchema = z
  .object({
    autoMinOverlap: fraction,
    maxStartDeltaSeconds: z.number().min(0),
    gpsAutoMaxMedianMeters: z.number().positive(),
    gpsReviewMaxMedianMeters: z.number().positive(),
    alignment: alignmentSchema,
  })
  .strict()
  .refine((m) => m.gpsAutoMaxMedianMeters <= m.gpsReviewMaxMedianMeters, {
    message: "gpsAutoMaxMedianMeters must not exceed gpsReviewMaxMedianMeters",
  });

const mergeSchema = z
  .object({
    speedLimitsMps: z
      .object({
        walk: z.number().positive(),
        hike: z.number().positive(),
        run: z.number().positive(),
        ride: z.number().positive(),
      })
      .strict(),
    defaultSpeedLimitMps: z.number().positive().nullable(),
    speedSlackMeters: z.number().min(0),
    reanchorAfter: positive,
  })
  .strict();

const postUploadSchema = z
  .object({
    /** Point count, distance and elapsed time must be within this fraction. */
    tolerance: fraction,
    /** Largest start time difference accepted, seconds. */
    startToleranceSeconds: z.number().min(0),
  })
  .strict();

const switchesSchema = z
  .object({ hide: z.boolean(), delete: z.boolean(), upload: z.boolean() })
  .strict();

const trialSchema = z
  .object({ enabled: z.boolean(), maxPairs: z.number().int().min(0).max(MAX_TRIAL_PAIRS) })
  .strict();

export const BACKFILL_MODES = ["off", "backup_only", "dry_run", "live"] as const;
export type BackfillMode = (typeof BACKFILL_MODES)[number];

const backfillSchema = z
  .object({
    mode: z.enum(BACKFILL_MODES),
    /** Reads per UTC day the backfill may spend (leaves headroom for another consumer). */
    dailyReads: z.number().int().min(0),
    /** Reads per 15-minute window the backfill may spend. */
    fifteenMinuteReads: z.number().int().min(0),
    /** Activities listed per page. */
    pageSize: z.number().int().min(1).max(200),
  })
  .strict();

const SCHEMAS = {
  timing: timingSchema,
  match: matchSchema,
  merge: mergeSchema,
  postUpload: postUploadSchema,
  switches: switchesSchema,
  trial: trialSchema,
  backfill: backfillSchema,
} as const;

export type Section = keyof typeof SCHEMAS;
export const SECTIONS = Object.keys(SCHEMAS) as Section[];

export interface Settings {
  timing: z.infer<typeof timingSchema>;
  match: Omit<MatchSettings, "partnerWaitMs">;
  merge: MergeSettings;
  postUpload: z.infer<typeof postUploadSchema>;
  switches: z.infer<typeof switchesSchema>;
  trial: z.infer<typeof trialSchema>;
  backfill: z.infer<typeof backfillSchema>;
}

const { partnerWaitMs: defaultPartnerWait, ...defaultMatch } = DEFAULT_MATCH_SETTINGS;

export const DEFAULT_SETTINGS: Settings = {
  timing: {
    pollIntervalMs: 10 * 60 * 1000,
    keepaliveIntervalMs: HOUR,
    partnerWaitMs: defaultPartnerWait,
    gracePeriodMs: 24 * HOUR,
  },
  match: defaultMatch,
  merge: DEFAULT_MERGE_SETTINGS,
  postUpload: { tolerance: 0.05, startToleranceSeconds: 2 },
  switches: { hide: true, delete: false, upload: true },
  trial: { enabled: false, maxPairs: MAX_TRIAL_PAIRS },
  backfill: { mode: "off", dailyReads: 600, fifteenMinuteReads: 70, pageSize: 30 },
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};
export type SettingsPatch = DeepPartial<Settings>;

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge `patch` over `base` (objects merge, everything else replaces). */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}

/** The full MatchSettings shared/ expects, from the stored sections. */
export function matchSettingsOf(settings: Settings): MatchSettings {
  return { ...settings.match, partnerWaitMs: settings.timing.partnerWaitMs };
}

export class SettingsStore {
  readonly #db: DatabaseSync;
  readonly #log: Logger | undefined;
  readonly #now: () => number;

  constructor(db: DatabaseSync, options: { log?: Logger; now?: () => number } = {}) {
    this.#db = db;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
  }

  #read(section: Section): Settings[Section] {
    const fallback = DEFAULT_SETTINGS[section];
    const row = this.#db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(`settings.${section}`) as { value: string } | undefined;
    if (row === undefined) return fallback;
    let stored: unknown;
    try {
      stored = JSON.parse(row.value);
    } catch {
      stored = undefined;
    }
    const parsed = SCHEMAS[section].safeParse(deepMerge(fallback, stored));
    if (stored === undefined || !parsed.success) {
      this.#log?.warn({ section }, "stored settings section is invalid; using defaults");
      return fallback;
    }
    return parsed.data as Settings[Section];
  }

  get(): Settings {
    const out = {} as Record<Section, unknown>;
    for (const section of SECTIONS) out[section] = this.#read(section);
    return out as unknown as Settings;
  }

  /**
   * Apply a partial update. The whole result is validated before anything is
   * written; all touched sections are written in one transaction.
   */
  update(patch: SettingsPatch): Settings {
    const current = this.get();
    const next = deepMerge(current, patch);
    const problems: string[] = [];
    for (const key of Object.keys(patch)) {
      if (!(SECTIONS as string[]).includes(key)) problems.push(`unknown section ${key}`);
    }
    for (const section of SECTIONS) {
      const parsed = SCHEMAS[section].safeParse(next[section]);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          problems.push(`${section}.${issue.path.join(".")}: ${issue.message}`);
        }
      }
    }
    if (problems.length > 0) throw new SettingsError(`invalid settings: ${problems.join("; ")}`);
    const at = new Date(this.#now()).toISOString();
    const upsert = this.#db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.#db.exec("BEGIN");
    try {
      for (const section of Object.keys(patch) as Section[]) {
        upsert.run(`settings.${section}`, JSON.stringify(next[section]), at);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#log?.info({ sections: Object.keys(patch) }, "settings updated");
    return next;
  }
}
