import { DeletionUnauthorizedError } from "./errors.ts";

/**
 * Permission to delete ONE Strava activity, once, shortly after the checks
 * that make deleting it safe (docs/ARCHITECTURE.md sections 5 and 6).
 *
 * Only the merge state machine mints these. Construction is deliberately
 * hard to do by accident:
 *
 * - The constructor is private. The only way in is the explicit static
 *   `DeletionAuthorization.mint(evidence)`, and ESLint (`no-restricted-syntax`
 *   in eslint.config.js) rejects that call anywhere outside
 *   `server/src/state/**` and the tests.
 * - The evidence type demands literal proofs (`deletionSwitch: "on"`,
 *   `originalFileBackedUp: true`, a snapshot name, a fresh backup time) and
 *   mint re-checks them at runtime, so a cast cannot skip them.
 * - The class carries an ECMAScript private brand, so a structurally similar
 *   object or an `as` cast is rejected by `consume`.
 * - It names one activity id, expires after TTL_MS, and is single use: the
 *   web session consumes it before sending the request, even if the request
 *   then fails, so a retry needs a fresh mint after fresh checks.
 */

export type DeletionReason = "path_a_grace_elapsed" | "path_b_duplicate_rejected" | "rollout_trial";

export interface DeletionEvidence {
  activityId: number;
  /** The owner's deletion switch. Only "on" is accepted. */
  deletionSwitch: "on";
  /** The original uploaded file is in the backup. */
  originalFileBackedUp: true;
  /** Epoch ms at which the fresh pre-delete backup was read back and checksum-verified. */
  backupVerifiedAt: number;
  /** ZFS snapshot covering that backup. */
  snapshot: string;
  reason: DeletionReason;
}

const REASONS: readonly DeletionReason[] = [
  "path_a_grace_elapsed",
  "path_b_duplicate_rejected",
  "rollout_trial",
];

export class DeletionAuthorization {
  /** An authorization (and the backup behind it) is stale after this long. */
  static readonly TTL_MS = 15 * 60_000;

  readonly #brand = true;
  #consumed = false;
  readonly activityId: number;
  readonly reason: DeletionReason;
  readonly snapshot: string;
  readonly mintedAt: number;
  readonly expiresAt: number;

  private constructor(evidence: DeletionEvidence, now: number) {
    this.activityId = evidence.activityId;
    this.reason = evidence.reason;
    this.snapshot = evidence.snapshot;
    this.mintedAt = now;
    this.expiresAt = now + DeletionAuthorization.TTL_MS;
  }

  /**
   * STATE MACHINE ONLY. Validates the evidence and returns a single-use token
   * for exactly one activity. Throws DeletionUnauthorizedError on any gap.
   */
  static mint(evidence: DeletionEvidence, now: number = Date.now()): DeletionAuthorization {
    const problems: string[] = [];
    if (!Number.isSafeInteger(evidence.activityId) || evidence.activityId <= 0)
      problems.push("activityId");
    if (evidence.deletionSwitch !== "on") problems.push("deletionSwitch");
    if (evidence.originalFileBackedUp !== true) problems.push("originalFileBackedUp");
    if (typeof evidence.snapshot !== "string" || evidence.snapshot.trim() === "")
      problems.push("snapshot");
    if (!REASONS.includes(evidence.reason)) problems.push("reason");
    if (
      !Number.isFinite(evidence.backupVerifiedAt) ||
      evidence.backupVerifiedAt > now ||
      now - evidence.backupVerifiedAt > DeletionAuthorization.TTL_MS
    )
      problems.push("backupVerifiedAt");
    if (problems.length > 0)
      throw new DeletionUnauthorizedError(`cannot authorize deletion: ${problems.join(", ")}`);
    return new DeletionAuthorization(evidence, now);
  }

  /**
   * Check and spend an authorization for `activityId`. Accepts `unknown` on
   * purpose: anything that is not a genuine, unexpired, unused token for this
   * exact activity is refused.
   */
  static consume(auth: unknown, activityId: number, now: number = Date.now()): void {
    if (typeof auth !== "object" || auth === null || !(#brand in auth))
      throw new DeletionUnauthorizedError("not a DeletionAuthorization");
    const token = auth as DeletionAuthorization;
    if (token.#consumed) throw new DeletionUnauthorizedError("authorization already used");
    if (token.activityId !== activityId)
      throw new DeletionUnauthorizedError(
        `authorization is for activity ${token.activityId}, not ${activityId}`,
      );
    if (now > token.expiresAt) throw new DeletionUnauthorizedError("authorization expired");
    token.#consumed = true;
  }

  get consumed(): boolean {
    return this.#consumed;
  }
}
