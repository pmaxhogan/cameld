import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckFailedError, isTransient } from "../src/state/machine.ts";
import { groupEvents, listGroups, requireGroup, writesFor } from "../src/state/repo.ts";
import { StravaApiError } from "../src/strava/client.ts";
import { DeletionAuthorization } from "../src/web/deletion-authorization.ts";
import { addOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("deletion guards", () => {
  it("parks instead of deleting while the deletion switch is off", async () => {
    h = await createHarness();
    addOuting(h.world);
    await h.poller.poll();
    expect(listGroups(h.db)[0]).toMatchObject({
      status: "parked",
      parkedReason: "deletion_switch_off",
    });
    expect(writesFor(h.db, { kind: "delete" })).toEqual([]);
  });

  it("parks a pair whose original file is missing, before anything is written", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    addOuting(h.world, { fitbitWithoutOriginal: true });
    await h.poller.poll();
    expect(listGroups(h.db)[0]).toMatchObject({
      status: "parked",
      parkedReason: "original_missing",
    });
    expect(h.world.uploads.size).toBe(0);
    expect(h.session.deleted).toEqual([]);
  });

  it("refuses to delete when the pre-delete backup went stale before the token was minted", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    addOuting(h.world);
    // The pre-delete snapshot takes longer than the 15 minute authorization TTL.
    h.snapshotter.onSnapshot = () => {
      if (h.snapshotter.taken.length >= 1) h.clock.t += DeletionAuthorization.TTL_MS + 1000;
    };
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("b_delete_fitbit");
    expect(group.lastError).toBe("wait:deletion_refused");
    const refused = groupEvents(h.db, group.id).find((e) => e.event === "deletion_refused");
    expect((refused?.evidence as { problem: string }).problem).toMatch(/backupVerifiedAt/);
    expect(h.session.calls.some((c) => c.op === "delete")).toBe(false);
    expect(writesFor(h.db, { kind: "delete" })).toEqual([]);
    // A fresh attempt with a quick snapshot goes through.
    h.snapshotter.onSnapshot = undefined;
    await h.machine.tick();
    expect(requireGroup(h.db, group.id).status).toBe("done");
  });

  it("waits while the snapshot helper is down and the web session is paused", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    addOuting(h.world);
    h.snapshotter.fail = true;
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("built");
    expect(listGroups(h.db)[0]?.lastError).toMatch(/SnapshotError/);
    h.snapshotter.fail = false;
    h.session.loggedIn = false;
    await h.web.keepAlive();
    expect(h.notifier.kinds()).toContain("login_unhealthy");
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("b_delete_fitbit");
    expect(listGroups(h.db)[0]?.lastError).toMatch(/WebPausedError/);
    expect(writesFor(h.db, { kind: "delete" })).toEqual([
      { ...writesFor(h.db, { kind: "delete" })[0], status: "failed" },
    ]);
    h.session.loggedIn = true;
    await h.web.keepAlive();
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("done");
  });

  it("freezes when the web claims a delete that the API does not confirm", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.session.deleteMode = "noop";
    await h.poller.poll();
    expect(h.freeze.isFrozen()).toBe(true);
    expect(outing.fitbit.exists).toBe(true);
    expect(writesFor(h.db, { kind: "delete" })[0]).toMatchObject({
      status: "failed",
      result: { stillExists: true },
    });
    expect(listGroups(h.db)[0]?.status).toBe("b_delete_fitbit");
  });

  it("treats a challenged delete as a paused web session, not a failure", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    addOuting(h.world);
    h.session.deleteMode = "challenge";
    await h.poller.poll();
    expect(h.freeze.isFrozen()).toBe(false);
    expect(h.web.available()).toBe(false);
    expect(listGroups(h.db)[0]?.lastError).toMatch(/ChallengeError/);
  });

  it("freezes when the pre-delete backup fails read-back verification", async () => {
    h = await createHarness({ settings: { switches: { upload: false, delete: true } } });
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    // Corrupt a stored kudos file of the wrist copy before its pre-delete backup.
    const row = h.db
      .prepare("SELECT rel_path FROM backup_files WHERE activity_id = ? AND kind = 'streams'")
      .get(outing.fitbit.id) as { rel_path: string };
    writeFileSync(join(h.dir, "backup", row.rel_path), "tampered");
    h.settings.update({ switches: { upload: true } });
    await h.machine.tick();
    expect(h.freeze.isFrozen()).toBe(true);
    expect(requireGroup(h.db, group.id).status).toBe("failed");
    expect(h.session.deleted).toEqual([]);
  });
});

describe("freeze on failure", () => {
  it("freezes and fails the group when the exact no-loss check fails", async () => {
    h = await createHarness({
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
    addOuting(h.world);
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("failed");
    expect(h.freeze.state().reason).toMatch(/exact no-loss check failed/);
    expect(h.world.uploads.size).toBe(0);
    expect(await h.metrics.render()).toContain("cameld_writes_frozen 1");
  });

  it("freezes when the post-upload tolerance check fails, and keeps backing up", async () => {
    h = await createHarness();
    h.world.duplicatePolicy = () => null;
    h.world.uploadDistanceFactor = 1.5;
    addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("failed");
    const failed = groupEvents(h.db, group.id).at(-1)!;
    expect((failed.evidence as { evidence: { failures: string[] } }).evidence.failures).toEqual([
      "distance",
    ]);
    addOuting(h.world, { day: 1, seed: 99 });
    h.clock.t += 24 * 3600_000;
    const poll = await h.poller.poll();
    expect(poll.backedUp).toBeGreaterThan(0);
    expect(listGroups(h.db).find((g) => g.id !== group.id)?.lastError).toBe("wait:frozen");
  });

  it("freezes when the merge upload is refused with a processing error", async () => {
    h = await createHarness();
    h.world.uploadError = "Synthetic processing failure";
    addOuting(h.world);
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("failed");
    expect(h.freeze.isFrozen()).toBe(true);
  });

  it("freezes on a missing heart rate after upload", async () => {
    h = await createHarness();
    h.world.duplicatePolicy = () => null;
    h.world.dropUploadHeartRate = true;
    addOuting(h.world);
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("failed");
  });

  it("freezes on an unexpected error but keeps the group for after the fix", async () => {
    h = await createHarness();
    addOuting(h.world);
    h.fault = (method, url) =>
      method === "POST" && url.pathname.endsWith("/uploads") ? "fail_before_send" : null;
    // A 400 is not transient: the request was refused outright.
    h.world.onRequest = undefined;
    await h.poller.poll();
    expect(h.freeze.isFrozen()).toBe(false);
    h.fault = null;
    h.restart({
      api: {
        ...h.client,
        getActivity: (id: number) => h.client.getActivity(id),
        getStreams: (id: number, keys?: never) => h.client.getStreams(id, keys),
        listActivities: (p?: never) => h.client.listActivities(p),
        updateActivity: (id: number, f: never) => h.client.updateActivity(id, f),
        getUpload: (id: number) => h.client.getUpload(id),
        waitForUpload: (u: never, o?: never) => h.client.waitForUpload(u, o),
        createUpload: () => Promise.reject(new StravaApiError(400, "/uploads", "bad request")),
      },
    });
    await h.machine.tick();
    const group = listGroups(h.db)[0]!;
    expect(h.freeze.isFrozen()).toBe(true);
    expect(group.status).toBe("snapshotted");
    expect(group.lastError).toMatch(/StravaApiError/);
    expect(writesFor(h.db, { kind: "upload" }).map((w) => w.status)).toEqual([
      "superseded",
      "failed",
    ]);
  });

  it("freezes when a stored original no longer matches its checksum", async () => {
    h = await createHarness({ settings: { switches: { upload: false } } });
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    rmSync(join(h.dir, "backup", group.mergedPath!));
    h.settings.update({ switches: { upload: true } });
    await h.machine.tick();
    expect(h.freeze.isFrozen()).toBe(true);
    expect(requireGroup(h.db, group.id).lastError).toMatch(/BackupIntegrityError/);
    expect(outing.app.exists).toBe(true);
  });
});

describe("error classification", () => {
  it("knows which errors are transient", () => {
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(new TypeError("x is not a function"))).toBe(false);
    expect(isTransient(new StravaApiError(503, "/x", ""))).toBe(true);
    expect(isTransient(new StravaApiError(400, "/x", ""))).toBe(false);
    expect(isTransient(new CheckFailedError("x", null))).toBe(false);
    expect(isTransient("string")).toBe(false);
  });
});
