import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listGroups, patchGroup, requireGroup } from "../src/state/repo.ts";
import { DEFAULT_SETTINGS } from "../src/state/settings.ts";
import { groupTracks, MAX_POINTS, toLine } from "../src/ui/tracks.ts";
import { addOuting } from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const merge = DEFAULT_SETTINGS.merge;

describe("toLine", () => {
  it("keeps located samples as [lng, lat], thinning long tracks but keeping the end", () => {
    expect(toLine("x", [{ time: 1, source: "s" }])).toBeNull();
    const short = toLine("x", [
      { time: 1, source: "s", lat: 0.5, lng: 0.6 },
      { time: 2, source: "s" },
      { time: 3, source: "s", lat: 0.51, lng: 0.61 },
    ]);
    expect(short).toEqual({
      label: "x",
      points: 2,
      coordinates: [
        [0.6, 0.5],
        [0.61, 0.51],
      ],
    });
    const long = Array.from({ length: MAX_POINTS * 2 + 1 }, (_, i) => ({
      time: i,
      source: "s",
      lat: 0.5 + i * 1e-6,
      lng: 0.5,
    }));
    const thinned = toLine("y", long)!;
    expect(thinned.points).toBe(long.length);
    expect(thinned.coordinates.length).toBeLessThanOrEqual(MAX_POINTS + 1);
    expect(thinned.coordinates.at(-1)).toEqual([0.5, long.at(-1)!.lat]);
    const even = toLine("z", long.slice(0, MAX_POINTS * 2))!;
    expect(even.coordinates.at(-1)).toEqual([0.5, long[MAX_POINTS * 2 - 1]!.lat]);
  });
});

describe("groupTracks", () => {
  it("draws both sources and a merge preview for a review group", async () => {
    h = await createHarness();
    addOuting(h.world, { fitbitNoiseMeters: 60 });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.status).toBe("review");
    const tracks = await groupTracks(h.db, join(h.dir, "backup"), group, merge);
    expect(tracks.app?.points).toBeGreaterThan(100);
    expect(tracks.fitbit?.points).toBeGreaterThan(100);
    expect(tracks.merged?.label).toBe("merge preview");
    expect(tracks.notes).toEqual([]);
    // An explicit offset wins over the measured one.
    const shifted = await groupTracks(
      h.db,
      join(h.dir, "backup"),
      { ...group, offsetSeconds: 3 },
      merge,
    );
    expect(shifted.merged).not.toBeNull();
    // A failing preview is a note, not an error.
    const broken = await groupTracks(h.db, join(h.dir, "backup"), group, null as never);
    expect(broken.app).not.toBeNull();
    expect(broken.merged).toBeNull();
    expect(broken.notes.join(" ")).toMatch(/^merge preview:/);
  });

  it("uses the stored merged file once built and notes what is missing", async () => {
    h = await createHarness();
    h.world.duplicatePolicy = (incoming) =>
      h.world.live().find((a) => a.externalId === incoming.externalId)?.id ?? null;
    const outing = addOuting(h.world);
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    expect(group.mergedPath).not.toBeNull();
    const root = join(h.dir, "backup");
    const tracks = await groupTracks(h.db, root, group, merge);
    expect(tracks.merged?.label).toBe("merged");

    const missing = await groupTracks(
      h.db,
      root,
      { ...group, mergedPath: "merges/nope/merged.fit" },
      merge,
    );
    expect(missing.notes.join(" ")).toMatch(/^merged:/);

    h.db
      .prepare("UPDATE activities SET original_status = 'none' WHERE id = ?")
      .run(outing.fitbit.id);
    const noWrist = await groupTracks(h.db, root, { ...group, mergedPath: null }, merge);
    expect(noWrist.fitbit).toBeNull();
    expect(noWrist.merged).toBeNull();
    expect(noWrist.notes.join(" ")).toMatch(/wrist: original file of \d+ is not in the backup/);

    h.db
      .prepare(
        "UPDATE activities SET original_path = 'activities/x/original/gone.fit' WHERE id = ?",
      )
      .run(outing.app.id);
    const unreadable = await groupTracks(h.db, root, { ...group, mergedPath: null }, merge);
    expect(unreadable.notes.join(" ")).toMatch(/phone:/);

    const empty = await groupTracks(h.db, root, { ...group, appIds: [], fitbitIds: [] }, merge);
    expect(empty).toEqual({ app: null, fitbit: null, merged: tracks.merged, notes: [] });
    patchGroup(h.db, group.id, { offsetSeconds: 0 }, 0);
    expect(requireGroup(h.db, group.id).offsetSeconds).toBe(0);
  });

  it("notes sources without GPS", async () => {
    h = await createHarness();
    addOuting(h.world, { indoor: true });
    await h.poller.poll();
    const group = listGroups(h.db)[0]!;
    const tracks = await groupTracks(
      h.db,
      join(h.dir, "backup"),
      { ...group, mergedPath: null },
      merge,
    );
    expect(tracks.notes).toContain("phone: no GPS points");
    expect(tracks.notes).toContain("wrist: no GPS points");
  });
});
