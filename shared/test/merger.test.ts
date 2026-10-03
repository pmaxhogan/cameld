import { describe, expect, it } from "vitest";
import type { ActivitySample } from "../src/activity/sample.ts";
import { FIT_QUANTIZATION, epochMsToFitSeconds } from "../src/fit/quantization.ts";
import {
  DEFAULT_MERGE_SETTINGS,
  MERGED_SOURCE,
  MergeError,
  alignedSecond,
  mergeSamples,
  sportCategory,
  type MergeInput,
} from "../src/merge/merger.ts";
import { checkNoLoss } from "../src/merge/no-loss.ts";
import { SYNTHETIC_ORIGIN, SYNTHETIC_START } from "./fixtures/synthetic-track.ts";

const S = SYNTHETIC_START;
const M = 1 / 111_320;

/** A sample at second `s` of the fictional outing. */
function at(
  s: number,
  fields: Omit<Partial<ActivitySample>, "time" | "source"> = {},
): ActivitySample {
  return { time: S + s * 1000, source: "synthetic", ...fields };
}

/** A position `north` metres north of the fictional origin. */
function pos(north: number): { lat: number; lng: number } {
  return { lat: SYNTHETIC_ORIGIN.lat + north * M, lng: SYNTHETIC_ORIGIN.lng };
}

function merge(input: Partial<MergeInput>, settings = DEFAULT_MERGE_SETTINGS) {
  const full: MergeInput = { app: [], fitbit: [], offsetSeconds: 0, sport: "Walk", ...input };
  const result = mergeSamples(full, settings);
  const report = checkNoLoss({ ...full, output: result.samples, ledger: result.ledger });
  expect(report.issues).toEqual([]);
  return result;
}

const reasons = (result: ReturnType<typeof merge>) =>
  result.ledger.map((e) => `${e.side}:${e.index}:${e.field}:${e.reason}`);

describe("sportCategory", () => {
  it("maps Strava and FIT sport names", () => {
    expect(sportCategory("Hike")).toBe("hike");
    expect(sportCategory("hiking")).toBe("hike");
    expect(sportCategory("Walk")).toBe("walk");
    expect(sportCategory("TrailRun")).toBe("run");
    expect(sportCategory("running")).toBe("run");
    expect(sportCategory("EBikeRide")).toBe("ride");
    expect(sportCategory("cycling")).toBe("ride");
    expect(sportCategory("Swim")).toBeNull();
    expect(sportCategory(null)).toBeNull();
  });
});

describe("alignedSecond", () => {
  it("shifts only the Fitbit side, by + offset", () => {
    expect(alignedSecond("app", S, 7)).toBe(epochMsToFitSeconds(S));
    expect(alignedSecond("fitbit", S, 7)).toBe(epochMsToFitSeconds(S) + 7);
  });
});

describe("mergeSamples", () => {
  it("takes the union of both spans and applies the offset to the Fitbit", () => {
    const result = merge({
      app: [at(10, pos(0)), at(11, pos(1))],
      fitbit: [at(0, { heartRate: 100 }), at(10, { heartRate: 101 })],
      offsetSeconds: 5,
    });
    expect(result.samples.map((s) => (s.time - S) / 1000)).toEqual([5, 10, 11, 15]);
    expect(result.samples.every((s) => s.source === MERGED_SOURCE)).toBe(true);
    expect(result.samples[0]).toMatchObject({ heartRate: 100 });
    expect(result.samples[1]).toMatchObject({ ...pos(0) });
    expect(result.provenance[3]).toEqual({ heartRate: { side: "fitbit", index: 1 } });
    expect(result.offsetSeconds).toBe(5);
  });

  it("prefers the app fix and ledgers a differing Fitbit fix", () => {
    const result = merge({
      app: [at(0, { ...pos(0) }), at(1, { ...pos(1) })],
      fitbit: [at(0, { ...pos(0) }), at(1, { ...pos(4) })],
    });
    expect(result.samples[1]).toMatchObject(pos(1));
    expect(result.provenance[1]!.lat).toEqual({ side: "app", index: 1 });
    expect(reasons(result)).toEqual([
      "fitbit:1:lat:position_app_preferred",
      "fitbit:1:lng:position_app_preferred",
    ]);
  });

  it("fills app gaps and extensions with Fitbit fixes", () => {
    const result = merge({
      app: [at(1, pos(1)), at(3, pos(3))],
      fitbit: [at(0, pos(0)), at(2, pos(2)), at(4, pos(4))],
    });
    expect(result.samples.map((s) => s.lat)).toEqual([0, 1, 2, 3, 4].map((n) => pos(n).lat));
    expect(result.provenance.map((p) => p.lat!.side)).toEqual([
      "fitbit",
      "app",
      "fitbit",
      "app",
      "fitbit",
    ]);
    expect(result.ledger).toEqual([]);
  });

  it("takes heart rate and cadence from the Fitbit, elevation, distance, speed from the app", () => {
    const result = merge({
      app: [at(0, { heartRate: 90, altitude: 10, distance: 0, speed: 1, cadence: 50 })],
      fitbit: [at(0, { heartRate: 120, altitude: 30, distance: 2, speed: 3, cadence: 80 })],
    });
    expect(result.samples[0]).toMatchObject({
      heartRate: 120,
      cadence: 80,
      altitude: 10,
      distance: 0,
      speed: 1,
    });
    expect(reasons(result).sort()).toEqual([
      "app:0:cadence:field_source_preferred",
      "app:0:heartRate:field_source_preferred",
      "fitbit:0:altitude:field_source_preferred",
      "fitbit:0:distance:field_source_preferred",
      "fitbit:0:speed:field_source_preferred",
    ]);
  });

  it("does not ledger a non-preferred value identical to the chosen one", () => {
    const result = merge({ app: [at(0, { altitude: 10 })], fitbit: [at(0, { altitude: 10 })] });
    expect(result.ledger).toEqual([]);
  });

  it("ledgers the non-preferred side even where the preferred side has a hole", () => {
    const result = merge({
      app: [at(0, { altitude: 10 }), at(1, {})],
      fitbit: [at(1, { altitude: 30 })],
    });
    expect(result.samples[1]!.altitude).toBeUndefined();
    expect(reasons(result)).toEqual(["fitbit:0:altitude:field_source_preferred"]);
  });

  it("falls back to the other side when the preferred side never has the field", () => {
    const result = merge({
      app: [at(0, { ...pos(0), heartRate: 140 })],
      fitbit: [at(0, { altitude: 30, distance: 5 }), at(1, { altitude: 31 })],
    });
    expect(result.samples[0]).toMatchObject({ heartRate: 140, altitude: 30, distance: 5 });
    expect(result.provenance[0]!.heartRate).toEqual({ side: "app", index: 0 });
    expect(result.ledger).toEqual([]);
  });

  it("merges records that share a second; later non-null wins, conflicts are ledgered", () => {
    const result = merge({
      app: [
        { time: S, source: "x", ...pos(0), altitude: 10, speed: 2 },
        { time: S + 400, source: "x", ...pos(0), altitude: 11 },
        { time: S + 450, source: "x", ...pos(1), speed: 2 },
      ],
    });
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]).toMatchObject({ ...pos(1), altitude: 11, speed: 2 });
    expect(result.provenance[0]).toMatchObject({
      lat: { side: "app", index: 2 },
      altitude: { side: "app", index: 1 },
      speed: { side: "app", index: 2 },
    });
    expect(reasons(result).sort()).toEqual([
      "app:0:altitude:same_timestamp_conflict",
      "app:0:lat:same_timestamp_conflict",
      "app:0:lng:same_timestamp_conflict",
      "app:1:lat:same_timestamp_conflict",
      "app:1:lng:same_timestamp_conflict",
    ]);
  });

  it("ledgers every earlier identical value when a later one differs", () => {
    const result = merge({
      app: [
        { time: S, source: "x", altitude: 5 },
        { time: S + 100, source: "x", altitude: 5 },
        { time: S + 200, source: "x", altitude: 6 },
      ],
    });
    expect(result.samples[0]!.altitude).toBe(6);
    expect(reasons(result).sort()).toEqual([
      "app:0:altitude:same_timestamp_conflict",
      "app:1:altitude:same_timestamp_conflict",
    ]);
  });

  it("ledgers values FIT cannot store instead of throwing", () => {
    const result = merge({
      app: [at(0, { altitude: -600, ...pos(0) }), at(1, { lat: 89, lng: 179.99 })],
      fitbit: [at(0, { heartRate: 300, cadence: 80 })],
    });
    expect(result.samples[0]).toMatchObject({ cadence: 80, ...pos(0) });
    expect(result.samples[0]!.altitude).toBeUndefined();
    expect(reasons(result)).toEqual([
      "app:0:altitude:outside_fit_range",
      "fitbit:0:heartRate:outside_fit_range",
    ]);
    const lngOut = mergeSamples({
      app: [{ time: S, source: "x", lat: 0, lng: 180.5 }],
      fitbit: [],
      offsetSeconds: 0,
      sport: null,
    });
    expect(lngOut.ledger.map((e) => e.field)).toEqual(["lat", "lng"]);
    expect(FIT_QUANTIZATION.lng.max).toBe(180);
  });

  it("refuses a timestamp outside the FIT range", () => {
    expect(() => merge({ app: [{ time: 0, source: "x" }] })).toThrow(MergeError);
    expect(() =>
      merge({ fitbit: [{ time: FIT_QUANTIZATION.time.min, source: "x" }], offsetSeconds: -1 }),
    ).toThrow(/fitbit sample 0/);
  });
});

describe("impossible-speed filter", () => {
  it("drops Fitbit fixes too fast for the sport, measured from the last kept point", () => {
    const result = merge({
      app: [at(0, pos(0))],
      // 1 s later 100 m away: (100 - 10) / 1 = 90 m/s, far above walking.
      fitbit: [at(1, pos(100)), at(2, pos(3)), at(3, pos(5))],
    });
    expect(result.samples[1]!.lat).toBeUndefined();
    expect(result.samples[2]).toMatchObject(pos(3));
    expect(reasons(result)).toEqual([
      "fitbit:0:lat:impossible_speed",
      "fitbit:0:lng:impossible_speed",
    ]);
    expect(result.ledger[0]!.detail).toMatch(/m\/s over 1 s exceeds 7 m\/s/);
  });

  it("allows 10 m of slack and uses the per-sport limit", () => {
    const fitbit = [at(1, pos(0)), at(2, pos(21.9))];
    expect(merge({ fitbit, sport: "Walk" }).ledger).toHaveLength(2);
    expect(merge({ fitbit, sport: "Run" }).ledger).toEqual([]);
    expect(merge({ fitbit: [at(1, pos(0)), at(2, pos(16.9))], sport: "Walk" }).ledger).toEqual([]);
  });

  it("never filters app fixes", () => {
    expect(merge({ app: [at(0, pos(0)), at(1, pos(5000))] }).ledger).toEqual([]);
  });

  it("does not filter unknown sports unless a default limit is set", () => {
    const fitbit = [at(0, pos(0)), at(1, pos(500))];
    expect(merge({ fitbit, sport: "Swim" }).ledger).toEqual([]);
    const strict = { ...DEFAULT_MERGE_SETTINGS, defaultSpeedLimitMps: 3 };
    expect(merge({ fitbit, sport: "Swim" }, strict).ledger).toHaveLength(2);
  });

  it("re-anchors on the 30th consecutive would-be drop", () => {
    const fitbit = [at(0, pos(0))];
    for (let s = 1; s <= 35; s += 1) fitbit.push(at(s, pos(2000 + s)));
    const result = merge({ fitbit });
    const dropped = new Set(result.ledger.map((e) => e.index));
    expect([...dropped]).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    expect(result.samples[30]).toMatchObject(pos(2030));
    expect(result.samples[35]).toMatchObject(pos(2035));
  });

  it("restarts the drop count after an app fix", () => {
    const fitbit = [at(0, pos(0))];
    for (let s = 1; s <= 40; s += 1) fitbit.push(at(s, pos(2000 + s)));
    const result = merge({ app: [at(20, pos(20))], fitbit });
    // Seconds 1-19 dropped, 20 is the app, 21-49 measured from the app fix.
    expect(result.samples[20]!.lat).toBe(pos(20).lat);
    expect(result.samples[40]!.lat).toBeUndefined();
    const reanchor = { ...DEFAULT_MERGE_SETTINGS, reanchorAfter: 5 };
    expect(merge({ app: [at(20, pos(20))], fitbit }, reanchor).samples[5]).toMatchObject(pos(2005));
  });
});
