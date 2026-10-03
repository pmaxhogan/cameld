import { gzipSync } from "node:zlib";
import { writeFitActivity } from "@cameld/shared";
import { afterEach, describe, expect, it } from "vitest";
import { BackupService, dataTypeOf, parseOriginal, safeFilename } from "../src/service/backup.ts";
import { WebGate } from "../src/service/web-gate.ts";
import { getActivity } from "../src/state/repo.ts";
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
    expect(getActivity(h.db, manual.id)?.originalStatus).toBe("none");
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
    expect(lines.join("")).toContain("original export deferred");
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
