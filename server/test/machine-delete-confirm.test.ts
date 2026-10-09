import { afterEach, describe, expect, it } from "vitest";
import { NotRestorableError } from "../src/state/machine.ts";
import {
  beginWrite,
  finishWrite,
  groupEvents,
  listGroups,
  patchGroup,
  requireGroup,
  writesFor,
} from "../src/state/repo.ts";
import { addOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";

/**
 * Strava's API is eventually consistent after a web delete: it kept serving
 * a web-deleted activity for minutes. A delete the web side confirmed waits
 * for the API 404 inside `timing.deleteConfirmWindowMs` (default 60 minutes)
 * and is never sent twice. All data here is synthetic (fixtures/).
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const MINUTE = 60_000;

/** Fresh (pre-delete) backups taken, per activity id. */
function countFreshBackups(harness: Harness): Map<number, number> {
  const counts = new Map<number, number>();
  const original = harness.backup.backupActivity.bind(harness.backup);
  harness.backup.backupActivity = (id, options = {}) => {
    if (options.fresh === true) counts.set(id, (counts.get(id) ?? 0) + 1);
    return original(id, options);
  };
  return counts;
}

/** Strava refuses the merge while an original exists; restored originals are accepted. */
function refuseMergesOnly(harness: Harness, duplicateOf: number): void {
  harness.world.duplicatePolicy = (incoming) =>
    incoming.externalId.startsWith("cameld-merge-") ? duplicateOf : null;
}

function deleteCalls(harness: Harness): number[] {
  return harness.session.calls.filter((c) => c.op === "delete").map((c) => c.id as number);
}

describe("path B: the API lags a web delete", () => {
  it("waits for the API 404 across ticks, records it gone, and carries on", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    const fresh = countFreshBackups(h);
    let lagging = true;
    h.world.apiLags = (id) => lagging && id === outing.fitbit.id;

    await h.poller.poll();
    let group = listGroups(h.db)[0]!;
    expect(group).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_confirming",
    });
    expect(h.freeze.isFrozen()).toBe(false);
    expect(group.deletedIds).toEqual([]);
    expect(h.machine.activity(outing.fitbit.id)?.goneAt).toBeNull();
    expect(writesFor(h.db, { kind: "delete" })[0]).toMatchObject({
      status: "sent",
      result: { stillExists: true, webError: null },
    });
    expect(groupEvents(h.db, group.id).map((e) => e.event)).toContain("delete_sent");

    for (let tick = 0; tick < 2; tick += 1) {
      h.clock.t += 10 * MINUTE;
      await h.machine.tick();
      expect(listGroups(h.db)[0]?.status).toBe("b_delete_fitbit");
    }
    lagging = false;
    h.clock.t += 10 * MINUTE;
    await h.machine.tick();

    group = requireGroup(h.db, group.id);
    expect(group.status).toBe("done");
    expect(h.freeze.isFrozen()).toBe(false);
    expect(deleteCalls(h)).toEqual([outing.fitbit.id, outing.app.id]);
    expect(fresh.get(outing.fitbit.id)).toBe(1);
    expect(fresh.get(outing.app.id)).toBe(1);
    expect(h.snapshotter.taken.filter((s) => s.includes("pre-delete"))).toHaveLength(2);
    const writes = writesFor(h.db, { kind: "delete" });
    expect(writes.map((w) => [w.targetId, w.status])).toEqual([
      [outing.fitbit.id, "done"],
      [outing.app.id, "done"],
    ]);
    expect(writes[0]?.result).toMatchObject({
      confirmed: "api_404",
      late: true,
      delayMs: 30 * MINUTE,
    });
    const deleted = groupEvents(h.db, group.id).filter((e) => e.event === "deleted");
    expect(deleted).toHaveLength(2);
    expect(deleted[0]?.evidence).toMatchObject({
      id: outing.fitbit.id,
      late: true,
      permit: "on",
      snapshot: expect.stringContaining("pre-delete"),
    });
    const metrics = await h.metrics.render();
    expect(metrics).toContain("cameld_delete_confirmation_delay_seconds_count 2");
    expect(metrics).toMatch(/cameld_delete_confirmation_delay_seconds_bucket\{le="1800"\} 2/);
  });

  it("confirms a sent delete while frozen, but restores nothing until it settles", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    refuseMergesOnly(h, outing.app.id);
    let lagging = true;
    h.world.apiLags = (id) => lagging && id === outing.fitbit.id;
    await h.poller.poll();
    await h.freeze.freeze("synthetic failure elsewhere", null);
    h.clock.t += 10 * MINUTE;
    await h.machine.tick();
    expect(listGroups(h.db)[0]).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_confirming",
    });
    lagging = false;
    h.clock.t += 10 * MINUTE;
    await h.machine.tick();
    // Confirmed gone, then restored because writes are frozen mid path B.
    const group = listGroups(h.db)[0]!;
    expect(group.deletedIds).toEqual([outing.fitbit.id]);
    expect(group.status).toBe("failed");
    expect(h.world.live().some((a) => a.externalId === outing.fitbit.externalId)).toBe(true);
    expect(deleteCalls(h)).toEqual([outing.fitbit.id]);
  });

  it("freezes once when the window runs out while frozen, and flags the restore", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.world.apiLags = (id) => id === outing.fitbit.id;
    await h.poller.poll();
    await h.freeze.freeze("synthetic failure elsewhere", null);
    h.clock.t += 61 * MINUTE;
    await h.machine.tick();
    expect(h.notifier.kinds().filter((k) => k === "deletion_unconfirmed")).toHaveLength(1);
    expect(h.freeze.events().filter((e) => e.action === "freeze_again")).toHaveLength(0);
    expect(writesFor(h.db, { kind: "delete" })[0]?.status).toBe("failed");
    await h.machine.tick();
    expect(h.notifier.kinds().filter((k) => k === "deletion_unconfirmed")).toHaveLength(1);
    expect(listGroups(h.db)[0]?.lastError).toBe("wait:frozen");
    expect(deleteCalls(h)).toEqual([outing.fitbit.id]);
  });

  it("flags an unconfirmed member when path B restores the others", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    // The merge is refused while the app copy is listed (the API still lists it).
    h.world.duplicatePolicy = (incoming) =>
      incoming.externalId.startsWith("cameld-merge-") && h.world.apiGet(outing.app.id) !== undefined
        ? outing.app.id
        : null;
    h.world.apiLags = (id) => id === outing.app.id;
    await h.poller.poll();
    let group = listGroups(h.db)[0]!;
    expect(group).toMatchObject({ status: "b_delete_app", deletedIds: [outing.fitbit.id] });
    await h.freeze.freeze("synthetic failure elsewhere", null);
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.lastError).toBe("wait:deletion_confirming");
    h.clock.t += 61 * MINUTE;
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.lastError).toBe("wait:deletion_unconfirmed");
    await h.machine.tick();
    group = requireGroup(h.db, group.id);
    expect(group.status).toBe("restore_flagged");
    const restored = groupEvents(h.db, group.id).find((e) => e.event === "restored");
    expect(restored?.evidence).toMatchObject({
      outcomes: [
        { id: outing.fitbit.id, outcome: { status: "restored" } },
        { id: outing.app.id, outcome: { status: "flagged", reason: "delete_sent_unconfirmed" } },
      ],
    });
  });
});

describe("recovery of a delete frozen before the confirmation window existed", () => {
  /**
   * The state an earlier release left: the web deleted the wrist copy, one
   * immediate API GET still found it, so the write was finished as failed
   * {stillExists, webError: null} and writes froze.
   */
  async function frozenAfterLegacyDelete(sentAt: (h: Harness) => number) {
    h = await createHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.parkedReason).toBe("deletion_switch_off");
    h.settings.update({ switches: { delete: true } });
    patchGroup(
      h.db,
      group.id,
      { status: "b_delete_fitbit", parkedReason: null, resumeStatus: null },
      h.clock.now(),
    );
    const writeId = beginWrite(
      h.db,
      { groupId: group.id, kind: "delete", targetId: outing.fitbit.id },
      sentAt(h),
    );
    outing.fitbit.exists = false;
    finishWrite(h.db, writeId, "failed", { stillExists: true, webError: null }, sentAt(h) + 1000);
    await h.freeze.freeze(`group ${group.id}: delete of ${outing.fitbit.id} was not confirmed`, {
      id: outing.fitbit.id,
      webError: null,
    });
    const fresh = countFreshBackups(h);
    return { outing, group, writeId, fresh };
  }

  it("records the delete gone after the owner unfreezes, without sending it again", async () => {
    const { outing, group, writeId, fresh } = await frozenAfterLegacyDelete((x) => x.clock.now());
    h.clock.t += 40 * MINUTE;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id)).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:frozen",
    });
    await h.freeze.unfreeze("owner: the website shows it deleted");
    await h.machine.tick();

    expect(requireGroup(h.db, group.id).status).toBe("done");
    expect(h.freeze.isFrozen()).toBe(false);
    expect(deleteCalls(h)).toEqual([outing.app.id]);
    expect(fresh.get(outing.fitbit.id)).toBeUndefined();
    expect(fresh.get(outing.app.id)).toBe(1);
    const first = writesFor(h.db, { kind: "delete" }).find((w) => w.id === writeId);
    expect(first).toMatchObject({
      status: "done",
      result: {
        confirmed: "api_404",
        late: true,
        delayMs: 40 * MINUTE,
        firstCheck: { status: "failed", result: { stillExists: true, webError: null } },
      },
    });
    expect(
      writesFor(h.db, { kind: "delete" }).filter((w) => w.targetId === outing.fitbit.id),
    ).toHaveLength(1);
    expect(h.machine.activity(outing.fitbit.id)?.goneAt).not.toBeNull();
    const late = groupEvents(h.db, group.id).find(
      (e) => e.event === "deleted" && (e.evidence as { late?: boolean }).late === true,
    );
    expect(late?.evidence).toMatchObject({ id: outing.fitbit.id, writeId, confirmed: "api_404" });
  });

  it("freezes again, sending nothing, when the API still lists it past the window", async () => {
    const { outing, group, fresh } = await frozenAfterLegacyDelete((x) => x.clock.now());
    h.world.apiLags = (id) => id === outing.fitbit.id;
    h.clock.t += 2 * 60 * MINUTE;
    await h.freeze.unfreeze("owner");
    await h.machine.tick();
    expect(h.freeze.isFrozen()).toBe(true);
    expect(h.freeze.state().reason).toMatch(/sent but not confirmed by the API within 60 minutes/);
    expect(requireGroup(h.db, group.id)).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_unconfirmed",
    });
    expect(deleteCalls(h)).toEqual([]);
    expect(fresh.size).toBe(0);
  });

  it("waits again when the owner unfreezes inside the window", async () => {
    const { outing, group } = await frozenAfterLegacyDelete((x) => x.clock.now());
    h.world.apiLags = (id) => id === outing.fitbit.id;
    h.clock.t += 5 * MINUTE;
    await h.freeze.unfreeze("owner");
    await h.machine.tick();
    expect(h.freeze.isFrozen()).toBe(false);
    expect(requireGroup(h.db, group.id).lastError).toBe("wait:deletion_confirming");
    expect(writesFor(h.db, { kind: "delete" })[0]?.status).toBe("sent");
    expect(deleteCalls(h)).toEqual([]);
  });
});

describe("path A and restore with a lagging API", () => {
  async function pathA(): Promise<Harness> {
    const harness = await createHarness({
      settings: { timing: { gracePeriodMs: 0 }, switches: { delete: true } },
    });
    harness.world.duplicatePolicy = (incoming) =>
      harness.world.live().find((a) => a.externalId === incoming.externalId)?.id ?? null;
    return harness;
  }

  it("waits in a_deleting for the API, then confirms and finishes", async () => {
    h = await pathA();
    const outing = addOuting(h.world);
    let lagging = true;
    h.world.apiLags = (id) => lagging && id === outing.app.id;
    await h.poller.poll();
    expect(listGroups(h.db)[0]).toMatchObject({
      status: "a_deleting",
      lastError: "wait:deletion_confirming",
    });
    lagging = false;
    h.clock.t += 15 * MINUTE;
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("done");
    expect(deleteCalls(h).sort()).toEqual([outing.app.id, outing.fitbit.id].sort());
    expect(h.freeze.isFrozen()).toBe(false);
  });

  it("refuses an owner restore while a delete waits for the API, then restores it", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    refuseMergesOnly(h, outing.app.id);
    let lagging = true;
    h.world.apiLags = (id) => lagging && id === outing.fitbit.id;
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    await expect(h.machine.restoreGroup(group.id, "synthetic")).rejects.toBeInstanceOf(
      NotRestorableError,
    );
    lagging = false;
    const result = await h.machine.restoreGroup(group.id, "synthetic");
    expect(result.restored).toMatchObject([{ id: outing.fitbit.id, outcome: "restored" }]);
    expect(requireGroup(h.db, group.id).deletedIds).toEqual([outing.fitbit.id]);
  });

  it("flags an owner restore of a member the API never confirmed gone", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.world.apiLags = (id) => id === outing.fitbit.id;
    await h.poller.poll();
    h.clock.t += 61 * MINUTE;
    await h.machine.tick();
    expect(h.freeze.isFrozen()).toBe(true);
    const result = await h.machine.restoreGroup(listGroups(h.db)[0]!.id, "synthetic");
    expect(result.restored).toEqual([]);
    expect(result.flags).toEqual([
      `${String(outing.fitbit.id)}: deleted on the website but still listed by the API`,
    ]);
  });
});

describe("open delete intents after a restart, with a lagging API", () => {
  it("waits on an unknown delete the API still lists, as sent", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    const id = beginWrite(h.db, { groupId: group.id, kind: "delete", targetId: outing.app.id }, 0);
    finishWrite(h.db, id, "unknown", { lookup: "synthetic lost response" }, 0);
    await h.machine.reconcile();
    const [write] = writesFor(h.db, { kind: "delete" });
    expect(write).toMatchObject({ status: "sent", result: { stillExists: true, webError: null } });
    expect((write?.result as { via?: string }).via).toBeUndefined();
  });

  it("re-checks an intent in the delete step when the reconcile lookup failed", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    beginWrite(
      h.db,
      { groupId: group.id, kind: "delete", targetId: outing.fitbit.id },
      h.clock.now(),
    );
    h.settings.update({ switches: { delete: true } });
    let lost = 0;
    h.fault = (method, url) => {
      if (
        method === "GET" &&
        url.pathname.endsWith(`/activities/${outing.fitbit.id}`) &&
        lost === 0
      ) {
        lost += 1;
        return "lose_response";
      }
      return null;
    };
    await h.machine.tick();
    expect(writesFor(h.db, { kind: "delete" })[0]).toMatchObject({
      status: "sent",
      result: { via: "lookup" },
    });
    expect(requireGroup(h.db, group.id).lastError).toBe("wait:deletion_confirming");
    expect(deleteCalls(h)).toEqual([]);
  });
});
