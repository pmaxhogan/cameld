import { describe, expect, it } from "vitest";
import { buildPatch, fieldValues, readPath, setPath, switchValues } from "../src/settings-form.ts";
import { settings } from "./fixtures.ts";

describe("settings form", () => {
  it("reads and writes nested paths", () => {
    const target: Record<string, unknown> = { a: { keep: 1 } };
    setPath(target, ["a", "b", "c"], 5);
    setPath(target, ["a", "d"], 6);
    expect(target).toEqual({ a: { keep: 1, b: { c: 5 }, d: 6 } });
    expect(readPath(target, ["a", "b", "c"])).toBe(5);
  });

  it("converts ms to hours for the form", () => {
    const values = fieldValues(settings());
    expect(values.grace).toBe(48);
    expect(values.partnerWait).toBe(4);
    expect(values.autoOverlap).toBe(0.8);
    expect(values.maxAutoOffset).toBe(15);
    expect(switchValues(settings())).toEqual({
      hide: false,
      upload: true,
      delete: false,
      trial: false,
    });
  });

  it("patches only what changed", () => {
    const s = settings();
    const unchanged = buildPatch(s, fieldValues(s), switchValues(s));
    expect(unchanged).toEqual({ patch: {}, invalid: [], changed: 0 });

    const values = { ...fieldValues(s), grace: 1.5, gpsAuto: 30.5, maxStartDelta: 300.4 };
    const toggles = { ...switchValues(s), hide: true, delete: true };
    expect(buildPatch(s, values, toggles)).toEqual({
      patch: {
        timing: { gracePeriodMs: 5_400_000 },
        match: { gpsAutoMaxMedianMeters: 30.5, maxStartDeltaSeconds: 300 },
        switches: { hide: true, delete: true },
      },
      invalid: [],
      changed: 5,
    });
  });

  it("reports fields that are not numbers", () => {
    const s = settings();
    const result = buildPatch(s, { ...fieldValues(s), grace: "" }, switchValues(s));
    expect(result.invalid).toEqual(["Grace period before deletion (hours)"]);
  });
});
