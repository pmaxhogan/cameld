/**
 * Matching and clock-alignment settings. Every default is the tuned value
 * from docs/MERGE-RULES.md; the server stores overrides and passes a full
 * object in.
 */

export interface AlignmentSettings {
  /** Offsets are searched in [-searchRangeSeconds, +searchRangeSeconds]. */
  searchRangeSeconds: number;
  /** Search step. */
  stepSeconds: number;
  /** Distance from the best offset at which sharpness is measured. */
  sharpnessDeltaSeconds: number;
  /** Cost at best +/- delta must be at least this many times the best cost. */
  sharpnessRatio: number;
  /** Largest median residual (metres) at the best offset for automatic use. */
  maxResidualMeters: number;
  /** Largest absolute offset applied automatically; beyond it a sharp minimum parks. */
  maxAutoOffsetSeconds: number;
  /** Fewer time-aligned point pairs than this and an offset has no cost. */
  minAlignedPoints: number;
}

export interface MatchSettings {
  /** Overlap (against the shorter side) needed for an automatic match. */
  autoMinOverlap: number;
  /** Start delta allowed without the overlap exception. */
  maxStartDeltaSeconds: number;
  /** Median GPS distance at or below which a pair auto-merges. */
  gpsAutoMaxMedianMeters: number;
  /** Median GPS distance above which a pair is not a match at all. */
  gpsReviewMaxMedianMeters: number;
  /** How long to wait for a partner before reporting a recording as single. */
  partnerWaitMs: number;
  alignment: AlignmentSettings;
}

export const DEFAULT_ALIGNMENT_SETTINGS: AlignmentSettings = {
  searchRangeSeconds: 120,
  stepSeconds: 1,
  sharpnessDeltaSeconds: 10,
  sharpnessRatio: 5,
  maxResidualMeters: 2,
  maxAutoOffsetSeconds: 15,
  minAlignedPoints: 10,
};

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  autoMinOverlap: 0.8,
  maxStartDeltaSeconds: 600,
  gpsAutoMaxMedianMeters: 25,
  gpsReviewMaxMedianMeters: 100,
  partnerWaitMs: 4 * 60 * 60 * 1000,
  alignment: DEFAULT_ALIGNMENT_SETTINGS,
};
