import { describe, expect, it } from "vitest";
import type { ActivitySample } from "../src/activity/sample.ts";
import { readFitActivity } from "../src/fit/read.ts";
import { writeFitActivity } from "../src/fit/write.ts";
import { mergeSamples, type MergeInput } from "../src/merge/merger.ts";
import { checkNoLoss, sameWithinQuantization } from "../src/merge/no-loss.ts";
import { syntheticPair } from "./fixtures/pair-generator.ts";

function scenario() {
  const { app, fitbit } = syntheticPair({
    seed: 11,
    durationSeconds: 200,
    speedMps: 1.4,
    lagSeconds: 4,
    appStartDelay: 20,
    appEndEarly: 10,
    fitbitStartDelay: 0,
    fitbitEndEarly: 30,
    fitbitNoiseMeters: 3,
    appGap: [80, 110],
    appDuplicateEvery: 7,
    fitbitMissingFixEvery: 5,
    spikes: [{ at: 90, length: 3, meters: 800 }],
  });
  const input: MergeInput = { app, fitbit, offsetSeconds: 4, sport: "Walk" };
  const merged = mergeSamples(input);
  return { input, merged };
}

describe("sameWithinQuantization", () => {
  it("accepts identical values and values within half a FIT step", () => {
    expect(sameWithinQuantization("heartRate", 120, undefined)).toBe(false);
    expect(sameWithinQuantization("heartRate", 120.4, 120)).toBe(true);
    expect(sameWithinQuantization("heartRate", 120.6, 120)).toBe(false);
    expect(sameWithinQuantization("altitude", 12.34, 12.4)).toBe(true);
    expect(sameWithinQuantization("altitude", 12.34, 12.6)).toBe(false);
  });
});

describe("checkNoLoss", () => {
  it("passes on a merge, in memory and after a FIT write and read", () => {
    const { input, merged } = scenario();
    expect(merged.ledger.map((e) => e.reason)).toEqual(
      expect.arrayContaining([
        "position_app_preferred",
        "impossible_speed",
        "field_source_preferred",
        "same_timestamp_conflict",
      ]),
    );
    const report = checkNoLoss({ ...input, output: merged.samples, ledger: merged.ledger });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkedValues).toBe(report.representedInOutput + report.representedInLedger);
    // A ledgered value within half a FIT step of the kept one also counts as in the output.
    expect(report.representedInLedger).toBeLessThanOrEqual(merged.ledger.length);
    expect(report.outputRecords).toBe(merged.samples.length);
    expect(report.ledgerEntries).toBe(merged.ledger.length);

    const read = readFitActivity(writeFitActivity(merged.samples, { sport: "walking" }), {
      source: "merged",
    });
    const fromFit = checkNoLoss({ ...input, output: read.samples, ledger: merged.ledger });
    expect(fromFit.issues).toEqual([]);
  });

  it("reports a value that is neither in the output nor in the ledger", () => {
    const { input, merged } = scenario();
    const ledger = merged.ledger.filter((e) => e.reason !== "impossible_speed");
    const report = checkNoLoss({ ...input, output: merged.samples, ledger });
    expect(report.ok).toBe(false);
    expect(new Set(report.issues.map((i) => i.kind))).toEqual(new Set(["missing_value"]));
    expect(report.issues[0]).toMatchObject({ side: "fitbit", field: "lat" });
  });

  it("reports a missing output record", () => {
    const { input, merged } = scenario();
    const output = merged.samples.slice(1);
    const report = checkNoLoss({ ...input, output, ledger: merged.ledger });
    expect(report.issues.map((i) => i.kind)).toContain("missing_record");
  });

  it("reports ledger entries that do not match an input value", () => {
    const { input, merged } = scenario();
    const first = merged.ledger[0]!;
    const ledger = [
      ...merged.ledger,
      { ...first, value: first.value + 1 },
      { ...first, index: 99_999 },
    ];
    const report = checkNoLoss({ ...input, output: merged.samples, ledger });
    expect(report.issues.filter((i) => i.kind === "bad_ledger_entry")).toHaveLength(2);
  });

  it("reports invented values and records", () => {
    const { input, merged } = scenario();
    const output: ActivitySample[] = merged.samples.map((s) => ({ ...s }));
    output[0]!.heartRate = 250;
    output[1]!.lat = output[1]!.lat! + 0.01;
    output[2]!.cadence = undefined;
    output.push({ time: output[output.length - 1]!.time + 60_000, source: "merged" });
    const report = checkNoLoss({ ...input, output, ledger: merged.ledger });
    const kinds = report.issues.map((i) => i.kind);
    expect(kinds).toContain("untraceable_value");
    expect(kinds).toContain("untraceable_record");
    expect(report.issues.find((i) => i.kind === "untraceable_value")).toMatchObject({
      field: "heartRate",
      value: 250,
    });
  });

  it("matches a position only when lat and lng are in the same record", () => {
    const time = Date.UTC(2020, 1, 2);
    const app: ActivitySample[] = [{ time, source: "x", lat: 0.5, lng: 0.5 }];
    const output: ActivitySample[] = [
      { time, source: "merged", lat: 0.5, lng: 0.6 },
      { time, source: "merged", lat: 0.6, lng: 0.5 },
    ];
    const report = checkNoLoss({ app, fitbit: [], offsetSeconds: 0, output, ledger: [] });
    expect(report.issues.filter((i) => i.kind === "missing_value")).toHaveLength(2);
  });
});
