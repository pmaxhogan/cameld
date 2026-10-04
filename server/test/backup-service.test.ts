import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { writeFitActivity } from "@cameld/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupService,
  dataTypeOf,
  noOriginalReason,
  ORIGINAL_BACKOFF_BASE_MS,
  ORIGINAL_BACKOFF_CAP_MS,
  originalBackoffMs,
  parseOriginal,
  safeFilename,
} from "../src/service/backup.ts";
import { WebGate } from "../src/service/web-gate.ts";
import { getActivity, originalCounts, requireActivity } from "../src/state/repo.ts";
import type { StravaDetailedActivity } from "../src/strava/types.ts";
import { WebNoFileError } from "../src/web/errors.ts";
import type { StravaWebSession } from "../src/web/session.ts";
import { SYNTHETIC_PNG } from "./fake-strava/fixtures.ts";
import {
  addOuting,
  addSingle,
  SYNTHETIC_START,
  syntheticTrack,
  toTcx,
} from "./fixtures/synthetic-outings.ts";
import { createHarness, type Harness } from "./machine-harness.ts";
import { captureLogger, RecordingNotifier } from "./state-helpers.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("backup helpers", () => {
  it("derives upload data types and safe file names", () => {
    expect(dataTypeOf("a.FIT")).toBe("fit");
    expect(dataTypeOf("a.tcx.gz")).toBe("tcx.gz");
    expect(dataTypeOf("a.csv")).toBeNull();
    expect(safeFilename("../../etc/pass wd.fit")).toBe("pass_wd.fit");
    expect(safeFilename("dir\\..hidden")).toBe("hidden");
    expect(safeFilename("...")).toBe("original");
  });

  it("parses fit, gzipped tcx and gpx originals", () => {
    const samples = syntheticTrack({
      seed: 3,
      start: SYNTHETIC_START,
      seconds: 5,
      heartRate: true,
    });
    const fit = Buffer.from(writeFitActivity(samples));
    expect(
      parseOriginal({ bytes: fit, dataType: "fit", filename: "a.fit" }, "s").samples,
    ).toHaveLength(5);
    const tcx = gzipSync(Buffer.from(toTcx(samples)));
    expect(
      parseOriginal({ bytes: tcx, dataType: "tcx.gz", filename: "a" }, "s").samples,
    ).toHaveLength(5);
    const gpx = Buffer.from(
      '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>' +
        '<trkpt lat="0.5" lon="0.5"><time>2020-02-02T02:02:02Z</time></trkpt></trkseg></trk></gpx>',
    );
    expect(parseOriginal({ bytes: gpx, dataType: "gpx", filename: "a" }, "s").samples).toHaveLength(
      1,
    );
  });
});

describe("BackupService", () => {
  it("re-fetches what can change on a fresh backup and stores new content only", async () => {
    h = await createHarness();
    const outing = addOuting(h.world, { withPhoto: true });
    await h.poller.poll();
    const files = h.backup.totals().files;
    const same = await h.backup.backupActivity(outing.app.id, { fresh: true });
    expect(same).toMatchObject({ written: 0, verified: true, originalStatus: "present" });
    outing.app.kudos.push({ firstname: "Another", lastname: "Synthetic" });
    outing.app.privateNote = "edited synthetic note";
    const changed = await h.backup.backupActivity(outing.app.id, { fresh: true });
    expect(changed.written).toBe(3);
    expect(h.backup.totals().files).toBe(files + 3);
    expect(await h.backup.latestJson(outing.app.id, "web_form")).toMatchObject({
      privateNote: "edited synthetic note",
    });
  });

  it("records manual entries: no streams, no original", async () => {
    h = await createHarness();
    const manual = h.world.add({
      name: "Synthetic manual",
      sportType: "Run",
      startMs: 1_580_608_922_000,
    });
    await h.backup.backupActivity(manual.id);
    expect(getActivity(h.db, manual.id)?.originalStatus).toBe("unavailable");
    expect(JSON.parse(getActivity(h.db, manual.id)?.originalEvidence ?? "")).toMatchObject({
      reason: "export_not_found",
    });
    expect(await h.backup.latestJson(manual.id, "streams")).toEqual({});
    expect(await h.backup.latestJson(manual.id, "nothing")).toBeNull();
    expect(await h.backup.readOriginal(manual.id)).toBeNull();
  });

  it("skips photos without an id or url, keeps jpegs, and survives failed downloads", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    single.photos.push(
      { uniqueId: "synthetic-jpg", bytes: SYNTHETIC_PNG, createdAt: "" },
      { uniqueId: "synthetic-gone", bytes: SYNTHETIC_PNG, createdAt: "" },
    );
    h.fault = (_m, url) => (url.pathname.endsWith("/synthetic-gone") ? "lose_response" : null);
    await h.backup.backupActivity(single.id);
    expect(h.backup.photoFiles(single.id).map((f) => f.relPath.split("/").pop())).toEqual([
      "synthetic-jpg.jpg",
    ]);
    const { log, lines } = captureLogger();
    const backup = new BackupService({
      db: h.db,
      api: {
        ...h.client,
        getActivity: (id: number) => h.client.getActivity(id),
        getStreams: (id: number) => h.client.getStreams(id),
        getKudoers: (id: number) => h.client.getKudoers(id),
        getComments: (id: number) => h.client.getComments(id),
        getActivityPhotos: () =>
          Promise.resolve([{ unique_id: "x" }, { urls: { "1": "http://x.invalid" } }]),
      },
      web: new WebGate({ session: null, notifier: new RecordingNotifier() }),
      root: `${h.dir}/other`,
      log,
    });
    const before = backup.photoFiles(single.id).length;
    await backup.backupActivity(single.id, { fresh: true });
    expect(backup.photoFiles(single.id)).toHaveLength(before);
    expect(lines.join("")).not.toContain("photo download failed");
  });

  it("downloads photos with plain fetch by default and logs a failed one", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    single.photos.push(
      { uniqueId: "synthetic-a", bytes: SYNTHETIC_PNG, createdAt: "" },
      { uniqueId: "synthetic-b", bytes: SYNTHETIC_PNG, createdAt: "" },
    );
    const { log, lines } = captureLogger();
    const backup = new BackupService({
      db: h.db,
      api: h.client,
      web: h.web,
      root: `${h.dir}/plain`,
      log,
    });
    h.world.failStatus = (_m, path) => (path.endsWith("/synthetic-b") ? 500 : null);
    await backup.backupActivity(single.id);
    expect(backup.photoFiles(single.id).map((f) => f.uniqueId)).toEqual(["synthetic-a"]);
    expect(lines.join("")).toContain("photo download failed");
  });

  it("defers the original and the web form when the web session fails, and logs it", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    h.session.exportFails = true;
    h.session.formFails = true;
    const { log, lines } = captureLogger();
    const backup = new BackupService({
      db: h.db,
      api: h.client,
      web: h.web,
      root: `${h.dir}/d`,
      log,
    });
    const outcome = await backup.backupActivity(single.id);
    expect(outcome).toMatchObject({ originalStatus: "pending", webFormSaved: false });
    expect(lines.join("")).toContain("original export failed; backing off");
    expect(lines.join("")).toContain("web form backup deferred");
  });

  it("reports a failed read-back verification", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    await h.backup.backupActivity(single.id);
    const { rmSync } = await import("node:fs");
    const row = h.db
      .prepare("SELECT rel_path FROM backup_files WHERE activity_id = ? AND kind = 'kudos'")
      .get(single.id) as { rel_path: string };
    rmSync(`${h.dir}/backup/${row.rel_path}`);
    const outcome = await h.backup.backupActivity(single.id);
    expect(outcome.verified).toBe(false);
    expect(outcome.failures[0]).toMatch(/missing-file/);
    expect(await h.backup.verifyActivity(424242)).toEqual({ ok: false, failures: [] });
  });
});

describe("original file exports", () => {
  const exportCalls = (id: number): number =>
    h.session.calls.filter((c) => c.op === "export_original" && c.id === id).length;
  const MINUTE = 60 * 1000;

  it("computes the backoff: 15 minutes doubling to a 24 hour cap", () => {
    expect(originalBackoffMs(0)).toBe(ORIGINAL_BACKOFF_BASE_MS);
    expect(originalBackoffMs(1)).toBe(15 * MINUTE);
    expect(originalBackoffMs(2)).toBe(30 * MINUTE);
    expect(originalBackoffMs(7)).toBe(16 * 60 * MINUTE);
    expect(originalBackoffMs(8)).toBe(ORIGINAL_BACKOFF_CAP_MS);
    expect(originalBackoffMs(500)).toBe(ORIGINAL_BACKOFF_CAP_MS);
  });

  it("reads 'no original' from the detail: manual, or an explicit null upload_id", () => {
    const base = { id: 1, name: "x", sport_type: "Run" } as StravaDetailedActivity;
    expect(noOriginalReason(null)).toBeNull();
    expect(noOriginalReason(base)).toBeNull();
    expect(noOriginalReason({ ...base, manual: false, upload_id: 7 })).toBeNull();
    expect(noOriginalReason({ ...base, manual: true, upload_id: null })).toBe("manual");
    expect(noOriginalReason({ ...base, manual: false, upload_id: null })).toBe("no_upload_id");
  });

  it("never exports a manual entry, and still backs up everything else", async () => {
    h = await createHarness();
    const manual = h.world.add({
      name: "Synthetic manual walk",
      sportType: "Walk",
      startMs: 1_580_608_922_000,
      manual: true,
      photos: [{ uniqueId: "synthetic-manual-photo", bytes: SYNTHETIC_PNG, createdAt: "" }],
      kudos: [{ firstname: "Synthetic", lastname: "Friend" }],
      comments: [{ id: 1, text: "synthetic comment" }],
      privateNote: "synthetic manual note",
    });
    const outcome = await h.backup.backupActivity(manual.id);
    expect(outcome).toMatchObject({ originalStatus: "unavailable", verified: true });
    expect(exportCalls(manual.id)).toBe(0);
    const row = requireActivity(h.db, manual.id);
    expect(row.originalNextAttemptAt).toBeNull();
    expect(JSON.parse(row.originalEvidence ?? "")).toMatchObject({ reason: "manual" });
    const kinds = (
      h.db
        .prepare("SELECT DISTINCT kind FROM backup_files WHERE activity_id = ? ORDER BY kind")
        .all(manual.id) as { kind: string }[]
    ).map((r) => r.kind);
    expect(kinds).toEqual([
      "comments",
      "kudos",
      "metadata",
      "photo",
      "photos_list",
      "streams",
      "web_form",
    ]);
    expect(await h.backup.latestJson(manual.id, "web_form")).toMatchObject({
      privateNote: "synthetic manual note",
    });
    // Later passes never touch it again.
    h.clock.t += ORIGINAL_BACKOFF_CAP_MS;
    await h.poller.poll();
    await h.backup.backupActivity(manual.id);
    expect(exportCalls(manual.id)).toBe(0);
    expect(originalCounts(h.db, h.clock.now()).unavailable).toBe(1);
  });

  it("marks an activity unavailable from stored metadata without a web session", async () => {
    h = await createHarness({ session: null });
    const manual = h.world.add({ name: "Synthetic manual", sportType: "Yoga", manual: true });
    const outcome = await h.backup.backupActivity(manual.id);
    expect(outcome.originalStatus).toBe("unavailable");
  });

  it("backs off a failing export, persists the next attempt and recovers", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    h.session.exportFails = true;
    await h.poller.poll();
    expect(exportCalls(single.id)).toBe(1);
    let row = requireActivity(h.db, single.id);
    expect(row).toMatchObject({ originalStatus: "pending", originalAttempts: 1 });
    expect(row.originalNextAttemptAt).toBe(h.clock.now() + 15 * MINUTE);
    expect(JSON.parse(row.originalEvidence ?? "")).toMatchObject({
      reason: "transient",
      error: "WebTimeoutError",
      attempts: 1,
    });
    expect(originalCounts(h.db, h.clock.now())).toMatchObject({ pending: 1, backingOff: 1 });

    // Within the backoff neither the poller nor a direct backup exports.
    h.clock.t += 10 * MINUTE;
    await h.poller.poll();
    await h.backup.backupActivity(single.id);
    expect(exportCalls(single.id)).toBe(1);

    // After it, one more try that fails doubles the delay.
    h.clock.t += 5 * MINUTE;
    await h.poller.poll();
    expect(exportCalls(single.id)).toBe(2);
    row = requireActivity(h.db, single.id);
    expect(row.originalAttempts).toBe(2);
    expect(row.originalNextAttemptAt).toBe(h.clock.now() + 30 * MINUTE);

    h.session.exportFails = false;
    h.clock.t += 30 * MINUTE;
    await h.poller.poll();
    expect(exportCalls(single.id)).toBe(3);
    row = requireActivity(h.db, single.id);
    expect(row).toMatchObject({
      originalStatus: "present",
      originalAttempts: 0,
      originalNextAttemptAt: null,
      originalEvidence: null,
    });
    const metrics = await h.metrics.registry.getSingleMetricAsString(
      "cameld_original_exports_total",
    );
    expect(metrics).toContain('result="failed"} 2');
    expect(metrics).toContain('result="present"} 1');
  });

  it("leaves the backoff alone when the web session itself fails", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    h.session.loggedIn = false;
    await h.backup.backupActivity(single.id);
    expect(exportCalls(single.id)).toBe(1);
    expect(requireActivity(h.db, single.id)).toMatchObject({
      originalStatus: "pending",
      originalAttempts: 0,
      originalNextAttemptAt: null,
    });
    // The gate is now paused: no further export until it is healthy again.
    await h.backup.backupActivity(single.id);
    expect(exportCalls(single.id)).toBe(1);
  });

  it("records what an export answered instead of a file", async () => {
    h = await createHarness();
    const single = addSingle(h.world, 0);
    const response = {
      status: 200,
      contentType: "text/html; charset=utf-8",
      finalPath: `/activities/${single.id}`,
      redirected: true,
      size: 42,
    };
    const session = {
      exportOriginal: (id: number) =>
        Promise.reject(new WebNoFileError(`/activities/${id}/export_original`, response)),
      getEditForm: (id: number) => h.session.getEditForm(id),
    } as unknown as StravaWebSession;
    const backup = new BackupService({
      db: h.db,
      api: h.client,
      web: new WebGate({ session, notifier: new RecordingNotifier() }),
      root: `${h.dir}/nofile`,
      now: () => h.clock.now(),
    });
    await backup.backupActivity(single.id);
    const row = requireActivity(h.db, single.id);
    expect(row.originalStatus).toBe("pending");
    expect(JSON.parse(row.originalEvidence ?? "")).toMatchObject({
      reason: "transient",
      error: "WebNoFileError",
      response,
    });
    expect(new WebNoFileError("/x", { ...response, contentType: "" }).message).toContain(
      "(200 no content type, final path",
    );
  });

  it("caps original exports per rolling hour without counting it as a failure", async () => {
    h = await createHarness();
    const singles = [addSingle(h.world, 0), addSingle(h.world, 1), addSingle(h.world, 2)];
    const backup = new BackupService({
      db: h.db,
      api: h.client,
      web: h.web,
      root: join(h.dir, "backup"),
      now: () => h.clock.now(),
      metrics: h.metrics,
      exportsPerHour: 2,
    });
    for (const single of singles) await backup.backupActivity(single.id);
    const statuses = singles.map((s) => requireActivity(h.db, s.id).originalStatus);
    expect(statuses).toEqual(["present", "present", "pending"]);
    expect(requireActivity(h.db, singles[2]!.id)).toMatchObject({
      originalAttempts: 0,
      originalNextAttemptAt: null,
    });
    expect(
      await h.metrics.registry.getSingleMetricAsString("cameld_original_exports_total"),
    ).toContain('result="capped"} 1');
    h.clock.t += 60 * MINUTE + 1;
    await backup.backupActivity(singles[2]!.id);
    expect(requireActivity(h.db, singles[2]!.id).originalStatus).toBe("present");
  });
});
