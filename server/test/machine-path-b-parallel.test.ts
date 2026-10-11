import { afterEach, describe, expect, it } from "vitest";
import { NotRestorableError } from "../src/state/machine.ts";
import {
  beginWrite,
  finishWrite,
  groupEvents,
  type GroupRow,
  type GroupStatus,
  listGroups,
  patchGroup,
  requireGroup,
  setActivityFields,
  trialPairsUsed,
  writesFor,
} from "../src/state/repo.ts";
import { DeletionAuthorization } from "../src/web/deletion-authorization.ts";
import type { WorldActivity } from "./fake-strava-api/world.ts";
import { addOuting, addWristPart, type SyntheticOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness, uploadCount } from "./machine-harness.ts";

/**
 * Path B deletes every member in one step: all deletes are sent first, then
 * the API confirmations (which lag a web delete by many minutes) are waited
 * for together, and the merge is uploaded once. Also: groups left in a
 * status of the older serial flow, and an accepted upload that would have
 * left an original behind. All data here is synthetic (fixtures/).
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const MINUTE = 60_000;

function deleteCalls(harness: Harness): number[] {
  return harness.session.calls.filter((c) => c.op === "delete").map((c) => c.id as number);
}

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

/** Run `hook` right after the n-th web delete was sent. */
function afterDelete(harness: Harness, n: number, hook: () => void | Promise<void>): void {
  const original = harness.session.deleteActivity.bind(harness.session);
  let sent = 0;
  harness.session.deleteActivity = async (id: number, auth: DeletionAuthorization) => {
    const result = await original(id, auth);
    sent += 1;
    if (sent === n) await hook();
    return result;
  };
}

/**
 * Strava refuses the merge while any original is on Strava and accepts
 * everything else, so a restored original is never called a duplicate.
 */
function refuseMergesOnly(harness: Harness): void {
  const isMerge = (externalId: string | null): boolean =>
    externalId?.startsWith("cameld-merge-") === true;
  harness.world.duplicatePolicy = (incoming) =>
    isMerge(incoming.externalId)
      ? (harness.world.live().find((a) => !isMerge(a.externalId))?.id ?? null)
      : null;
}

function isLive(harness: Harness, activity: WorldActivity): boolean {
  return harness.world.live().some((a) => a.externalId === activity.externalId);
}

function eventsOf(group: GroupRow): string[] {
  return groupEvents(h.db, group.id).map((e) => e.event);
}

describe("path B: both deletes are sent in one step", () => {
  it("sends both deletes in the same tick, waits for both 404s, then uploads once", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    const fresh = countFreshBackups(h);
    const lagging = new Set([outing.fitbit.id, outing.app.id]);
    h.world.apiLags = (id) => lagging.has(id);

    await h.poller.poll();
    let group = listGroups(h.db)[0]!;
    expect(group).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_confirming",
      deletedIds: [],
    });
    // Both went out in the first tick, although neither is confirmed yet.
    expect(deleteCalls(h)).toEqual([outing.fitbit.id, outing.app.id]);
    expect(writesFor(h.db, { kind: "delete" }).map((w) => [w.targetId, w.status])).toEqual([
      [outing.fitbit.id, "sent"],
      [outing.app.id, "sent"],
    ]);
    expect(eventsOf(group).filter((e) => e === "delete_sent")).toHaveLength(2);
    expect(uploadCount(h, group.externalId)).toBe(1);

    h.clock.t += 10 * MINUTE;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).deletedIds).toEqual([]);

    // One 404 is not enough to upload.
    lagging.delete(outing.fitbit.id);
    h.clock.t += 5 * MINUTE;
    await h.machine.tick();
    group = requireGroup(h.db, group.id);
    expect(group).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_confirming",
      deletedIds: [outing.fitbit.id],
    });
    expect(uploadCount(h, group.externalId)).toBe(1);

    lagging.clear();
    h.clock.t += 5 * MINUTE;
    await h.machine.tick();
    group = requireGroup(h.db, group.id);
    expect(group.status).toBe("done");
    expect(h.freeze.isFrozen()).toBe(false);
    // Exactly one delete per member, one fresh backup and one snapshot each.
    expect(deleteCalls(h)).toEqual([outing.fitbit.id, outing.app.id]);
    expect(fresh.get(outing.fitbit.id)).toBe(1);
    expect(fresh.get(outing.app.id)).toBe(1);
    expect(h.snapshotter.taken.filter((s) => s.includes("pre-delete"))).toHaveLength(2);
    expect(writesFor(h.db, { kind: "delete" }).map((w) => [w.targetId, w.status])).toEqual([
      [outing.fitbit.id, "done"],
      [outing.app.id, "done"],
    ]);
    // The rejected first upload plus a single one after both 404s.
    expect(uploadCount(h, group.externalId)).toBe(2);
    const reached = groupEvents(h.db, group.id).map((e) => e.to);
    expect(reached).not.toContain("b_retry_1");
    expect(reached).not.toContain("b_delete_app");
    expect(eventsOf(group)).toEqual(
      expect.arrayContaining(["path_b_start", "originals_deleted", "uploaded_after_delete"]),
    );
    // The lags overlapped: the pair took 20 minutes, not the sum of two lags.
    const delays = writesFor(h.db, { kind: "delete" }).map(
      (w) => (w.result as { delayMs: number }).delayMs,
    );
    expect(delays).toEqual([15 * MINUTE, 20 * MINUTE]);
  });

  it("restores both originals and freezes when the upload errors after both deletes", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    refuseMergesOnly(h);
    let uploads = 0;
    h.world.onRequest = (method, path) => {
      if (method === "POST" && path.endsWith("/uploads")) {
        uploads += 1;
        h.world.uploadError = uploads === 2 ? "Synthetic processing failure" : null;
      }
    };
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("failed");
    expect(h.freeze.isFrozen()).toBe(true);
    expect(eventsOf(group)).toContain("upload_failed_after_delete");
    expect(deleteCalls(h)).toEqual([outing.fitbit.id, outing.app.id]);
    expect(uploadCount(h, group.externalId)).toBe(2);
    expect(isLive(h, outing.app)).toBe(true);
    expect(isLive(h, outing.fitbit)).toBe(true);
    expect(h.world.live().some((a) => a.externalId?.startsWith("cameld-merge-"))).toBe(false);
  });

  it("does not send the second delete after a freeze that arrives while the first waits", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    refuseMergesOnly(h);
    let lagging = true;
    h.world.apiLags = (id) => lagging && id === outing.fitbit.id;
    afterDelete(h, 1, () => h.freeze.freeze("synthetic failure elsewhere", null));
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group).toMatchObject({ status: "b_delete_fitbit", lastError: "wait:frozen" });
    expect(deleteCalls(h)).toEqual([outing.fitbit.id]);
    expect(writesFor(h.db, { kind: "delete" }).map((w) => w.status)).toEqual(["sent"]);

    // Still frozen: the sent delete is waited for, nothing new is sent, nothing restored.
    h.clock.t += 10 * MINUTE;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).lastError).toBe("wait:deletion_confirming");
    lagging = false;
    h.clock.t += 10 * MINUTE;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("failed");
    expect(deleteCalls(h)).toEqual([outing.fitbit.id]);
    expect(outing.app.exists).toBe(true);
    expect(isLive(h, outing.fitbit)).toBe(true);
    expect(uploadCount(h, group.externalId)).toBe(1);
  });

  it("stops between members when the owner withdraws the go-ahead, and resumes with it", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    afterDelete(h, 1, () => {
      h.settings.update({ switches: { delete: false } });
    });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_switch_off",
      deletedIds: [outing.fitbit.id],
    });
    expect(deleteCalls(h)).toEqual([outing.fitbit.id]);
    expect(outing.app.exists).toBe(true);
    await h.machine.tick();
    expect(deleteCalls(h)).toEqual([outing.fitbit.id]);
    expect(uploadCount(h, group.externalId)).toBe(1);

    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("done");
    expect(deleteCalls(h)).toEqual([outing.fitbit.id, outing.app.id]);
  });

  it("stops at a member whose authorization is refused, before sending any other", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    // Only the first pre-delete snapshot outlasts the authorization TTL.
    h.snapshotter.onSnapshot = () => {
      if (h.snapshotter.taken.length === 1) h.clock.t += DeletionAuthorization.TTL_MS + 1000;
    };
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group).toMatchObject({ status: "b_delete_fitbit", lastError: "wait:deletion_refused" });
    expect(eventsOf(group).filter((e) => e === "deletion_refused")).toHaveLength(1);
    expect(deleteCalls(h)).toEqual([]);
    expect(h.snapshotter.taken.filter((s) => s.includes("pre-delete"))).toHaveLength(1);
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("done");
    expect(deleteCalls(h)).toEqual([outing.fitbit.id, outing.app.id]);
  });

  it("stops on a transient error for the second member and keeps the first one's sent delete", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    let lagging = true;
    h.world.apiLags = (id) => lagging && id === outing.fitbit.id;
    afterDelete(h, 1, () => {
      h.snapshotter.fail = true;
    });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("b_delete_fitbit");
    expect(group.lastError).toMatch(/^transient:SnapshotError/);
    expect(deleteCalls(h)).toEqual([outing.fitbit.id]);
    expect(h.freeze.isFrozen()).toBe(false);
    h.snapshotter.fail = false;
    await h.machine.tick();
    // The first is only re-checked (never sent again); the second goes out now.
    expect(deleteCalls(h)).toEqual([outing.fitbit.id, outing.app.id]);
    expect(requireGroup(h.db, group.id).lastError).toBe("wait:deletion_confirming");
    lagging = false;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("done");
    expect(deleteCalls(h)).toEqual([outing.fitbit.id, outing.app.id]);
  });

  it("waits for every sent delete to settle before restoring when frozen with both sent", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    refuseMergesOnly(h);
    const lagging = new Set([outing.fitbit.id, outing.app.id]);
    h.world.apiLags = (id) => lagging.has(id);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(deleteCalls(h)).toHaveLength(2);
    await h.freeze.freeze("synthetic failure elsewhere", null);

    h.clock.t += 5 * MINUTE;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id)).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_confirming",
    });
    // One side confirmed, the other still waiting: nothing is restored yet.
    lagging.delete(outing.app.id);
    h.clock.t += 5 * MINUTE;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id)).toMatchObject({
      status: "b_delete_fitbit",
      deletedIds: [outing.app.id],
    });
    expect(isLive(h, outing.app)).toBe(false);

    lagging.clear();
    h.clock.t += 5 * MINUTE;
    await h.machine.tick();
    const after = requireGroup(h.db, group.id);
    expect(after.status).toBe("failed");
    expect(eventsOf(after)).toContain("frozen_mid_path_b");
    expect(isLive(h, outing.app)).toBe(true);
    expect(isLive(h, outing.fitbit)).toBe(true);
    expect(deleteCalls(h)).toHaveLength(2);
    expect(uploadCount(h, group.externalId)).toBe(1);
  });

  it("keeps waiting, frozen, when the lookup of a sent delete fails", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.world.apiLags = (id) => id === outing.fitbit.id;
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    await h.freeze.freeze("synthetic failure elsewhere", null);
    h.world.failStatus = (method, path) =>
      method === "GET" && path.endsWith(`/activities/${outing.fitbit.id}`) ? 503 : null;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("b_delete_fitbit");
    expect(requireGroup(h.db, group.id).lastError).toMatch(/^transient:/);
    expect(isLive(h, outing.app)).toBe(false);
  });

  it("refuses an owner restore until both sent deletes are confirmed, then restores both", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    refuseMergesOnly(h);
    const lagging = new Set([outing.fitbit.id, outing.app.id]);
    h.world.apiLags = (id) => lagging.has(id);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    await expect(h.machine.restoreGroup(group.id, "synthetic")).rejects.toBeInstanceOf(
      NotRestorableError,
    );
    lagging.delete(outing.app.id);
    await expect(h.machine.restoreGroup(group.id, "synthetic")).rejects.toBeInstanceOf(
      NotRestorableError,
    );
    expect(isLive(h, outing.app)).toBe(false);
    lagging.clear();
    const result = await h.machine.restoreGroup(group.id, "synthetic");
    expect(result.restored).toMatchObject([
      { id: outing.app.id, outcome: "restored" },
      { id: outing.fitbit.id, outcome: "restored" },
    ]);
    expect(result.flags).toEqual([]);
    expect(requireGroup(h.db, group.id).status).toBe("restored");
  });
});

describe("multi-member sides (1-to-N)", () => {
  /** One phone recording against two wrist parts of the same outing. */
  async function oneToTwo(settings = {}): Promise<{ ids: number[]; group: GroupRow }> {
    h = await createHarness({ settings });
    const outing = addOuting(h.world);
    outing.fitbit.exists = false;
    const first = addWristPart(h.world, { seed: 501, from: 0, seconds: 290 });
    const second = addWristPart(h.world, { seed: 502, from: 290, seconds: 600 });
    const ids = [first.id, second.id, outing.app.id];
    const lagging = new Set(ids);
    h.world.apiLags = (id) => lagging.has(id);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.fitbitIds).toHaveLength(2);
    expect(group).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_confirming",
    });
    // All three deletes were sent in the first tick.
    expect(deleteCalls(h).sort()).toEqual([...ids].sort());
    lagging.clear();
    h.clock.t += 20 * MINUTE;
    await h.machine.tick();
    return { ids, group: requireGroup(h.db, group.id) };
  }

  it("sends every member's delete in one tick and uploads once", async () => {
    const { ids, group } = await oneToTwo({ switches: { delete: true } });
    expect(group.status).toBe("done");
    expect(deleteCalls(h).sort()).toEqual([...ids].sort());
    expect([...group.deletedIds].sort()).toEqual([...ids].sort());
    expect(uploadCount(h, group.externalId)).toBe(2);
    expect(h.snapshotter.taken.filter((s) => s.includes("pre-delete"))).toHaveLength(3);
  });

  it("counts a pair with three members as one trial slot", async () => {
    const { group } = await oneToTwo({ trial: { enabled: true } });
    expect(group.status).toBe("done");
    expect(group.trial).toBe(true);
    expect(trialPairsUsed(h.db)).toBe(1);
    const deleted = groupEvents(h.db, group.id).filter((e) => e.event === "deleted");
    expect(deleted).toHaveLength(3);
    expect(deleted.every((e) => (e.evidence as { permit: string }).permit === "trial")).toBe(true);
  });
});

describe("path A: a_deleting sends every delete before waiting", () => {
  it("sends both deletes in one tick, then confirms and finishes", async () => {
    h = await createHarness({
      settings: { timing: { gracePeriodMs: 0 }, switches: { delete: true } },
    });
    h.world.duplicatePolicy = (incoming) =>
      h.world.live().find((a) => a.externalId === incoming.externalId)?.id ?? null;
    const outing = addOuting(h.world);
    const lagging = new Set([outing.fitbit.id, outing.app.id]);
    h.world.apiLags = (id) => lagging.has(id);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group).toMatchObject({
      status: "a_deleting",
      path: "A",
      lastError: "wait:deletion_confirming",
    });
    expect(deleteCalls(h)).toEqual([outing.app.id, outing.fitbit.id]);
    expect(writesFor(h.db, { kind: "delete" }).map((w) => w.status)).toEqual(["sent", "sent"]);
    const reasons = groupEvents(h.db, group.id).filter((e) => e.event === "delete_sent");
    expect(reasons).toHaveLength(2);

    lagging.clear();
    h.clock.t += 20 * MINUTE;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("done");
    expect(deleteCalls(h)).toHaveLength(2);
    expect(h.freeze.isFrozen()).toBe(false);
  });

  it("does not send the second delete after the first one's lookup froze writes", async () => {
    h = await createHarness({
      settings: { timing: { gracePeriodMs: 0 }, switches: { delete: true } },
    });
    h.world.duplicatePolicy = (incoming) =>
      h.world.live().find((a) => a.externalId === incoming.externalId)?.id ?? null;
    const outing = addOuting(h.world);
    // The API cannot say whether the first delete happened: unknown outcome.
    h.world.failStatus = (method, path) =>
      method === "GET" &&
      path.endsWith(`/activities/${outing.app.id}`) &&
      h.session.deleted.includes(outing.app.id)
        ? 503
        : null;
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(h.freeze.isFrozen()).toBe(true);
    expect(group).toMatchObject({ status: "a_deleting", lastError: "wait:deletion_unconfirmed" });
    expect(deleteCalls(h)).toEqual([outing.app.id]);
    expect(outing.fitbit.exists).toBe(true);
  });
});

/**
 * A pair parked at the duplicate rejection (deletion off), as the base for
 * seeding a status the serial flow left behind.
 */
async function parkedPair(): Promise<{ outing: SyntheticOuting; group: GroupRow }> {
  h = await createHarness();
  const outing = addOuting(h.world);
  await h.poller.poll();
  const group = listGroups(h.db)[0]!;
  expect(group.parkedReason).toBe("deletion_switch_off");
  return { outing, group };
}

function seedStatus(group: GroupRow, status: GroupStatus): void {
  patchGroup(h.db, group.id, { status, parkedReason: null, resumeStatus: null }, h.clock.now());
}

/** Journal a delete the serial flow already sent: confirmed by the API, or still waiting. */
function seedDelete(group: GroupRow, activity: WorldActivity, state: "done" | "sent"): number {
  const now = h.clock.now();
  const writeId = beginWrite(
    h.db,
    { groupId: group.id, kind: "delete", targetId: activity.id },
    now,
  );
  activity.exists = false;
  if (state === "sent") {
    finishWrite(h.db, writeId, "sent", { stillExists: true, webError: null }, now);
    return writeId;
  }
  finishWrite(h.db, writeId, "done", { confirmed: "api_404", delayMs: 0, webError: null }, now);
  setActivityFields(h.db, activity.id, { gone_at: now });
  const { deletedIds } = requireGroup(h.db, group.id);
  patchGroup(h.db, group.id, { deletedIds: [...deletedIds, activity.id] }, now);
  return writeId;
}

describe("groups in flight from the serial flow", () => {
  it("b_delete_fitbit with the wrist delete sent: confirms it, sends only the other", async () => {
    const { outing, group } = await parkedPair();
    seedStatus(group, "b_delete_fitbit");
    const writeId = seedDelete(group, outing.fitbit, "sent");
    let lagging = true;
    h.world.apiLags = (id) => lagging && id === outing.fitbit.id;
    h.settings.update({ switches: { delete: true } });
    const fresh = countFreshBackups(h);
    await h.machine.tick();
    expect(requireGroup(h.db, group.id)).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_confirming",
      deletedIds: [outing.app.id],
    });
    expect(deleteCalls(h)).toEqual([outing.app.id]);
    lagging = false;
    h.clock.t += 10 * MINUTE;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("done");
    expect(deleteCalls(h)).toEqual([outing.app.id]);
    expect(fresh.get(outing.fitbit.id)).toBeUndefined();
    expect(writesFor(h.db, { kind: "delete" }).find((w) => w.id === writeId)).toMatchObject({
      status: "done",
      result: { confirmed: "api_404", late: true },
    });
    expect(uploadCount(h, group.externalId)).toBe(2);
  });

  it("b_delete_fitbit with the wrist delete confirmed: deletes the other and uploads once", async () => {
    const { outing, group } = await parkedPair();
    seedStatus(group, "b_delete_fitbit");
    seedDelete(group, outing.fitbit, "done");
    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    const after = requireGroup(h.db, group.id);
    expect(after.status).toBe("done");
    expect(deleteCalls(h)).toEqual([outing.app.id]);
    expect(after.deletedIds).toEqual([outing.fitbit.id, outing.app.id]);
    expect(uploadCount(h, group.externalId)).toBe(2);
    expect(groupEvents(h.db, group.id).map((e) => e.to)).not.toContain("b_retry_1");
  });

  it("b_retry_1 rejected again: deletes the remaining original, then uploads", async () => {
    const { outing, group } = await parkedPair();
    seedStatus(group, "b_retry_1");
    seedDelete(group, outing.fitbit, "done");
    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    const after = requireGroup(h.db, group.id);
    expect(after.status).toBe("done");
    expect(eventsOf(after)).toContain("still_duplicate");
    expect(groupEvents(h.db, group.id).map((e) => e.to)).toEqual(
      expect.arrayContaining(["b_delete_app", "b_retry_2", "uploaded", "done"]),
    );
    expect(deleteCalls(h)).toEqual([outing.app.id]);
    expect(uploadCount(h, group.externalId)).toBe(3);
  });

  it("b_retry_1 failing with an error restores the deleted side and freezes", async () => {
    const { outing, group } = await parkedPair();
    refuseMergesOnly(h);
    seedStatus(group, "b_retry_1");
    seedDelete(group, outing.fitbit, "done");
    h.settings.update({ switches: { delete: true } });
    // Only the merge upload fails; the restore upload after it is accepted.
    let uploads = 0;
    h.world.onRequest = (method, path) => {
      if (method === "POST" && path.endsWith("/uploads")) {
        uploads += 1;
        h.world.uploadError = uploads === 1 ? "Synthetic processing failure" : null;
      }
    };
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("failed");
    expect(h.freeze.isFrozen()).toBe(true);
    expect(deleteCalls(h)).toEqual([]);
    expect(outing.app.exists).toBe(true);
    expect(isLive(h, outing.fitbit)).toBe(true);
  });

  it("b_delete_app with the phone delete sent: waits for it without sending anything", async () => {
    const { outing, group } = await parkedPair();
    seedStatus(group, "b_delete_app");
    seedDelete(group, outing.fitbit, "done");
    seedDelete(group, outing.app, "sent");
    let lagging = true;
    h.world.apiLags = (id) => lagging && id === outing.app.id;
    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    expect(requireGroup(h.db, group.id)).toMatchObject({
      status: "b_delete_app",
      lastError: "wait:deletion_confirming",
    });
    lagging = false;
    h.clock.t += 10 * MINUTE;
    await h.machine.tick();
    const after = requireGroup(h.db, group.id);
    expect(after.status).toBe("done");
    expect(after.deletedIds).toEqual([outing.fitbit.id, outing.app.id]);
    expect(deleteCalls(h)).toEqual([]);
    expect(uploadCount(h, group.externalId)).toBe(2);
  });

  it("b_delete_app with nothing sent for the phone copy yet: deletes it and uploads", async () => {
    const { outing, group } = await parkedPair();
    seedStatus(group, "b_delete_app");
    seedDelete(group, outing.fitbit, "done");
    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("done");
    expect(deleteCalls(h)).toEqual([outing.app.id]);
  });

  it("b_retry_2 with both confirmed: uploads once and finishes", async () => {
    const { outing, group } = await parkedPair();
    seedStatus(group, "b_retry_2");
    seedDelete(group, outing.fitbit, "done");
    seedDelete(group, outing.app, "done");
    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("done");
    expect(deleteCalls(h)).toEqual([]);
    expect(uploadCount(h, group.externalId)).toBe(2);
  });

  it("b_retry_2 with both confirmed while frozen: restores both instead of uploading", async () => {
    const { outing, group } = await parkedPair();
    refuseMergesOnly(h);
    seedStatus(group, "b_retry_2");
    seedDelete(group, outing.fitbit, "done");
    seedDelete(group, outing.app, "done");
    h.settings.update({ switches: { delete: true } });
    await h.freeze.freeze("synthetic failure elsewhere", null);
    await h.machine.tick();
    const after = requireGroup(h.db, group.id);
    expect(after.status).toBe("failed");
    expect(eventsOf(after)).toContain("frozen_mid_path_b");
    expect(uploadCount(h, group.externalId)).toBe(1);
    expect(isLive(h, outing.app)).toBe(true);
    expect(isLive(h, outing.fitbit)).toBe(true);
  });

  it("b_restore with both confirmed: restores both and freezes", async () => {
    const { outing, group } = await parkedPair();
    refuseMergesOnly(h);
    seedStatus(group, "b_restore");
    seedDelete(group, outing.fitbit, "done");
    seedDelete(group, outing.app, "done");
    await h.machine.tick();
    const after = requireGroup(h.db, group.id);
    expect(after.status).toBe("failed");
    expect(h.freeze.isFrozen()).toBe(true);
    expect(isLive(h, outing.app)).toBe(true);
    expect(isLive(h, outing.fitbit)).toBe(true);
    const restored = groupEvents(h.db, group.id).find((e) => e.event === "restored");
    expect(restored?.evidence).toMatchObject({
      outcomes: [
        { id: outing.fitbit.id, outcome: { status: "restored" } },
        { id: outing.app.id, outcome: { status: "restored" } },
      ],
    });
    expect(deleteCalls(h)).toEqual([]);
  });

  it("b_restore with one delete sent but never confirmed: restores the other, flags it", async () => {
    const { outing, group } = await parkedPair();
    seedStatus(group, "b_restore");
    seedDelete(group, outing.fitbit, "done");
    const writeId = seedDelete(group, outing.app, "sent");
    finishWrite(
      h.db,
      writeId,
      "failed",
      { stillExists: true, webError: null, unconfirmedAfterMs: 61 * MINUTE },
      h.clock.now(),
    );
    h.world.apiLags = (id) => id === outing.app.id;
    await h.machine.tick();
    const after = requireGroup(h.db, group.id);
    expect(after.status).toBe("restore_flagged");
    const restored = groupEvents(h.db, group.id).find((e) => e.event === "restored");
    expect(restored?.evidence).toMatchObject({
      outcomes: [
        { id: outing.fitbit.id, outcome: { status: "restored" } },
        { id: outing.app.id, outcome: { status: "flagged", reason: "delete_sent_unconfirmed" } },
      ],
    });
  });
});

describe("an accepted path B upload never leaves an original behind", () => {
  /** In flight at retry 1: the wrist copy is deleted, the phone copy is still on Strava. */
  async function acceptedRetryOne(): Promise<{ outing: SyntheticOuting; group: GroupRow }> {
    const { outing, group } = await parkedPair();
    seedStatus(group, "b_retry_1");
    seedDelete(group, outing.fitbit, "done");
    // Strava's duplicate check is not deterministic: this time it accepts the merge.
    h.world.duplicatePolicy = () => null;
    return { outing, group };
  }

  it("deletes and confirms the remaining original before done", async () => {
    const { outing, group } = await acceptedRetryOne();
    h.settings.update({ switches: { delete: true } });
    let lagging = true;
    h.world.apiLags = (id) => lagging && id === outing.app.id;
    await h.machine.tick();
    let after = requireGroup(h.db, group.id);
    // Accepted and verified, but not done while the phone copy is not confirmed gone.
    expect(after).toMatchObject({
      status: "a_deleting",
      path: "B",
      lastError: "wait:deletion_confirming",
    });
    expect(after.mergedActivityId).not.toBeNull();
    expect(deleteCalls(h)).toEqual([outing.app.id]);
    expect(h.notifier.kinds()).not.toContain("merged");
    const remaining = groupEvents(h.db, group.id).find((e) => e.event === "originals_remaining");
    expect(remaining).toMatchObject({
      from: "metadata_applied",
      to: "a_deleting",
      evidence: { remaining: [outing.app.id], permit: "on" },
    });

    lagging = false;
    h.clock.t += 20 * MINUTE;
    await h.machine.tick();
    after = requireGroup(h.db, group.id);
    expect(after.status).toBe("done");
    expect(after.deletedIds).toEqual([outing.fitbit.id, outing.app.id]);
    expect(outing.app.exists).toBe(false);
    expect(deleteCalls(h)).toEqual([outing.app.id]);
    expect(eventsOf(after).slice(-2)).toEqual(["originals_deleted", "confirmed"]);
    const deleted = groupEvents(h.db, group.id).find((e) => e.event === "deleted");
    expect(deleted?.evidence).toMatchObject({ id: outing.app.id, permit: "on" });
    // Never hidden, no grace period.
    expect(after.hiddenAt).toBeNull();
    expect(outing.app.visibility).toBe("everyone");
    expect(h.world.get(after.mergedActivityId!)?.exists).toBe(true);
    expect(uploadCount(h, group.externalId)).toBe(2);
  });

  it("waits, not done, without the owner's go-ahead, and finishes once it is given", async () => {
    const { outing, group } = await acceptedRetryOne();
    await h.machine.tick();
    let after = requireGroup(h.db, group.id);
    expect(after).toMatchObject({
      status: "awaiting_deletion",
      lastError: "wait:deletion_switch_off",
    });
    expect(eventsOf(after)).toContain("originals_remaining_deletion_off");
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("awaiting_deletion");
    expect(deleteCalls(h)).toEqual([]);
    expect(outing.app.exists).toBe(true);
    expect(h.notifier.kinds()).not.toContain("merged");

    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    after = requireGroup(h.db, group.id);
    expect(after.status).toBe("done");
    expect(eventsOf(after)).toContain("deletion_permitted");
    expect(deleteCalls(h)).toEqual([outing.app.id]);
    expect(outing.app.exists).toBe(false);
  });

  it("waits in a_deleting when the go-ahead is withdrawn after the upload was verified", async () => {
    const { outing, group } = await acceptedRetryOne();
    h.settings.update({ switches: { delete: true } });
    h.world.failStatus = (method, path) =>
      method === "GET" && path.endsWith("/streams") ? 503 : null;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("metadata_applied");
    h.world.failStatus = undefined;
    const original = h.backup.backupActivity.bind(h.backup);
    h.backup.backupActivity = (id, options = {}) => {
      if (options.fresh === true) h.settings.update({ switches: { delete: false } });
      return original(id, options);
    };
    await h.machine.tick();
    expect(requireGroup(h.db, group.id)).toMatchObject({
      status: "a_deleting",
      lastError: "wait:deletion_switch_off",
    });
    expect(deleteCalls(h)).toEqual([]);
    expect(outing.app.exists).toBe(true);
  });

  it("can still be restored by the owner while the remaining original waits", async () => {
    const { outing, group } = await acceptedRetryOne();
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("awaiting_deletion");
    const result = await h.machine.restoreGroup(group.id, "synthetic");
    expect(result.restored).toMatchObject([{ id: outing.fitbit.id, outcome: "restored" }]);
    expect(result.unhidden).toEqual([]);
    expect(outing.app.exists).toBe(true);
  });

  it("goes straight to done when every original is already recorded gone", async () => {
    const { outing, group } = await parkedPair();
    seedStatus(group, "b_retry_2");
    seedDelete(group, outing.fitbit, "done");
    seedDelete(group, outing.app, "done");
    await h.machine.tick();
    const after = requireGroup(h.db, group.id);
    expect(after.status).toBe("done");
    expect(eventsOf(after)).not.toContain("originals_remaining");
    expect(eventsOf(after).at(-1)).toBe("post_upload_check");
  });
});
