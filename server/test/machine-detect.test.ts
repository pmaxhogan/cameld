import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  groupEvents,
  listGroups,
  patchGroup,
  requireGroup,
  setActivityFields,
  writesFor,
} from "../src/state/repo.ts";
import { ORIGINAL_BACKOFF_BASE_MS } from "../src/service/backup.ts";
import { LoginRequiredError } from "../src/web/errors.ts";
import { addOuting, addWristPart } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function accepting(settings = {}): Promise<Harness> {
  const harness = await createHarness({ settings });
  harness.world.duplicatePolicy = (incoming) =>
    harness.world.live().find((a) => a.externalId === incoming.externalId)?.id ?? null;
  return harness;
}

describe("detection and scoring", () => {
  it("sends a borderline pair to review, then merges it once the owner approves", async () => {
    h = await accepting();
    addOuting(h.world, { fitbitNoiseMeters: 50 });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("review");
    expect(h.notifier.kinds()).toContain("review");
    expect(() => h.machine.rejectReview("missing")).toThrow(/does not exist/);
    h.machine.approveReview(group.id);
    expect(() => h.machine.approveReview(group.id)).toThrow(/not in review/);
    expect(() => h.machine.rejectReview(group.id)).toThrow(/not in review/);
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("hidden");
    expect(groupEvents(h.db, group.id).map((e) => e.event)).toContain("review_approved");
  });

  it("dissolves a rejected review and never forms the same group again", async () => {
    h = await createHarness();
    addOuting(h.world, { fitbitNoiseMeters: 50 });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    h.machine.rejectReview(group.id);
    await h.poller.poll();
    expect(listGroups(h.db)).toHaveLength(1);
    expect(requireGroup(h.db, group.id).status).toBe("dissolved");
  });

  it("dissolves a pair that does not match at all", async () => {
    h = await createHarness();
    addOuting(h.world, { fitbitNoiseMeters: 2000 });
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("dissolved");
    expect(await h.metrics.render()).toContain('cameld_merges_total{outcome="dissolved"} 1');
  });

  it("sends a three-source group to review and refuses to approve it", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    addOuting(h.world, { seed: 70, wristDevice: "Synthetic Bike Computer" }).app.exists = false;
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("review");
    expect([...group.appIds, ...group.fitbitIds]).toContain(outing.app.id);
    expect(group.appIds.length + group.fitbitIds.length).toBe(3);
    expect(() => h.machine.approveReview(group.id)).toThrow(/two-sided/);
  });

  it("pairs an app recording with another device in the wrist role", async () => {
    h = await accepting();
    const outing = addOuting(h.world, { wristDevice: "Synthetic Bike Computer" });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.fitbitIds).toEqual([outing.fitbit.id]);
    expect(group.status).toBe("hidden");
  });

  it("merges an indoor pair with the non-GPS rule at offset 0", async () => {
    h = await accepting();
    addOuting(h.world, { indoor: true });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("hidden");
    expect(group.offsetSeconds).toBe(0);
    expect((group.match as { reasons: string[] }).reasons).toContain("non_gps_rule");
  });

  it("regroups when a split part arrives before any write, and merges 1-to-N", async () => {
    h = await accepting();
    h.session.exportFails = true;
    const outing = addOuting(h.world);
    outing.fitbit.exists = false;
    const first = addWristPart(h.world, { seed: 501, from: 0, seconds: 290 });
    await h.poller.poll();
    const old = listGroups(h.db)[0]!;
    expect(old.lastError).toBe("wait:original_pending");
    addWristPart(h.world, { seed: 502, from: 290, seconds: 600 });
    h.session.exportFails = false;
    // The failed export backs off for 15 minutes before it is tried again.
    h.clock.t += ORIGINAL_BACKOFF_BASE_MS;
    await h.poller.poll();
    const groups = listGroups(h.db);
    expect(requireGroup(h.db, old.id).status).toBe("superseded");
    const merged = groups.find((g) => g.id !== old.id)!;
    expect(merged.fitbitIds).toHaveLength(2);
    expect(merged.fitbitIds).toContain(first.id);
    expect(merged.status).toBe("hidden");
  });

  it("never pairs the merged upload again", async () => {
    h = await accepting();
    addOuting(h.world);
    await h.poller.poll();
    await h.poller.poll();
    expect(listGroups(h.db)).toHaveLength(1);
    const merged = listGroups(h.db)[0]!.mergedActivityId!;
    expect(h.machine.activity(merged)?.isMergeOutput).toBe(true);
  });

  it("dissolves a group whose member was deleted before it was backed up", async () => {
    h = await createHarness();
    h.session.exportFails = true;
    const outing = addOuting(h.world);
    await h.poller.poll();
    setActivityFields(h.db, outing.fitbit.id, { gone_at: 1 });
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("dissolved");
  });

  it("freezes when a member's backup fails verification before scoring", async () => {
    h = await createHarness();
    h.session.exportFails = true;
    const outing = addOuting(h.world);
    await h.poller.poll();
    const row = h.db
      .prepare("SELECT rel_path FROM backup_files WHERE activity_id = ? AND kind = 'streams'")
      .get(outing.app.id) as { rel_path: string };
    rmSync(join(h.dir, "backup", row.rel_path));
    h.session.exportFails = false;
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("failed");
    expect(h.freeze.isFrozen()).toBe(true);
  });
});

describe("step edge cases", () => {
  it("freezes when the merged file's checksum no longer matches the record", async () => {
    h = await createHarness({ settings: { switches: { upload: false } } });
    addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    patchGroup(h.db, group.id, { mergedSha256: "0".repeat(64) }, 0);
    h.settings.update({ switches: { upload: true } });
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("failed");
  });

  it("journals a failed API edit and retries the step later", async () => {
    h = await accepting();
    addOuting(h.world);
    h.world.failStatus = (method) => (method === "PUT" ? 503 : null);
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("uploaded");
    expect(writesFor(h.db, { kind: "update" })[0]?.status).toBe("failed");
    h.world.failStatus = undefined;
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("hidden");
  });

  it("does not guess when the duplicate lookup itself fails", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.world.failStatus = (method, path) =>
      method === "GET" && path === `/api/v3/activities/${outing.app.id}` && h.world.uploads.size > 0
        ? 502
        : null;
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("snapshotted");
    expect(h.session.deleted).toEqual([]);
  });

  it("freezes when the uploaded merge has no streams to check", async () => {
    h = await accepting();
    addOuting(h.world);
    h.world.streamsOverride = () => ({});
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("failed");
  });

  it("carries a merge with no exertion and no web forms, with jpeg photos lacking a date", async () => {
    h = await accepting();
    h.session.formFails = true;
    const outing = addOuting(h.world);
    outing.app.photos.push({ uniqueId: "synthetic-x-jpg", bytes: Buffer.from("x"), createdAt: "" });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("hidden");
    const merged = h.world.get(group.mergedActivityId!)!;
    expect(merged.privateNote).toMatch(/^merged by cameld/);
    expect(merged.perceivedExertion).toBeNull();
    expect(merged.photos).toHaveLength(1);
  });

  it("waits with the photo step while the web session is paused, without journaling", async () => {
    h = await accepting();
    const outing = addOuting(h.world, { withPhoto: true });
    let paused = false;
    const exertion = h.session.setPerceivedExertion.bind(h.session);
    h.session.setPerceivedExertion = async (id, value, prefer) => {
      const values = await exertion(id, value, prefer);
      if (paused) return values;
      paused = true;
      // The gate pauses on the next failure: simulate one before the photos.
      await h.web.run(() => Promise.reject(new LoginRequiredError("x"))).catch(() => undefined);
      return values;
    };
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("uploaded");
    expect(writesFor(h.db, { kind: "photo" })).toEqual([]);
    expect(outing.app.photos).toHaveLength(1);
    await h.web.keepAlive();
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("hidden");
  });
});

describe("deletion step edge cases", () => {
  it("parks path B when an original went missing from the backup record", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    setActivityFields(h.db, outing.fitbit.id, { original_status: "unavailable" });
    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    expect(listGroups(h.db)[0]).toMatchObject({
      status: "parked",
      parkedReason: "original_unavailable",
    });
  });

  it("parks path B as original_missing when an original is no longer recorded", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    setActivityFields(h.db, outing.fitbit.id, { original_status: "pending" });
    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    expect(listGroups(h.db)[0]).toMatchObject({
      status: "parked",
      parkedReason: "original_missing",
    });
  });

  it("parks mid path when the original disappears right before its delete", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.snapshotter.fail = true;
    await h.poller.poll();
    h.snapshotter.fail = false;
    // The original record is lost during the fresh pre-delete backup.
    h.world.onRequest = (method, path) => {
      if (path === `/api/v3/activities/${outing.fitbit.id}` && h.world.uploads.size > 0) {
        setActivityFields(h.db, outing.fitbit.id, { original_status: "unavailable" });
      }
    };
    await h.machine.tick();
    expect(listGroups(h.db)[0]).toMatchObject({
      status: "parked",
      parkedReason: "original_missing",
    });
    expect(h.session.deleted).toEqual([]);
  });

  it("waits when deletion is switched off mid path, and when frozen before any delete", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.world.onRequest = (method, path) => {
      if (path === `/api/v3/activities/${outing.fitbit.id}` && h.world.uploads.size > 0) {
        h.settings.update({ switches: { delete: false } });
      }
    };
    await h.poller.poll();
    expect(listGroups(h.db)[0]).toMatchObject({
      status: "b_delete_fitbit",
      lastError: "wait:deletion_switch_off",
    });
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.lastError).toBe("wait:deletion_switch_off");
    await h.freeze.freeze("synthetic", null);
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.lastError).toBe("wait:frozen");
    expect(h.session.deleted).toEqual([]);
  });

  it("skips an original already gone and fails when an original survives confirmation", async () => {
    h = await accepting({ timing: { gracePeriodMs: 0 }, switches: { delete: true } });
    const outing = addOuting(h.world);
    let gets = 0;
    h.world.onRequest = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/v3/activities/${outing.app.id}` &&
        !outing.app.exists
      ) {
        gets += 1;
        // The confirmation step finds the activity back.
        if (gets === 2) outing.app.exists = true;
      }
    };
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("failed");
    expect(h.freeze.isFrozen()).toBe(true);
    await h.freeze.unfreeze("synthetic");
    patchGroup(h.db, group.id, { status: "a_deleting" }, 0);
    outing.app.exists = false;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("done");
  });

  it("retries the confirmation after a transient lookup failure", async () => {
    h = await accepting({ timing: { gracePeriodMs: 0 }, switches: { delete: true } });
    const outing = addOuting(h.world);
    let gets = 0;
    h.world.failStatus = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/v3/activities/${outing.fitbit.id}` &&
        !outing.fitbit.exists
      ) {
        gets += 1;
        if (gets === 2) return 503;
      }
      return null;
    };
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("a_confirming");
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("done");
  });
});

describe("restore", () => {
  it("flags a restore without an original, or refused with a processing error", async () => {
    h = await createHarness();
    const outing = addOuting(h.world, { fitbitWithoutOriginal: true });
    await h.poller.poll();
    expect(await h.machine.restoreActivity(outing.fitbit.id)).toEqual({
      status: "flagged",
      reason: "no_original_in_backup",
    });
    outing.app.exists = false;
    h.world.uploadError = "Synthetic processing failure";
    expect(await h.machine.restoreActivity(outing.app.id)).toEqual({
      status: "flagged",
      reason: "Synthetic processing failure",
    });
  });

  it("restores with a fallback external id and flags metadata it could not restore", async () => {
    h = await createHarness();
    h.session.formFails = true;
    const outing = addOuting(h.world);
    outing.app.externalId = null;
    await h.poller.poll();
    h.session.formFails = false;
    await h.backup.backupActivity(outing.fitbit.id);
    h.session.formFails = true;
    outing.app.exists = false;
    outing.fitbit.exists = false;
    h.world.duplicatePolicy = () => null;
    const first = await h.machine.restoreActivity(outing.app.id);
    expect(first).toMatchObject({ status: "restored", flags: ["no web form in backup"] });
    expect(h.world.uploadsWithExternalId(`cameld-restore-${outing.app.id}`)).toHaveLength(1);
    h.session.loggedIn = false;
    await h.web.keepAlive();
    const second = await h.machine.restoreActivity(outing.fitbit.id);
    expect(second.status).toBe("restored");
    expect((second as { flags: string[] }).flags[0]).toMatch(/^restore_web: WebPausedError/);
  });
});
