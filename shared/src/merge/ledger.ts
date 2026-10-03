import type { SampleField } from "../activity/sample.ts";

/**
 * The exclusion ledger: every input field value that is not represented in
 * the merged output, with the reason. Together with the output it accounts
 * for every value of both inputs (invariant 1); the no-loss check proves it.
 */

/** Which input a value came from. */
export type MergeSide = "app" | "fitbit";

export type ExclusionReason =
  /** A Fitbit fix in a second where the app has a fix (L9). */
  | "position_app_preferred"
  /** A Fitbit-derived fix implying an impossible speed for the sport (L12). */
  | "impossible_speed"
  /** The field is taken from the other source for the whole merge (L10). */
  | "field_source_preferred"
  /** Superseded by a later record of the same source in the same second. */
  | "same_timestamp_conflict"
  /** FIT cannot store the value (see fit/quantization.ts). */
  | "outside_fit_range";

export interface LedgerEntry {
  side: MergeSide;
  /** Index of the sample in that side's input array. */
  index: number;
  /** The sample's own recorded time (epoch ms), before any clock offset. */
  time: number;
  /** Aligned whole FIT second the sample maps to. */
  alignedSecond: number;
  field: SampleField;
  /** The excluded value, exactly as it was in the input. */
  value: number;
  reason: ExclusionReason;
  /** Human-readable context, for example the implied speed. */
  detail?: string;
}

/** Reference to an input sample. */
export interface SampleRef {
  side: MergeSide;
  index: number;
}
