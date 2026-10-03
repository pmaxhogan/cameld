import type { ActivitySample } from "../activity/sample.ts";
import { epochMsToFitSeconds } from "../fit/quantization.ts";
import { distanceMeters, median } from "./geo.ts";
import { DEFAULT_ALIGNMENT_SETTINGS, type AlignmentSettings } from "./settings.ts";

/**
 * Clock alignment (rule L11, docs/MERGE-RULES.md "Clock alignment").
 *
 * Sign convention: an offset of N seconds means the Fitbit clock is N seconds
 * BEHIND the app, so the aligned Fitbit time is `time + N * 1000`. The app
 * clock is the reference and is never shifted.
 *
 * Every offset in [-range, +range] (1 s steps) is scored by the median
 * distance between time-aligned positions: a Fitbit fix at aligned second S
 * is paired with the app fix recorded in second S (whole FIT seconds, the
 * same key the merger uses). Offsets with fewer than `minAlignedPoints` pairs
 * have no cost.
 *
 * Decision, in order:
 * - no offset has a cost: "no_gps", offset 0 (non-GPS pairs use 0).
 * - the minimum is not sharp (cost at best +/- 10 s is not at least 5x the
 *   best, or neither neighbour can be scored): "flat", offset 0, NOT parked.
 *   An independent, noisy Fitbit track looks like this.
 * - sharp but |best| > 15 s: "large_offset", parked for review, offset 0.
 * - sharp, small, but the median residual is above 2 m and the best offset
 *   is not 0: "uncertain", parked for review, offset 0. MERGE-RULES only
 *   exempts the flat case from parking, and L11 parks uncertain offsets.
 * - otherwise "applied" with the best offset.
 *
 * Ties in cost prefer the smaller absolute offset, then the smaller offset,
 * so the result is deterministic.
 */

export type AlignmentStatus = "applied" | "flat" | "large_offset" | "uncertain" | "no_gps";

export interface AlignmentCostPoint {
  offsetSeconds: number;
  /** Median paired distance in metres, or null when too few pairs. */
  costMeters: number | null;
  pairs: number;
}

export interface AlignmentResult {
  status: AlignmentStatus;
  /** The offset to use for the merge (0 unless status is "applied"). */
  offsetSeconds: number;
  /** The offset with the lowest cost, or null when nothing could be scored. */
  bestOffsetSeconds: number | null;
  /** Median residual at the best offset, in metres. */
  bestCostMeters: number | null;
  /**
   * Lower of the two neighbour costs (best +/- delta) divided by the best
   * cost. Infinity when the best cost is 0 and a neighbour is not; null when
   * no neighbour could be scored or both costs are 0.
   */
  sharpness: number | null;
  /** True when the pair must go to the review queue because of the clock. */
  parked: boolean;
  curve: AlignmentCostPoint[];
}

interface Fix {
  second: number;
  lat: number;
  lng: number;
}

function fixes(samples: readonly ActivitySample[]): Fix[] {
  const out: Fix[] = [];
  for (const sample of samples) {
    if (sample.lat !== undefined && sample.lng !== undefined) {
      out.push({ second: epochMsToFitSeconds(sample.time), lat: sample.lat, lng: sample.lng });
    }
  }
  return out;
}

function indexBySecond(list: readonly Fix[]): Map<number, Fix> {
  const index = new Map<number, Fix>();
  for (const fix of list) {
    if (!index.has(fix.second)) {
      index.set(fix.second, fix);
    }
  }
  return index;
}

function distancesAt(appIndex: Map<number, Fix>, fitbit: readonly Fix[], offset: number): number[] {
  const distances: number[] = [];
  for (const fix of fitbit) {
    const partner = appIndex.get(fix.second + offset);
    if (partner !== undefined) {
      distances.push(distanceMeters(partner, fix));
    }
  }
  return distances;
}

/**
 * Distances between time-aligned fixes at one offset (see the sign
 * convention above). Used for the GPS proximity criterion.
 */
export function pairedDistances(
  app: readonly ActivitySample[],
  fitbit: readonly ActivitySample[],
  offsetSeconds: number,
): number[] {
  return distancesAt(indexBySecond(fixes(app)), fixes(fitbit), offsetSeconds);
}

function better(candidate: AlignmentCostPoint, best: AlignmentCostPoint | undefined): boolean {
  if (best === undefined) return true;
  const c = candidate.costMeters!;
  const b = best.costMeters!;
  if (c !== b) return c < b;
  const ca = Math.abs(candidate.offsetSeconds);
  const ba = Math.abs(best.offsetSeconds);
  if (ca !== ba) return ca < ba;
  return candidate.offsetSeconds < best.offsetSeconds;
}

function ratio(neighbour: number, best: number): number | null {
  if (best > 0) return neighbour / best;
  return neighbour > 0 ? Number.POSITIVE_INFINITY : null;
}

/** Search the clock offset between an app track and a Fitbit track. */
export function alignClocks(
  app: readonly ActivitySample[],
  fitbit: readonly ActivitySample[],
  settings: AlignmentSettings = DEFAULT_ALIGNMENT_SETTINGS,
): AlignmentResult {
  const appIndex = indexBySecond(fixes(app));
  const fitbitFixes = fixes(fitbit);
  const curve: AlignmentCostPoint[] = [];
  const byOffset = new Map<number, AlignmentCostPoint>();
  let best: AlignmentCostPoint | undefined;
  const range = settings.searchRangeSeconds;
  for (let offset = -range; offset <= range; offset += settings.stepSeconds) {
    const distances = distancesAt(appIndex, fitbitFixes, offset);
    const enough = distances.length >= settings.minAlignedPoints;
    const point: AlignmentCostPoint = {
      offsetSeconds: offset,
      costMeters: enough ? median(distances) : null,
      pairs: distances.length,
    };
    curve.push(point);
    byOffset.set(offset, point);
    if (enough && better(point, best)) {
      best = point;
    }
  }

  const base = { curve, offsetSeconds: 0, parked: false };
  if (best === undefined) {
    return {
      ...base,
      status: "no_gps",
      bestOffsetSeconds: null,
      bestCostMeters: null,
      sharpness: null,
    };
  }
  const bestOffset = best.offsetSeconds;
  const bestCost = best.costMeters!;
  const neighbours = [
    byOffset.get(bestOffset - settings.sharpnessDeltaSeconds)?.costMeters,
    byOffset.get(bestOffset + settings.sharpnessDeltaSeconds)?.costMeters,
  ].filter((cost): cost is number => cost !== undefined && cost !== null);
  const lowestNeighbour = neighbours.length > 0 ? Math.min(...neighbours) : undefined;
  const sharpness = lowestNeighbour === undefined ? null : ratio(lowestNeighbour, bestCost);
  const found = { bestOffsetSeconds: bestOffset, bestCostMeters: bestCost, sharpness };

  const sharp =
    lowestNeighbour !== undefined &&
    lowestNeighbour > bestCost &&
    lowestNeighbour >= settings.sharpnessRatio * bestCost;
  if (!sharp) {
    return { ...base, ...found, status: "flat" };
  }
  if (Math.abs(bestOffset) > settings.maxAutoOffsetSeconds) {
    return { ...base, ...found, status: "large_offset", parked: true };
  }
  if (bestCost > settings.maxResidualMeters && bestOffset !== 0) {
    return { ...base, ...found, status: "uncertain", parked: true };
  }
  return { ...base, ...found, status: "applied", offsetSeconds: bestOffset };
}
