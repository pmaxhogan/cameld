import { describe, expect, it } from "vitest";
import {
  dryRunRow,
  fmtDate,
  fmtNum,
  fmtPct,
  fmtTime,
  prettyJson,
  readMetrics,
  severityOf,
  usagePct,
} from "../src/format.ts";
import { MATCH } from "./fixtures.ts";

describe("format", () => {
  it("formats times and dates in local time", () => {
    const ms = new Date(2026, 0, 2, 3, 4).getTime();
    expect(fmtTime(ms)).toBe("2026-01-02 03:04");
    expect(fmtDate(new Date(2026, 10, 12).getTime())).toBe("2026-11-12");
    expect(fmtTime(null)).toBe("-");
  });

  it("formats numbers and percentages", () => {
    expect(fmtPct(0.934)).toBe("93%");
    expect(fmtPct("x")).toBe("-");
    expect(fmtNum(8.25)).toBe("8.3");
    expect(fmtNum(8.25, " m", 0)).toBe("8 m");
    expect(fmtNum(Number.NaN)).toBe("-");
    expect(fmtNum(null)).toBe("-");
  });

  it("computes window usage, guarding a zero limit", () => {
    expect(usagePct({ limit: 200, usage: 50 })).toBe(25);
    expect(usagePct({ limit: 10, usage: 50 })).toBe(100);
    expect(usagePct({ limit: 0, usage: 5 })).toBe(0);
  });

  it("reads a full match summary", () => {
    expect(readMetrics(MATCH)).toEqual({
      decision: "review",
      overlap: "93%",
      startDelta: "12 s",
      median: "8.3 m",
      p90: "20 m",
      alignStatus: "uncertain",
      alignOffset: "0 s",
      sharpness: "1.23",
      reasons: ["alignment_uncertain", "gps_far"],
    });
  });

  it("reads missing or malformed summaries as dashes", () => {
    for (const bad of [null, undefined, [], "x", { metrics: null }]) {
      const view = readMetrics(bad);
      expect(view.decision).toBe("-");
      expect(view.overlap).toBe("-");
      expect(view.alignStatus).toBe("-");
      expect(view.reasons).toEqual([]);
    }
  });

  it("builds dry-run rows for every report shape", () => {
    const base = { groupKey: "k", startMs: new Date(2026, 0, 2, 3, 4).getTime(), decision: "auto" };
    expect(
      dryRunRow({
        ...base,
        report: { members: [{}, {}], match: MATCH, noLoss: { ok: true, points: 1200 } },
      }),
    ).toEqual({
      key: "k",
      start: "2026-01-02 03:04",
      decision: "auto",
      members: 2,
      overlap: "93%",
      median: "8.3 m",
      noLoss: "ok (1200 points)",
    });
    const failed = dryRunRow({ ...base, report: { noLoss: { ok: false, error: "gap" } } });
    expect(failed.noLoss).toBe("failed: gap");
    expect(failed.members).toBe(0);
    expect(dryRunRow({ ...base, report: { noLoss: { ok: false } } }).noLoss).toBe(
      "failed: unknown",
    );
    expect(dryRunRow({ ...base, report: null }).noLoss).toBe("-");
  });

  it("maps decisions to tag severities", () => {
    expect(severityOf("auto")).toBe("success");
    expect(severityOf("merge_check_failed")).toBe("danger");
    expect(severityOf("something_else")).toBe("secondary");
  });

  it("pretty prints evidence", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson(undefined)).toBe("null");
  });
});
