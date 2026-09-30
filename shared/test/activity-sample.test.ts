import { describe, expect, it } from "vitest";
import { activitySampleSchema, parseActivitySamples } from "../src/activity/sample.ts";
import { syntheticTrack } from "./fixtures/synthetic-track.ts";

describe("activitySampleSchema", () => {
  it("accepts generated samples, with and without position", () => {
    const samples = syntheticTrack({ count: 10, gpsGap: [3, 6] });
    expect(parseActivitySamples(samples)).toEqual(samples);
  });

  it("requires lat and lng together", () => {
    const result = activitySampleSchema.safeParse({ time: 0, source: "s", lat: 0.5 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/both present or both absent/);
    expect(activitySampleSchema.safeParse({ time: 0, source: "s", lng: 0.5 }).success).toBe(false);
  });

  it("rejects missing source, fractional time, unknown fields and negative speed", () => {
    expect(activitySampleSchema.safeParse({ time: 0 }).success).toBe(false);
    expect(activitySampleSchema.safeParse({ time: 0.5, source: "s" }).success).toBe(false);
    expect(activitySampleSchema.safeParse({ time: 0, source: "s", power: 200 }).success).toBe(
      false,
    );
    expect(activitySampleSchema.safeParse({ time: 0, source: "s", speed: -1 }).success).toBe(false);
    expect(() => parseActivitySamples([{ time: 0, source: "" }])).toThrow();
  });
});
