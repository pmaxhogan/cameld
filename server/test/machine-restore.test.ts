import { afterEach, describe, expect, it } from "vitest";
import { isRestorable, NotRestorableError } from "../src/state/machine.ts";
import { groupEvents, listGroups, requireGroup, writesFor } from "../src/state/repo.ts";
import { addOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const HOUR = 3600_000;

async function acceptingHarness(settings = {}): Promise<Harness> {
  const harness = await createHarness({ settings });
  harness.world.duplicatePolicy = (incoming) =>
    harness.world.live().find((a) => a.externalId === incoming.externalId)?.id ?? null;
  return harness;
}

describe("manual restore of a merge", () => {
  it("un-hides hidden originals with their pre-hide visibility and ends in restored", async () => {
    h = await acceptingHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("hidden");
    expect(outing.app.visibility).toBe("only_me");
    // A later backup (taken after hiding) must not be what restore uses.
    h.clock.t += HOUR;
    await h.backup.backupActivity(outing.app.id);

    const result = await h.machine.restoreGroup(group.id, "synthetic owner reason");
    expect(result.status).toBe("restored");
    expect(result.unhidden.sort()).toEqual([outing.app.id, outing.fitbit.id].sort());
    expect(result.restored).toEqual([]);
    expect(result.flags).toEqual([]);
    expect(outing.app.visibility).toBe("everyone");
    expect(outing.fitbit.visibility).toBe("everyone");
    const after = requireGroup(h.db, group.id);
    expect(after.status).toBe("restored");
    const event = groupEvents(h.db, group.id).at(-1)!;
    expect(event.event).toBe("restored_by_owner");
    expect((event.evidence as { merged: number }).merged).toBe(group.mergedActivityId);
    expect(writesFor(h.db, { groupId: group.id, kind: "restore_web" })).toHaveLength(2);
    // Terminal: nothing more happens to it.
    h.clock.t += 48 * HOUR;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("restored");
    expect(isRestorable(after)).toBe(false);
    await expect(h.machine.restoreGroup(group.id, "again")).rejects.toThrow(NotRestorableError);
  });

  it("re-uploads deleted originals from the backup, even while frozen", async () => {
    h = await acceptingHarness({ switches: { delete: true } });
    const outing = addOuting(h.world);
    await h.poller.poll();
    h.clock.t += 25 * HOUR;
    await h.machine.tick();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("done");
    expect(h.session.deleted.sort()).toEqual([outing.app.id, outing.fitbit.id].sort());
    await h.freeze.freeze("synthetic freeze", null);

    const result = await h.machine.restoreGroup(group.id, "synthetic owner reason");
    expect(result.restored.map((r) => r.outcome)).toEqual(["restored", "restored"]);
    expect(result.restored.every((r) => r.newId !== null)).toBe(true);
    const live = h.world.live().map((a) => a.externalId);
    expect(live).toContain(outing.app.externalId);
    expect(requireGroup(h.db, group.id).status).toBe("restored");
    expect(h.notifier.kinds()).not.toContain("restore_flagged");
  });

  it("flags members it cannot fully restore and notifies", async () => {
    h = await acceptingHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    h.db
      .prepare("DELETE FROM backup_files WHERE activity_id = ? AND kind = 'web_form'")
      .run(outing.fitbit.id);
    h.session.setVisibility = () => Promise.reject(new Error("synthetic web failure"));
    const result = await h.machine.restoreGroup(group.id, "synthetic owner reason");
    expect(result.unhidden).toEqual([]);
    expect(result.flags).toHaveLength(2);
    expect(result.flags.join(" ")).toMatch(/no visibility in the backup/);
    expect(result.flags.join(" ")).toMatch(/synthetic web failure/);
    expect(h.notifier.kinds()).toContain("restore_flagged");
    expect(writesFor(h.db, { groupId: group.id, kind: "restore_web" })[0]?.status).toBe("failed");
  });

  it("reports a deleted original whose re-upload is refused", async () => {
    h = await acceptingHarness({ switches: { delete: true } });
    const outing = addOuting(h.world);
    await h.poller.poll();
    h.clock.t += 25 * HOUR;
    await h.machine.tick();
    const group = listGroups(h.db)[0]!;
    h.db
      .prepare("UPDATE activities SET original_status = 'unavailable' WHERE id = ?")
      .run(outing.app.id);
    const result = await h.machine.restoreGroup(group.id, "synthetic owner reason");
    const refused = result.restored.find((r) => r.id === outing.app.id);
    expect(refused).toEqual({
      id: outing.app.id,
      outcome: "flagged",
      newId: null,
      flags: ["no_original_in_backup"],
    });
  });

  it("refuses groups before any write and serializes with tick()", async () => {
    h = await createHarness();
    addOuting(h.world, { fitbitNoiseMeters: 60 });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("review");
    expect(isRestorable(group)).toBe(false);
    const [tick, restore] = await Promise.allSettled([
      h.machine.tick(),
      h.machine.restoreGroup(group.id, "synthetic"),
    ]);
    expect(tick.status).toBe("fulfilled");
    expect(restore.status).toBe("rejected");
    expect(
      isRestorable({ ...group, status: "parked", hiddenAt: null, deletedIds: [], uploadId: null }),
    ).toBe(false);
    expect(isRestorable({ ...group, status: "parked", hiddenAt: 1 })).toBe(true);
    expect(isRestorable({ ...group, status: "parked", hiddenAt: null, deletedIds: [1] })).toBe(
      true,
    );
    expect(isRestorable({ ...group, status: "parked", hiddenAt: null, uploadId: 5 })).toBe(true);
  });
});

describe("owner notifications", () => {
  it("announces a failed merge and the end of the deletion trial", async () => {
    h = await createHarness({ settings: { trial: { enabled: true, maxPairs: 1 } } });
    addOuting(h.world);
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("done");
    expect(h.notifier.kinds()).toContain("trial_done");

    const failing = await createHarness({
      machine: {
        noLossCheck: () => ({
          ok: false,
          checkedValues: 1,
          representedInOutput: 0,
          representedInLedger: 0,
          outputRecords: 0,
          ledgerEntries: 0,
          issues: [{ kind: "missing_value", detail: "synthetic" }],
        }),
      },
    });
    try {
      addOuting(failing.world);
      await failing.poller.poll();
      expect(failing.notifier.kinds()).toContain("merge_failed");
    } finally {
      await failing.close();
    }
  });

  it("does not announce the trial while trial pairs are still open", async () => {
    h = await createHarness({ settings: { trial: { enabled: true, maxPairs: 3 } } });
    addOuting(h.world);
    await h.poller.poll();
    expect(h.notifier.kinds()).not.toContain("trial_done");
  });
});
