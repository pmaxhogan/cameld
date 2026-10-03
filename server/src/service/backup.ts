import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import {
  type ParsedActivity,
  readFitActivity,
  readGpxActivity,
  readTcxActivity,
} from "@cameld/shared";
import { BackupIntegrityError, sha256Hex, verify, writeOnce } from "../backup-store.ts";
import type { Logger } from "../logging.ts";
import { getActivity, requireActivity, setActivityFields, upsertActivity } from "../state/repo.ts";
import { StravaApiError, type StravaClient } from "../strava/client.ts";
import type { StravaDetailedActivity, StravaPhoto, UploadDataType } from "../strava/types.ts";
import { WebNotFoundError } from "../web/errors.ts";
import type { ReadGate } from "./budget.ts";
import type { Metrics } from "./metrics.ts";
import type { WebGate } from "./web-gate.ts";

/**
 * Activity backups (ARCHITECTURE.md section 7, rule L20): full metadata, all
 * streams, the original uploaded file, photos, kudos and comments, plus the
 * web edit-form values (private note, visibility, perceived exertion) that
 * the API cannot read. Every file is write-once and checksummed
 * (backup-store.ts) and recorded in `backup_files`.
 *
 * Layout under <dataDir>/backup/activities/<id>/:
 *   metadata/<sha16>.json   API detail, one file per distinct content
 *   streams.json            API streams, once
 *   photos/list-<sha16>.json, photos/<unique_id>.<ext>
 *   kudos/<sha16>.json, comments/<sha16>.json
 *   web-form/<sha16>.json   edit-form VALUES only (never tokens)
 *   original/<filename>     the original uploaded file, once
 *
 * Incremental and idempotent: a normal backup fetches only parts not yet
 * stored; `fresh` re-fetches everything that can change (metadata, photos,
 * kudos, comments, web form). Identical content maps to the same path and is
 * a no-op. Web parts wait while the web gate is closed; API parts never do.
 */

export type BackupApi = Pick<
  StravaClient,
  "getActivity" | "getStreams" | "getActivityPhotos" | "getKudoers" | "getComments"
>;

export type FetchPhoto = (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;

export interface BackupServiceOptions {
  db: DatabaseSync;
  api: BackupApi;
  web: WebGate;
  /** <dataDir>/backup */
  root: string;
  now?: () => number;
  log?: Logger;
  metrics?: Metrics;
  fetchPhoto?: FetchPhoto;
}

export interface BackupOptions {
  /** Re-fetch everything that can change (pre-delete backups). */
  fresh?: boolean;
  /** Budget for API reads (backfill). */
  gate?: ReadGate;
}

export interface BackupOutcome {
  activityId: number;
  written: number;
  /** The original file is stored (or Strava has none: see originalStatus). */
  originalStatus: "pending" | "present" | "none";
  webFormSaved: boolean;
  /** Every recorded file of the activity was read back and matched its checksum. */
  verified: boolean;
  verifiedAt: number;
  failures: string[];
}

export interface StoredOriginal {
  bytes: Buffer;
  dataType: UploadDataType;
  filename: string;
}

const DATA_TYPES: readonly UploadDataType[] = ["fit.gz", "tcx.gz", "gpx.gz", "fit", "tcx", "gpx"];

/** Upload data type from an original file name, or null when unknown. */
export function dataTypeOf(filename: string): UploadDataType | null {
  const lower = filename.toLowerCase();
  return DATA_TYPES.find((type) => lower.endsWith(`.${type}`)) ?? null;
}

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() as string;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return (cleaned === "" ? "original" : cleaned).slice(-120);
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function short(bytes: Uint8Array): string {
  return sha256Hex(bytes).slice(0, 16);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parse a stored original into samples (gunzipping when needed). */
export function parseOriginal(original: StoredOriginal, source: string): ParsedActivity {
  const raw = original.dataType.endsWith(".gz") ? gunzipSync(original.bytes) : original.bytes;
  const format = original.dataType.replace(".gz", "");
  if (format === "fit") return readFitActivity(new Uint8Array(raw), { source });
  const text = raw.toString("utf8");
  return format === "tcx" ? readTcxActivity(text, { source }) : readGpxActivity(text, { source });
}

const defaultFetchPhoto: FetchPhoto = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`photo download returned ${response.status}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: String(response.headers.get("content-type")),
  };
};

/** Read a backup file after checking it against its checksum sidecar. */
export async function readVerifiedFile(root: string, relPath: string): Promise<Buffer> {
  const path = join(root, relPath);
  const check = await verify(path);
  if (!check.ok) throw new BackupIntegrityError(`${relPath} failed verification: ${check.reason}`);
  return readFile(path);
}

/**
 * The backed-up original file of an activity, verified, or null when there is
 * none. Read-only: usable without a Strava connection (the UI's track view).
 */
export async function readStoredOriginal(
  db: DatabaseSync,
  root: string,
  activityId: number,
): Promise<StoredOriginal | null> {
  const activity = requireActivity(db, activityId);
  if (activity.originalStatus !== "present" || activity.originalPath === null) return null;
  const bytes = await readVerifiedFile(root, activity.originalPath);
  return {
    bytes,
    dataType: activity.originalFormat as UploadDataType,
    filename: activity.originalPath.split("/").pop() as string,
  };
}

export class BackupService {
  readonly #db: DatabaseSync;
  readonly #api: BackupApi;
  readonly #web: WebGate;
  readonly #root: string;
  readonly #now: () => number;
  readonly #log: Logger | undefined;
  readonly #metrics: Metrics | undefined;
  readonly #fetchPhoto: FetchPhoto;

  constructor(options: BackupServiceOptions) {
    this.#db = options.db;
    this.#api = options.api;
    this.#web = options.web;
    this.#root = options.root;
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
    this.#metrics = options.metrics;
    this.#fetchPhoto = options.fetchPhoto ?? defaultFetchPhoto;
  }

  #has(activityId: number, kind: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM backup_files WHERE activity_id = ? AND kind = ? LIMIT 1")
        .get(activityId, kind) !== undefined
    );
  }

  /** Write one file (write-once) and record it. Returns true if new bytes were written. */
  async #store(
    activityId: number,
    kind: string,
    relPath: string,
    bytes: Uint8Array,
  ): Promise<boolean> {
    const result = await writeOnce(join(this.#root, relPath), bytes);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO backup_files (activity_id, kind, rel_path, sha256, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(activityId, kind, relPath, result.sha256, result.size, this.#now());
    return result.status === "written";
  }

  /** Store a JSON document under a content-addressed name in `dir`. */
  #storeJson(activityId: number, kind: string, dir: string, prefix: string, value: unknown) {
    const bytes = json(value);
    return this.#store(activityId, kind, `${dir}/${prefix}${short(bytes)}.json`, bytes);
  }

  /** Store a merge artifact (merged FIT, ledger, report) under merges/<groupId>/. */
  async storeMergeArtifact(groupId: string, name: string, bytes: Uint8Array): Promise<string> {
    const relPath = `merges/${groupId}/${name}`;
    await this.#store(0, `merge_${name}`, relPath, bytes);
    return relPath;
  }

  async readVerified(relPath: string): Promise<Buffer> {
    return readVerifiedFile(this.#root, relPath);
  }

  /**
   * Latest stored JSON of a kind for an activity (by insertion order), or
   * null. With `beforeMs`, only copies stored before that instant count (for
   * example the visibility an activity had before cameld hid it).
   */
  async latestJson<T>(activityId: number, kind: string, beforeMs?: number): Promise<T | null> {
    const row = this.#db
      .prepare(
        "SELECT rel_path FROM backup_files WHERE activity_id = ? AND kind = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(activityId, kind, beforeMs ?? Number.MAX_SAFE_INTEGER) as
      { rel_path: string } | undefined;
    if (row === undefined) return null;
    return JSON.parse((await this.readVerified(row.rel_path)).toString("utf8")) as T;
  }

  async readOriginal(activityId: number): Promise<StoredOriginal | null> {
    return readStoredOriginal(this.#db, this.#root, activityId);
  }

  /** Photo files of an activity: [relPath, unique id]. */
  photoFiles(activityId: number): { relPath: string; uniqueId: string }[] {
    const rows = this.#db
      .prepare(
        "SELECT rel_path FROM backup_files WHERE activity_id = ? AND kind = 'photo' ORDER BY rel_path",
      )
      .all(activityId) as { rel_path: string }[];
    return rows.map((row) => {
      const file = row.rel_path.split("/").pop() as string;
      return { relPath: row.rel_path, uniqueId: file.replace(/\.[^.]+$/, "") };
    });
  }

  /** Re-read every recorded file of the activity and check its checksum. */
  async verifyActivity(activityId: number): Promise<{ ok: boolean; failures: string[] }> {
    const rows = this.#db
      .prepare("SELECT rel_path FROM backup_files WHERE activity_id = ?")
      .all(activityId) as { rel_path: string }[];
    const failures: string[] = [];
    for (const row of rows) {
      const result = await verify(join(this.#root, row.rel_path));
      if (!result.ok) failures.push(`${row.rel_path}: ${result.reason}`);
    }
    return { ok: failures.length === 0 && rows.length > 0, failures };
  }

  totals(): { bytes: number; files: number } {
    const row = this.#db
      .prepare("SELECT coalesce(sum(size), 0) AS bytes, count(*) AS files FROM backup_files")
      .get() as { bytes: number; files: number };
    return row;
  }

  /** Back up one activity. See the module comment. */
  async backupActivity(activityId: number, options: BackupOptions = {}): Promise<BackupOutcome> {
    const fresh = options.fresh ?? false;
    const read = (): void => options.gate?.beforeRead();
    let written = 0;
    const note = (isNew: boolean): void => {
      if (isNew) written += 1;
    };
    const dir = `activities/${activityId}`;

    let detail: StravaDetailedActivity | null = null;
    if (fresh || !this.#has(activityId, "metadata") || getActivity(this.#db, activityId) === null) {
      read();
      detail = await this.#api.getActivity(activityId);
      upsertActivity(this.#db, detail, this.#now());
      note(await this.#storeJson(activityId, "metadata", `${dir}/metadata`, "", detail));
    }

    if (!this.#has(activityId, "streams")) {
      read();
      let streams: unknown;
      try {
        streams = await this.#api.getStreams(activityId);
      } catch (error) {
        // Manual entries have no streams; record that rather than retrying forever.
        if (!(error instanceof StravaApiError && error.status === 404)) throw error;
        streams = {};
      }
      note(await this.#store(activityId, "streams", `${dir}/streams.json`, json(streams)));
    }

    const needsSocial = (kind: string): boolean => fresh || !this.#has(activityId, kind);
    if (needsSocial("photos_list") || needsSocial("kudos") || needsSocial("comments")) {
      detail ??= await this.latestJson<StravaDetailedActivity>(activityId, "metadata");
    }
    if (needsSocial("photos_list")) {
      const photoCount = count(detail?.total_photo_count) || count(detail?.photo_count);
      let photos: StravaPhoto[] = [];
      if (photoCount > 0) {
        read();
        photos = await this.#api.getActivityPhotos(activityId, 5000);
      }
      note(await this.#storeJson(activityId, "photos_list", `${dir}/photos`, "list-", photos));
      for (const photo of photos) note(await this.#backupPhoto(activityId, dir, photo));
    }
    if (needsSocial("kudos")) {
      let kudos: unknown[] = [];
      if (count(detail?.kudos_count) > 0) {
        read();
        kudos = await this.#api.getKudoers(activityId);
      }
      note(await this.#storeJson(activityId, "kudos", `${dir}/kudos`, "", kudos));
    }
    if (needsSocial("comments")) {
      let comments: unknown[] = [];
      if (count(detail?.comment_count) > 0) {
        read();
        comments = await this.#api.getComments(activityId);
      }
      note(await this.#storeJson(activityId, "comments", `${dir}/comments`, "", comments));
    }

    let activity = requireActivity(this.#db, activityId);
    if (activity.originalStatus === "pending" && this.#web.available()) {
      note(await this.#backupOriginal(activityId, dir));
    }
    if ((fresh || !activity.webFormSaved) && this.#web.available()) {
      note(await this.#backupWebForm(activityId, dir));
    }

    const check = await this.verifyActivity(activityId);
    const verifiedAt = this.#now();
    setActivityFields(this.#db, activityId, { backed_up_at: verifiedAt });
    activity = requireActivity(this.#db, activityId);
    this.#metrics?.backups.inc({ result: check.ok ? "ok" : "verify_failed" });
    if (!check.ok)
      this.#log?.error({ activityId, failures: check.failures }, "backup verify failed");
    return {
      activityId,
      written,
      originalStatus: activity.originalStatus,
      webFormSaved: activity.webFormSaved,
      verified: check.ok,
      verifiedAt,
      failures: check.failures,
    };
  }

  async #backupPhoto(activityId: number, dir: string, photo: StravaPhoto): Promise<boolean> {
    const id = safeFilename(String(photo.unique_id ?? ""));
    const url = Object.entries(photo.urls ?? {}).sort(
      (a, b) => Number(b[0]) - Number(a[0]),
    )[0]?.[1];
    if (id === "original" || url === undefined) return false;
    if (this.photoFiles(activityId).some((file) => file.uniqueId === id)) return false;
    try {
      const { bytes, contentType } = await this.#fetchPhoto(url);
      const ext = contentType.includes("png") ? "png" : "jpg";
      return await this.#store(activityId, "photo", `${dir}/photos/${id}.${ext}`, bytes);
    } catch (error) {
      // The photo list (with its URL) is stored; a later backup retries the file.
      this.#log?.warn({ err: error, activityId }, "photo download failed");
      return false;
    }
  }

  async #backupOriginal(activityId: number, dir: string): Promise<boolean> {
    try {
      const file = await this.#web.run((session) => session.exportOriginal(activityId));
      const filename = safeFilename(file.filename);
      const relPath = `${dir}/original/${filename}`;
      const isNew = await this.#store(activityId, "original", relPath, file.bytes);
      setActivityFields(this.#db, activityId, {
        original_status: "present",
        original_path: relPath,
        original_format: dataTypeOf(filename),
      });
      return isNew;
    } catch (error) {
      if (error instanceof WebNotFoundError) {
        setActivityFields(this.#db, activityId, { original_status: "none" });
        return false;
      }
      this.#log?.warn({ err: error, activityId }, "original export deferred");
      return false;
    }
  }

  async #backupWebForm(activityId: number, dir: string): Promise<boolean> {
    try {
      const form = await this.#web.run((session) => session.getEditForm(activityId));
      const isNew = await this.#storeJson(
        activityId,
        "web_form",
        `${dir}/web-form`,
        "",
        form.values,
      );
      setActivityFields(this.#db, activityId, { web_form_saved: 1 });
      return isNew;
    } catch (error) {
      this.#log?.warn({ err: error, activityId }, "web form backup deferred");
      return false;
    }
  }
}
