import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { groupIdFor, memberKey } from "../src/state/evaluate.ts";
import { getGroup, listGroups, requireActivity, writesFor } from "../src/state/repo.ts";
import { addOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness, uploadCount } from "./machine-harness.ts";
import { memoryDb } from "./state-helpers.ts";

/**
 * Data written before ids were strings must keep meaning the same thing:
 * group ids (and the external_id of every merge) are derived from the member
 * ids, and rows hold ids as JSON numbers. SYNTHETIC ids only.
 */

describe("group ids do not change", () => {
  // Expected values come from the implementation before the change:
  //   sha256([...ids].sort((a, b) => a - b).join(",")).slice(0, 10)
  // with ids as numbers. A string sort ("100" < "20" < "3") would give others.
  it("hashes members in numeric order, as it always did", () => {
    expect(groupIdFor(1767225600000, ["9400003", "9400001", "10000000000", "999"])).toBe(
      "g-1767225600-f283fb3d33",
    );
    expect(groupIdFor(1767225600000, ["20", "100", "3"])).toBe("g-1767225600-2175725e7f");
  });

  it("builds the same member key whatever the order given", () => {
    expect(memberKey(["20", "100", "3"])).toBe("3,20,100");
    expect(memberKey(["100", "3", "20"])).toBe("3,20,100");
    // Above 2^53, where a numeric sort could no longer tell neighbours apart.
    expect(memberKey(["9100000000000000102", "999", "9100000000000000101"])).toBe(
      "999,9100000000000000101,9100000000000000102",
    );
  });

  it("does not mutate the list it is given", () => {
    const ids = ["20", "100", "3"];
    memberKey(ids);
    expect(ids).toEqual(["20", "100", "3"]);
  });
});

describe("rows written before ids were strings", () => {
  function legacyDb() {
    const db = memoryDb();
    // Exactly what the previous version wrote: INTEGER ids and JSON numbers.
    db.exec(`
      INSERT INTO activities (id, name, sport_type, start_ms, end_ms, source, first_seen_at,
        restored_as) VALUES (9400101, 'Synthetic A', 'Run', 1000, 2000, 'app', 1, 9400401);
      INSERT INTO activities (id, name, sport_type, start_ms, end_ms, source, first_seen_at,
        restored_from) VALUES (9400401, 'Synthetic A again', 'Run', 1000, 2000, 'app', 1, 9400101);
      INSERT INTO merge_groups (id, status, app_ids, fitbit_ids, start_ms, external_id,
        upload_id, merged_activity_id, deleted_ids, match_json, created_at, updated_at)
      VALUES ('g-1-legacy', 'a_confirming', '[9400101]', '[9400102,9400103]', 1000,
        'cameld-merge-g-1-legacy', 77000001, 9400301, '[9400101]',
        '{"memberIds":[9400101,9400102],"appIds":[9400101],"fitbitIds":[9400102]}', 1, 1);
      INSERT INTO strava_writes (group_id, kind, target_id, external_id, status, upload_id,
        result, created_at, completed_at)
      VALUES ('g-1-legacy', 'upload', NULL, 'cameld-merge-g-1-legacy', 'done', 77000001,
        '{"activityId":9400301}', 1, 2);
      INSERT INTO strava_writes (group_id, kind, target_id, status, result, created_at)
      VALUES ('g-1-legacy', 'delete', 9400101, 'sent', '{"webError":null}', 3);
    `);
    return db;
  }

  it("reads a legacy group with every id as the same decimal string", () => {
    const db = legacyDb();
    const group = getGroup(db, "g-1-legacy")!;
    expect(group.appIds).toEqual(["9400101"]);
    expect(group.fitbitIds).toEqual(["9400102", "9400103"]);
    expect(group.deletedIds).toEqual(["9400101"]);
    expect(group.uploadId).toBe("77000001");
    expect(group.mergedActivityId).toBe("9400301");
    // The checks the state machine makes on these lists keep working.
    expect(group.deletedIds.includes(group.appIds[0]!)).toBe(true);
    expect(new Set([...group.appIds, ...group.fitbitIds]).has("9400102")).toBe(true);
    expect(listGroups(db, ["a_confirming"])).toHaveLength(1);
    db.close();
  });

  it("derives the same member key from a legacy group as from a new one", () => {
    const db = legacyDb();
    const group = getGroup(db, "g-1-legacy")!;
    expect(memberKey([...group.appIds, ...group.fitbitIds])).toBe("9400101,9400102,9400103");
    db.close();
  });

  it("reads legacy activities and the journal", () => {
    const db = legacyDb();
    expect(requireActivity(db, "9400101")).toMatchObject({ id: "9400101", restoredAs: "9400401" });
    expect(requireActivity(db, "9400401").restoredFrom).toBe("9400101");
    const [upload] = writesFor(db, { groupId: "g-1-legacy", kind: "upload" });
    expect(upload).toMatchObject({ uploadId: "77000001", targetId: null });
    const [del] = writesFor(db, { kind: "delete" });
    expect(del?.targetId).toBe("9400101");
    expect(del?.targetId === getGroup(db, "g-1-legacy")?.appIds[0]).toBe(true);
    db.close();
  });

  it("refuses a stored id list that is not ids, rather than guess", () => {
    const db = legacyDb();
    db.exec("UPDATE merge_groups SET app_ids = '[9400101.5]'");
    expect(() => getGroup(db, "g-1-legacy")).toThrow(/not a valid Strava id/);
    db.close();
  });
});

describe("a pair in flight when ids became strings", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  it("is not detected again and finishes as the same group, with one upload", async () => {
    h = await createHarness();
    h.world.duplicatePolicy = (incoming) =>
      h.world.live().find((a) => a.externalId === incoming.externalId)?.id ?? null;
    h.world.useLegacyIds();
    const outing = addOuting(h.world, { withPhoto: true });
    await h.poller.poll();
    const before = listGroups(h.db)[0]!;
    expect(before.status).toBe("hidden");

    // The group id is what the previous version derived from NUMBERS.
    const numeric = [outing.app.id, outing.fitbit.id]
      .map(Number)
      .sort((a, b) => a - b)
      .join(",");
    const hash = createHash("sha256").update(numeric).digest("hex").slice(0, 10);
    expect(before.id).toBe(`g-${String(Math.floor(before.startMs / 1000))}-${hash}`);

    // Put the rows back into the shape the previous version wrote: JSON numbers.
    h.db.exec(`
      UPDATE merge_groups SET
        app_ids = (SELECT json_group_array(CAST(value AS INTEGER)) FROM json_each(app_ids)),
        fitbit_ids = (SELECT json_group_array(CAST(value AS INTEGER)) FROM json_each(fitbit_ids)),
        deleted_ids = (SELECT json_group_array(CAST(value AS INTEGER)) FROM json_each(deleted_ids));
      UPDATE strava_writes
        SET result = json_set(result, '$.activityId',
          CAST(json_extract(result, '$.activityId') AS INTEGER))
        WHERE json_extract(result, '$.activityId') IS NOT NULL;
    `);
    const raw = h.db.prepare("SELECT app_ids, fitbit_ids FROM merge_groups").get() as {
      app_ids: string;
      fitbit_ids: string;
    };
    expect(raw.app_ids).toBe(`[${outing.app.id}]`);
    expect(raw.fitbit_ids).toBe(`[${outing.fitbit.id}]`);
    const journaled = h.db
      .prepare("SELECT result FROM strava_writes WHERE kind = 'upload' AND status = 'done'")
      .get() as { result: string };
    expect(typeof (JSON.parse(journaled.result) as { activityId: unknown }).activityId).toBe(
      "number",
    );

    // The new version starts on that database.
    h.restart();
    await h.poller.poll();
    let groups = listGroups(h.db);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: before.id,
      status: "hidden",
      appIds: [outing.app.id],
      fitbitIds: [outing.fitbit.id],
      mergedActivityId: before.mergedActivityId,
    });

    // It carries the pair through deletion to done, as the same group.
    h.settings.update({ switches: { delete: true } });
    h.clock.t += 25 * 3600_000;
    await h.machine.tick();
    await h.machine.tick();
    groups = listGroups(h.db);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe(before.id);
    expect(groups[0]?.status).toBe("done");
    expect([...(groups[0]?.deletedIds ?? [])].sort()).toEqual(
      [outing.app.id, outing.fitbit.id].sort(),
    );
    expect([...h.session.deleted].sort()).toEqual([outing.app.id, outing.fitbit.id].sort());
    expect(uploadCount(h, before.externalId)).toBe(1);
    expect(h.world.get(before.mergedActivityId!)).toBeDefined();
    expect(h.freeze.isFrozen()).toBe(false);
  });
});
