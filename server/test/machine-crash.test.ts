import { afterEach, describe, expect, it } from "vitest";
import { beginWrite, groupEvents, listGroups, requireGroup, writesFor } from "../src/state/repo.ts";
import type { DeletionAuthorization } from "../src/web/deletion-authorization.ts";
import { addOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness, uploadCount } from "./machine-harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function acceptingHarness(settings = {}): Promise<Harness> {
  const harness = await createHarness({ settings });
  harness.world.duplicatePolicy = (incoming) =>
    harness.world.live().find((a) => a.externalId === incoming.externalId)?.id ?? null;
  return harness;
}

/** Fault exactly the nth request matching method and path suffix. */
function once(method: string, suffix: string | RegExp, kind: "lose_response" | "fail_before_send") {
  let fired = false;
  return (m: string, url: URL) => {
    const hit =
      typeof suffix === "string" ? url.pathname.endsWith(suffix) : suffix.test(url.pathname);
    if (!fired && m === method && hit) {
      fired = true;
      return kind;
    }
    return null;
  };
}

describe("crash and resume: an upload is never repeated", () => {
  it("persists the intent with the external id before the upload request is sent", async () => {
    h = await acceptingHarness();
    addOuting(h.world);
    const seen: string[] = [];
    h.world.onRequest = (method, path) => {
      if (method === "POST" && path.endsWith("/uploads")) {
        const open = writesFor(h.db, { kind: "upload" }).filter((w) => w.status === "intent");
        seen.push(open.map((w) => w.externalId).join(","));
      }
    };
    await h.poller.poll();
    const [group] = listGroups(h.db);
    expect(seen).toEqual([group!.externalId]);
    expect(writesFor(h.db, { kind: "upload" })[0]).toMatchObject({ status: "done" });
  });

  it("finds a lost upload by external id after a restart (no upload id recorded)", async () => {
    h = await acceptingHarness();
    addOuting(h.world);
    h.fault = once("POST", "/uploads", "lose_response");
    await h.poller.poll();
    let [group] = listGroups(h.db);
    expect(group?.status).toBe("snapshotted");
    expect(group?.lastError).toMatch(/^transient:TypeError: fetch failed/);
    expect(writesFor(h.db, { kind: "upload" })[0]).toMatchObject({
      status: "intent",
      uploadId: null,
    });

    h.restart();
    await h.machine.tick();
    [group] = listGroups(h.db);
    expect(group?.status).toBe("hidden");
    expect(uploadCount(h, group!.externalId)).toBe(1);
    expect(writesFor(h.db, { kind: "upload" })[0]).toMatchObject({
      status: "done",
      result: { via: "lookup" },
    });
  });

  it("resolves an upload whose id was recorded by asking strava for that upload", async () => {
    h = await acceptingHarness();
    addOuting(h.world);
    h.fault = once("GET", /\/uploads\/\d+$/, "lose_response");
    await h.poller.poll();
    expect(writesFor(h.db, { kind: "upload" })[0]?.uploadId).not.toBeNull();
    h.restart();
    await h.machine.tick();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("hidden");
    expect(uploadCount(h, group!.externalId)).toBe(1);
  });

  it("leaves an upload that is still processing open and settles it later", async () => {
    h = await acceptingHarness();
    addOuting(h.world);
    h.world.processingPolls = 100;
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.lastError).toMatch(/UploadTimeoutError/);
    h.restart();
    await h.machine.tick();
    expect(writesFor(h.db, { kind: "upload" })[0]?.status).toBe("intent");
    h.world.processingPolls = 0;
    for (const upload of h.world.uploads.values()) upload.pollsLeft = 0;
    await h.machine.tick();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("hidden");
    expect(uploadCount(h, group!.externalId)).toBe(1);
  });

  it("uploads exactly once when the process died after the intent but before sending", async () => {
    h = await acceptingHarness();
    addOuting(h.world);
    h.fault = once("POST", "/uploads", "fail_before_send");
    await h.poller.poll();
    h.restart();
    await h.machine.tick();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("hidden");
    expect(uploadCount(h, group!.externalId)).toBe(1);
    expect(writesFor(h.db, { kind: "upload" }).map((w) => w.status)).toEqual([
      "superseded",
      "done",
    ]);
  });

  it("treats a duplicate of its own earlier upload as the merge, never as path B", async () => {
    h = await createHarness({ settings: { switches: { upload: false, delete: true } } });
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("snapshotted");
    // An earlier upload landed but its journal was lost (e.g. a restored database).
    const earlier = h.world.add({
      name: "Synthetic Upload",
      sportType: "Run",
      externalId: group.externalId,
      samples: outing.app.samples,
    });
    h.settings.update({ switches: { upload: true } });
    await h.machine.tick();
    const after = requireGroup(h.db, group.id);
    expect(after.path).toBe("A");
    expect(after.mergedActivityId).toBe(earlier.id);
    expect(h.session.deleted).toEqual([]);
    expect(writesFor(h.db, { kind: "upload" })[0]).toMatchObject({
      status: "done",
      result: { via: "own_duplicate" },
    });
  });
});

describe("crash and resume: a delete is never repeated", () => {
  it("persists the delete intent before the web delete is sent", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    addOuting(h.world);
    const original = h.session.deleteActivity.bind(h.session);
    const open: number[] = [];
    h.session.deleteActivity = (id: number, auth: DeletionAuthorization) => {
      open.push(
        writesFor(h.db, { kind: "delete" }).filter(
          (w) => w.status === "intent" && w.targetId === id,
        ).length,
      );
      return original(id, auth);
    };
    await h.poller.poll();
    expect(open).toEqual([1, 1]);
  });

  it("confirms a delete whose web confirmation was lost through the API, once", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.session.deleteMode = "lose_confirmation";
    await h.poller.poll();
    // The lost confirmation looked like an expired login: web actions paused.
    let [group] = listGroups(h.db);
    expect(group?.deletedIds).toEqual([outing.fitbit.id]);
    expect(h.web.available()).toBe(false);
    expect(h.freeze.isFrozen()).toBe(false);
    h.session.deleteMode = "normal";
    await h.web.keepAlive();
    await h.machine.tick();
    [group] = listGroups(h.db);
    expect(group?.status).toBe("done");
    expect(h.session.deleted).toEqual([outing.fitbit.id, outing.app.id]);
    expect(writesFor(h.db, { kind: "delete" })[0]?.result).toMatchObject({ confirmed: "api_404" });
  });

  it("freezes and notifies when a sent delete cannot be confirmed, then resolves it by lookup", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    h.world.duplicatePolicy = (incoming) =>
      incoming.externalId.startsWith("cameld-merge-") ? outing.app.id : null;
    let deletes = 0;
    h.fault = (method, url) => {
      if (
        method === "GET" &&
        url.pathname.endsWith(`/activities/${outing.fitbit.id}`) &&
        h.session.deleted.length === 1 &&
        deletes === 0
      ) {
        deletes += 1;
        return "lose_response";
      }
      return null;
    };
    await h.poller.poll();
    expect(h.freeze.isFrozen()).toBe(true);
    expect(h.notifier.kinds()).toContain("deletion_unconfirmed");
    expect(writesFor(h.db, { kind: "delete" })[0]?.status).toBe("unknown");

    h.restart();
    await h.machine.tick();
    expect(writesFor(h.db, { kind: "delete" })[0]?.status).toBe("done");
    // Frozen with an original deleted and no merge: the original is restored.
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("failed");
    expect(h.session.deleted).toEqual([outing.fitbit.id]);
    expect(h.world.live().some((a) => a.externalId === outing.fitbit.externalId)).toBe(true);
  });

  it("re-runs the guard and deletes once when the process died after the intent", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("parked");
    beginWrite(
      h.db,
      { groupId: group.id, kind: "delete", targetId: outing.fitbit.id },
      h.clock.now(),
    );
    h.settings.update({ switches: { delete: true } });
    h.restart();
    await h.machine.tick();
    expect(writesFor(h.db, { kind: "delete" }).map((w) => [w.targetId, w.status])).toEqual([
      [outing.fitbit.id, "failed"],
      [outing.fitbit.id, "done"],
      [outing.app.id, "done"],
    ]);
    expect(h.session.deleted).toEqual([outing.fitbit.id, outing.app.id]);
    expect(requireGroup(h.db, group.id).status).toBe("done");
  });
});

describe("crash and resume: other intents", () => {
  it("never retries an open photo attach and flags the pair; field edits run again", async () => {
    h = await createHarness();
    addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    beginWrite(h.db, { groupId: group.id, kind: "photo", targetId: 1, externalId: "x:y" }, 0);
    beginWrite(h.db, { groupId: group.id, kind: "private_note", targetId: 1 }, 0);
    beginWrite(h.db, { groupId: null, kind: "photo", targetId: 1, externalId: "x:z" }, 0);
    await h.machine.reconcile();
    expect(writesFor(h.db, { kind: "photo" }).map((w) => w.status)).toEqual(["failed", "failed"]);
    expect(writesFor(h.db, { kind: "private_note" })[0]?.status).toBe("superseded");
    expect(requireGroup(h.db, group.id).photosFlagged).toBe(true);
  });

  it("keeps an intent open when the lookup itself fails", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    beginWrite(h.db, { groupId: group.id, kind: "delete", targetId: outing.app.id }, 0);
    h.fault = () => "lose_response";
    await h.machine.reconcile();
    expect(writesFor(h.db, { kind: "delete" })[0]?.status).toBe("intent");
    h.fault = null;
    await h.machine.reconcile();
    expect(writesFor(h.db, { kind: "delete" })[0]?.status).toBe("failed");
    expect(groupEvents(h.db, group.id).length).toBeGreaterThan(0);
  });

  it("finds a lost restore upload by the original's external id", async () => {
    h = await createHarness();
    const outing = addOuting(h.world);
    await h.poller.poll();
    outing.fitbit.exists = false;
    h.world.duplicatePolicy = () => null;
    h.fault = once("POST", "/uploads", "lose_response");
    await expect(h.machine.restoreActivity(outing.fitbit.id)).rejects.toThrow(/fetch failed/);
    h.restart();
    await h.machine.reconcile();
    const write = writesFor(h.db, { kind: "restore_upload" })[0];
    expect(write).toMatchObject({ status: "done", result: { via: "lookup" } });
    const outcome = await h.machine.restoreActivity(outing.fitbit.id);
    expect(outcome.status).toBe("restored");
    expect(uploadCount(h, outing.fitbit.externalId!)).toBe(1);
    expect(await h.machine.restoreActivity(outing.fitbit.id)).toEqual(
      outcome.status === "restored"
        ? { status: "restored", newId: outcome.newId, flags: [] }
        : outcome,
    );
  });
});
