import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { classifySource, type RecordingSource } from "@cameld/shared";
import type { StravaSummaryActivity } from "../strava/types.ts";

/**
 * SQLite access for the merge state (migration 0003). Plain functions over
 * rows; the state machine owns the rules, this module owns the SQL.
 */

/** external_id prefix of every merged file cameld uploads. */
export const MERGE_EXTERNAL_ID_PREFIX = "cameld-merge-";

export type OriginalStatus = "pending" | "present" | "none";

export interface ActivityRow {
  id: number;
  name: string | null;
  sportType: string | null;
  startMs: number;
  endMs: number;
  deviceName: string | null;
  externalId: string | null;
  source: RecordingSource;
  isMergeOutput: boolean;
  firstSeenAt: number;
  backedUpAt: number | null;
  originalStatus: OriginalStatus;
  originalPath: string | null;
  originalFormat: string | null;
  webFormSaved: boolean;
  singleAt: number | null;
  goneAt: number | null;
  restoredAs: number | null;
  restoredFrom: number | null;
}

type Row = Record<string, SQLInputValue>;

function toActivity(row: Row): ActivityRow {
  return {
    id: row.id as number,
    name: row.name as string | null,
    sportType: row.sport_type as string | null,
    startMs: row.start_ms as number,
    endMs: row.end_ms as number,
    deviceName: row.device_name as string | null,
    externalId: row.external_id as string | null,
    source: row.source as RecordingSource,
    isMergeOutput: row.is_merge_output === 1,
    firstSeenAt: row.first_seen_at as number,
    backedUpAt: row.backed_up_at as number | null,
    originalStatus: row.original_status as OriginalStatus,
    originalPath: row.original_path as string | null,
    originalFormat: row.original_format as string | null,
    webFormSaved: row.web_form_saved === 1,
    singleAt: row.single_at as number | null,
    goneAt: row.gone_at as number | null,
    restoredAs: row.restored_as as number | null,
    restoredFrom: row.restored_from as number | null,
  };
}

export function isMergeExternalId(externalId: string | null | undefined): boolean {
  return typeof externalId === "string" && externalId.startsWith(MERGE_EXTERNAL_ID_PREFIX);
}

/** Insert or refresh an activity from an API summary or detail. Returns true when new. */
export function upsertActivity(
  db: DatabaseSync,
  activity: StravaSummaryActivity,
  now: number,
): boolean {
  const startMs = Date.parse(activity.start_date);
  const endMs = startMs + Math.max(0, activity.elapsed_time) * 1000;
  const externalId = activity.external_id ?? null;
  const deviceName = activity.device_name ?? null;
  const source = classifySource({ deviceName, externalId });
  const mergedBy = db
    .prepare("SELECT 1 FROM merge_groups WHERE merged_activity_id = ?")
    .get(activity.id);
  const isMerge = isMergeExternalId(externalId) || mergedBy !== undefined ? 1 : 0;
  const existing = db.prepare("SELECT 1 FROM activities WHERE id = ?").get(activity.id);
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO activities (id, name, sport_type, start_ms, end_ms, device_name, external_id,
         source, is_merge_output, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      activity.id,
      activity.name,
      activity.sport_type,
      startMs,
      endMs,
      deviceName,
      externalId,
      source,
      isMerge,
      now,
    );
    return true;
  }
  db.prepare(
    `UPDATE activities SET name = ?, sport_type = ?, start_ms = ?, end_ms = ?, device_name = ?,
       external_id = ?, source = ?, is_merge_output = max(is_merge_output, ?) WHERE id = ?`,
  ).run(
    activity.name,
    activity.sport_type,
    startMs,
    endMs,
    deviceName,
    externalId,
    source,
    isMerge,
    activity.id,
  );
  return false;
}

export function getActivity(db: DatabaseSync, id: number): ActivityRow | null {
  const row = db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toActivity(row);
}

export function requireActivity(db: DatabaseSync, id: number): ActivityRow {
  const row = getActivity(db, id);
  if (row === null) throw new Error(`activity ${id} is not known`);
  return row;
}

export function activitiesBetween(db: DatabaseSync, fromMs: number, toMs: number): ActivityRow[] {
  const rows = db
    .prepare("SELECT * FROM activities WHERE end_ms >= ? AND start_ms <= ? ORDER BY start_ms, id")
    .all(fromMs, toMs) as Row[];
  return rows.map(toActivity);
}

export function setActivityFields(
  db: DatabaseSync,
  id: number,
  fields: Partial<Record<string, SQLInputValue>>,
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((key) => `${key} = ?`).join(", ");
  db.prepare(`UPDATE activities SET ${sets} WHERE id = ?`).run(
    ...keys.map((key) => fields[key] as SQLInputValue),
    id,
  );
}

// ---------------------------------------------------------------------------
// Groups

export const GROUP_STATUSES = [
  "detected",
  "backed_up",
  "review",
  "scored",
  "built",
  "snapshotted",
  "uploaded",
  "metadata_applied",
  "verified",
  "hidden",
  "awaiting_deletion",
  "a_deleting",
  "a_confirming",
  "b_rejected",
  "b_delete_fitbit",
  "b_retry_1",
  "b_delete_app",
  "b_retry_2",
  "b_restore",
  "parked",
  "done",
  "failed",
  "restore_flagged",
  "dissolved",
  "superseded",
] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

export const TERMINAL_STATUSES: readonly GroupStatus[] = [
  "done",
  "failed",
  "restore_flagged",
  "dissolved",
  "superseded",
];

/** Statuses before any Strava write: a later arrival may still regroup these. */
export const PRE_WRITE_STATUSES: readonly GroupStatus[] = [
  "detected",
  "backed_up",
  "review",
  "scored",
  "built",
  "snapshotted",
];

export type MergePath = "A" | "B";

export interface GroupRow {
  id: string;
  status: GroupStatus;
  path: MergePath | null;
  appIds: number[];
  fitbitIds: number[];
  startMs: number;
  match: unknown;
  offsetSeconds: number;
  mergedPath: string | null;
  mergedSha256: string | null;
  externalId: string;
  uploadId: number | null;
  mergedActivityId: number | null;
  snapshot: string | null;
  parkedReason: string | null;
  resumeStatus: GroupStatus | null;
  hiddenAt: number | null;
  trial: boolean;
  photosFlagged: boolean;
  deletedIds: number[];
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function toGroup(row: Row): GroupRow {
  return {
    id: row.id as string,
    status: row.status as GroupStatus,
    path: row.path as MergePath | null,
    appIds: JSON.parse(row.app_ids as string) as number[],
    fitbitIds: JSON.parse(row.fitbit_ids as string) as number[],
    startMs: row.start_ms as number,
    match: row.match_json === null ? null : (JSON.parse(row.match_json as string) as unknown),
    offsetSeconds: row.offset_seconds as number,
    mergedPath: row.merged_path as string | null,
    mergedSha256: row.merged_sha256 as string | null,
    externalId: row.external_id as string,
    uploadId: row.upload_id as number | null,
    mergedActivityId: row.merged_activity_id as number | null,
    snapshot: row.snapshot as string | null,
    parkedReason: row.parked_reason as string | null,
    resumeStatus: row.resume_status as GroupStatus | null,
    hiddenAt: row.hidden_at as number | null,
    trial: row.trial === 1,
    photosFlagged: row.photos_flagged === 1,
    deletedIds: JSON.parse(row.deleted_ids as string) as number[],
    lastError: row.last_error as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function insertGroup(
  db: DatabaseSync,
  group: { id: string; appIds: number[]; fitbitIds: number[]; startMs: number },
  now: number,
): GroupRow {
  db.prepare(
    `INSERT INTO merge_groups (id, status, app_ids, fitbit_ids, start_ms, external_id, created_at,
       updated_at) VALUES (?, 'detected', ?, ?, ?, ?, ?, ?)`,
  ).run(
    group.id,
    JSON.stringify(group.appIds),
    JSON.stringify(group.fitbitIds),
    group.startMs,
    `${MERGE_EXTERNAL_ID_PREFIX}${group.id}`,
    now,
    now,
  );
  appendEvent(db, group.id, now, null, "detected", "detected", {
    appIds: group.appIds,
    fitbitIds: group.fitbitIds,
  });
  return requireGroup(db, group.id);
}

export function getGroup(db: DatabaseSync, id: string): GroupRow | null {
  const row = db.prepare("SELECT * FROM merge_groups WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : toGroup(row);
}

export function requireGroup(db: DatabaseSync, id: string): GroupRow {
  const group = getGroup(db, id);
  if (group === null) throw new Error(`group ${id} does not exist`);
  return group;
}

export function listGroups(db: DatabaseSync, statuses?: readonly GroupStatus[]): GroupRow[] {
  const rows = (
    statuses === undefined
      ? db.prepare("SELECT * FROM merge_groups ORDER BY start_ms, id").all()
      : db
          .prepare(
            `SELECT * FROM merge_groups WHERE status IN (${statuses.map(() => "?").join(",")})
             ORDER BY start_ms, id`,
          )
          .all(...statuses)
  ) as Row[];
  return rows.map(toGroup);
}

/** Groups (not terminal) that contain the activity. */
export function openGroupsOf(db: DatabaseSync, activityId: number): GroupRow[] {
  return listGroups(db).filter(
    (group) =>
      !TERMINAL_STATUSES.includes(group.status) &&
      [...group.appIds, ...group.fitbitIds].includes(activityId),
  );
}

/** Groups that merged the activity (done) or are past their first write. */
export function mergedOrWrittenGroupsOf(db: DatabaseSync, activityId: number): GroupRow[] {
  return listGroups(db).filter(
    (group) =>
      !["dissolved", "superseded"].includes(group.status) &&
      !PRE_WRITE_STATUSES.includes(group.status) &&
      group.status !== "parked" &&
      [...group.appIds, ...group.fitbitIds].includes(activityId),
  );
}

const GROUP_COLUMNS: Record<string, string> = {
  status: "status",
  path: "path",
  appIds: "app_ids",
  fitbitIds: "fitbit_ids",
  match: "match_json",
  offsetSeconds: "offset_seconds",
  mergedPath: "merged_path",
  mergedSha256: "merged_sha256",
  uploadId: "upload_id",
  mergedActivityId: "merged_activity_id",
  snapshot: "snapshot",
  parkedReason: "parked_reason",
  resumeStatus: "resume_status",
  hiddenAt: "hidden_at",
  trial: "trial",
  photosFlagged: "photos_flagged",
  deletedIds: "deleted_ids",
  lastError: "last_error",
};

export type GroupPatch = Partial<Omit<GroupRow, "id" | "externalId" | "createdAt" | "updatedAt">>;

function encode(key: string, value: unknown): SQLInputValue {
  if (key === "appIds" || key === "fitbitIds" || key === "deletedIds") return JSON.stringify(value);
  if (key === "match") return value === null ? null : JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}

export function patchGroup(db: DatabaseSync, id: string, patch: GroupPatch, now: number): void {
  const keys = Object.keys(patch).filter((key) => key in GROUP_COLUMNS);
  const sets = [...keys.map((key) => `${GROUP_COLUMNS[key]} = ?`), "updated_at = ?"].join(", ");
  db.prepare(`UPDATE merge_groups SET ${sets} WHERE id = ?`).run(
    ...keys.map((key) => encode(key, patch[key as keyof GroupPatch])),
    now,
    id,
  );
}

export function appendEvent(
  db: DatabaseSync,
  groupId: string,
  at: number,
  from: GroupStatus | null,
  to: GroupStatus | null,
  event: string,
  evidence: unknown,
): void {
  db.prepare(
    `INSERT INTO group_events (group_id, at, from_status, to_status, event, evidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(groupId, at, from, to, event, JSON.stringify(evidence ?? null));
}

export interface GroupEvent {
  at: number;
  from: GroupStatus | null;
  to: GroupStatus | null;
  event: string;
  evidence: unknown;
}

export function groupEvents(db: DatabaseSync, groupId: string): GroupEvent[] {
  const rows = db
    .prepare(
      "SELECT at, from_status, to_status, event, evidence FROM group_events WHERE group_id = ? ORDER BY id",
    )
    .all(groupId) as Row[];
  return rows.map((row) => ({
    at: row.at as number,
    from: row.from_status as GroupStatus | null,
    to: row.to_status as GroupStatus | null,
    event: row.event as string,
    evidence: JSON.parse(row.evidence as string) as unknown,
  }));
}

/** Trial pairs already used (groups that deleted under the trial allowance). */
export function trialPairsUsed(db: DatabaseSync): number {
  return (
    db.prepare("SELECT count(*) AS n FROM merge_groups WHERE trial = 1").get() as { n: number }
  ).n;
}

export function parkedByReason(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT parked_reason AS reason, count(*) AS n FROM merge_groups WHERE status = 'parked' GROUP BY parked_reason",
    )
    .all() as { reason: string; n: number }[];
  return Object.fromEntries(rows.map((row) => [row.reason, row.n]));
}

// ---------------------------------------------------------------------------
// Write journal

export type WriteKind =
  | "upload"
  | "update"
  | "hide"
  | "private_note"
  | "exertion"
  | "photo"
  | "delete"
  | "restore_upload"
  | "restore_update"
  | "restore_web";

export type WriteStatus = "intent" | "done" | "rejected" | "failed" | "unknown" | "superseded";

export interface WriteRow {
  id: number;
  groupId: string | null;
  kind: WriteKind;
  targetId: number | null;
  externalId: string | null;
  status: WriteStatus;
  uploadId: number | null;
  result: unknown;
  createdAt: number;
  completedAt: number | null;
}

function toWrite(row: Row): WriteRow {
  return {
    id: row.id as number,
    groupId: row.group_id as string | null,
    kind: row.kind as WriteKind,
    targetId: row.target_id as number | null,
    externalId: row.external_id as string | null,
    status: row.status as WriteStatus,
    uploadId: row.upload_id as number | null,
    result: row.result === null ? null : (JSON.parse(row.result as string) as unknown),
    createdAt: row.created_at as number,
    completedAt: row.completed_at as number | null,
  };
}

export function beginWrite(
  db: DatabaseSync,
  write: { groupId: string | null; kind: WriteKind; targetId: number | null; externalId?: string },
  now: number,
): number {
  const result = db
    .prepare(
      `INSERT INTO strava_writes (group_id, kind, target_id, external_id, status, created_at)
       VALUES (?, ?, ?, ?, 'intent', ?)`,
    )
    .run(write.groupId, write.kind, write.targetId, write.externalId ?? null, now);
  return Number(result.lastInsertRowid);
}

export function setWriteUploadId(db: DatabaseSync, id: number, uploadId: number): void {
  db.prepare("UPDATE strava_writes SET upload_id = ? WHERE id = ?").run(uploadId, id);
}

export function finishWrite(
  db: DatabaseSync,
  id: number,
  status: Exclude<WriteStatus, "intent">,
  result: unknown,
  now: number,
): void {
  db.prepare("UPDATE strava_writes SET status = ?, result = ?, completed_at = ? WHERE id = ?").run(
    status,
    JSON.stringify(result ?? null),
    now,
    id,
  );
}

export function openWrites(db: DatabaseSync): WriteRow[] {
  const rows = db
    .prepare("SELECT * FROM strava_writes WHERE status IN ('intent', 'unknown') ORDER BY id")
    .all() as Row[];
  return rows.map(toWrite);
}

export function writesFor(
  db: DatabaseSync,
  filter: { groupId?: string; kind?: WriteKind },
): WriteRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM strava_writes WHERE (?1 IS NULL OR group_id = ?1) AND (?2 IS NULL OR kind = ?2)
       ORDER BY id`,
    )
    .all(filter.groupId ?? null, filter.kind ?? null) as Row[];
  return rows.map(toWrite);
}
