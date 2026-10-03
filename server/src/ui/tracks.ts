import type { DatabaseSync } from "node:sqlite";
import {
  type ActivitySample,
  type GroupTracks,
  type LngLat,
  type MergeSettings,
  readFitActivity,
  type TrackLine,
} from "@cameld/shared";
import { readStoredOriginal, readVerifiedFile } from "../service/backup.ts";
import { buildMerge } from "../state/build.ts";
import { SampleCache } from "../state/evaluate.ts";
import type { GroupRow } from "../state/repo.ts";
import { requireActivity } from "../state/repo.ts";

/**
 * Tracks for the review map: both sources from their ORIGINAL backed-up files
 * and the merge (the stored merged FIT once built, else an in-memory preview
 * built exactly as the state machine would). Read-only; works without Strava.
 */

/** Points per line sent to the browser; longer tracks are thinned evenly. */
export const MAX_POINTS = 2000;

export function toLine(label: string, samples: readonly ActivitySample[]): TrackLine | null {
  const located = samples.filter(
    (s): s is ActivitySample & { lat: number; lng: number } =>
      s.lat !== undefined && s.lng !== undefined,
  );
  if (located.length === 0) return null;
  const step = Math.max(1, Math.ceil(located.length / MAX_POINTS));
  const coordinates: LngLat[] = [];
  for (let i = 0; i < located.length; i += step) {
    const s = located[i] as { lat: number; lng: number };
    coordinates.push([s.lng, s.lat]);
  }
  const last = located[located.length - 1] as { lat: number; lng: number };
  const tail = coordinates[coordinates.length - 1] as LngLat;
  if (tail[0] !== last.lng || tail[1] !== last.lat) coordinates.push([last.lng, last.lat]);
  return { label, coordinates, points: located.length };
}

function offsetOf(group: GroupRow): number {
  if (group.offsetSeconds !== 0) return group.offsetSeconds;
  const match = group.match as {
    metrics?: { alignment?: { offsetSeconds?: number } | null } | null;
  };
  return match?.metrics?.alignment?.offsetSeconds ?? 0;
}

export async function groupTracks(
  db: DatabaseSync,
  backupRoot: string,
  group: GroupRow,
  mergeSettings: MergeSettings,
): Promise<GroupTracks> {
  const cache = new SampleCache(db, {
    readOriginal: (id) => readStoredOriginal(db, backupRoot, id),
  });
  const notes: string[] = [];
  const side = async (ids: number[], label: string): Promise<ActivitySample[] | null> => {
    if (ids.length === 0) return null;
    for (const id of ids) {
      if (requireActivity(db, id).originalStatus !== "present") {
        notes.push(`${label}: original file of ${String(id)} is not in the backup`);
        return null;
      }
    }
    try {
      return await cache.concat(ids);
    } catch (error) {
      notes.push(`${label}: ${(error as Error).message}`);
      return null;
    }
  };
  const app = await side(group.appIds, "phone");
  const fitbit = await side(group.fitbitIds, "wrist");

  let merged: TrackLine | null = null;
  if (group.mergedPath !== null) {
    try {
      const bytes = await readVerifiedFile(backupRoot, group.mergedPath);
      merged = toLine(
        "merged",
        readFitActivity(new Uint8Array(bytes), { source: "merged" }).samples,
      );
    } catch (error) {
      notes.push(`merged: ${(error as Error).message}`);
    }
  } else if (app !== null && fitbit !== null) {
    try {
      const sport = requireActivity(db, group.appIds[0] as number).sportType;
      const built = buildMerge({
        app,
        fitbit,
        offsetSeconds: offsetOf(group),
        sport,
        settings: mergeSettings,
      });
      merged = toLine("merge preview", built.samples);
    } catch (error) {
      notes.push(`merge preview: ${(error as Error).message}`);
    }
  }
  const appLine = app === null ? null : toLine("phone", app);
  const fitbitLine = fitbit === null ? null : toLine("wrist", fitbit);
  if (app !== null && appLine === null) notes.push("phone: no GPS points");
  if (fitbit !== null && fitbitLine === null) notes.push("wrist: no GPS points");
  return { app: appLine, fitbit: fitbitLine, merged, notes };
}
