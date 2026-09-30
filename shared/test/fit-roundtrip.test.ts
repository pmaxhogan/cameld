import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SAMPLE_FIELDS, type ActivitySample } from "../src/activity/sample.ts";
import { readFitActivity } from "../src/fit/read.ts";
import { FIT_QUANTIZATION } from "../src/fit/quantization.ts";
import { quantizeTime, writeFitActivity } from "../src/fit/write.ts";
import { sampleListArb } from "./fixtures/arbitraries.ts";
import { syntheticTrack } from "./fixtures/synthetic-track.ts";

/**
 * Floating point slack on top of the documented half-step bound. The SDK
 * computes (value + offset) * scale in doubles, so a value that sits exactly
 * on a half step can land a hair either side. The slack is relative to the
 * magnitude so it stays meaningful for both 0.001 m/s and 4e7 m values.
 */
function slack(value: number): number {
  return 1e-9 + Math.abs(value) * 1e-12;
}

/** Assert that `read` is `written` after FIT quantization, field by field. */
function expectWithinQuantization(written: ActivitySample, read: ActivitySample): void {
  expect(read.time).toBe(quantizeTime(written.time));
  expect(Math.abs(read.time - written.time)).toBeLessThanOrEqual(FIT_QUANTIZATION.time.step / 2);
  expect(read.source).toBe(written.source);
  for (const field of SAMPLE_FIELDS) {
    const before = written[field];
    const after = read[field];
    if (before === undefined) {
      expect(after, `${field} appeared from nowhere`).toBeUndefined();
      continue;
    }
    expect(after, `${field} was lost`).toBeTypeOf("number");
    const bound = FIT_QUANTIZATION[field].step / 2 + slack(before);
    expect(
      Math.abs(after! - before),
      `${field}: wrote ${before}, read ${after}, bound ${bound}`,
    ).toBeLessThanOrEqual(bound);
  }
}

describe("FIT write then read", () => {
  it("preserves every sample of a synthetic outing within quantization", () => {
    const samples = syntheticTrack({ count: 300, gpsGap: [100, 130], source: "phone" });
    const parsed = readFitActivity(writeFitActivity(samples, { sport: "running" }), {
      source: "phone",
    });
    expect(parsed.format).toBe("fit");
    expect(parsed.sport).toBe("running");
    expect(parsed.startTime).toBe(samples[0]!.time);
    expect(parsed.samples).toHaveLength(samples.length);
    samples.forEach((sample, i) => expectWithinQuantization(sample, parsed.samples[i]!));
  });

  it("property: every sample survives, in order, within the documented bounds", () => {
    fc.assert(
      fc.property(sampleListArb, (samples) => {
        const parsed = readFitActivity(writeFitActivity(samples), { source: "synthetic" });
        expect(parsed.samples).toHaveLength(samples.length);
        samples.forEach((sample, i) => expectWithinQuantization(sample, parsed.samples[i]!));
      }),
      { numRuns: 300 },
    );
  });

  it("property: writing what was read is a fixed point (quantization is idempotent)", () => {
    fc.assert(
      fc.property(sampleListArb, (samples) => {
        const once = readFitActivity(writeFitActivity(samples), { source: "synthetic" }).samples;
        const twice = readFitActivity(writeFitActivity(once), { source: "synthetic" }).samples;
        expect(twice).toEqual(once);
      }),
      { numRuns: 100 },
    );
  });
});
