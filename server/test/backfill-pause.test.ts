import { afterEach, describe, expect, it } from "vitest";
import { addSingle } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("backfill pause", () => {
  it("does not start while paused and records the last batch", async () => {
    h = await createHarness({ settings: { backfill: { mode: "backup_only", paused: true } } });
    for (let day = 0; day < 3; day += 1) addSingle(h.world, day);
    expect(h.backfill.lastBatch()).toBeNull();
    const result = await h.backfill.runBatch();
    expect(result.stopped).toBe("paused");
    expect(result.activities).toBe(0);
    expect(h.backfill.running()).toBe(false);
  });

  it("stops between activities when paused mid-batch, and resumes later", async () => {
    h = await createHarness({ settings: { backfill: { mode: "backup_only", pageSize: 2 } } });
    for (let day = 0; day < 5; day += 1) addSingle(h.world, day);
    h.clock.t += 10 * 24 * 3600_000;
    const original = h.backup.backupActivity.bind(h.backup);
    let calls = 0;
    h.backup.backupActivity = async (...args) => {
      calls += 1;
      if (calls === 1) h.settings.update({ backfill: { paused: true } });
      return original(...args);
    };
    const first = await h.backfill.runBatch();
    expect(first.stopped).toBe("paused");
    expect(first.activities).toBe(1);
    expect(h.backfill.lastBatch()).toMatchObject({ stopped: "paused", activities: 1 });

    h.settings.update({ backfill: { paused: false } });
    const second = await h.backfill.runBatch();
    expect(second.stopped).toBe("done");
    expect(second.activities).toBe(4);
  });

  it("pauses after a page whose first activity already saw the pause", async () => {
    h = await createHarness({ settings: { backfill: { mode: "dry_run", pageSize: 2 } } });
    for (let day = 0; day < 3; day += 1) addSingle(h.world, day);
    const list = h.client.listActivities.bind(h.client);
    h.client.listActivities = async (...args) => {
      const page = await list(...args);
      h.settings.update({ backfill: { paused: true } });
      return page;
    };
    const result = await h.backfill.runBatch();
    expect(result).toMatchObject({ stopped: "paused", activities: 0, groups: 0 });
  });
});
