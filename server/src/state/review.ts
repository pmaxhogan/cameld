import type { DatabaseSync } from "node:sqlite";
import { appendEvent, patchGroup, requireGroup, withTransaction } from "./repo.ts";

/**
 * The owner's review decisions (ARCHITECTURE.md section 4: anything
 * borderline goes to the review queue and is never auto-merged). Plain
 * database transitions, so they work without a Strava connection; the next
 * tick of the state machine picks an approved group up from "scored".
 */

export class ReviewError extends Error {
  override readonly name = "ReviewError";
}

export function approveReview(
  db: DatabaseSync,
  groupId: string,
  now: number,
  offsetSeconds = 0,
  note: string | null = null,
): void {
  const group = requireGroup(db, groupId);
  if (group.status !== "review") throw new ReviewError(`group ${groupId} is not in review`);
  // Three sources (or none) have no app/wrist roles: the owner can only reject.
  if (((group.match as { appIds?: number[] } | null)?.appIds ?? []).length === 0) {
    throw new ReviewError(`group ${groupId} has no two-sided structure to merge`);
  }
  withTransaction(db, () => {
    patchGroup(db, groupId, { status: "scored", offsetSeconds }, now);
    appendEvent(db, groupId, now, "review", "scored", "review_approved", {
      offsetSeconds,
      ...(note === null ? {} : { note }),
    });
  });
}

export function rejectReview(
  db: DatabaseSync,
  groupId: string,
  now: number,
  note: string | null = null,
): void {
  const group = requireGroup(db, groupId);
  if (group.status !== "review") throw new ReviewError(`group ${groupId} is not in review`);
  withTransaction(db, () => {
    patchGroup(db, groupId, { status: "dissolved" }, now);
    appendEvent(
      db,
      groupId,
      now,
      "review",
      "dissolved",
      "review_rejected",
      note === null ? null : { note },
    );
  });
}
