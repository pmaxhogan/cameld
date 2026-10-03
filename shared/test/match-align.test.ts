import { describe, expect, it } from "vitest";
import type { ActivitySample } from "../src/activity/sample.ts";
import { alignClocks, pairedDistances } from "../src/match/align.ts";
import { distanceMeters, median, percentile } from "../src/match/geo.ts";
import { DEFAULT_ALIGNMENT_SETTINGS } from "../src/match/settings.ts";
import { syntheticPair } from "./fixtures/pair-generator.ts";
import { SYNTHETIC_ORIGIN, SYNTHETIC_START } from "./fixtures/synthetic-track.ts";

const base = {
  seed: 7,
  durationSeconds: 300,
  speedMps: 1.5,
  lagSeconds: 0,
  appStartDelay: 0,
  appEndEarly: 0,
  fitbitStartDelay: 0,
  fitbitEndEarly: 0,
  fitbitNoiseMeters: 0,
};

/** A fix `metres` north of the synthetic origin at second `s` of the outing. */
function fixAt(second: number, north: number, east = 0): ActivitySample {
  return {
    time: SYNTHETIC_START + second * 1000,
    source: "synthetic",
    lat: SYNTHETIC_ORIGIN.lat + north / 111_320,
    lng: SYNTHETIC_ORIGIN.lng + east / 111_320,
  };
}

describe("geo helpers", () => {
  it("measures distance and percentiles", () => {
    expect(distanceMeters(SYNTHETIC_ORIGIN, SYNTHETIC_ORIGIN)).toBe(0);
    const d = distanceMeters(SYNTHETIC_ORIGIN, { lat: SYNTHETIC_ORIGIN.lat + 0.001, lng: 0.5 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5, 1], 0)).toBe(1);
  });
});

describe("alignClocks", () => {
  it("finds the Fitbit lag with the documented sign (aligned = time + offset)", () => {
    const { app, fitbit } = syntheticPair({ ...base, lagSeconds: 6 });
    const result = alignClocks(app, fitbit);
    expect(result.status).toBe("applied");
    expect(result.offsetSeconds).toBe(6);
    expect(result.parked).toBe(false);
    expect(result.bestCostMeters!).toBeLessThan(2);
    expect(result.sharpness!).toBeGreaterThan(5);
    expect(result.curve).toHaveLength(241);
  });

  it("finds a negative lag", () => {
    const { app, fitbit } = syntheticPair({ ...base, lagSeconds: -4 });
    expect(alignClocks(app, fitbit).offsetSeconds).toBe(-4);
  });

  it("parks a sharp offset above 15 s and does not apply it", () => {
    const { app, fitbit } = syntheticPair({ ...base, lagSeconds: 40 });
    const result = alignClocks(app, fitbit);
    expect(result.status).toBe("large_offset");
    expect(result.parked).toBe(true);
    expect(result.offsetSeconds).toBe(0);
    expect(result.bestOffsetSeconds).toBe(40);
  });

  it("uses offset 0 without parking when the curve is flat", () => {
    const { app, fitbit } = syntheticPair({ ...base, lagSeconds: 5, fitbitNoiseMeters: 8 });
    const result = alignClocks(app, fitbit);
    expect(result.status).toBe("flat");
    expect(result.offsetSeconds).toBe(0);
    expect(result.parked).toBe(false);
    expect(result.sharpness!).toBeLessThan(5);
  });

  it("parks a sharp, small offset with a residual above 2 m", () => {
    // The copy runs 5 m east of the app track: sharp in time, but never closer than 5 m.
    const app = Array.from({ length: 120 }, (_, s) => fixAt(s, s * 4));
    const shifted = (lag: number) =>
      app.map((sample, s) => ({ ...fixAt(s, s * 4, 5), time: sample.time - lag * 1000 }));
    const result = alignClocks(app, shifted(5));
    expect(result.status).toBe("uncertain");
    expect(result.parked).toBe(true);
    expect(result.offsetSeconds).toBe(0);
    expect(result.bestOffsetSeconds).toBe(5);

    const atZero = alignClocks(app, shifted(0));
    expect(atZero.status).toBe("applied");
    expect(atZero.offsetSeconds).toBe(0);
  });

  it("reports an infinitely sharp minimum for an exact copy", () => {
    const app = Array.from({ length: 60 }, (_, s) => fixAt(s, s * 2));
    const fitbit = app.map((sample) => ({ ...sample, time: sample.time - 3000 }));
    const result = alignClocks(app, fitbit);
    expect(result.status).toBe("applied");
    expect(result.offsetSeconds).toBe(3);
    expect(result.bestCostMeters).toBe(0);
    expect(result.sharpness).toBe(Number.POSITIVE_INFINITY);
  });

  it("breaks ties toward the smaller absolute offset, then the negative one", () => {
    // A path that repeats every 10 s, copied 5 s late: offsets -5 and +5 tie.
    const app = Array.from({ length: 80 }, (_, s) => fixAt(s, (s % 10) * 3));
    const fitbit = Array.from({ length: 40 }, (_, i) => {
      const s = i + 20;
      return { ...fixAt(s, ((s - 5) % 10) * 3) };
    });
    const result = alignClocks(app, fitbit);
    expect(result.bestOffsetSeconds).toBe(-5);
    expect(result.bestCostMeters).toBe(0);
    expect(result.sharpness).toBeNull();
    expect(result.status).toBe("flat");
  });

  it("is flat when no neighbour can be scored", () => {
    const app = Array.from({ length: 10 }, (_, s) => fixAt(s, s * 5));
    const result = alignClocks(app, app);
    expect(result.bestOffsetSeconds).toBe(0);
    expect(result.sharpness).toBeNull();
    expect(result.status).toBe("flat");
  });

  it("scores the one neighbour inside the search range at the edge", () => {
    const app = Array.from({ length: 60 }, (_, s) => fixAt(s, s * 2));
    const fitbit = app.map((sample) => ({ ...sample, time: sample.time - 120_000 }));
    const result = alignClocks(app, fitbit);
    expect(result.bestOffsetSeconds).toBe(120);
    expect(result.status).toBe("large_offset");
  });

  it("returns no_gps when nothing can be paired", () => {
    const { app } = syntheticPair(base);
    const result = alignClocks(app, [{ time: SYNTHETIC_START, source: "fitbit", heartRate: 90 }]);
    expect(result.status).toBe("no_gps");
    expect(result.bestOffsetSeconds).toBeNull();
    expect(result.sharpness).toBeNull();
  });

  it("pairs only one app fix per second and honours the settings", () => {
    const app = [fixAt(0, 0), fixAt(0, 50), fixAt(1, 0)];
    expect(pairedDistances(app, [fixAt(0, 0)], 0)).toEqual([0]);
    const narrow = { ...DEFAULT_ALIGNMENT_SETTINGS, searchRangeSeconds: 2, minAlignedPoints: 1 };
    expect(alignClocks(app, [fixAt(0, 0)], narrow).curve).toHaveLength(5);
  });
});
