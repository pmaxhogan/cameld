import { afterEach, describe, expect, it } from "vitest";
import { Poller } from "../src/service/poller.ts";
import {
  beginWrite,
  getActivity,
  groupEvents,
  listGroups,
  requireGroup,
  setActivityFields,
  writesFor,
} from "../src/state/repo.ts";
import { LoginRequiredError } from "../src/web/errors.ts";
import { addOuting, addSingle } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";
import { captureLogger } from "./state-helpers.ts";

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

function poller(extra: Partial<ConstructorParameters<typeof Poller>[0]> = {}): Poller {
  return new Poller({
    db: h.db,
    api: h.client,
    backup: h.backup,
    machine: h.machine,
    web: h.web,
    settings: h.settings,
    clock: h.clock,
    ...extra,
  });
}

describe("machine branches", () => {
  it("records a repeated transient error once", async () => {
    h = await createHarness();
    addOuting(h.world);
    h.snapshotter.fail = true;
    await h.poller.poll();
    await h.machine.tick();
    const group = listGroups(h.db)[0]!;
    const transient = groupEvents(h.db, group.id).filter((e) => e.event.startsWith("transient:"));
    expect(transient).toHaveLength(1);
  });

  it("never re-attaches a photo whose attach was already journaled", async () => {
    h = await accepting();
    const outing = addOuting(h.world, { withPhoto: true });
    outing.fitbit.photos.push({
      uniqueId: "synthetic-wrist-photo",
      bytes: Buffer.from("w"),
      createdAt: "",
    });
    const attach = h.session.attachPhoto.bind(h.session);
    let calls = 0;
    h.session.attachPhoto = async (id, photo) => {
      calls += 1;
      const result = await attach(id, photo);
      if (calls === 1) {
        await h.web.run(() => Promise.reject(new LoginRequiredError("x"))).catch(() => undefined);
      }
      return result;
    };
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("uploaded");
    await h.web.keepAlive();
    await h.machine.tick();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("hidden");
    expect(calls).toBe(2);
    expect(h.world.get(group.mergedActivityId!)!.photos).toHaveLength(2);
  });

  it("freezes with the web error when an odd delete answer leaves the activity in place", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    addOuting(h.world);
    h.session.deleteMode = "error";
    await h.poller.poll();
    expect(h.freeze.isFrozen()).toBe(true);
    expect(h.freeze.state().evidence).toMatchObject({
      webError: expect.stringMatching(/odd page/),
    });
  });

  it("reconciles deletes outside a group and ones already recorded", async () => {
    h = await createHarness({ settings: { switches: { delete: true } } });
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.deletedIds).toEqual([outing.fitbit.id, outing.app.id]);
    beginWrite(h.db, { groupId: null, kind: "delete", targetId: outing.app.id }, 0);
    beginWrite(h.db, { groupId: group.id, kind: "delete", targetId: outing.app.id }, 0);
    await h.machine.reconcile();
    expect(writesFor(h.db, { kind: "delete" }).every((w) => w.status === "done")).toBe(true);
    expect(requireGroup(h.db, group.id).deletedIds).toEqual([outing.fitbit.id, outing.app.id]);
  });

  it("restores sparse metadata: hidden from home, no note, no visibility, no exertion", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    single.hideFromHome = true;
    (single as { visibility: unknown }).visibility = null;
    await h.poller.poll();
    single.exists = false;
    h.world.duplicatePolicy = () => null;
    const outcome = await h.machine.restoreActivity(single.id);
    expect(outcome).toMatchObject({ status: "restored", flags: [] });
    const restored = h.world.get((outcome as { newId: number }).newId)!;
    expect(restored.hideFromHome).toBe(true);
    expect(restored.privateNote).toBe("");
  });

  it("settles a restore upload by its upload id after a lost answer", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    await h.poller.poll();
    single.exists = false;
    h.world.duplicatePolicy = () => null;
    let fired = false;
    h.fault = (method, url) => {
      if (!fired && method === "GET" && /\/uploads\/\d+$/.test(url.pathname)) {
        fired = true;
        return "lose_response";
      }
      return null;
    };
    await expect(h.machine.restoreActivity(single.id)).rejects.toThrow(/fetch failed/);
    await h.machine.reconcile();
    expect(writesFor(h.db, { kind: "restore_upload" })[0]?.status).toBe("done");
    expect((await h.machine.restoreActivity(single.id)).status).toBe("restored");
  });
});

describe("poller options", () => {
  it("pages through long lists and retries old incomplete backups within limits", async () => {
    h = await createHarness();
    addOuting(h.world);
    const old = addSingle(h.world, -30);
    const paged = poller({ pageSize: 1 });
    expect((await paged.poll()).listed).toBe(2);
    // An old activity outside the list window, still missing its backup.
    h.db
      .prepare(
        "INSERT INTO activities (id, start_ms, end_ms, source, first_seen_at) VALUES (?, ?, ?, 'app', 0)",
      )
      .run(old.id, old.startMs, old.startMs + 1000);
    expect((await poller({ retryLimit: 0 }).poll()).backedUp).toBe(0);
    expect(
      (
        await poller({
          readReserve: 50,
          limiter: { usage: () => ({ read: { day: { limit: 1000, usage: 990 } } }) } as never,
        }).poll()
      ).backedUp,
    ).toBe(0);
    expect((await paged.poll()).backedUp).toBe(1);
    expect(getActivity(h.db, old.id)?.backedUpAt).not.toBeNull();
    setActivityFields(h.db, old.id, { web_form_saved: 0 });
    expect((await h.poller.poll()).backedUp).toBe(1);
  });

  it("logs a non-transient backup failure and keeps polling", async () => {
    h = await createHarness();
    const { log, lines } = captureLogger();
    const single = addSingle(h.world, 0);
    h.world.failStatus = (_m, path) =>
      path === `/api/v3/activities/${single.id}/streams` ? 400 : null;
    expect((await poller({ log }).poll()).error).toBeNull();
    expect(lines.join("")).toContain("activity backup failed");
  });
});

describe("backfill branches", () => {
  it("reports an indoor pair at offset 0 and logs a non-transient failure", async () => {
    h = await createHarness({ settings: { backfill: { mode: "dry_run" } } });
    addOuting(h.world, { indoor: true });
    h.clock.t += 10 * 24 * 3600_000;
    expect((await h.backfill.runBatch()).stopped).toBe("done");
    const report = h.backfill.report().groups[0]!.report as {
      match: { metrics: { alignment: null } };
    };
    expect(report.match.metrics.alignment).toBeNull();
    h.backfill.reset();
    h.db.prepare("DELETE FROM backup_files").run();
    h.db.prepare("DELETE FROM activities").run();
    h.world.failStatus = (_m, path) => (path.endsWith("/streams") ? 400 : null);
    expect(await h.backfill.runBatch()).toMatchObject({ stopped: "error" });
  });
});
