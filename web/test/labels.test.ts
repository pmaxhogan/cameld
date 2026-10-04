import { describe, expect, it } from "vitest";
import {
  eventLabel,
  evidenceEntries,
  groupTitle,
  lastErrorLabel,
  parkLabel,
  shortVersion,
  sourceLabel,
  statusLabel,
  stoppedLabel,
  stravaActivityUrl,
  writeKindLabel,
} from "../src/labels.ts";

describe("labels", () => {
  it("explains park reasons and events, falling back to the raw code", () => {
    expect(parkLabel("deletion_switch_off")).toBe(
      "Parked: deletion is off, so both originals were left in place on Strava",
    );
    expect(parkLabel("original_missing")).toContain("not in the backup");
    expect(parkLabel("something_new")).toBe("something_new");
    expect(parkLabel(null)).toBe("-");
    expect(eventLabel("upload_duplicate")).toBe(
      "Strava rejected the merged upload as a duplicate of the original (expected while originals exist)",
    );
    expect(eventLabel("deletion_switch_off")).toBe(parkLabel("deletion_switch_off"));
    expect(eventLabel("scored_auto")).toBe("scored_auto");
  });

  it("names statuses, write kinds and sources", () => {
    expect(statusLabel("b_rejected")).toBe("Upload rejected as duplicate");
    expect(statusLabel(null)).toBe("-");
    expect(statusLabel("weird")).toBe("weird");
    expect(writeKindLabel("delete")).toBe("Delete original");
    expect(writeKindLabel("other")).toBe("other");
    expect(sourceLabel("fitbit")).toBe("Wrist (Fitbit)");
    expect(sourceLabel("garmin")).toBe("garmin");
  });

  it("reads lastError markers", () => {
    expect(lastErrorLabel(null)).toBe("-");
    expect(lastErrorLabel("wait:grace_period")).toBe(
      "Waiting for the grace period before deletion",
    );
    expect(lastErrorLabel("wait:new_reason")).toBe("Waiting for new_reason");
    expect(lastErrorLabel("transient:fetch failed: x")).toBe(
      "Temporary problem, retrying: fetch failed: x",
    );
    expect(lastErrorLabel("error:boom")).toBe("Error: boom");
    expect(lastErrorLabel("deletion_refused")).toBe("A delete was refused by a safety check");
    expect(lastErrorLabel("wait:")).toBe("wait:");
  });

  it("builds Strava links and group titles", () => {
    expect(stravaActivityUrl(42)).toBe("https://www.strava.com/activities/42");
    const start = new Date(2031, 4, 6, 7, 8).getTime();
    expect(groupTitle({ startMs: start, sportType: "Ride", appIds: [1, 2], fitbitIds: [3] })).toBe(
      "2031-05-06 Ride, 2 phone + 1 wrist recordings",
    );
    expect(groupTitle({ startMs: start, sportType: null, appIds: [], fitbitIds: [3] })).toBe(
      "2031-05-06 Activity, 0 phone + 1 wrist recording",
    );
  });

  it("flattens evidence into readable rows", () => {
    expect(evidenceEntries(null)).toEqual([]);
    expect(evidenceEntries(undefined)).toEqual([]);
    expect(evidenceEntries("plain")).toEqual([{ key: "value", value: "plain" }]);
    expect(evidenceEntries([1, 2])).toEqual([{ key: "value", value: "1, 2" }]);
    expect(
      evidenceEntries({
        ok: true,
        n: 3,
        none: null,
        ids: [1, "a"],
        empty: [],
        objs: [{ a: 1 }],
        nested: { inner: { deep: { deeper: 1 } }, flag: false },
        blank: {},
      }),
    ).toEqual([
      { key: "ok", value: "true" },
      { key: "n", value: "3" },
      { key: "none", value: "null" },
      { key: "ids", value: "1, a" },
      { key: "empty", value: "(none)" },
      { key: "objs", value: '[{"a":1}]' },
      { key: "nested.inner.deep", value: '{"deeper":1}' },
      { key: "nested.flag", value: "false" },
      { key: "blank", value: "{}" },
    ]);
  });

  it("says why a backfill batch stopped", () => {
    expect(stoppedLabel({ stopped: "budget", budgetLimit: "daily" })).toBe(
      "budget (cameld daily cap)",
    );
    expect(stoppedLabel({ stopped: "budget", budgetLimit: "fifteen_minute" })).toBe(
      "budget (cameld 15-minute cap)",
    );
    expect(stoppedLabel({ stopped: "budget", budgetLimit: null })).toBe("budget");
    expect(stoppedLabel({ stopped: "rate_limited", budgetLimit: null })).toBe(
      "Strava app rate limit (all consumers)",
    );
    expect(stoppedLabel({ stopped: "done", budgetLimit: null })).toContain("oldest activity");
    expect(stoppedLabel({ stopped: "later", budgetLimit: null })).toBe("later");
  });

  it("shortens a git sha version and keeps others", () => {
    expect(shortVersion("0123456789abcdef0123456789abcdef01234567")).toBe("v0123456");
    expect(shortVersion("0.1.0")).toBe("v0.1.0");
  });
});
