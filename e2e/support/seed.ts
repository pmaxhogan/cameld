/**
 * Seeds a fresh DATA_DIR for the end to end suite, through the server's own
 * (built) database and backup modules. Everything is SYNTHETIC: tracks are
 * circles around the fictional origin lat 0.5, lng 0.5 (open ocean), ids and
 * names are invented ("Quillmere" does not exist), times are an arbitrary
 * instant in 2020. Run before the server starts:
 *
 *   node e2e/support/seed.ts <DATA_DIR>
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ActivitySample, writeFitActivity } from "@cameld/shared";
import { writeOnce } from "../../server/dist/backup-store.js";
import { migrate, openDatabase } from "../../server/dist/db.js";
import {
  appendEvent,
  insertGroup,
  patchGroup,
  setActivityFields,
  upsertActivity,
} from "../../server/dist/state/repo.js";
import { SEED } from "./constants.ts";

const DAY_MS = 24 * 3600 * 1000;
const START = Date.UTC(2020, 1, 2, 2, 2, 2);
const ORIGIN = { lat: 0.5, lng: 0.5 };
const METRES_PER_DEGREE = 111_320;

/** A 1 Hz loop of `seconds` on a 300 m circle, shifted east by `eastMetres`. */
function loop(
  start: number,
  seconds: number,
  eastMetres: number,
  wrist: boolean,
): ActivitySample[] {
  const out: ActivitySample[] = [];
  for (let t = 0; t < seconds; t += 1) {
    const angle = (t * 3) / 300;
    const north = 300 * Math.sin(angle);
    const east = 300 * Math.cos(angle) + eastMetres;
    const sample: ActivitySample = {
      time: start + t * 1000,
      source: "synthetic",
      lat: ORIGIN.lat + north / METRES_PER_DEGREE,
      lng: ORIGIN.lng + east / METRES_PER_DEGREE,
      altitude: 12 + 3 * Math.sin(t / 50),
      distance: t * 3,
    };
    if (wrist) sample.heartRate = 120 + Math.round(10 * Math.sin(t / 40));
    else sample.speed = 3;
    out.push(sample);
  }
  return out;
}

interface Pair {
  appId: number;
  fitbitId: number;
  start: number;
}

async function addPair(
  db: ReturnType<typeof openDatabase>,
  root: string,
  pair: Pair,
  fitbitEastMetres: number,
): Promise<void> {
  const now = pair.start + DAY_MS;
  const members = [
    {
      id: pair.appId,
      wrist: false,
      device: "Strava App",
      ext: `synthetic-${String(pair.appId)}.fit`,
    },
    {
      id: pair.fitbitId,
      wrist: true,
      device: "Fitbit Charge",
      ext: `fitbit_${String(pair.fitbitId)}.tcx`,
    },
  ];
  for (const member of members) {
    upsertActivity(
      db,
      {
        id: member.id,
        name: member.wrist ? "Afternoon Run" : "Quillmere Harbour Loop",
        sport_type: "Run",
        start_date: new Date(pair.start).toISOString(),
        elapsed_time: 600,
        device_name: member.device,
        external_id: member.ext,
      } as never,
      now,
    );
    const samples = loop(pair.start, 600, member.wrist ? fitbitEastMetres : 0, member.wrist);
    const rel = `activities/${String(member.id)}/original/synthetic-${String(member.id)}.fit`;
    await writeOnce(join(root, rel), writeFitActivity(samples, { sport: "running" }));
    setActivityFields(db, member.id, {
      original_status: "present",
      original_path: rel,
      original_format: "fit",
      backed_up_at: now,
    });
  }
}

function matchSummary(pair: Pair, medianMeters: number): unknown {
  return {
    decision: "review",
    reasons: ["gps_median_between_auto_and_review"],
    memberIds: [pair.appId, pair.fitbitId],
    appIds: [pair.appId],
    fitbitIds: [pair.fitbitId],
    metrics: {
      overlapRatio: 0.97,
      overlapSeconds: 582,
      startDeltaSeconds: 4,
      sportMatch: true,
      appHasGps: true,
      fitbitHasGps: true,
      proximity: { medianMeters, p90Meters: medianMeters * 1.6, pairs: 560 },
      alignment: {
        status: "confident",
        offsetSeconds: 0,
        bestOffsetSeconds: 0,
        bestCostMeters: medianMeters,
        sharpness: 2.4,
      },
    },
  };
}

export async function seed(dataDir: string): Promise<void> {
  mkdirSync(join(dataDir, "state"), { recursive: true });
  const db = openDatabase(join(dataDir, "state", "cameld.db"));
  migrate(db);
  const root = join(dataDir, "backup");

  // 1. A borderline pair waiting for review.
  const review: Pair = { appId: 9_000_000_101, fitbitId: 9_000_000_102, start: START };
  await addPair(db, root, review, 35);
  insertGroup(
    db,
    { id: SEED.reviewGroup, appIds: [review.appId], fitbitIds: [review.fitbitId], startMs: START },
    START,
  );
  patchGroup(db, SEED.reviewGroup, { status: "review", match: matchSummary(review, 35) }, START);
  appendEvent(db, SEED.reviewGroup, START, "backed_up", "review", "scored_review", {
    reasons: ["gps_median_between_auto_and_review"],
  });

  // 2. A finished merge (originals deleted) with a full timeline.
  const done: Pair = { appId: 9_000_000_201, fitbitId: 9_000_000_202, start: START + DAY_MS };
  await addPair(db, root, done, 4);
  insertGroup(
    db,
    { id: SEED.doneGroup, appIds: [done.appId], fitbitIds: [done.fitbitId], startMs: done.start },
    done.start,
  );
  const steps: [string, string, string][] = [
    ["detected", "backed_up", "backed_up"],
    ["backed_up", "scored", "scored_auto"],
    ["scored", "built", "built"],
    ["built", "snapshotted", "snapshotted"],
    ["snapshotted", "uploaded", "uploaded"],
    ["uploaded", "metadata_applied", "metadata_applied"],
    ["metadata_applied", "verified", "verified"],
    ["verified", "hidden", "hidden"],
    ["hidden", "a_deleting", "grace_elapsed"],
    ["a_deleting", "a_confirming", "deleted"],
    ["a_confirming", "done", "confirmed"],
  ];
  steps.forEach(([from, to, event], i) => {
    appendEvent(
      db,
      SEED.doneGroup,
      done.start + (i + 1) * 60_000,
      from as never,
      to as never,
      event,
      { step: i + 1 },
    );
  });
  patchGroup(
    db,
    SEED.doneGroup,
    {
      status: "done",
      path: "A",
      mergedActivityId: 9_000_000_299,
      hiddenAt: done.start + 8 * 60_000,
      deletedIds: [done.appId, done.fitbitId],
      match: matchSummary(done, 4),
    },
    done.start + DAY_MS,
  );
  setActivityFields(db, done.appId, { gone_at: done.start + DAY_MS });
  setActivityFields(db, done.fitbitId, { gone_at: done.start + DAY_MS });

  // 3. A merge whose originals are hidden, waiting out the grace period.
  const hidden: Pair = { appId: 9_000_000_301, fitbitId: 9_000_000_302, start: START + 2 * DAY_MS };
  await addPair(db, root, hidden, 5);
  insertGroup(
    db,
    {
      id: SEED.hiddenGroup,
      appIds: [hidden.appId],
      fitbitIds: [hidden.fitbitId],
      startMs: hidden.start,
    },
    hidden.start,
  );
  patchGroup(
    db,
    SEED.hiddenGroup,
    { status: "hidden", path: "A", mergedActivityId: 9_000_000_399, hiddenAt: hidden.start },
    hidden.start,
  );

  // 4. A dry-run report with one entry of each kind.
  const report = db.prepare(
    "INSERT INTO dry_run_report (group_key, start_ms, decision, report, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  report.run(
    "g-dry-auto",
    START,
    "auto",
    JSON.stringify({
      members: [{ id: 1 }, { id: 2 }],
      match: matchSummary(review, 6),
      noLoss: { ok: true, points: 600 },
    }),
    START,
  );
  report.run(
    "g-dry-review",
    START + DAY_MS,
    "review",
    JSON.stringify({ members: [{ id: 3 }, { id: 4 }], match: matchSummary(review, 40) }),
    START,
  );
  report.run(
    "g-dry-orig",
    START + 2 * DAY_MS,
    "needs_original",
    JSON.stringify({ members: [{ id: 5 }, { id: 6 }] }),
    START,
  );

  // 5. Writes are frozen, so the banner and unfreeze can be exercised.
  db.prepare(
    "INSERT INTO freeze (id, frozen, reason, evidence, frozen_at) VALUES (1, 1, ?, 'null', ?)",
  ).run(SEED.frozenReason, START);
  db.close();
}

const target = process.argv[2];
if (target !== undefined) await seed(target);
