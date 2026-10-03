import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SAMPLE_FIELDS, type ActivitySample } from "../src/activity/sample.ts";
import { epochMsToFitSeconds } from "../src/fit/quantization.ts";
import { readFitActivity } from "../src/fit/read.ts";
import { writeFitActivity } from "../src/fit/write.ts";
import { alignClocks } from "../src/match/align.ts";
import type { MergeSide } from "../src/merge/ledger.ts";
import { alignedSecond, mergeSamples, type MergeInput } from "../src/merge/merger.ts";
import { checkNoLoss } from "../src/merge/no-loss.ts";
import { syntheticPair, syntheticPairOptionsArb } from "./fixtures/pair-generator.ts";

const SPORTS = ["Walk", "Hike", "Run", "Ride", "Swim", null] as const;

/** A random synthetic pair plus a merge offset and sport. */
const mergeInputArb: fc.Arbitrary<MergeInput> = fc
  .record({
    options: syntheticPairOptionsArb,
    offsetChoice: fc.oneof(fc.constant<"lag">("lag"), fc.integer({ min: -120, max: 120 })),
    sport: fc.constantFrom(...SPORTS),
  })
  .map(({ options, offsetChoice, sport }) => {
    const { app, fitbit } = syntheticPair(options);
    const offsetSeconds = offsetChoice === "lag" ? options.lagSeconds : offsetChoice;
    return { app, fitbit, offsetSeconds, sport };
  });

function inputSeconds(input: MergeInput): number[] {
  const seconds = new Set<number>();
  for (const side of ["app", "fitbit"] as const) {
    for (const sample of input[side]) {
      seconds.add(alignedSecond(side, sample.time, input.offsetSeconds));
    }
  }
  return [...seconds].sort((a, b) => a - b);
}

describe("merge properties (synthetic pairs)", () => {
  it("the no-loss check passes, the span is the union, nothing is invented", () => {
    fc.assert(
      fc.property(mergeInputArb, (input) => {
        const merged = mergeSamples(input);
        const report = checkNoLoss({ ...input, output: merged.samples, ledger: merged.ledger });
        expect(report.issues).toEqual([]);
        expect(report.ok).toBe(true);

        // Union of time spans: exactly one output record per input second.
        const outSeconds = merged.samples.map((s) => epochMsToFitSeconds(s.time));
        expect(outSeconds).toEqual(inputSeconds(input));

        // Every output value is an input value from the same aligned second.
        const inputs: Record<MergeSide, readonly ActivitySample[]> = input;
        merged.samples.forEach((sample, i) => {
          for (const field of SAMPLE_FIELDS) {
            const ref = merged.provenance[i]![field];
            if (sample[field] === undefined) {
              expect(ref).toBeUndefined();
              continue;
            }
            const origin = inputs[ref!.side][ref!.index]!;
            expect(origin[field]).toBe(sample[field]);
            expect(alignedSecond(ref!.side, origin.time, input.offsetSeconds)).toBe(outSeconds[i]);
          }
        });

        // Only Fitbit-derived positions are ever speed-filtered.
        for (const entry of merged.ledger) {
          if (entry.reason === "impossible_speed") expect(entry.side).toBe("fitbit");
        }
      }),
      { numRuns: 150 },
    );
  });

  it("the app position wins wherever the app has a fix", () => {
    fc.assert(
      fc.property(mergeInputArb, (input) => {
        const merged = mergeSamples(input);
        const lastAppFix = new Map<number, ActivitySample>();
        for (const sample of input.app) {
          if (sample.lat !== undefined) lastAppFix.set(epochMsToFitSeconds(sample.time), sample);
        }
        for (const sample of merged.samples) {
          const app = lastAppFix.get(epochMsToFitSeconds(sample.time));
          if (app !== undefined) {
            expect(sample.lat).toBe(app.lat);
            expect(sample.lng).toBe(app.lng);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("FIT write then read of the merge still passes the no-loss check", () => {
    fc.assert(
      fc.property(mergeInputArb, (input) => {
        const merged = mergeSamples(input);
        const bytes = writeFitActivity(merged.samples, { sport: "walking" });
        const read = readFitActivity(bytes, { source: "merged" });
        expect(read.samples).toHaveLength(merged.samples.length);
        const report = checkNoLoss({ ...input, output: read.samples, ledger: merged.ledger });
        expect(report.issues).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it("alignment recovers a small Fitbit lag with the documented sign", () => {
    fc.assert(
      fc.property(
        syntheticPairOptionsArb.map((options) => ({
          ...options,
          durationSeconds: 300,
          speedMps: Math.max(options.speedMps, 1.2),
          appGap: undefined,
          spikes: [],
          fitbitNoiseMeters: 0,
          // Every-second gaps would leave the Fitbit with no fix at all.
          fitbitMissingFixEvery:
            options.fitbitMissingFixEvery === 1 ? 0 : options.fitbitMissingFixEvery,
          lagSeconds: options.lagSeconds % 16 || 0, // never -0
        })),
        (options) => {
          const { app, fitbit } = syntheticPair(options);
          const result = alignClocks(app, fitbit);
          expect(result.status).toBe("applied");
          expect(result.offsetSeconds).toBe(options.lagSeconds);
        },
      ),
      { numRuns: 40 },
    );
  });
});
