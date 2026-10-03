import { describe, expect, it } from "vitest";
import type { ActivitySample } from "../src/activity/sample.ts";
import {
  evaluateGroup,
  findCandidateGroups,
  matchRecordings,
  partnerWaitOver,
  sideSamples,
  type MatchRecording,
} from "../src/match/matcher.ts";
import { DEFAULT_MATCH_SETTINGS } from "../src/match/settings.ts";
import type { RecordingSource } from "../src/match/source.ts";
import { syntheticPair, type SyntheticPairOptions } from "./fixtures/pair-generator.ts";
import { SYNTHETIC_ORIGIN, SYNTHETIC_START } from "./fixtures/synthetic-track.ts";

const S = SYNTHETIC_START;

function rec(
  id: string,
  source: RecordingSource,
  fromSecond: number,
  toSecond: number,
  extra: Partial<MatchRecording> = {},
): MatchRecording {
  return {
    id,
    source,
    sportType: "Walk",
    startTime: S + fromSecond * 1000,
    endTime: S + toSecond * 1000,
    ...extra,
  };
}

function fromSamples(
  id: string,
  source: RecordingSource,
  samples: ActivitySample[],
): MatchRecording {
  return {
    id,
    source,
    sportType: "Walk",
    startTime: samples[0]!.time,
    endTime: samples[samples.length - 1]!.time,
    samples,
  };
}

const pairBase: SyntheticPairOptions = {
  seed: 3,
  durationSeconds: 300,
  speedMps: 1.5,
  lagSeconds: 5,
  appStartDelay: 0,
  appEndEarly: 0,
  fitbitStartDelay: 0,
  fitbitEndEarly: 0,
  fitbitNoiseMeters: 0,
};

/** Two MatchRecordings built from a synthetic pair. */
function gpsPair(options: Partial<SyntheticPairOptions> = {}): MatchRecording[] {
  const { app, fitbit } = syntheticPair({ ...pairBase, ...options });
  return [fromSamples("a", "app", app), fromSamples("f", "fitbit", fitbit)];
}

/** A fix `north` metres north and `east` metres east of the origin at second `s`. */
function fix(s: number, north: number, east = 0, lagMs = 0): ActivitySample {
  return {
    time: S + s * 1000 - lagMs,
    source: "synthetic",
    lat: SYNTHETIC_ORIGIN.lat + north / 111_320,
    lng: SYNTHETIC_ORIGIN.lng + east / 111_320,
  };
}

describe("findCandidateGroups", () => {
  it("links different sources that overlap or start close, never the same source", () => {
    const groups = findCandidateGroups([
      rec("a1", "app", 0, 100),
      rec("a2", "app", 50, 150),
      rec("f1", "fitbit", 10000, 10100),
      rec("o1", "other", 20000, 20100),
      rec("f2", "fitbit", 20500, 20600),
    ]);
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([["o1", "f2"]]);
  });

  it("orders members by start time, then id", () => {
    const groups = findCandidateGroups([
      rec("z", "fitbit", 0, 100),
      rec("c", "app", 0, 100),
      rec("b", "app", 0, 100),
      rec("b", "app", 0, 100),
    ]);
    expect(groups[0]!.map((r) => r.id)).toEqual(["b", "b", "c", "z"]);
  });
});

describe("evaluateGroup", () => {
  it("auto-matches a GPS pair after applying the clock offset", () => {
    const [result] = matchRecordings(gpsPair());
    expect(result!.decision).toBe("auto");
    expect(result!.reasons).toEqual(["gps_within_auto"]);
    const metrics = result!.metrics!;
    expect(metrics.alignment!.status).toBe("applied");
    expect(metrics.alignment!.offsetSeconds).toBe(5);
    expect(metrics.proximity!.offsetSeconds).toBe(5);
    expect(metrics.proximity!.medianMeters).toBeLessThan(2);
    expect(metrics.proximity!.p90Meters).toBeGreaterThanOrEqual(metrics.proximity!.medianMeters);
    expect(metrics.sportMatch).toBe(true);
    expect(result!.app!.source).toBe("app");
    expect(result!.fitbit!.source).toBe("fitbit");
  });

  it("puts a 25-100 m median in review and above 100 m at none", () => {
    const review = evaluateGroup(
      gpsPair({ lagSeconds: 0, spikes: [{ at: 0, length: 999, meters: 30 }] }),
    );
    expect(review.decision).toBe("review");
    expect(review.reasons).toContain("gps_review_band");
    const far = evaluateGroup(
      gpsPair({ lagSeconds: 0, spikes: [{ at: 0, length: 999, meters: 200 }] }),
    );
    expect(far.decision).toBe("none");
    expect(far.reasons).toContain("gps_too_far");
  });

  it("reviews a pair whose clock offset is parked, measuring at the best offset", () => {
    const result = evaluateGroup(gpsPair({ lagSeconds: 40 }));
    expect(result.decision).toBe("review");
    expect(result.reasons).toContain("alignment_large_offset");
    expect(result.metrics!.proximity!.offsetSeconds).toBe(40);
  });

  it("reviews an uncertain offset", () => {
    const app = Array.from({ length: 120 }, (_, s) => fix(s, s * 4));
    const fitbit = Array.from({ length: 120 }, (_, s) => fix(s, s * 4, 5, 5000));
    const result = evaluateGroup([
      fromSamples("a", "app", app),
      fromSamples("f", "fitbit", fitbit),
    ]);
    expect(result.reasons).toContain("alignment_uncertain");
    expect(result.decision).toBe("review");
  });

  it("reviews GPS tracks that cannot be compared", () => {
    // Fixes never share a second at any offset in the search range.
    const early = Array.from({ length: 20 }, (_, s) => fix(s, s));
    const late = Array.from({ length: 20 }, (_, s) => fix(s + 300, s));
    const noPairs = evaluateGroup([
      rec("a", "app", 0, 400, { samples: early }),
      rec("f", "fitbit", 0, 400, { samples: late }),
    ]);
    expect(noPairs.metrics!.alignment!.status).toBe("no_gps");
    expect(noPairs.metrics!.proximity).toBeNull();
    expect(noPairs.reasons).toContain("gps_not_comparable");

    // A flat curve (both stationary, 10 m apart) whose offset 0 has no pairs.
    const still = (from: number, north: number): ActivitySample[] =>
      Array.from({ length: 20 }, (_, i) => fix(from + i, north));
    const flat = evaluateGroup([
      rec("a", "app", 0, 100, { samples: still(0, 0) }),
      rec("f", "fitbit", 0, 100, { samples: still(50, 10) }),
    ]);
    expect(flat.metrics!.alignment!.status).toBe("flat");
    expect(flat.metrics!.proximity).toBeNull();
    expect(flat.reasons).toContain("gps_not_comparable");
  });

  it("auto-matches a non-GPS pair on sport and overlap", () => {
    const result = evaluateGroup([rec("a", "app", 0, 1000), rec("f", "fitbit", 30, 1000)]);
    expect(result.decision).toBe("auto");
    expect(result.reasons).toEqual(["non_gps_rule"]);
    expect(result.metrics!.alignment).toBeNull();
    expect(result.metrics!.appHasGps).toBe(false);
  });

  it("uses the non-GPS rule when only one side has GPS", () => {
    const [app] = gpsPair();
    const result = evaluateGroup([
      app!,
      { ...rec("f", "fitbit", 0, 0), startTime: app!.startTime, endTime: app!.endTime },
    ]);
    expect(result.decision).toBe("auto");
    expect(result.metrics!.appHasGps).toBe(true);
    expect(result.metrics!.fitbitHasGps).toBe(false);
  });

  it("measures overlap against the shorter side", () => {
    const short = evaluateGroup([rec("a", "app", 0, 3600), rec("f", "fitbit", 100, 1000)]);
    expect(short.metrics!.overlapRatio).toBe(1);
    expect(short.decision).toBe("auto");
    const half = evaluateGroup([rec("a", "app", 0, 1000), rec("f", "fitbit", 500, 1500)]);
    expect(half.metrics!.overlapRatio).toBe(0.5);
    expect(half.decision).toBe("review");
    expect(half.reasons).toContain("overlap_below_auto");
  });

  it("allows a start delta above 600 s only with enough overlap", () => {
    const allowed = evaluateGroup([rec("a", "app", 0, 5000), rec("f", "fitbit", 700, 1000)]);
    expect(allowed.metrics!.startDeltaSeconds).toBe(700);
    expect(allowed.decision).toBe("auto");
    const refused = evaluateGroup([rec("a", "app", 0, 1000), rec("f", "fitbit", 700, 2000)]);
    expect(refused.decision).toBe("none");
    expect(refused.reasons).toContain("start_delta_too_large");
  });

  it("refuses groups with no time overlap", () => {
    const result = evaluateGroup([rec("a", "app", 0, 100), rec("f", "fitbit", 200, 300)]);
    expect(result.decision).toBe("none");
    expect(result.reasons).toContain("no_overlap");
  });

  it("treats a zero-length side as no overlap", () => {
    const result = evaluateGroup([rec("a", "app", 0, 100), rec("f", "fitbit", 50, 50)]);
    expect(result.metrics!.overlapRatio).toBe(0);
    expect(result.decision).toBe("none");
  });

  it("reviews a sport mismatch and an unknown sport", () => {
    const mismatch = evaluateGroup([
      rec("a", "app", 0, 100),
      rec("f", "fitbit", 0, 100, { sportType: "Run" }),
    ]);
    expect(mismatch.reasons).toContain("sport_mismatch");
    expect(mismatch.decision).toBe("review");
    const unknown = evaluateGroup([
      rec("a", "app", 0, 100),
      rec("f", "fitbit", 0, 100, { sportType: null }),
    ]);
    expect(unknown.reasons).toContain("sport_unknown");
    expect(unknown.metrics!.sportMatch).toBe(false);
  });

  it("pairs one app recording with a Fitbit split into parts (1-to-N)", () => {
    const result = evaluateGroup([
      rec("f2", "fitbit", 420, 1000),
      rec("a", "app", 0, 1000),
      rec("f1", "fitbit", 0, 400),
    ]);
    expect(result.decision).toBe("auto");
    expect(result.fitbit!.members.map((r) => r.id)).toEqual(["f1", "f2"]);
    expect(result.fitbit!.primaryId).toBe("f2");
    expect(result.app!.primaryId).toBe("a");
    expect(result.metrics!.fitbitSeconds).toBe(980);
    expect(result.metrics!.overlapRatio).toBe(1);
    expect(result.memberIds).toEqual(["a", "f1", "f2"]);
  });

  it("concatenates the samples of a split side in order", () => {
    const one: ActivitySample = { time: S, source: "x", heartRate: 1 };
    const two: ActivitySample = { time: S + 1000, source: "x", heartRate: 2 };
    const result = evaluateGroup([
      rec("f2", "fitbit", 1, 2, { samples: [two] }),
      rec("f1", "fitbit", 0, 1, { samples: [one] }),
      rec("a", "app", 0, 2),
    ]);
    expect(sideSamples(result.fitbit!)).toEqual([one, two]);
    expect(sideSamples(result.app!)).toEqual([]);
  });

  it("gives the Fitbit role to the other device in an app-vs-other pair", () => {
    const result = evaluateGroup([rec("o", "other", 0, 100), rec("a", "app", 0, 100)]);
    expect(result.app!.source).toBe("app");
    expect(result.fitbit!.source).toBe("other");
    const other = evaluateGroup([rec("o", "other", 0, 100), rec("f", "fitbit", 0, 100)]);
    expect(other.app!.source).toBe("other");
    expect(other.fitbit!.source).toBe("fitbit");
  });

  it("reviews structurally ambiguous groups", () => {
    const manyToMany = evaluateGroup([
      rec("a1", "app", 0, 500),
      rec("a2", "app", 510, 1000),
      rec("f1", "fitbit", 0, 400),
      rec("f2", "fitbit", 420, 1000),
    ]);
    expect(manyToMany.reasons).toContain("many_to_many");
    expect(manyToMany.decision).toBe("review");
    const overlapping = evaluateGroup([
      rec("a", "app", 0, 1000),
      rec("f1", "fitbit", 0, 600),
      rec("f2", "fitbit", 500, 1000),
    ]);
    expect(overlapping.reasons).toContain("overlapping_parts");
    const three = evaluateGroup([
      rec("a", "app", 0, 100),
      rec("f", "fitbit", 0, 100),
      rec("o", "other", 0, 100),
    ]);
    expect(three).toMatchObject({
      decision: "review",
      reasons: ["more_than_two_sources"],
      app: null,
      metrics: null,
    });
    const single = evaluateGroup([rec("a", "app", 0, 100), rec("b", "app", 0, 100)]);
    expect(single.decision).toBe("none");
    expect(single.reasons).toEqual(["single_source"]);
  });
});

describe("partnerWaitOver", () => {
  it("waits four hours by default", () => {
    expect(partnerWaitOver(0, 4 * 3600 * 1000 - 1)).toBe(false);
    expect(partnerWaitOver(0, 4 * 3600 * 1000)).toBe(true);
    expect(partnerWaitOver(0, 10, { ...DEFAULT_MATCH_SETTINGS, partnerWaitMs: 10 })).toBe(true);
  });
});
