import type { BackfillBatchInfo, BudgetWindow, GroupSummary } from "@cameld/shared";
import { fmtDate, NONE } from "./format.ts";

/**
 * Plain-language labels for the machine's codes (server/src/state/machine.ts).
 * Every lookup falls back to the raw code, so a code added on the server
 * still shows up, just less friendly. The raw code stays visible next to the
 * label wherever the owner may need to look it up.
 */

/** Why a group is parked (GroupRow.parkedReason, also the event that parks it). */
export const PARK_REASONS: Record<string, string> = {
  deletion_switch_off: "Parked: deletion is off, so both originals were left in place on Strava",
  original_missing:
    "Parked: an original uploaded file is not in the backup, so nothing can be deleted",
  original_unavailable:
    "Parked: Strava has no original file for a member (a manual entry), so it is backed up from streams and never deleted",
};

/** What each event in a group's timeline means. */
export const EVENT_LABELS: Record<string, string> = {
  detected: "Detected as a possible pair",
  backup_verified: "Both originals backed up and verified",
  member_gone: "A member was deleted on Strava, so the group was dropped",
  borderline: "Borderline match, sent to the review queue",
  auto_match: "Matched automatically",
  no_match: "Not a match, so the group was dropped",
  review_approved: "Approved in the review queue",
  review_rejected: "Rejected in the review queue",
  no_loss_ok: "Merged file built and passed the exact no-loss check",
  snapshot: "Backup snapshot taken",
  uploaded: "Merged activity uploaded to Strava",
  upload_duplicate:
    "Strava rejected the merged upload as a duplicate of the original (expected while originals exist)",
  metadata: "Title, description, photos and private note carried over",
  post_upload_check: "Uploaded activity passed the post-upload check",
  hidden: "Originals hidden on Strava",
  grace_elapsed_deletion_off: "Grace period over; deletion is off, so the originals stay hidden",
  grace_elapsed: "Grace period over; deleting the originals",
  originals_deleted: "Originals deleted on Strava",
  deleted: "Original deleted on Strava",
  deletion_refused: "A delete was refused by a safety check",
  confirmed: "Confirmed: originals gone and the merged activity intact",
  path_b_start: "Path B: deleting originals one side at a time so the merge can upload",
  side_deleted: "One side's originals deleted (Path B)",
  uploaded_after_delete: "Merged activity uploaded after deleting an original (Path B)",
  still_duplicate: "Still rejected as a duplicate; deleting the other side too (Path B)",
  upload_failed_after_delete: "Upload still failed after deleting; restoring the originals",
  frozen_mid_path_b: "Writes froze during Path B; restoring the deleted originals",
  restored: "Deleted originals re-uploaded from the backup",
  restored_by_owner: "Restored by the owner",
  check_failed: "A safety check failed, so all Strava writes are frozen",
  resumed: "Resumed after the reason it was parked went away",
  superseded: "Replaced by a newer group with the same activities",
  ...PARK_REASONS,
};

/** What each group status means. */
export const STATUS_LABELS: Record<string, string> = {
  detected: "Detected",
  backed_up: "Backed up",
  review: "Needs review",
  scored: "Matched",
  built: "Merge built",
  snapshotted: "Snapshot taken",
  uploaded: "Merge uploaded",
  metadata_applied: "Metadata carried over",
  verified: "Upload verified",
  hidden: "Originals hidden (grace period)",
  awaiting_deletion: "Waiting for deletion to be turned on",
  a_deleting: "Deleting originals",
  a_confirming: "Confirming deletion",
  b_rejected: "Upload rejected as duplicate",
  b_delete_fitbit: "Path B: deleting wrist original",
  b_retry_1: "Path B: retrying upload",
  b_delete_app: "Path B: deleting phone original",
  b_retry_2: "Path B: retrying upload again",
  b_restore: "Path B: restoring originals",
  parked: "Parked",
  done: "Done",
  failed: "Failed",
  restore_flagged: "Restore flagged",
  restored: "Restored",
  dissolved: "Dropped",
  superseded: "Superseded",
};

/** What the group is waiting for (lastError "wait:<reason>"). */
export const WAIT_LABELS: Record<string, string> = {
  frozen: "Strava writes are frozen",
  grace_period: "the grace period before deletion",
  deletion_switch_off: "deletion to be turned on",
  upload_switch_off: "uploads to be turned on",
  upload_pending: "Strava to finish processing the upload",
  original_pending: "the original file to be downloaded",
  web_paused: "the Strava web login to be healthy",
  deletion_refused: "a refused delete to be resolved",
  deletion_failed: "a failed delete to be retried",
  deletion_unconfirmed: "a delete to be confirmed",
};

export const WRITE_KIND_LABELS: Record<string, string> = {
  upload: "Upload merged activity",
  update: "Update metadata",
  hide: "Hide original",
  private_note: "Private note",
  exertion: "Perceived exertion",
  photo: "Photo",
  delete: "Delete original",
  restore_upload: "Re-upload original",
  restore_update: "Restore metadata",
  restore_web: "Restore web fields",
};

export const SOURCE_LABELS: Record<string, string> = {
  app: "Phone (app)",
  fitbit: "Wrist (Fitbit)",
  other: "Other",
};

function lookup(table: Record<string, string>, code: string | null): string {
  if (code === null) return NONE;
  return table[code] ?? code;
}

export function parkLabel(reason: string | null): string {
  return lookup(PARK_REASONS, reason);
}

export function eventLabel(event: string): string {
  return lookup(EVENT_LABELS, event);
}

export function statusLabel(status: string | null): string {
  return lookup(STATUS_LABELS, status);
}

export function writeKindLabel(kind: string): string {
  return lookup(WRITE_KIND_LABELS, kind);
}

export function sourceLabel(source: string): string {
  return lookup(SOURCE_LABELS, source);
}

/** A group's lastError marker ("wait:x", "transient:x", "error:x") in words. */
export function lastErrorLabel(marker: string | null): string {
  if (marker === null) return NONE;
  const [kind, ...rest] = marker.split(":");
  const detail = rest.join(":");
  if (kind === "wait" && detail !== "") return `Waiting for ${lookup(WAIT_LABELS, detail)}`;
  if (kind === "transient" && detail !== "") return `Temporary problem, retrying: ${detail}`;
  if (kind === "error" && detail !== "") return `Error: ${detail}`;
  return eventLabel(marker);
}

/** Link to an activity on strava.com. */
export function stravaActivityUrl(id: number): string {
  return `https://www.strava.com/activities/${String(id)}`;
}

/** "2026-01-02 Run, 1 phone + 1 wrist recording" for titles and lists. */
export function groupTitle(
  group: Pick<GroupSummary, "startMs" | "sportType" | "appIds" | "fitbitIds">,
): string {
  const sport = group.sportType ?? "Activity";
  const recordings = group.appIds.length + group.fitbitIds.length;
  const word = recordings === 1 ? "recording" : "recordings";
  return `${fmtDate(group.startMs)} ${sport}, ${String(group.appIds.length)} phone + ${String(group.fitbitIds.length)} wrist ${word}`;
}

export interface EvidenceEntry {
  key: string;
  value: string;
}

function scalar(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Evidence (arbitrary JSON) as readable key/value rows: nested objects are
 * flattened to dotted keys, arrays of plain values are joined, anything
 * deeper is shown as compact JSON.
 */
export function evidenceEntries(evidence: unknown, maxDepth = 3): EvidenceEntry[] {
  if (evidence === null || evidence === undefined) return [];
  const out: EvidenceEntry[] = [];
  const walk = (value: unknown, key: string, depth: number): void => {
    const plain = scalar(value);
    if (plain !== null) {
      out.push({ key, value: plain });
      return;
    }
    if (Array.isArray(value)) {
      const parts = value.map(scalar);
      out.push({
        key,
        value: parts.every((p) => p !== null)
          ? parts.join(", ") || "(none)"
          : JSON.stringify(value),
      });
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= maxDepth || entries.length === 0) {
      out.push({ key, value: JSON.stringify(value) });
      return;
    }
    for (const [k, v] of entries) walk(v, key === "" ? k : `${key}.${k}`, depth + 1);
  };
  if (typeof evidence !== "object" || Array.isArray(evidence)) walk(evidence, "value", 0);
  else walk(evidence, "", 0);
  return out;
}

export const BUDGET_WINDOW_LABELS: Record<BudgetWindow, string> = {
  daily: "cameld daily cap",
  fifteen_minute: "cameld 15-minute cap",
};

const STOPPED_LABELS: Record<string, string> = {
  off: "backfill is off",
  paused: "paused",
  done: "done (reached the oldest activity)",
  error: "error",
  running: "another batch was already running",
  rate_limited: "Strava app rate limit (all consumers)",
};

/** Why the last batch stopped, e.g. "budget (cameld daily cap)". */
export function stoppedLabel(batch: Pick<BackfillBatchInfo, "stopped" | "budgetLimit">): string {
  if (batch.stopped === "budget") {
    return batch.budgetLimit === null
      ? "budget"
      : `budget (${BUDGET_WINDOW_LABELS[batch.budgetLimit]})`;
  }
  return STOPPED_LABELS[batch.stopped] ?? batch.stopped;
}

/** "v" plus the first 7 characters of a git sha; any other version as given. */
export function shortVersion(version: string): string {
  return /^[0-9a-f]{8,40}$/i.test(version) ? `v${version.slice(0, 7)}` : `v${version}`;
}
