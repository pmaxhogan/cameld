import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ActivitySample,
  evaluateGroup,
  findCandidateGroups,
  type MatchRecording,
  type MatchResult,
  type MatchSettings,
} from "@cameld/shared";
import { type BackupService, parseOriginal } from "../service/backup.ts";
import { type ActivityRow, activitiesBetween, requireActivity } from "./repo.ts";

/**
 * Shared by the state machine (step 3) and the backfill dry run: candidate
 * detection over stored activities and scoring from the ORIGINAL files.
 */

/** Activities that may take part in pairing at all. */
export function pairable(activity: ActivityRow): boolean {
  return !activity.isMergeOutput && activity.goneAt === null && activity.restoredFrom === null;
}

export function recordingOf(activity: ActivityRow, samples?: ActivitySample[]): MatchRecording {
  const first = samples?.[0]?.time;
  const last = samples?.[samples.length - 1]?.time;
  return {
    id: String(activity.id),
    source: activity.source,
    sportType: activity.sportType,
    startTime: first ?? activity.startMs,
    endTime: Math.max(last ?? activity.endMs, first ?? activity.startMs),
    samples,
  };
}

/** Candidate components (by time and source only) among `pool`. Ids sorted by start. */
export function candidateComponents(
  pool: readonly ActivityRow[],
  settings: MatchSettings,
): number[][] {
  return findCandidateGroups(
    pool.map((activity) => recordingOf(activity)),
    settings,
  ).map((group) => group.map((recording) => Number(recording.id)));
}

export function poolBetween(db: DatabaseSync, fromMs: number, toMs: number): ActivityRow[] {
  return activitiesBetween(db, fromMs, toMs).filter(pairable);
}

/** Stable group id from its first start and member ids. */
export function groupIdFor(startMs: number, ids: readonly number[]): string {
  const hash = createHash("sha256")
    .update([...ids].sort((a, b) => a - b).join(","))
    .digest("hex")
    .slice(0, 10);
  return `g-${Math.floor(startMs / 1000)}-${hash}`;
}

/** Original samples per activity, parsed once per instance. */
export class SampleCache {
  readonly #db: DatabaseSync;
  readonly #backup: BackupService;
  readonly #cache = new Map<number, ActivitySample[]>();

  constructor(db: DatabaseSync, backup: BackupService) {
    this.#db = db;
    this.#backup = backup;
  }

  /** Samples of the original file. Callers only ask once the original is stored. */
  async samples(activityId: number): Promise<ActivitySample[]> {
    const cached = this.#cache.get(activityId);
    if (cached !== undefined) return cached;
    const original = (await this.#backup.readOriginal(activityId))!;
    const samples = parseOriginal(original, `activity:${activityId}`).samples;
    this.#cache.set(activityId, samples);
    return samples;
  }

  /** Concatenated samples of several activities, in the given order. */
  async concat(ids: readonly number[]): Promise<ActivitySample[]> {
    const out: ActivitySample[] = [];
    for (const id of ids) out.push(...(await this.samples(id)));
    return out;
  }

  clear(): void {
    this.#cache.clear();
  }

  async evaluate(ids: readonly number[], settings: MatchSettings): Promise<MatchResult> {
    const recordings: MatchRecording[] = [];
    for (const id of ids) {
      const samples = await this.samples(id);
      recordings.push(recordingOf(requireActivity(this.#db, id), samples));
    }
    return evaluateGroup(recordings, settings);
  }
}

/** A compact, JSON-safe summary of a match result (the alignment curve is dropped). */
export function summarizeMatch(result: MatchResult): unknown {
  const metrics = result.metrics;
  return {
    decision: result.decision,
    reasons: result.reasons,
    memberIds: result.memberIds.map(Number),
    appIds: result.app?.members.map((m) => Number(m.id)) ?? [],
    fitbitIds: result.fitbit?.members.map((m) => Number(m.id)) ?? [],
    metrics:
      metrics === null
        ? null
        : {
            overlapRatio: metrics.overlapRatio,
            overlapSeconds: metrics.overlapSeconds,
            startDeltaSeconds: metrics.startDeltaSeconds,
            sportMatch: metrics.sportMatch,
            appHasGps: metrics.appHasGps,
            fitbitHasGps: metrics.fitbitHasGps,
            proximity: metrics.proximity,
            alignment:
              metrics.alignment === null
                ? null
                : {
                    status: metrics.alignment.status,
                    offsetSeconds: metrics.alignment.offsetSeconds,
                    bestOffsetSeconds: metrics.alignment.bestOffsetSeconds,
                    bestCostMeters: metrics.alignment.bestCostMeters,
                    sharpness: metrics.alignment.sharpness,
                  },
          },
  };
}
