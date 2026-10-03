import type { ActivitySample } from "../activity/sample.ts";
import { alignClocks, pairedDistances, type AlignmentResult } from "./align.ts";
import { median, percentile } from "./geo.ts";
import { DEFAULT_MATCH_SETTINGS, type MatchSettings } from "./settings.ts";
import type { RecordingSource } from "./source.ts";

/**
 * Pair matcher (docs/MERGE-RULES.md "Pairing", ARCHITECTURE.md section 4).
 *
 * Pairing is 1-to-N: one recording on one side can pair with several
 * recordings on the other when a device split the outing into parts. A group
 * has two sides, each with one primary (its longest member). Roles:
 * - the "fitbit" side is the Fitbit source; in an app-vs-other pair (no
 *   Fitbit) the other device takes the Fitbit role.
 * - the "app" side is the other source; its clock is the reference and its
 *   positions win (L9).
 *
 * Decision:
 * - "none": no time overlap; start delta above the limit without the overlap
 *   exception; or a GPS median distance above the review limit.
 * - "review": anything structurally ambiguous (three sources, both sides
 *   split, overlapping parts on one side), overlap below the auto limit, a
 *   sport mismatch or unknown sport, a GPS median in the review band, GPS
 *   tracks that cannot be compared, or a clock offset parked by alignment.
 * - "auto": everything else. A pair where at least one side has no GPS is
 *   judged by the non-GPS rule (same sport, different sources, overlap).
 *
 * The p90 distance is reported but is never a criterion, and neither is the
 * distance ratio between the copies.
 */

export interface MatchRecording {
  id: string;
  source: RecordingSource;
  sportType: string | null;
  /** Epoch ms. */
  startTime: number;
  /** Epoch ms, at or after startTime. */
  endTime: number;
  /** Samples for the GPS criteria (original file or display streams). */
  samples?: readonly ActivitySample[] | undefined;
}

export type MatchDecision = "auto" | "review" | "none";

export type MatchReason =
  | "no_overlap"
  | "single_source"
  | "start_delta_too_large"
  | "gps_too_far"
  | "more_than_two_sources"
  | "many_to_many"
  | "overlapping_parts"
  | "overlap_below_auto"
  | "sport_mismatch"
  | "sport_unknown"
  | "gps_review_band"
  | "gps_not_comparable"
  | "alignment_large_offset"
  | "alignment_uncertain"
  | "gps_within_auto"
  | "non_gps_rule";

export interface GroupSide {
  source: RecordingSource;
  /** Members ordered by start time, then id. */
  members: MatchRecording[];
  primaryId: string;
}

export interface GpsProximity {
  /** Offset the distances were measured at. */
  offsetSeconds: number;
  medianMeters: number;
  p90Meters: number;
  pairs: number;
}

export interface MatchMetrics {
  overlapSeconds: number;
  appSeconds: number;
  fitbitSeconds: number;
  /** Overlap divided by the shorter side's duration (0 when that is 0). */
  overlapRatio: number;
  startDeltaSeconds: number;
  sportMatch: boolean;
  appHasGps: boolean;
  fitbitHasGps: boolean;
  alignment: AlignmentResult | null;
  proximity: GpsProximity | null;
}

export interface MatchResult {
  decision: MatchDecision;
  reasons: MatchReason[];
  memberIds: string[];
  /** Null only for a group with more than two sources. */
  app: GroupSide | null;
  fitbit: GroupSide | null;
  metrics: MatchMetrics | null;
}

interface Interval {
  start: number;
  end: number;
}

function byStart(a: MatchRecording, b: MatchRecording): number {
  return a.startTime - b.startTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function intervalOverlapMs(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Merge intervals into a sorted, disjoint list. */
function union(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      out.push({ ...interval });
    }
  }
  return out;
}

const measure = (intervals: readonly Interval[]): number =>
  intervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0);

function intersectionMs(a: readonly Interval[], b: readonly Interval[]): number {
  let total = 0;
  for (const x of a) {
    for (const y of b) {
      total += intervalOverlapMs(x, y);
    }
  }
  return total;
}

const intervalOf = (r: MatchRecording): Interval => ({ start: r.startTime, end: r.endTime });

/** Two recordings are candidates when their sources differ and they overlap or start close. */
function linked(a: MatchRecording, b: MatchRecording, settings: MatchSettings): boolean {
  if (a.source === b.source) return false;
  const overlap = intervalOverlapMs(intervalOf(a), intervalOf(b));
  const startDelta = Math.abs(a.startTime - b.startTime);
  return overlap > 0 || startDelta <= settings.maxStartDeltaSeconds * 1000;
}

/**
 * Group recordings into candidate groups: connected components of the
 * "different source and overlapping or close start" relation, with at least
 * two members. Groups are ordered by their earliest start.
 */
export function findCandidateGroups(
  recordings: readonly MatchRecording[],
  settings: MatchSettings = DEFAULT_MATCH_SETTINGS,
): MatchRecording[][] {
  const sorted = [...recordings].sort(byStart);
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (linked(sorted[i]!, sorted[j]!, settings)) {
        parent[find(j)] = find(i);
      }
    }
  }
  const components = new Map<number, MatchRecording[]>();
  sorted.forEach((recording, i) => {
    const root = find(i);
    const list = components.get(root) ?? [];
    list.push(recording);
    components.set(root, list);
  });
  return [...components.values()].filter((group) => group.length >= 2);
}

function side(source: RecordingSource, members: MatchRecording[]): GroupSide {
  const ordered = [...members].sort(byStart);
  let primary = ordered[0]!;
  for (const member of ordered) {
    if (member.endTime - member.startTime > primary.endTime - primary.startTime) {
      primary = member;
    }
  }
  return { source, members: ordered, primaryId: primary.id };
}

/** Concatenate the members' samples in time order (members are already ordered). */
export function sideSamples(groupSide: GroupSide): ActivitySample[] {
  return groupSide.members.flatMap((member) => member.samples ?? []);
}

const hasGps = (samples: readonly ActivitySample[]): boolean =>
  samples.some((sample) => sample.lat !== undefined);

function partsOverlap(groupSide: GroupSide): boolean {
  const members = groupSide.members;
  for (let i = 1; i < members.length; i += 1) {
    if (members[i]!.startTime < members[i - 1]!.endTime) return true;
  }
  return false;
}

/** Split a two-source group into its app and fitbit roles. */
function roles(group: readonly MatchRecording[]): { app: GroupSide; fitbit: GroupSide } {
  const fitbitSource: RecordingSource = group.some((r) => r.source === "fitbit")
    ? "fitbit"
    : "other";
  const fitbitMembers = group.filter((r) => r.source === fitbitSource);
  const appMembers = group.filter((r) => r.source !== fitbitSource);
  return {
    app: side(appMembers[0]!.source, appMembers),
    fitbit: side(fitbitSource, fitbitMembers),
  };
}

function gpsCriteria(
  appSamples: readonly ActivitySample[],
  fitbitSamples: readonly ActivitySample[],
  settings: MatchSettings,
): { alignment: AlignmentResult; proximity: GpsProximity | null } {
  const alignment = alignClocks(appSamples, fitbitSamples, settings.alignment);
  if (alignment.bestOffsetSeconds === null) {
    return { alignment, proximity: null };
  }
  const offset = alignment.parked ? alignment.bestOffsetSeconds : alignment.offsetSeconds;
  const distances = pairedDistances(appSamples, fitbitSamples, offset);
  if (distances.length < settings.alignment.minAlignedPoints) {
    return { alignment, proximity: null };
  }
  return {
    alignment,
    proximity: {
      offsetSeconds: offset,
      medianMeters: median(distances),
      p90Meters: percentile(distances, 0.9),
      pairs: distances.length,
    },
  };
}

/** Score one candidate group and decide auto, review or none. */
export function evaluateGroup(
  group: readonly MatchRecording[],
  settings: MatchSettings = DEFAULT_MATCH_SETTINGS,
): MatchResult {
  const memberIds = [...group].sort(byStart).map((r) => r.id);
  const sources = new Set(group.map((r) => r.source));
  if (sources.size !== 2) {
    return {
      decision: sources.size > 2 ? "review" : "none",
      reasons: [sources.size > 2 ? "more_than_two_sources" : "single_source"],
      memberIds,
      app: null,
      fitbit: null,
      metrics: null,
    };
  }
  const { app, fitbit } = roles(group);
  const review: MatchReason[] = [];
  const none: MatchReason[] = [];
  const info: MatchReason[] = [];

  if (app.members.length > 1 && fitbit.members.length > 1) review.push("many_to_many");
  if (partsOverlap(app) || partsOverlap(fitbit)) review.push("overlapping_parts");

  const appIntervals = union(app.members.map(intervalOf));
  const fitbitIntervals = union(fitbit.members.map(intervalOf));
  const appMs = measure(appIntervals);
  const fitbitMs = measure(fitbitIntervals);
  const overlapMs = intersectionMs(appIntervals, fitbitIntervals);
  const shorterMs = Math.min(appMs, fitbitMs);
  const overlapRatio = shorterMs > 0 ? overlapMs / shorterMs : 0;
  const startDeltaSeconds =
    Math.abs(app.members[0]!.startTime - fitbit.members[0]!.startTime) / 1000;

  if (overlapMs === 0) none.push("no_overlap");
  const enoughOverlap = overlapRatio >= settings.autoMinOverlap;
  if (startDeltaSeconds > settings.maxStartDeltaSeconds && !enoughOverlap) {
    none.push("start_delta_too_large");
  }
  if (!enoughOverlap) review.push("overlap_below_auto");

  const sports = group.map((r) => r.sportType);
  const sportKnown = sports.every((sport) => sport !== null);
  const sportMatch = sportKnown && sports.every((sport) => sport === sports[0]);
  if (!sportKnown) review.push("sport_unknown");
  else if (!sportMatch) review.push("sport_mismatch");

  const appSamples = sideSamples(app);
  const fitbitSamples = sideSamples(fitbit);
  const appHasGps = hasGps(appSamples);
  const fitbitHasGps = hasGps(fitbitSamples);
  let alignment: AlignmentResult | null = null;
  let proximity: GpsProximity | null = null;
  if (appHasGps && fitbitHasGps) {
    ({ alignment, proximity } = gpsCriteria(appSamples, fitbitSamples, settings));
    if (alignment.status === "large_offset") review.push("alignment_large_offset");
    if (alignment.status === "uncertain") review.push("alignment_uncertain");
    if (proximity === null) {
      review.push("gps_not_comparable");
    } else if (proximity.medianMeters > settings.gpsReviewMaxMedianMeters) {
      none.push("gps_too_far");
    } else if (proximity.medianMeters > settings.gpsAutoMaxMedianMeters) {
      review.push("gps_review_band");
    } else {
      info.push("gps_within_auto");
    }
  } else {
    info.push("non_gps_rule");
  }

  const decision: MatchDecision = none.length > 0 ? "none" : review.length > 0 ? "review" : "auto";
  return {
    decision,
    reasons: [...none, ...review, ...info],
    memberIds,
    app,
    fitbit,
    metrics: {
      overlapSeconds: overlapMs / 1000,
      appSeconds: appMs / 1000,
      fitbitSeconds: fitbitMs / 1000,
      overlapRatio,
      startDeltaSeconds,
      sportMatch,
      appHasGps,
      fitbitHasGps,
      alignment,
      proximity,
    },
  };
}

/** Find every candidate group among the recordings and evaluate each one. */
export function matchRecordings(
  recordings: readonly MatchRecording[],
  settings: MatchSettings = DEFAULT_MATCH_SETTINGS,
): MatchResult[] {
  return findCandidateGroups(recordings, settings).map((group) => evaluateGroup(group, settings));
}

/**
 * Whether the partner wait is over for a recording that arrived at
 * `arrivedAt` (epoch ms) and has no partner yet, so it may be reported as
 * "single". Single is not terminal: a later partner re-opens pairing for any
 * recording that has not been merged.
 */
export function partnerWaitOver(
  arrivedAt: number,
  now: number,
  settings: MatchSettings = DEFAULT_MATCH_SETTINGS,
): boolean {
  return now - arrivedAt >= settings.partnerWaitMs;
}
