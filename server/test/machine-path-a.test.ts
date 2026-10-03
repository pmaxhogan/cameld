import { afterEach, describe, expect, it } from "vitest";
import { groupEvents, listGroups, writesFor } from "../src/state/repo.ts";
import { addOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness, uploadCount } from "./machine-harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const HOUR = 3600_000;

async function acceptingHarness(settings = {}): Promise<Harness> {
  const harness = await createHarness({ settings });
  // Path A: this Strava accepts the merge while the originals exist.
  harness.world.duplicatePolicy = (incoming) =>
    harness.world.live().find((a) => a.externalId === incoming.externalId)?.id ?? null;
  return harness;
}

describe("path A (hide first)", () => {
  it("uploads, carries metadata, verifies, hides, waits the grace period and stops with delete off", async () => {
    h = await acceptingHarness();
    const outing = addOuting(h.world, { withPhoto: true });
    await h.poller.poll();
    let [group] = listGroups(h.db);
    expect(group?.status).toBe("hidden");
    expect(group?.path).toBe("A");
    expect(outing.app.visibility).toBe("only_me");
    expect(outing.fitbit.visibility).toBe("only_me");
    const merged = h.world.get(group!.mergedActivityId!)!;
    expect(merged.privateNote).toMatch(/merged by cameld from \d+, \d+$/);
    expect(merged.gearId).toBe("g9001");
    expect(merged.photos).toHaveLength(1);
    expect(uploadCount(h, group!.externalId)).toBe(1);

    h.clock.t += 23 * HOUR;
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("hidden");
    h.clock.t += 2 * HOUR;
    await h.machine.tick();
    [group] = listGroups(h.db);
    expect(group?.status).toBe("awaiting_deletion");
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("awaiting_deletion");
    expect(h.session.deleted).toEqual([]);

    // The owner's go-ahead: the next tick deletes both originals and confirms.
    h.settings.update({ switches: { delete: true } });
    await h.machine.tick();
    [group] = listGroups(h.db);
    expect(group?.status).toBe("done");
    expect(h.session.deleted.sort()).toEqual([outing.app.id, outing.fitbit.id].sort());
    const events = groupEvents(h.db, group!.id).map((e) => e.event);
    expect(events).toContain("grace_elapsed");
    expect(events.filter((e) => e === "deleted")).toHaveLength(2);
    expect(events.at(-1)).toBe("confirmed");
    expect(writesFor(h.db, { groupId: group!.id, kind: "delete" }).map((w) => w.status)).toEqual([
      "done",
      "done",
    ]);
    expect(h.notifier.kinds()).toContain("merged");
    expect(await h.metrics.render()).toContain('cameld_merges_total{outcome="merged"} 1');
  });

  it("skips hiding when the hide switch is off and still ages through the grace period", async () => {
    h = await acceptingHarness({ switches: { hide: false } });
    const outing = addOuting(h.world);
    await h.poller.poll();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("hidden");
    expect(outing.app.visibility).toBe("everyone");
    const hidden = groupEvents(h.db, group!.id).find((e) => e.event === "hidden");
    expect(hidden?.evidence).toEqual({ hidden: [], hideSwitch: false });
  });

  it("waits with uploads switched off and while frozen, then proceeds", async () => {
    h = await acceptingHarness({ switches: { upload: false } });
    addOuting(h.world);
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.status).toBe("snapshotted");
    expect(listGroups(h.db)[0]?.lastError).toBe("wait:upload_switch_off");
    await h.machine.tick();
    expect(
      groupEvents(h.db, listGroups(h.db)[0]!.id).filter((e) => e.event.startsWith("wait:")),
    ).toHaveLength(1);
    h.settings.update({ switches: { upload: true } });
    await h.freeze.freeze("synthetic freeze", null);
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.lastError).toBe("wait:frozen");
    expect(h.world.uploads.size).toBe(0);
    await h.freeze.unfreeze("owner fixed forward");
    await h.machine.tick();
    expect(listGroups(h.db)[0]?.status).toBe("hidden");
  });

  it("flags a pair whose photos cannot be re-attached, without blocking the merge", async () => {
    h = await acceptingHarness();
    h.session.photoFails = true;
    addOuting(h.world, { withPhoto: true });
    await h.poller.poll();
    const [group] = listGroups(h.db);
    expect(group?.status).toBe("hidden");
    expect(group?.photosFlagged).toBe(true);
    expect(h.notifier.kinds()).toContain("photos_flagged");
  });

  it("flags unverified photo attaches too", async () => {
    h = await acceptingHarness();
    h.session.photoUnverified = true;
    addOuting(h.world, { withPhoto: true });
    await h.poller.poll();
    expect(listGroups(h.db)[0]?.photosFlagged).toBe(true);
  });
});
