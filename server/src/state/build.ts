import {
  type ActivitySample,
  checkNoLoss,
  distanceMeters,
  type LedgerEntry,
  mergeSamples,
  type MergeSettings,
  type NoLossInput,
  type NoLossReport,
  readFitActivity,
  writeFitActivity,
} from "@cameld/shared";

/**
 * Step 4 of the common prefix: build the merged FIT from the ORIGINAL files
 * and run the EXACT no-loss check against the file as written (decoded back
 * from its bytes), not against the in-memory merge.
 */

export interface BuildInput {
  /** Concatenated original samples of each side, members in time order. */
  app: ActivitySample[];
  fitbit: ActivitySample[];
  offsetSeconds: number;
  /** Strava sport type of the merge. */
  sport: string | null;
  settings: MergeSettings;
}

export interface BuiltMerge {
  fit: Uint8Array;
  /** Samples decoded back from `fit`. */
  samples: ActivitySample[];
  ledger: LedgerEntry[];
  noLoss: NoLossReport;
}

export type NoLossCheck = (input: NoLossInput) => NoLossReport;

const FIT_SPORTS: [RegExp, string][] = [
  [/hike/i, "hiking"],
  [/walk/i, "walking"],
  [/run/i, "running"],
  [/ride|cycl|bike/i, "cycling"],
  [/swim/i, "swimming"],
];

/** FIT sport name for a Strava sport type ("generic" when unknown). */
export function fitSport(sportType: string | null): string {
  return FIT_SPORTS.find(([pattern]) => pattern.test(sportType ?? ""))?.[1] ?? "generic";
}

export class MergeCheckError extends Error {
  override readonly name = "MergeCheckError";
  readonly evidence: unknown;
  constructor(message: string, evidence: unknown) {
    super(message);
    this.evidence = evidence;
  }
}

export function buildMerge(input: BuildInput, noLossCheck: NoLossCheck = checkNoLoss): BuiltMerge {
  const merged = mergeSamples(
    {
      app: input.app,
      fitbit: input.fitbit,
      offsetSeconds: input.offsetSeconds,
      sport: input.sport,
    },
    input.settings,
  );
  if (merged.samples.length === 0) throw new MergeCheckError("merge produced no samples", {});
  const fit = writeFitActivity(merged.samples, { sport: fitSport(input.sport) });
  const samples = readFitActivity(fit, { source: "merged" }).samples;
  const noLoss = noLossCheck({
    app: input.app,
    fitbit: input.fitbit,
    offsetSeconds: merged.offsetSeconds,
    output: samples,
    ledger: merged.ledger,
  });
  if (!noLoss.ok) {
    throw new MergeCheckError("exact no-loss check failed", {
      issues: noLoss.issues.slice(0, 50),
      issueCount: noLoss.issues.length,
      checkedValues: noLoss.checkedValues,
    });
  }
  return { fit, samples, ledger: merged.ledger, noLoss };
}

/** Expected post-upload figures of a merged file. */
export interface MergeFigures {
  points: number;
  distanceMeters: number;
  elapsedSeconds: number;
  startMs: number;
  hasHeartRate: boolean;
}

export function mergeFigures(samples: readonly ActivitySample[]): MergeFigures {
  let recorded = 0;
  let path = 0;
  let last: { lat: number; lng: number } | undefined;
  for (const sample of samples) {
    if (sample.distance !== undefined) recorded = Math.max(recorded, sample.distance);
    if (sample.lat !== undefined && sample.lng !== undefined) {
      const point = { lat: sample.lat, lng: sample.lng };
      if (last !== undefined) path += distanceMeters(last, point);
      last = point;
    }
  }
  const first = samples[0];
  const end = samples[samples.length - 1];
  return {
    points: samples.length,
    distanceMeters: recorded > 0 ? recorded : path,
    elapsedSeconds: first === undefined || end === undefined ? 0 : (end.time - first.time) / 1000,
    startMs: first?.time ?? 0,
    hasHeartRate: samples.some((sample) => sample.heartRate !== undefined),
  };
}

export interface ToleranceInput {
  expected: MergeFigures;
  actual: {
    points: number;
    distanceMeters: number;
    elapsedSeconds: number;
    startMs: number;
    hasHeartRate: boolean;
  };
  tolerance: number;
  startToleranceSeconds: number;
}

/** Within `tolerance` (a fraction), with small absolute floors for tiny values. */
function near(expected: number, actual: number, tolerance: number, floor: number): boolean {
  return Math.abs(actual - expected) <= Math.max(Math.abs(expected) * tolerance, floor);
}

/** The tolerance-based post-upload check (Strava resamples, so not exact). */
export function postUploadCheck(input: ToleranceInput): { ok: boolean; failures: string[] } {
  const { expected, actual, tolerance } = input;
  const failures: string[] = [];
  if (!near(expected.points, actual.points, tolerance, 2)) failures.push("points");
  if (!near(expected.distanceMeters, actual.distanceMeters, tolerance, 10))
    failures.push("distance");
  if (!near(expected.elapsedSeconds, actual.elapsedSeconds, tolerance, 2)) failures.push("elapsed");
  if (expected.hasHeartRate && !actual.hasHeartRate) failures.push("heart_rate");
  if (Math.abs(actual.startMs - expected.startMs) > input.startToleranceSeconds * 1000) {
    failures.push("start_time");
  }
  return { ok: failures.length === 0, failures };
}
