import { describe, expect, it } from "vitest";
import { MAX_STRAVA_ID } from "@cameld/shared";
import {
  activitiesBetween,
  activityIds,
  beginWrite,
  exactRows,
  finishWrite,
  getActivity,
  getGroup,
  insertGroup,
  listGroups,
  openWrites,
  patchGroup,
  requireActivity,
  setActivityFields,
  setWriteUploadId,
  upsertActivity,
  writesFor,
} from "../src/state/repo.ts";
import type { StravaSummaryActivity } from "../src/strava/types.ts";
import { memoryDb } from "./state-helpers.ts";

/**
 * 64-bit ids through SQLite. SYNTHETIC ids only. Each pair below differs by
 * one and sits above 2^53, where a JavaScript number cannot tell them apart:
 * a read or write that goes through a number anywhere merges the two.
 */
const A = "9100000000000000101";
const A_NEXT = "9100000000000000102";
const B = "9100000000000000201";
const MERGED = "9100000000000000301";
const UPLOAD = "9100000000000600301";

function summary(id: string, startIso: string): StravaSummaryActivity {
  return {
    id,
    name: `Synthetic ${id.slice(-3)}`,
    sport_type: "Run",
    start_date: startIso,
    start_date_local: startIso,
    distance: 1000,
    moving_time: 600,
    elapsed_time: 600,
    device_name: "Strava App",
    external_id: null,
  };
}

describe("64-bit ids in SQLite", () => {
  it("sanity: these ids collide as numbers", () => {
    expect(Number(A)).toBe(Number(A_NEXT));
  });

  it("stores an id as an exact INTEGER and reads it back digit for digit", () => {
    const db = memoryDb();
    expect(upsertActivity(db, summary(A, "2020-02-02T10:00:00Z"), 1)).toBe(true);
    expect(upsertActivity(db, summary(A_NEXT, "2020-02-02T11:00:00Z"), 1)).toBe(true);
    expect(upsertActivity(db, summary(MAX_STRAVA_ID, "2020-02-02T12:00:00Z"), 1)).toBe(true);
    // A second upsert finds the row instead of inserting a twin.
    expect(upsertActivity(db, summary(A, "2020-02-02T10:00:00Z"), 2)).toBe(false);

    const stored = db
      .prepare("SELECT typeof(id) AS t, CAST(id AS TEXT) AS id FROM activities ORDER BY id")
      .all();
    expect(stored).toEqual([
      { t: "integer", id: A },
      { t: "integer", id: A_NEXT },
      { t: "integer", id: MAX_STRAVA_ID },
    ]);

    expect(requireActivity(db, A).id).toBe(A);
    expect(requireActivity(db, A_NEXT).id).toBe(A_NEXT);
    expect(requireActivity(db, A).name).toBe("Synthetic 101");
    expect(requireActivity(db, A_NEXT).name).toBe("Synthetic 102");
    expect(requireActivity(db, MAX_STRAVA_ID).id).toBe(MAX_STRAVA_ID);
    expect(getActivity(db, B)).toBeNull();
    db.close();
  });

  it("keeps the other integer columns as numbers", () => {
    const db = memoryDb();
    upsertActivity(db, summary(A, "2020-02-02T10:00:00Z"), 1234);
    const row = requireActivity(db, A);
    expect(row.startMs).toBe(Date.parse("2020-02-02T10:00:00Z"));
    expect(row.endMs).toBe(row.startMs + 600_000);
    expect(row.firstSeenAt).toBe(1234);
    expect(row.isMergeOutput).toBe(false);
    expect(row.originalAttempts).toBe(0);
    expect(row.restoredAs).toBeNull();
    db.close();
  });

  it("updates exactly the activity it names", () => {
    const db = memoryDb();
    upsertActivity(db, summary(A, "2020-02-02T10:00:00Z"), 1);
    upsertActivity(db, summary(A_NEXT, "2020-02-02T11:00:00Z"), 1);
    setActivityFields(db, A, { gone_at: 77, restored_as: B });
    setActivityFields(db, A_NEXT, { restored_from: A });
    expect(requireActivity(db, A)).toMatchObject({ goneAt: 77, restoredAs: B, restoredFrom: null });
    expect(requireActivity(db, A_NEXT)).toMatchObject({
      goneAt: null,
      restoredAs: null,
      restoredFrom: A,
    });
    db.close();
  });

  it("lists activities in a window with exact ids", () => {
    const db = memoryDb();
    upsertActivity(db, summary(A_NEXT, "2020-02-02T10:00:00Z"), 1);
    upsertActivity(db, summary(A, "2020-02-02T10:00:00Z"), 1);
    const from = Date.parse("2020-02-02T00:00:00Z");
    // Same start: the tiebreak is the id, in numeric order.
    expect(activitiesBetween(db, from, from + 86_400_000).map((a) => a.id)).toEqual([A, A_NEXT]);
    expect(
      activityIds(db, "SELECT id FROM activities WHERE first_seen_at <= ? ORDER BY id DESC", 5),
    ).toEqual([A_NEXT, A]);
    db.close();
  });

  it("refuses to read an id column the plain way, loudly", () => {
    const db = memoryDb();
    upsertActivity(db, summary(A, "2020-02-02T10:00:00Z"), 1);
    // The guard rail behind exactRows: node:sqlite throws rather than round.
    expect(() => db.prepare("SELECT id FROM activities").all()).toThrow(/too large/);
    expect(exactRows(db, "SELECT id, start_ms FROM activities", ["id"])).toEqual([
      { id: A, start_ms: Date.parse("2020-02-02T10:00:00Z") },
    ]);
    db.close();
  });

  it("refuses an id beyond a signed 64-bit integer instead of storing it wrong", () => {
    const db = memoryDb();
    expect(() =>
      upsertActivity(db, summary("9223372036854775808", "2020-02-02T10:00:00Z"), 1),
    ).toThrow(/datatype mismatch/);
    expect(() => upsertActivity(db, summary("12abc", "2020-02-02T10:00:00Z"), 1)).toThrow(
      /datatype mismatch/,
    );
    expect(db.prepare("SELECT count(*) AS n FROM activities").get()).toEqual({ n: 0 });
    db.close();
  });

  it("round-trips a group's member, upload and merged ids", () => {
    const db = memoryDb();
    const group = insertGroup(
      db,
      { id: "g-1-synthetic", appIds: [A], fitbitIds: [B, A_NEXT], startMs: 5 },
      10,
    );
    expect(group).toMatchObject({ appIds: [A], fitbitIds: [B, A_NEXT], deletedIds: [] });
    expect(group.uploadId).toBeNull();
    expect(group.mergedActivityId).toBeNull();

    patchGroup(
      db,
      group.id,
      { uploadId: UPLOAD, mergedActivityId: MERGED, deletedIds: [A_NEXT], trial: true },
      20,
    );
    const read = getGroup(db, group.id)!;
    expect(read).toMatchObject({
      uploadId: UPLOAD,
      mergedActivityId: MERGED,
      deletedIds: [A_NEXT],
      trial: true,
      updatedAt: 20,
    });
    expect(read.deletedIds.includes(A)).toBe(false);
    expect(listGroups(db, ["detected"])[0]?.mergedActivityId).toBe(MERGED);
    expect(listGroups(db)[0]?.appIds).toEqual([A]);

    // Stored as JSON strings (a JSON number would be rounded on the way back).
    const raw = db
      .prepare(
        "SELECT app_ids, fitbit_ids, deleted_ids, typeof(merged_activity_id) AS t FROM merge_groups",
      )
      .get();
    expect(raw).toEqual({
      app_ids: JSON.stringify([A]),
      fitbit_ids: JSON.stringify([B, A_NEXT]),
      deleted_ids: JSON.stringify([A_NEXT]),
      t: "integer",
    });

    // upsertActivity recognises the merge output by its exact id only.
    upsertActivity(db, summary(MERGED, "2020-02-02T10:00:00Z"), 30);
    upsertActivity(db, summary("9100000000000000302", "2020-02-02T10:00:00Z"), 30);
    expect(requireActivity(db, MERGED).isMergeOutput).toBe(true);
    expect(requireActivity(db, "9100000000000000302").isMergeOutput).toBe(false);
    db.close();
  });

  it("round-trips the write journal's target and upload ids", () => {
    const db = memoryDb();
    const del = beginWrite(db, { groupId: "g-1", kind: "delete", targetId: A }, 1);
    const other = beginWrite(db, { groupId: "g-1", kind: "delete", targetId: A_NEXT }, 2);
    const upload = beginWrite(
      db,
      { groupId: "g-1", kind: "upload", targetId: null, externalId: "x" },
      3,
    );
    setWriteUploadId(db, upload, UPLOAD);

    const open = openWrites(db);
    expect(open.map((w) => [w.id, w.targetId, w.uploadId])).toEqual([
      [del, A, null],
      [other, A_NEXT, null],
      [upload, null, UPLOAD],
    ]);
    expect(typeof open[0]?.id).toBe("number");
    expect(typeof open[0]?.createdAt).toBe("number");

    finishWrite(db, upload, "done", { activityId: MERGED }, 4);
    const done = writesFor(db, { groupId: "g-1", kind: "upload" })[0]!;
    expect(done).toMatchObject({ status: "done", uploadId: UPLOAD, completedAt: 4 });
    expect(done.result).toEqual({ activityId: MERGED });
    // The delete of A is not the delete of its neighbour.
    expect(writesFor(db, { kind: "delete" }).filter((w) => w.targetId === A)).toHaveLength(1);
    db.close();
  });
});
