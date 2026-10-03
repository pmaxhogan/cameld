import { afterEach, describe, expect, it } from "vitest";
import { groupEvents, listGroups } from "../src/state/repo.ts";
import { addOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness, uploadCount } from "./machine-harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("path B (the live norm: strava rejects the merge while originals exist)", () => {
  it("parks the pair with deletion OFF after backup, build and no-loss, writing nothing", async () => {
    h = await createHarness();
    const outing = addOuting(h.world, { withPhoto: true });
    const result = await h.poller.poll();
    expect(result.error).toBeNull();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("parked");
    expect(group?.parkedReason).toBe("deletion_switch_off");
    expect(group?.mergedPath).toMatch(/merged\.fit$/);
    expect(groupEvents(h.db, group!.id).map((e) => e.event)).toEqual([
      "detected",
      "backup_verified",
      "auto_match",
      "no_loss_ok",
      "snapshot",
      "upload_duplicate",
      "deletion_switch_off",
    ]);
    expect(outing.app.exists && outing.fitbit.exists).toBe(true);
    expect(h.session.deleted).toEqual([]);
    expect(h.notifier.kinds()).toContain("parked");
  });

  it("deletes the fitbit then the app original, uploads, carries metadata and verifies", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world, { withPhoto: true });
    await h.poller.poll();
    const [group] = listGroups(h.db);
    expect(group?.lastError).toBeNull();
    expect(group?.status).toBe("done");
    expect(h.session.deleted).toEqual([outing.fitbit.id, outing.app.id]);
    expect(uploadCount(h, group!.externalId)).toBe(3);
    const merged = h.world.get(group!.mergedActivityId!)!;
    expect(merged.name).toBe("Quillmere Tempo");
    expect(merged.privateNote).toContain("merged by cameld");
    expect(merged.privateNote).toContain("synthetic app note");
    expect(merged.perceivedExertion).toBe(6);
    expect(merged.photos).toHaveLength(1);
    expect(h.snapshotter.taken.filter((s) => s.includes("pre-delete"))).toHaveLength(2);
    expect(h.freeze.isFrozen()).toBe(false);
  });

  it("resumes a parked pair once the owner turns deletion on", async () => {
    h = await createHarness();
    addOuting(h.world);
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("parked");
    expect(await h.metrics.render()).toContain(
      'cameld_parked_pairs{reason="deletion_switch_off"} 1',
    );
    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("done");
    expect(groupEvents(h.db, group!.id).map((e) => e.event)).toContain("resumed");
  });

  it("runs at most three trial pairs with deletion off, then parks the rest", async () => {
    h = await createHarness({ settings: { trial: { enabled: true } } });
    for (let day = 0; day < 4; day += 1) addOuting(h.world, { day });
    h.clock.t += 4 * 24 * 3600_000;
    await h.poller.poll();
    const groups = listGroups(h.db);
    expect(groups.map((g) => g.status).sort()).toEqual(["done", "done", "done", "parked"]);
    expect(groups.filter((g) => g.trial)).toHaveLength(3);
    const trialEvents = groups
      .flatMap((g) => groupEvents(h.db, g.id))
      .filter((e) => e.event === "deleted");
    expect(trialEvents).toHaveLength(6);
    expect(trialEvents.every((e) => (e.evidence as { permit: string }).permit === "trial")).toBe(
      true,
    );
  });

  it("restores the deleted originals from backup when the upload still fails, then freezes", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    // Strava keeps refusing the merge even after both deletes; restores are accepted.
    h.world.duplicatePolicy = (incoming) =>
      incoming.externalId.startsWith("cameld-merge-")
        ? (h.world.live()[0]?.id ?? outing.app.id)
        : null;
    await h.poller.poll();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("failed");
    expect(h.freeze.isFrozen()).toBe(true);
    expect(h.session.deleted).toEqual([outing.fitbit.id, outing.app.id]);
    const restored = h.world.live().filter((a) => !a.externalId?.startsWith("cameld-merge-"));
    expect(restored.map((a) => a.externalId).sort()).toEqual(
      [outing.app.externalId, outing.fitbit.externalId].sort(),
    );
    const app = restored.find((a) => a.externalId === outing.app.externalId)!;
    expect(app.name).toBe("Morning Run");
    expect(app.privateNote).toBe("synthetic app note");
    expect(app.perceivedExertion).toBe(6);
    expect(h.machine.activity(outing.app.id)?.restoredAs).toBe(app.id);
    expect(h.machine.activity(app.id)?.restoredFrom).toBe(outing.app.id);
    // Restored copies never pair again.
    await h.poller.poll();
    expect(listGroups(h.db)).toHaveLength(1);
  });

  it("flags a restore that strava rejects as a duplicate and keeps it in the backup", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    // The merge is refused after the first delete with a processing error; the
    // restore of the wrist copy is refused as a duplicate of the app copy.
    h.world.duplicatePolicy = (incoming) =>
      h.world.live().some((a) => a.id === outing.fitbit.id) ||
      incoming.externalId === outing.fitbit.externalId
        ? outing.app.id
        : null;
    h.world.uploadError = null;
    let uploads = 0;
    h.world.onRequest = (method, path) => {
      if (method === "POST" && path.endsWith("/uploads")) {
        uploads += 1;
        if (uploads === 2) h.world.uploadError = "Synthetic processing failure";
        else h.world.uploadError = null;
      }
    };
    await h.poller.poll();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("restore_flagged");
    expect(h.freeze.isFrozen()).toBe(true);
    expect(h.notifier.kinds()).toContain("restore_flagged");
    expect(h.session.deleted).toEqual([outing.fitbit.id]);
  });

  it("restores instead of uploading when a freeze lands mid path B", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.world.duplicatePolicy = (incoming) =>
      incoming.externalId.startsWith("cameld-merge-") ? outing.app.id : null;
    h.world.onRequest = (method, path) => {
      // Another group fails right after the wrist copy is deleted.
      if (
        method === "GET" &&
        path === `/api/v3/activities/${outing.fitbit.id}` &&
        h.session.deleted.length === 1
      ) {
        void h.freeze.freeze("synthetic failure elsewhere", null);
      }
    };
    await h.poller.poll();
    await h.machine.tick();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("failed");
    expect(groupEvents(h.db, group!.id).map((e) => e.event)).toContain("frozen_mid_path_b");
    expect(h.world.live().some((a) => a.externalId === outing.fitbit.externalId)).toBe(true);
    expect(h.world.live().some((a) => a.externalId?.startsWith("cameld-merge-"))).toBe(false);
  });
});
