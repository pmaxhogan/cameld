import type { ActivitySample, SampleField } from "../activity/sample.ts";
import { FIT_QUANTIZATION, epochMsToFitSeconds, fitSecondsToEpochMs } from "../fit/quantization.ts";
import { distanceMeters } from "../match/geo.ts";
import type { ExclusionReason, LedgerEntry, MergeSide, SampleRef } from "./ledger.ts";

/**
 * Sample merger (rules L9, L10, L12; docs/MERGE-RULES.md "Field sources" and
 * "Impossible-speed filter").
 *
 * Inputs are the ORIGINAL file samples of both sides (never API streams) and
 * the clock offset from alignment. The "app" side is the reference clock and
 * the preferred position source; the "fitbit" side is shifted by the offset
 * (aligned time = time + offset s) and is the preferred heart rate source.
 * When a group has several parts on one side, the caller concatenates them in
 * time order; ledger indexes refer to that concatenated array.
 *
 * Everything is keyed by the aligned whole FIT second, because the merged
 * file is FIT and FIT timestamps are whole seconds:
 *
 * 1. Same-second records of one side are merged into one: per field the later
 *    value (file order) wins, and every earlier value that differs goes to the
 *    ledger as same_timestamp_conflict. A position is one unit (lat and lng
 *    from the same record).
 * 2. The output has one record for every second that holds any input sample,
 *    even if all of that second's values were excluded, so the merged span is
 *    exactly the union of both spans (extensions before and after are kept).
 * 3. Position: the app fix wherever the app has one in that second; the
 *    Fitbit fix otherwise, after the impossible-speed filter. A Fitbit fix
 *    that loses to an app fix goes to the ledger.
 * 4. Other fields come from one side for the whole merge: heart rate and
 *    cadence from the Fitbit, altitude, distance and speed from the app.
 *    Distance and speed are not assigned by MERGE-RULES; they follow the app
 *    like elevation because cumulative distance from two devices cannot be
 *    mixed. When the preferred side has no value for a field anywhere, the
 *    other side's values are used instead. Values not used go to the ledger.
 * 5. Values FIT cannot store go to the ledger as outside_fit_range rather
 *    than making the writer throw.
 *
 * Impossible-speed filter (Fitbit-derived positions only): each candidate is
 * compared with the last KEPT position of the merged track (app or Fitbit),
 * speed = max(0, distance - slack) / dt. Above the sport's limit it is
 * dropped to the ledger. The 30th consecutive would-be drop is accepted
 * instead (re-anchor) and the count restarts. Unknown sports are not
 * filtered unless a default limit is set.
 *
 * Nothing is smoothed, interpolated or invented: every output value is an
 * input value, and every output timestamp is an input's aligned second.
 */

export class MergeError extends Error {
  override readonly name = "MergeError";
}

export type SportCategory = "walk" | "hike" | "run" | "ride";

export interface MergeSettings {
  /** Speed limits in m/s per sport category. */
  speedLimitsMps: Record<SportCategory, number>;
  /** Limit for sports outside the categories; null disables the filter for them. */
  defaultSpeedLimitMps: number | null;
  /** Distance slack before speed is computed. */
  speedSlackMeters: number;
  /** The Nth consecutive would-be drop is accepted as a new anchor. */
  reanchorAfter: number;
}

export const DEFAULT_MERGE_SETTINGS: MergeSettings = {
  speedLimitsMps: { walk: 7, hike: 7, run: 12, ride: 25 },
  defaultSpeedLimitMps: null,
  speedSlackMeters: 10,
  reanchorAfter: 30,
};

export interface MergeInput {
  app: readonly ActivitySample[];
  fitbit: readonly ActivitySample[];
  /** Fitbit clock lag in seconds (see match/align.ts). */
  offsetSeconds: number;
  /** Sport type (Strava or FIT name) for the speed limit. */
  sport: string | null;
}

/** Which input each output field value came from. */
export type Provenance = Partial<Record<SampleField, SampleRef>>;

export interface MergeResult {
  /** Merged samples in time order, one per aligned second. */
  samples: ActivitySample[];
  /** provenance[i] maps each field of samples[i] to its input sample. */
  provenance: Provenance[];
  ledger: LedgerEntry[];
  offsetSeconds: number;
}

/** Source tag on merged samples. */
export const MERGED_SOURCE = "merged";

/** The aligned whole FIT second of an input sample. */
export function alignedSecond(side: MergeSide, time: number, offsetSeconds: number): number {
  return epochMsToFitSeconds(side === "fitbit" ? time + offsetSeconds * 1000 : time);
}

/** Map a Strava sport type or FIT sport name to a speed-limit category. */
export function sportCategory(sport: string | null): SportCategory | null {
  const name = (sport ?? "").toLowerCase();
  if (name.includes("hike") || name.includes("hiking")) return "hike";
  if (name.includes("walk")) return "walk";
  if (name.includes("run")) return "run";
  if (name.includes("ride") || name.includes("cycl") || name.includes("bik")) return "ride";
  return null;
}

/** A field value with its origin. */
interface Valued {
  value: number;
  index: number;
  /** Earlier same-second indexes holding the identical value (represented by this one). */
  equal: number[];
}

interface Fix {
  lat: number;
  lng: number;
  index: number;
  /** Earlier same-second indexes holding the identical fix. */
  equal: number[];
}

/** One side's samples in one second, after same-second merging. */
interface Slot {
  fix?: Fix;
  fields: Partial<Record<Exclude<SampleField, "lat" | "lng">, Valued>>;
}

const VALUE_FIELDS = ["altitude", "heartRate", "cadence", "distance", "speed"] as const;
type ValueField = (typeof VALUE_FIELDS)[number];

const PREFERRED_SIDE: Record<ValueField, MergeSide> = {
  altitude: "app",
  heartRate: "fitbit",
  cadence: "fitbit",
  distance: "app",
  speed: "app",
};

const inRange = (field: SampleField | "time", value: number): boolean =>
  value >= FIT_QUANTIZATION[field].min && value <= FIT_QUANTIZATION[field].max;

class Ledger {
  readonly entries: LedgerEntry[] = [];
  readonly #inputs: Record<MergeSide, readonly ActivitySample[]>;
  readonly #offsetSeconds: number;

  constructor(inputs: Record<MergeSide, readonly ActivitySample[]>, offsetSeconds: number) {
    this.#inputs = inputs;
    this.#offsetSeconds = offsetSeconds;
  }

  add(
    side: MergeSide,
    index: number,
    field: SampleField,
    reason: ExclusionReason,
    detail?: string,
  ): void {
    const sample = this.#inputs[side][index]!;
    const entry: LedgerEntry = {
      side,
      index,
      time: sample.time,
      alignedSecond: alignedSecond(side, sample.time, this.#offsetSeconds),
      field,
      value: sample[field]!,
      reason,
    };
    if (detail !== undefined) entry.detail = detail;
    this.entries.push(entry);
  }

  addFix(side: MergeSide, index: number, reason: ExclusionReason, detail?: string): void {
    this.add(side, index, "lat", reason, detail);
    this.add(side, index, "lng", reason, detail);
  }

  /** Exclude a value and every same-second twin it stands for. */
  addValued(side: MergeSide, valued: Valued, field: SampleField, reason: ExclusionReason): void {
    for (const index of [valued.index, ...valued.equal]) {
      this.add(side, index, field, reason);
    }
  }

  /** Exclude a fix and every same-second twin it stands for. */
  addFixes(side: MergeSide, fix: Fix, reason: ExclusionReason, detail?: string): void {
    for (const index of [fix.index, ...fix.equal]) {
      this.addFix(side, index, reason, detail);
    }
  }
}

/** Collapse one side into per-second slots (step 1 and 5 of the module doc). */
function slotsFor(
  side: MergeSide,
  samples: readonly ActivitySample[],
  offsetSeconds: number,
  ledger: Ledger,
): Map<number, Slot> {
  const slots = new Map<number, Slot>();
  samples.forEach((sample, index) => {
    const alignedTime = side === "fitbit" ? sample.time + offsetSeconds * 1000 : sample.time;
    if (!inRange("time", alignedTime)) {
      throw new MergeError(`${side} sample ${index}: time ${alignedTime} is outside the FIT range`);
    }
    const second = alignedSecond(side, sample.time, offsetSeconds);
    const slot = slots.get(second) ?? { fields: {} };
    slots.set(second, slot);
    if (sample.lat !== undefined && sample.lng !== undefined) {
      const equalFix: number[] = [];
      if (!inRange("lat", sample.lat) || !inRange("lng", sample.lng)) {
        ledger.addFix(side, index, "outside_fit_range");
      } else {
        const previous = slot.fix;
        if (previous !== undefined) {
          if (previous.lat !== sample.lat || previous.lng !== sample.lng) {
            for (const earlier of [previous.index, ...previous.equal]) {
              ledger.addFix(side, earlier, "same_timestamp_conflict");
            }
          } else {
            equalFix.push(previous.index, ...previous.equal);
          }
        }
        slot.fix = { lat: sample.lat, lng: sample.lng, index, equal: equalFix };
      }
    }
    for (const field of VALUE_FIELDS) {
      const value = sample[field];
      if (value === undefined) continue;
      if (!inRange(field, value)) {
        ledger.add(side, index, field, "outside_fit_range");
        continue;
      }
      const previous = slot.fields[field];
      const equal: number[] = [];
      if (previous !== undefined) {
        if (previous.value !== value) {
          for (const earlier of [previous.index, ...previous.equal]) {
            ledger.add(side, earlier, field, "same_timestamp_conflict");
          }
        } else {
          equal.push(previous.index, ...previous.equal);
        }
      }
      slot.fields[field] = { value, index, equal };
    }
  });
  return slots;
}

function speedLimit(sport: string | null, settings: MergeSettings): number | null {
  const category = sportCategory(sport);
  return category === null ? settings.defaultSpeedLimitMps : settings.speedLimitsMps[category];
}

/** Merge the original samples of both sides. */
export function mergeSamples(
  input: MergeInput,
  settings: MergeSettings = DEFAULT_MERGE_SETTINGS,
): MergeResult {
  const { offsetSeconds } = input;
  const ledger = new Ledger({ app: input.app, fitbit: input.fitbit }, offsetSeconds);
  const slots: Record<MergeSide, Map<number, Slot>> = {
    app: slotsFor("app", input.app, offsetSeconds, ledger),
    fitbit: slotsFor("fitbit", input.fitbit, offsetSeconds, ledger),
  };
  const seconds = [...new Set([...slots.app.keys(), ...slots.fitbit.keys()])].sort((a, b) => a - b);

  const provides = (side: MergeSide, field: ValueField): boolean =>
    [...slots[side].values()].some((slot) => slot.fields[field] !== undefined);
  const sourceOf = {} as Record<ValueField, MergeSide>;
  for (const field of VALUE_FIELDS) {
    const preferred = PREFERRED_SIDE[field];
    const other: MergeSide = preferred === "app" ? "fitbit" : "app";
    sourceOf[field] = provides(preferred, field) ? preferred : other;
  }

  const limit = speedLimit(input.sport, settings);
  let lastKept: { lat: number; lng: number; second: number } | undefined;
  let drops = 0;

  const samples: ActivitySample[] = [];
  const provenance: Provenance[] = [];
  for (const second of seconds) {
    const app = slots.app.get(second);
    const fitbit = slots.fitbit.get(second);
    const sample: ActivitySample = { time: fitSecondsToEpochMs(second), source: MERGED_SOURCE };
    const origin: Provenance = {};

    const appFix = app?.fix;
    const fitbitFix = fitbit?.fix;
    let chosen: { fix: Fix; side: MergeSide } | undefined;
    if (appFix !== undefined) {
      chosen = { fix: appFix, side: "app" };
      if (
        fitbitFix !== undefined &&
        (fitbitFix.lat !== appFix.lat || fitbitFix.lng !== appFix.lng)
      ) {
        ledger.addFixes("fitbit", fitbitFix, "position_app_preferred");
      }
    } else if (fitbitFix !== undefined) {
      let keep = true;
      if (lastKept !== undefined && limit !== null) {
        const dt = second - lastKept.second;
        const speed =
          Math.max(0, distanceMeters(lastKept, fitbitFix) - settings.speedSlackMeters) / dt;
        if (speed > limit) {
          drops += 1;
          if (drops >= settings.reanchorAfter) {
            drops = 0;
          } else {
            keep = false;
            ledger.addFixes(
              "fitbit",
              fitbitFix,
              "impossible_speed",
              `${speed.toFixed(1)} m/s over ${dt} s exceeds ${limit} m/s`,
            );
          }
        }
      }
      if (keep) chosen = { fix: fitbitFix, side: "fitbit" };
    }
    if (chosen !== undefined) {
      drops = 0;
      sample.lat = chosen.fix.lat;
      sample.lng = chosen.fix.lng;
      const ref = { side: chosen.side, index: chosen.fix.index };
      origin.lat = ref;
      origin.lng = ref;
      lastKept = { lat: chosen.fix.lat, lng: chosen.fix.lng, second };
    }

    for (const field of VALUE_FIELDS) {
      const side = sourceOf[field];
      const otherSide: MergeSide = side === "app" ? "fitbit" : "app";
      const used = (side === "app" ? app : fitbit)?.fields[field];
      const unused = (otherSide === "app" ? app : fitbit)?.fields[field];
      if (used !== undefined) {
        sample[field] = used.value;
        origin[field] = { side, index: used.index };
      }
      if (unused !== undefined && unused.value !== used?.value) {
        ledger.addValued(otherSide, unused, field, "field_source_preferred");
      }
    }
    samples.push(sample);
    provenance.push(origin);
  }

  return { samples, provenance, ledger: ledger.entries, offsetSeconds };
}
