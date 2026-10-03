import type { DatabaseSync } from "node:sqlite";
import { type ActivityMetadata, checkNoLoss, mergeMetadata, readFitActivity } from "@cameld/shared";
import { BackupIntegrityError, sha256Hex } from "../backup-store.ts";
import type { Logger } from "../logging.ts";
import type { BackupService } from "../service/backup.ts";
import { BudgetExhaustedError } from "../service/budget.ts";
import type { Metrics, MergeOutcome } from "../service/metrics.ts";
import { type NotificationKind, type Notifier, notifySafely } from "../service/notifier.ts";
import { SnapshotError, type Snapshotter } from "../service/snapshotter.ts";
import { WebPausedError, type WebGate } from "../service/web-gate.ts";
import {
  classifyUpload,
  type PollOptions,
  StravaApiError,
  type StravaClient,
  StravaRateLimitedError,
  UploadTimeoutError,
} from "../strava/client.ts";
import type { Clock } from "../strava/rate-limiter.ts";
import { StravaAuthError } from "../strava/tokens.ts";
import type {
  StravaDetailedActivity,
  StravaPhoto,
  UpdateActivityFields,
  UploadDataType,
  UploadResult,
} from "../strava/types.ts";
import { DeletionAuthorization, type DeletionReason } from "../web/deletion-authorization.ts";
import {
  BrowserUnavailableError,
  ChallengeError,
  DeletionUnauthorizedError,
  LoginRequiredError,
  WebNotReadyError,
  WebTimeoutError,
} from "../web/errors.ts";
import type { EditFormValues } from "../web/forms.ts";
import type { StravaWebSession } from "../web/session.ts";
import {
  buildMerge,
  MergeCheckError,
  mergeFigures,
  type NoLossCheck,
  postUploadCheck,
} from "./build.ts";
import {
  candidateComponents,
  groupIdFor,
  poolBetween,
  SampleCache,
  summarizeMatch,
} from "./evaluate.ts";
import type { FreezeStore } from "./freeze.ts";
import {
  appendEvent,
  beginWrite,
  finishWrite,
  getActivity,
  type GroupPatch,
  type GroupRow,
  type GroupStatus,
  insertGroup,
  listGroups,
  openWrites,
  patchGroup,
  PRE_WRITE_STATUSES,
  requireActivity,
  requireGroup,
  setActivityFields,
  setWriteUploadId,
  TERMINAL_STATUSES,
  trialPairsUsed,
  upsertActivity,
  type WriteKind,
  type WriteRow,
  writesFor,
} from "./repo.ts";
import { matchSettingsOf, type SettingsStore } from "./settings.ts";

/**
 * The persistent merge state machine (docs/ARCHITECTURE.md section 5).
 *
 * Every transition is a row update plus an append-only event with evidence.
 * Before every Strava write an intent row (with the external_id for uploads)
 * is committed; the result follows it. `reconcile()` runs first on every
 * tick: an open intent is looked up on Strava (the upload by id, else the
 * activity by external_id; a delete by GET -> 404) before anything is
 * repeated, so a crash never uploads or deletes twice.
 *
 * Writes are refused while frozen (checked right before each write), except
 * the restore writes of Path B, which run first and then freeze.
 *
 * This is the ONLY place a DeletionAuthorization is minted.
 */

export type MachineApi = Pick<
  StravaClient,
  | "getActivity"
  | "getStreams"
  | "listActivities"
  | "updateActivity"
  | "createUpload"
  | "getUpload"
  | "waitForUpload"
>;

export interface MachineOptions {
  db: DatabaseSync;
  api: MachineApi;
  web: WebGate;
  backup: BackupService;
  snapshotter: Snapshotter;
  notifier: Notifier;
  freeze: FreezeStore;
  settings: SettingsStore;
  clock: Clock;
  log?: Logger;
  metrics?: Metrics;
  uploadPoll?: PollOptions;
  /** Injection point for tests; the real check is shared/src/merge/no-loss.ts. */
  noLossCheck?: NoLossCheck;
}

/** A failed check: freezes all writes and fails the group. */
export class CheckFailedError extends Error {
  override readonly name = "CheckFailedError";
  readonly evidence: unknown;
  constructor(message: string, evidence: unknown) {
    super(message);
    this.evidence = evidence;
  }
}

/** Stop this group for now; the next tick looks again. */
class Wait extends Error {
  override readonly name = "Wait";
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** Park the group until the owner (or a resumable condition) moves it on. */
class Park extends Error {
  override readonly name = "Park";
  readonly reason: string;
  readonly resume: GroupStatus | null;
  constructor(reason: string, resume: GroupStatus | null) {
    super(reason);
    this.reason = reason;
    this.resume = resume;
  }
}

interface Step {
  to: GroupStatus;
  event: string;
  evidence?: unknown;
  patch?: GroupPatch;
}

export type RestoreOutcome =
  { status: "restored"; newId: number; flags: string[] } | { status: "flagged"; reason: string };

/** Errors that leave the group where it is for the next tick. */
export function isTransient(error: unknown): boolean {
  if (error instanceof StravaRateLimitedError || error instanceof UploadTimeoutError) return true;
  if (error instanceof StravaApiError) return error.status >= 500;
  if (error instanceof StravaAuthError || error instanceof BudgetExhaustedError) return true;
  if (error instanceof SnapshotError || error instanceof WebPausedError) return true;
  if (
    error instanceof LoginRequiredError ||
    error instanceof ChallengeError ||
    error instanceof BrowserUnavailableError ||
    error instanceof WebTimeoutError ||
    error instanceof WebNotReadyError
  ) {
    return true;
  }
  // undici reports a lost connection or response as TypeError("fetch failed").
  return error instanceof TypeError && error.message === "fetch failed";
}

function is404(error: unknown): boolean {
  return error instanceof StravaApiError && error.status === 404;
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const OUTCOMES: Partial<Record<GroupStatus, MergeOutcome>> = {
  done: "merged",
  parked: "parked",
  review: "review",
  failed: "failed",
  restore_flagged: "restore_flagged",
  dissolved: "dissolved",
};

/** Strava may store the external id with the file extension appended. */
function sameExternalId(stored: unknown, ours: string): boolean {
  return stored === ours || stored === `${ours}.fit`;
}

const MERGE_MARKER = "merged by cameld";

function metadataOf(detail: StravaDetailedActivity | null): ActivityMetadata {
  return {
    name: detail?.name ?? null,
    description: detail?.description ?? null,
    sportType: detail?.sport_type ?? null,
    gearId: detail?.gear_id ?? null,
    commute: detail?.commute ?? null,
    trainer: detail?.trainer ?? null,
  };
}

export class MergeMachine {
  readonly #db: DatabaseSync;
  readonly #api: MachineApi;
  readonly #web: WebGate;
  readonly #backup: BackupService;
  readonly #snapshotter: Snapshotter;
  readonly #notifier: Notifier;
  readonly #freeze: FreezeStore;
  readonly #settings: SettingsStore;
  readonly #clock: Clock;
  readonly #log: Logger | undefined;
  readonly #metrics: Metrics | undefined;
  readonly #poll: PollOptions;
  readonly #noLoss: NoLossCheck;
  readonly #samples: SampleCache;

  constructor(options: MachineOptions) {
    this.#db = options.db;
    this.#api = options.api;
    this.#web = options.web;
    this.#backup = options.backup;
    this.#snapshotter = options.snapshotter;
    this.#notifier = options.notifier;
    this.#freeze = options.freeze;
    this.#settings = options.settings;
    this.#clock = options.clock;
    this.#log = options.log?.child({ mod: "machine" });
    this.#metrics = options.metrics;
    this.#poll = options.uploadPoll ?? {};
    this.#noLoss = options.noLossCheck ?? checkNoLoss;
    this.#samples = new SampleCache(options.db, options.backup);
  }

  #now(): number {
    return this.#clock.now();
  }

  async #notify(
    kind: NotificationKind,
    level: "info" | "warning" | "critical",
    title: string,
    body: string,
    groupId?: string,
  ): Promise<void> {
    await notifySafely(
      this.#notifier,
      { kind, level, title, body, ...(groupId === undefined ? {} : { groupId }) },
      this.#log,
    );
  }

  // -------------------------------------------------------------------------
  // Detection

  /**
   * Find candidate groups among stored activities that start in the window.
   * A group whose members are all unclaimed is created. A component that
   * grows a group still before its first write (a late split part) replaces
   * it; anything already written is never regrouped. A member set that was
   * already judged (dissolved, superseded) is not formed again.
   */
  detectGroups(fromMs: number, toMs: number): string[] {
    const groups = listGroups(this.#db);
    const live = groups.filter((g) => !["dissolved", "superseded"].includes(g.status));
    const members = (g: GroupRow): number[] => [...g.appIds, ...g.fitbitIds];
    const claimedByWritten = new Set(
      live.filter((g) => !PRE_WRITE_STATUSES.includes(g.status)).flatMap(members),
    );
    const pool = poolBetween(this.#db, fromMs, toMs).filter((a) => !claimedByWritten.has(a.id));
    const settings = matchSettingsOf(this.#settings.get());
    const created: string[] = [];
    const now = this.#now();
    for (const ids of candidateComponents(pool, settings)) {
      const key = [...ids].sort((a, b) => a - b).join(",");
      const sameSet = (g: GroupRow): boolean =>
        [...members(g)].sort((a, b) => a - b).join(",") === key;
      if (groups.some(sameSet)) continue;
      const overlapping = live.filter((g) => members(g).some((id) => ids.includes(id)));
      const activities = ids.map((id) => requireActivity(this.#db, id));
      const fitbit = activities.filter((a) => a.source === "fitbit");
      const fitbitSide =
        fitbit.length > 0 ? fitbit : activities.filter((a) => a.source === "other");
      const appSide = activities.filter((a) => !fitbitSide.includes(a));
      const startMs = Math.min(...activities.map((a) => a.startMs));
      const id = groupIdFor(startMs, ids);
      this.#db.exec("BEGIN");
      try {
        for (const old of overlapping) {
          patchGroup(this.#db, old.id, { status: "superseded" }, now);
          appendEvent(this.#db, old.id, now, old.status, "superseded", "superseded", { by: id });
        }
        insertGroup(
          this.#db,
          {
            id,
            appIds: appSide.map((a) => a.id),
            fitbitIds: fitbitSide.map((a) => a.id),
            startMs,
          },
          now,
        );
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
      created.push(id);
      this.#log?.info({ groupId: id, members: ids }, "candidate group detected");
    }
    return created;
  }

  /** Report recordings without a partner after the partner wait as single (not terminal). */
  markSingles(): number {
    const wait = this.#settings.get().timing.partnerWaitMs;
    const now = this.#now();
    const grouped = new Set(
      listGroups(this.#db)
        .filter((g) => !["dissolved", "superseded"].includes(g.status))
        .flatMap((g) => [...g.appIds, ...g.fitbitIds]),
    );
    const rows = this.#db
      .prepare(
        `SELECT id FROM activities WHERE single_at IS NULL AND is_merge_output = 0
         AND restored_from IS NULL AND gone_at IS NULL AND first_seen_at <= ?`,
      )
      .all(now - wait) as { id: number }[];
    let marked = 0;
    for (const { id } of rows) {
      if (grouped.has(id)) continue;
      setActivityFields(this.#db, id, { single_at: now });
      marked += 1;
    }
    return marked;
  }

  // -------------------------------------------------------------------------
  // Driving

  /** Reconcile open intents, resume parked groups, then advance every live group. */
  async tick(): Promise<void> {
    this.#samples.clear();
    await this.reconcile();
    await this.#resumeParked();
    for (const group of listGroups(this.#db)) {
      if (!TERMINAL_STATUSES.includes(group.status)) await this.advance(group.id);
    }
  }

  async advance(groupId: string): Promise<GroupStatus> {
    for (let guard = 0; guard < 50; guard += 1) {
      const group = requireGroup(this.#db, groupId);
      if (
        TERMINAL_STATUSES.includes(group.status) ||
        group.status === "parked" ||
        group.status === "review"
      ) {
        return group.status;
      }
      let step: Step;
      try {
        step = await this.#step(group);
      } catch (error) {
        await this.#onError(group, error);
        return requireGroup(this.#db, groupId).status;
      }
      await this.#transition(group, step);
    }
    /* v8 ignore next 2 -- a step graph without cycles cannot get here */
    throw new Error(`group ${groupId} did not settle`);
  }

  async #transition(group: GroupRow, step: Step): Promise<void> {
    const now = this.#now();
    this.#db.exec("BEGIN");
    try {
      patchGroup(this.#db, group.id, { ...step.patch, status: step.to, lastError: null }, now);
      appendEvent(
        this.#db,
        group.id,
        now,
        group.status,
        step.to,
        step.event,
        step.evidence ?? null,
      );
      this.#db.exec("COMMIT");
    } catch (error) {
      /* v8 ignore next 2 -- a failing local SQLite write; nothing to recover */
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#log?.info(
      { groupId: group.id, from: group.status, to: step.to, event: step.event },
      "transition",
    );
    const outcome = OUTCOMES[step.to];
    if (outcome !== undefined) this.#metrics?.merges.inc({ outcome });
    if (step.to === "parked") {
      await this.#notify(
        "parked",
        "warning",
        "A pair was parked",
        `${group.id}: ${step.event}`,
        group.id,
      );
    } else if (step.to === "review") {
      await this.#notify("review", "info", "A pair needs review", group.id, group.id);
    } else if (step.to === "done") {
      await this.#notify("merged", "info", "A pair was merged", group.id, group.id);
    }
  }

  #note(group: GroupRow, event: string, evidence: unknown): void {
    const now = this.#now();
    patchGroup(this.#db, group.id, { lastError: event }, now);
    appendEvent(this.#db, group.id, now, group.status, group.status, event, evidence);
  }

  async #onError(group: GroupRow, error: unknown): Promise<void> {
    if (error instanceof Wait) {
      const marker = `wait:${error.reason}`;
      if (group.lastError !== marker) this.#note(group, marker, null);
      return;
    }
    if (error instanceof Park) {
      await this.#transition(group, {
        to: "parked",
        event: error.reason,
        patch: { parkedReason: error.reason, resumeStatus: error.resume },
      });
      return;
    }
    if (error instanceof CheckFailedError || error instanceof MergeCheckError) {
      await this.#freeze.freeze(`group ${group.id}: ${error.message}`, error.evidence);
      await this.#transition(group, {
        to: "failed",
        event: "check_failed",
        evidence: { message: error.message, evidence: error.evidence },
      });
      return;
    }
    if (error instanceof BackupIntegrityError) {
      await this.#freeze.freeze(`group ${group.id}: ${error.message}`, null);
      this.#note(group, `error:${message(error)}`, null);
      return;
    }
    if (isTransient(error)) {
      const marker = `transient:${message(error)}`;
      if (group.lastError !== marker) this.#note(group, marker, null);
      this.#log?.warn({ err: error, groupId: group.id }, "transient error; retrying next tick");
      return;
    }
    // Anything unexpected during a live merge is a failure: freeze, keep the state.
    this.#log?.error({ err: error, groupId: group.id }, "unexpected error in a merge group");
    this.#note(group, `error:${message(error)}`, null);
    await this.#freeze.freeze(`group ${group.id}: unexpected ${message(error)}`, null);
  }

  #assertWritable(): void {
    if (this.#freeze.isFrozen()) throw new Wait("frozen");
  }

  #permit(group: GroupRow): "on" | "trial" | null {
    const settings = this.#settings.get();
    if (settings.switches.delete) return "on";
    // Re-read: the group may have claimed a trial slot earlier in this step.
    const trial = requireGroup(this.#db, group.id).trial;
    if (settings.trial.enabled && (trial || trialPairsUsed(this.#db) < settings.trial.maxPairs)) {
      return "trial";
    }
    return null;
  }

  async #resumeParked(): Promise<void> {
    for (const group of listGroups(this.#db, ["parked"])) {
      if (group.parkedReason === "deletion_switch_off" && this.#permit(group) !== null) {
        await this.#transition(group, {
          to: group.resumeStatus as GroupStatus,
          event: "resumed",
          evidence: { reason: group.parkedReason },
          patch: { parkedReason: null, resumeStatus: null },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Owner actions (wired to the authenticated UI later)

  approveReview(groupId: string, offsetSeconds = 0): void {
    const group = requireGroup(this.#db, groupId);
    if (group.status !== "review") throw new Error(`group ${groupId} is not in review`);
    if (group.appIds.length === 0 || group.fitbitIds.length === 0) {
      throw new Error(`group ${groupId} has no two-sided structure to merge`);
    }
    const now = this.#now();
    patchGroup(this.#db, groupId, { status: "scored", offsetSeconds }, now);
    appendEvent(this.#db, groupId, now, "review", "scored", "review_approved", { offsetSeconds });
  }

  rejectReview(groupId: string): void {
    const group = requireGroup(this.#db, groupId);
    if (group.status !== "review") throw new Error(`group ${groupId} is not in review`);
    const now = this.#now();
    patchGroup(this.#db, groupId, { status: "dissolved" }, now);
    appendEvent(this.#db, groupId, now, "review", "dissolved", "review_rejected", null);
  }

  // -------------------------------------------------------------------------
  // Steps

  #members(group: GroupRow): number[] {
    return [...group.appIds, ...group.fitbitIds];
  }

  async #step(group: GroupRow): Promise<Step> {
    switch (group.status) {
      case "detected":
        return this.#stepBackup(group);
      case "backed_up":
        return this.#stepScore(group);
      case "scored":
        return this.#stepBuild(group);
      case "built": {
        const snapshot = await this.#snapshotter.snapshot(`merge-${group.id}`);
        return {
          to: "snapshotted",
          event: "snapshot",
          evidence: { snapshot },
          patch: { snapshot },
        };
      }
      case "snapshotted":
        return this.#stepFirstUpload(group);
      case "uploaded":
        return {
          to: "metadata_applied",
          event: "metadata",
          evidence: await this.#applyMetadata(group),
        };
      case "metadata_applied": {
        const evidence = await this.#verifyMerged(group);
        return {
          to: group.path === "B" ? "done" : "verified",
          event: "post_upload_check",
          evidence,
        };
      }
      case "verified":
        return this.#stepHide(group);
      case "hidden":
      case "awaiting_deletion":
        return this.#stepGrace(group);
      case "a_deleting": {
        const evidence = await this.#verifyMerged(group);
        for (const id of this.#members(group))
          await this.#guardedDelete(group, id, "path_a_grace_elapsed");
        return { to: "a_confirming", event: "originals_deleted", evidence };
      }
      case "a_confirming":
        return this.#stepConfirm(group);
      case "b_rejected":
        return this.#stepPathB(group);
      case "b_delete_fitbit":
      case "b_delete_app": {
        if (this.#freeze.isFrozen()) return this.#restoreOrWait(group);
        const ids = group.status === "b_delete_fitbit" ? group.fitbitIds : group.appIds;
        for (const id of ids) await this.#guardedDelete(group, id, "path_b_duplicate_rejected");
        const to = group.status === "b_delete_fitbit" ? "b_retry_1" : "b_retry_2";
        return { to, event: "side_deleted", evidence: { ids } };
      }
      case "b_retry_1":
      case "b_retry_2":
        return this.#stepRetry(group);
      case "b_restore":
        return this.#stepRestore(group);
      /* v8 ignore next 2 -- advance() never hands a terminal, parked or review group here */
      default:
        throw new Error(`no step for status ${group.status}`);
    }
  }

  async #stepBackup(group: GroupRow): Promise<Step> {
    const outcomes = [];
    for (const id of this.#members(group)) {
      const activity = requireActivity(this.#db, id);
      if (activity.goneAt !== null) {
        return { to: "dissolved", event: "member_gone", evidence: { id } };
      }
      if (activity.originalStatus === "pending" && !this.#web.available())
        throw new Wait("web_paused");
      const outcome = await this.#backup.backupActivity(id);
      if (!outcome.verified) {
        throw new CheckFailedError("backup failed read-back verification", {
          id,
          failures: outcome.failures,
        });
      }
      if (outcome.originalStatus === "none") throw new Park("original_missing", null);
      if (outcome.originalStatus === "pending") throw new Wait("original_pending");
      outcomes.push({ id, verifiedAt: outcome.verifiedAt, written: outcome.written });
    }
    return { to: "backed_up", event: "backup_verified", evidence: { members: outcomes } };
  }

  async #stepScore(group: GroupRow): Promise<Step> {
    const settings = matchSettingsOf(this.#settings.get());
    const result = await this.#samples.evaluate(this.#members(group), settings);
    const summary = summarizeMatch(result);
    const sides = {
      appIds: result.app?.members.map((m) => Number(m.id)) ?? group.appIds,
      fitbitIds: result.fitbit?.members.map((m) => Number(m.id)) ?? group.fitbitIds,
    };
    if (result.decision === "none")
      return { to: "dissolved", event: "no_match", evidence: summary };
    if (result.decision === "review") {
      return {
        to: "review",
        event: "borderline",
        evidence: summary,
        patch: { match: summary, ...sides },
      };
    }
    return {
      to: "scored",
      event: "auto_match",
      evidence: summary,
      patch: {
        match: summary,
        ...sides,
        offsetSeconds: result.metrics?.alignment?.offsetSeconds ?? 0,
      },
    };
  }

  #primary(ids: readonly number[]): number {
    const activities = ids.map((id) => requireActivity(this.#db, id));
    return activities.reduce((best, a) =>
      a.endMs - a.startMs > best.endMs - best.startMs ? a : best,
    ).id;
  }

  async #stepBuild(group: GroupRow): Promise<Step> {
    const app = await this.#samples.concat(group.appIds);
    const fitbit = await this.#samples.concat(group.fitbitIds);
    const sport =
      requireActivity(this.#db, this.#primary(group.appIds)).sportType ??
      requireActivity(this.#db, this.#primary(group.fitbitIds)).sportType;
    const built = buildMerge(
      {
        app,
        fitbit,
        offsetSeconds: group.offsetSeconds,
        sport,
        settings: this.#settings.get().merge,
      },
      this.#noLoss,
    );
    const mergedPath = await this.#backup.storeMergeArtifact(group.id, "merged.fit", built.fit);
    const ledger = Buffer.from(`${JSON.stringify(built.ledger)}\n`, "utf8");
    await this.#backup.storeMergeArtifact(group.id, "ledger.json", ledger);
    const report = {
      groupId: group.id,
      appIds: group.appIds,
      fitbitIds: group.fitbitIds,
      offsetSeconds: group.offsetSeconds,
      points: built.samples.length,
      noLoss: { ...built.noLoss, issues: [] },
    };
    await this.#backup.storeMergeArtifact(
      group.id,
      "report.json",
      Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"),
    );
    return {
      to: "built",
      event: "no_loss_ok",
      evidence: report,
      patch: { mergedPath, mergedSha256: sha256Hex(built.fit) },
    };
  }

  async #stepFirstUpload(group: GroupRow): Promise<Step> {
    if (!this.#settings.get().switches.upload) throw new Wait("upload_switch_off");
    this.#assertWritable();
    const result = await this.#uploadMerged(group);
    if (result.kind === "ready") {
      return {
        to: "uploaded",
        event: "uploaded",
        evidence: result,
        patch: { path: "A", mergedActivityId: result.activityId },
      };
    }
    if (result.kind === "duplicate") {
      return {
        to: "b_rejected",
        event: "upload_duplicate",
        evidence: result,
        patch: { path: "B" },
      };
    }
    throw new CheckFailedError("merged upload was refused", result);
  }

  async #stepHide(group: GroupRow): Promise<Step> {
    const hide = this.#settings.get().switches.hide;
    const hidden: number[] = [];
    if (hide) {
      for (const id of this.#members(group)) {
        await this.#webWrite(group, "hide", id, (s) => s.setVisibility(id, "only_me"));
        hidden.push(id);
      }
    }
    return {
      to: "hidden",
      event: "hidden",
      evidence: { hidden, hideSwitch: hide },
      patch: { hiddenAt: this.#now() },
    };
  }

  #stepGrace(group: GroupRow): Step {
    const grace = this.#settings.get().timing.gracePeriodMs;
    if (this.#now() < (group.hiddenAt as number) + grace) throw new Wait("grace_period");
    if (this.#permit(group) === null) {
      if (group.status === "awaiting_deletion") throw new Wait("deletion_switch_off");
      return { to: "awaiting_deletion", event: "grace_elapsed_deletion_off" };
    }
    return { to: "a_deleting", event: "grace_elapsed" };
  }

  async #stepConfirm(group: GroupRow): Promise<Step> {
    const gone: number[] = [];
    for (const id of this.#members(group)) {
      try {
        await this.#api.getActivity(id);
      } catch (error) {
        if (!is404(error)) throw error;
        gone.push(id);
        continue;
      }
      throw new CheckFailedError("an original still exists after its delete", { id });
    }
    const merged = await this.#api.getActivity(group.mergedActivityId as number);
    return { to: "done", event: "confirmed", evidence: { gone, merged: merged.id } };
  }

  async #stepPathB(group: GroupRow): Promise<Step> {
    if (this.#permit(group) === null) throw new Park("deletion_switch_off", "b_rejected");
    for (const id of this.#members(group)) {
      if (requireActivity(this.#db, id).originalStatus !== "present") {
        throw new Park("original_missing", null);
      }
    }
    return {
      to: "b_delete_fitbit",
      event: "path_b_start",
      evidence: { permit: this.#permit(group) },
    };
  }

  #restoreOrWait(group: GroupRow): Step {
    if (group.deletedIds.length === 0) throw new Wait("frozen");
    return { to: "b_restore", event: "frozen_mid_path_b", evidence: { deleted: group.deletedIds } };
  }

  async #stepRetry(group: GroupRow): Promise<Step> {
    if (this.#freeze.isFrozen()) return this.#restoreOrWait(group);
    const result = await this.#uploadMerged(group);
    if (result.kind === "ready") {
      return {
        to: "uploaded",
        event: "uploaded_after_delete",
        evidence: result,
        patch: { mergedActivityId: result.activityId },
      };
    }
    if (result.kind === "duplicate" && group.status === "b_retry_1") {
      return { to: "b_delete_app", event: "still_duplicate", evidence: result };
    }
    return { to: "b_restore", event: "upload_failed_after_delete", evidence: result };
  }

  async #stepRestore(group: GroupRow): Promise<Step> {
    const outcomes: { id: number; outcome: RestoreOutcome }[] = [];
    for (const id of group.deletedIds) {
      outcomes.push({ id, outcome: await this.restoreActivity(id, group.id) });
    }
    const flagged = outcomes.some((o) => o.outcome.status === "flagged");
    await this.#freeze.freeze(
      `group ${group.id}: path B merge failed; deleted originals restored`,
      {
        outcomes,
      },
    );
    if (flagged) {
      await this.#notify(
        "restore_flagged",
        "critical",
        "A restore was rejected",
        `${group.id}: an original could not be restored and is kept in the backup`,
        group.id,
      );
    }
    return {
      to: flagged ? "restore_flagged" : "failed",
      event: "restored",
      evidence: { outcomes },
    };
  }

  // -------------------------------------------------------------------------
  // Writes

  async #ownedBy(activityId: number, externalId: string): Promise<boolean> {
    try {
      const activity = await this.#api.getActivity(activityId);
      return sameExternalId(activity.external_id, externalId);
    } catch (error) {
      if (is404(error)) return false;
      throw error;
    }
  }

  /** Record an upload outcome. A duplicate of our own upload is our upload. */
  async #settleUpload(
    writeId: number,
    externalId: string,
    result: UploadResult,
  ): Promise<
    | { kind: "ready"; activityId: number }
    | { kind: "duplicate"; duplicateOf: number; error: string }
    | { kind: "error"; error: string }
  > {
    const now = (): number => this.#now();
    if (result.kind === "ready") {
      finishWrite(this.#db, writeId, "done", { activityId: result.activityId }, now());
      return { kind: "ready", activityId: result.activityId };
    }
    if (result.kind === "duplicate") {
      if (await this.#ownedBy(result.duplicateOf, externalId)) {
        finishWrite(
          this.#db,
          writeId,
          "done",
          { activityId: result.duplicateOf, via: "own_duplicate" },
          now(),
        );
        return { kind: "ready", activityId: result.duplicateOf };
      }
      finishWrite(
        this.#db,
        writeId,
        "rejected",
        { duplicateOf: result.duplicateOf, error: result.error },
        now(),
      );
      return { kind: "duplicate", duplicateOf: result.duplicateOf, error: result.error };
    }
    finishWrite(this.#db, writeId, "rejected", { error: result.error }, now());
    return { kind: "error", error: result.error };
  }

  /** A completed upload already journaled for (group, kind, target), if any. */
  #doneUpload(groupId: string | null, kind: WriteKind, targetId: number | null): number | null {
    const rows = writesFor(this.#db, { ...(groupId === null ? {} : { groupId }), kind });
    const done = rows.find(
      (w) =>
        w.status === "done" &&
        w.targetId === targetId &&
        (w.result as { activityId?: number } | null)?.activityId !== undefined,
    );
    return done === undefined ? null : (done.result as { activityId: number }).activityId;
  }

  async #upload(
    groupId: string | null,
    kind: "upload" | "restore_upload",
    targetId: number | null,
    params: { file: Uint8Array; dataType: UploadDataType; externalId: string; name?: string },
  ) {
    const reused = this.#doneUpload(groupId, kind, targetId);
    if (reused !== null) return { kind: "ready" as const, activityId: reused };
    // An earlier attempt is still unresolved (processing, or its lookup failed):
    // never send a second one until reconcile() has settled it.
    const pending = writesFor(this.#db, { ...(groupId === null ? {} : { groupId }), kind }).some(
      (w) => (w.status === "intent" || w.status === "unknown") && w.targetId === targetId,
    );
    if (pending) throw new Wait("upload_pending");
    const writeId = beginWrite(
      this.#db,
      { groupId, kind, targetId, externalId: params.externalId },
      this.#now(),
    );
    let upload;
    try {
      upload = await this.#api.createUpload({
        file: params.file,
        data_type: params.dataType,
        external_id: params.externalId,
        ...(params.name === undefined ? {} : { name: params.name }),
      });
    } catch (error) {
      // A 4xx answer means nothing was created; anything else may have been.
      if (error instanceof StravaApiError && error.status < 500 && error.status !== 429) {
        finishWrite(this.#db, writeId, "failed", { error: message(error) }, this.#now());
      }
      throw error;
    }
    setWriteUploadId(this.#db, writeId, upload.id);
    const result = await this.#api.waitForUpload(upload, this.#poll);
    return this.#settleUpload(writeId, params.externalId, result);
  }

  async #uploadMerged(group: GroupRow) {
    const bytes = await this.#backup.readVerified(group.mergedPath as string);
    if (sha256Hex(bytes) !== group.mergedSha256) {
      throw new CheckFailedError("merged file does not match its recorded checksum", {
        path: group.mergedPath,
      });
    }
    const result = await this.#upload(group.id, "upload", null, {
      file: bytes,
      dataType: "fit",
      externalId: group.externalId,
    });
    if (result.kind === "ready") {
      patchGroup(this.#db, group.id, { mergedActivityId: result.activityId }, this.#now());
      setActivityFields(this.#db, result.activityId, { is_merge_output: 1 });
    }
    return result;
  }

  async #apiWrite<T>(
    group: GroupRow,
    kind: WriteKind,
    target: number,
    write: () => Promise<T>,
  ): Promise<T> {
    this.#assertWritable();
    const writeId = beginWrite(
      this.#db,
      { groupId: group.id, kind, targetId: target },
      this.#now(),
    );
    try {
      const result = await write();
      finishWrite(this.#db, writeId, "done", null, this.#now());
      return result;
    } catch (error) {
      finishWrite(this.#db, writeId, "failed", { error: message(error) }, this.#now());
      throw error;
    }
  }

  #webWrite<T>(
    group: GroupRow,
    kind: WriteKind,
    target: number,
    write: (session: StravaWebSession) => Promise<T>,
  ): Promise<T> {
    return this.#apiWrite(group, kind, target, () => this.#web.run(write));
  }

  async #applyMetadata(group: GroupRow): Promise<unknown> {
    const merged = group.mergedActivityId as number;
    const appId = this.#primary(group.appIds);
    const fitbitId = this.#primary(group.fitbitIds);
    const appDetail = await this.#backup.latestJson<StravaDetailedActivity>(appId, "metadata");
    const fitbitDetail = await this.#backup.latestJson<StravaDetailedActivity>(
      fitbitId,
      "metadata",
    );
    const meta = mergeMetadata(metadataOf(appDetail), metadataOf(fitbitDetail));
    const fields: UpdateActivityFields = {};
    if (meta.name !== null) fields.name = meta.name;
    if (meta.description !== null) fields.description = meta.description;
    if (meta.sportType !== null) fields.sport_type = meta.sportType;
    if (meta.gearId !== null) fields.gear_id = meta.gearId;
    if (meta.commute !== null) fields.commute = meta.commute;
    if (meta.trainer !== null) fields.trainer = meta.trainer;
    await this.#apiWrite(group, "update", merged, () => this.#api.updateActivity(merged, fields));

    const forms: EditFormValues[] = [];
    for (const id of [...group.appIds, ...group.fitbitIds]) {
      const form = await this.#backup.latestJson<EditFormValues>(id, "web_form");
      if (form !== null) forms.push(form);
    }
    const notes = [...new Set(forms.map((f) => f.privateNote.trim()).filter((n) => n !== ""))];
    const marker = `${MERGE_MARKER} from ${this.#members(group).join(", ")}`;
    const note = [...notes, marker].join("\n\n");
    await this.#webWrite(group, "private_note", merged, (s) => s.setPrivateNote(merged, note));
    const exertion = forms.find((f) => f.perceivedExertion !== null);
    if (exertion !== undefined) {
      await this.#webWrite(group, "exertion", merged, (s) =>
        s.setPerceivedExertion(
          merged,
          exertion.perceivedExertion,
          exertion.preferPerceivedExertion,
        ),
      );
    }
    const photos = await this.#attachPhotos(group, merged, appDetail);
    return {
      fields,
      conflicts: meta.conflicts,
      privateNoteMarked: true,
      exertion: exertion?.perceivedExertion ?? null,
      photos,
      kudosAndComments: "archived in backup",
    };
  }

  async #attachPhotos(
    group: GroupRow,
    merged: number,
    appDetail: StravaDetailedActivity | null,
  ): Promise<{ attached: number; flagged: boolean }> {
    const athleteId = Number((appDetail?.athlete as { id?: unknown } | undefined)?.id ?? 0);
    const previous = writesFor(this.#db, { groupId: group.id, kind: "photo" });
    let attached = 0;
    let flagged = group.photosFlagged;
    for (const id of this.#members(group)) {
      const list = (await this.#backup.latestJson<StravaPhoto[]>(id, "photos_list")) ?? [];
      const startMs = requireActivity(this.#db, id).startMs;
      for (const file of this.#backup.photoFiles(id)) {
        const key = `${id}:${file.uniqueId}`;
        if (previous.some((w) => w.externalId === key)) continue;
        this.#assertWritable();
        const listed = list.find((p) => String(p.unique_id) === file.uniqueId);
        const takenAt = new Date(
          typeof listed?.created_at === "string" ? Date.parse(listed.created_at) : startMs,
        );
        const writeId = beginWrite(
          this.#db,
          { groupId: group.id, kind: "photo", targetId: merged, externalId: key },
          this.#now(),
        );
        try {
          const bytes = await this.#backup.readVerified(file.relPath);
          const contentType = file.relPath.endsWith(".png") ? "image/png" : "image/jpeg";
          const result = await this.#web.run((s) =>
            s.attachPhoto(merged, { bytes, contentType, takenAt, athleteId }),
          );
          finishWrite(this.#db, writeId, "done", result, this.#now());
          attached += 1;
          if (!result.verified) flagged = true;
        } catch (error) {
          finishWrite(this.#db, writeId, "failed", { error: message(error) }, this.#now());
          if (error instanceof WebPausedError) throw error;
          flagged = true;
        }
      }
    }
    if (flagged && !group.photosFlagged) {
      patchGroup(this.#db, group.id, { photosFlagged: true }, this.#now());
      await this.#notify(
        "photos_flagged",
        "warning",
        "Photos could not be re-attached",
        `${group.id}: photos stay archived in the backup`,
        group.id,
      );
    }
    return { attached, flagged };
  }

  /** The tolerance-based post-upload check against the uploaded merge. */
  async #verifyMerged(group: GroupRow): Promise<unknown> {
    const merged = group.mergedActivityId as number;
    const activity = await this.#api.getActivity(merged);
    const streams = await this.#api.getStreams(merged, ["time", "heartrate"]);
    const fit = await this.#backup.readVerified(group.mergedPath as string);
    const expected = mergeFigures(
      readFitActivity(new Uint8Array(fit), { source: "merged" }).samples,
    );
    const actual = {
      points: streams.time?.data.length ?? 0,
      distanceMeters: activity.distance,
      elapsedSeconds: activity.elapsed_time,
      startMs: Date.parse(activity.start_date),
      hasHeartRate: (streams.heartrate?.data.length ?? 0) > 0,
    };
    const settings = this.#settings.get().postUpload;
    const check = postUploadCheck({
      expected,
      actual,
      tolerance: settings.tolerance,
      startToleranceSeconds: settings.startToleranceSeconds,
    });
    const evidence = { expected, actual, failures: check.failures };
    if (!check.ok) throw new CheckFailedError("post-upload check failed", evidence);
    return evidence;
  }

  // -------------------------------------------------------------------------
  // Deletion: the only place a DeletionAuthorization is minted.

  async #guardedDelete(group: GroupRow, id: number, reason: DeletionReason): Promise<void> {
    if (requireActivity(this.#db, id).goneAt !== null) return;
    this.#assertWritable();
    const permit = this.#permit(group);
    if (permit === null) throw new Wait("deletion_switch_off");
    if (requireActivity(this.#db, id).originalStatus !== "present") {
      throw new Park("original_missing", null);
    }
    if (permit === "trial" && !requireGroup(this.#db, group.id).trial) {
      patchGroup(this.#db, group.id, { trial: true }, this.#now());
    }
    // Fresh pre-delete backup: metadata, photos, kudos and comments may have changed.
    const fresh = await this.#backup.backupActivity(id, { fresh: true });
    if (!fresh.verified) {
      throw new CheckFailedError("pre-delete backup failed read-back verification", {
        id,
        failures: fresh.failures,
      });
    }
    const original = await this.#backup.readOriginal(id);
    if (original === null) throw new Park("original_missing", null);
    const snapshot = await this.#snapshotter.snapshot(`pre-delete-${id}`);
    let auth: DeletionAuthorization;
    try {
      auth = DeletionAuthorization.mint(
        {
          activityId: id,
          deletionSwitch: permit,
          originalFileBackedUp: true,
          backupVerifiedAt: fresh.verifiedAt,
          snapshot,
          reason: permit === "trial" ? "rollout_trial" : reason,
        },
        this.#now(),
      );
    } catch (error) {
      /* v8 ignore next -- mint only ever throws DeletionUnauthorizedError */
      if (!(error instanceof DeletionUnauthorizedError)) throw error;
      appendEvent(this.#db, group.id, this.#now(), group.status, group.status, "deletion_refused", {
        id,
        problem: error.message,
      });
      throw new Wait("deletion_refused");
    }
    this.#assertWritable();
    const writeId = beginWrite(
      this.#db,
      { groupId: group.id, kind: "delete", targetId: id },
      this.#now(),
    );
    let webError: unknown = null;
    try {
      await this.#web.run((session) => session.deleteActivity(id, auth));
    } catch (error) {
      webError = error;
    }
    if (webError instanceof WebPausedError) {
      finishWrite(this.#db, writeId, "failed", { notSent: true }, this.#now());
      throw webError;
    }
    const gone = await this.#confirmGone(group, writeId, id, webError);
    if (gone) {
      appendEvent(this.#db, group.id, this.#now(), group.status, group.status, "deleted", {
        id,
        snapshot,
        backupVerifiedAt: fresh.verifiedAt,
        permit,
      });
      return;
    }
    if (webError instanceof LoginRequiredError || webError instanceof ChallengeError)
      throw webError;
    await this.#freeze.freeze(`group ${group.id}: delete of ${id} was not confirmed`, {
      id,
      webError: webError === null ? null : message(webError),
    });
    throw new Wait("deletion_failed");
  }

  /** Confirm a delete through the API (404). Freezes and notifies when unknown. */
  async #confirmGone(
    group: GroupRow,
    writeId: number,
    id: number,
    webError: unknown,
  ): Promise<boolean> {
    try {
      await this.#api.getActivity(id);
    } catch (error) {
      if (is404(error)) {
        this.#recordGone(group.id, writeId, id, webError);
        return true;
      }
      finishWrite(this.#db, writeId, "unknown", { lookup: message(error) }, this.#now());
      await this.#freeze.freeze(`group ${group.id}: delete of ${id} sent but unconfirmed`, {
        id,
        lookup: message(error),
      });
      await this.#notify(
        "deletion_unconfirmed",
        "critical",
        "A delete could not be confirmed",
        `${group.id}: activity ${id}`,
        group.id,
      );
      throw new Wait("deletion_unconfirmed");
    }
    finishWrite(
      this.#db,
      writeId,
      "failed",
      {
        stillExists: true,
        webError: webError === null ? null : message(webError),
      },
      this.#now(),
    );
    return false;
  }

  #recordGone(groupId: string | null, writeId: number, id: number, webError: unknown): void {
    const now = this.#now();
    finishWrite(
      this.#db,
      writeId,
      "done",
      { confirmed: "api_404", webError: webError === null ? null : message(webError) },
      now,
    );
    setActivityFields(this.#db, id, { gone_at: now });
    if (groupId !== null) {
      const group = requireGroup(this.#db, groupId);
      if (!group.deletedIds.includes(id)) {
        patchGroup(this.#db, groupId, { deletedIds: [...group.deletedIds, id] }, now);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Restore: re-upload a deleted original from its backed-up file. Allowed
  // while frozen (the one exception).

  async restoreActivity(
    activityId: number,
    groupId: string | null = null,
  ): Promise<RestoreOutcome> {
    const activity = requireActivity(this.#db, activityId);
    if (activity.restoredAs !== null)
      return { status: "restored", newId: activity.restoredAs, flags: [] };
    const original = await this.#backup.readOriginal(activityId);
    if (original === null) return this.#flagRestore(activityId, "no_original_in_backup");
    const detail = await this.#backup.latestJson<StravaDetailedActivity>(activityId, "metadata");
    const externalId =
      typeof detail?.external_id === "string" && detail.external_id !== ""
        ? detail.external_id
        : `cameld-restore-${activityId}`;
    const result = await this.#upload(groupId, "restore_upload", activityId, {
      file: original.bytes,
      dataType: original.dataType,
      externalId,
      ...(detail?.name === undefined ? {} : { name: detail.name }),
    });
    if (result.kind !== "ready") {
      return this.#flagRestore(
        activityId,
        result.kind === "duplicate" ? "duplicate" : result.error,
      );
    }
    const newId = result.activityId;
    const fresh = await this.#api.getActivity(newId);
    upsertActivity(this.#db, fresh, this.#now());
    setActivityFields(this.#db, newId, { restored_from: activityId });
    setActivityFields(this.#db, activityId, { restored_as: newId });
    const flags = await this.#restoreMetadata(groupId, activityId, newId, detail);
    this.#metrics?.merges.inc({ outcome: "restored" });
    this.#log?.warn({ activityId, newId, flags }, "original restored from backup");
    return { status: "restored", newId, flags };
  }

  async #flagRestore(activityId: number, reason: string): Promise<RestoreOutcome> {
    this.#log?.error({ activityId, reason }, "restore rejected; original kept in backup");
    await this.#notify(
      "restore_flagged",
      "critical",
      "An original could not be restored",
      `activity ${activityId}: ${reason}; it stays in the backup`,
    );
    return { status: "flagged", reason };
  }

  async #restoreMetadata(
    groupId: string | null,
    oldId: number,
    newId: number,
    detail: StravaDetailedActivity | null,
  ): Promise<string[]> {
    const flags: string[] = [];
    const journal = async (kind: WriteKind, write: () => Promise<unknown>): Promise<void> => {
      const writeId = beginWrite(this.#db, { groupId, kind, targetId: newId }, this.#now());
      try {
        await write();
        finishWrite(this.#db, writeId, "done", null, this.#now());
      } catch (error) {
        finishWrite(this.#db, writeId, "failed", { error: message(error) }, this.#now());
        flags.push(`${kind}: ${message(error)}`);
      }
    };
    const meta = metadataOf(detail);
    const fields: UpdateActivityFields = {};
    if (meta.name !== null) fields.name = meta.name;
    if (meta.description !== null) fields.description = meta.description;
    if (meta.sportType !== null) fields.sport_type = meta.sportType;
    if (meta.gearId !== null) fields.gear_id = meta.gearId;
    if (meta.commute !== null) fields.commute = meta.commute;
    if (meta.trainer !== null) fields.trainer = meta.trainer;
    if (typeof detail?.hide_from_home === "boolean") fields.hide_from_home = detail.hide_from_home;
    await journal("restore_update", () => this.#api.updateActivity(newId, fields));
    const form = await this.#backup.latestJson<EditFormValues>(oldId, "web_form");
    if (form === null) {
      flags.push("no web form in backup");
    } else {
      await journal("restore_web", async () => {
        if (form.privateNote !== "")
          await this.#web.run((s) => s.setPrivateNote(newId, form.privateNote));
        if (form.visibility !== null) {
          const visibility = form.visibility;
          await this.#web.run((s) => s.setVisibility(newId, visibility));
        }
        if (form.perceivedExertion !== null) {
          const exertion = form.perceivedExertion;
          await this.#web.run((s) =>
            s.setPerceivedExertion(newId, exertion, form.preferPerceivedExertion),
          );
        }
      });
    }
    return flags;
  }

  // -------------------------------------------------------------------------
  // Resume

  /**
   * Resolve every open intent by looking it up on Strava before anything is
   * repeated. Lookups that fail leave the intent open for the next tick.
   */
  async reconcile(): Promise<void> {
    for (const write of openWrites(this.#db)) {
      try {
        await this.#reconcileOne(write);
      } catch (error) {
        this.#log?.warn(
          { err: error, writeId: write.id },
          "intent lookup failed; retrying next tick",
        );
      }
    }
  }

  async #reconcileOne(write: WriteRow): Promise<void> {
    const now = this.#now();
    if (write.kind === "upload" || write.kind === "restore_upload") {
      const externalId = write.externalId as string;
      if (write.uploadId !== null) {
        const result = classifyUpload(await this.#api.getUpload(write.uploadId));
        if (result === null) return;
        const settled = await this.#settleUpload(write.id, externalId, result);
        if (settled.kind === "ready" && write.kind === "upload" && write.groupId !== null) {
          patchGroup(this.#db, write.groupId, { mergedActivityId: settled.activityId }, now);
        }
        return;
      }
      const around =
        write.kind === "upload"
          ? requireGroup(this.#db, write.groupId as string).startMs
          : requireActivity(this.#db, write.targetId as number).startMs;
      const found = await this.#findByExternalId(externalId, around);
      if (found === null) {
        finishWrite(this.#db, write.id, "superseded", { lookup: "not on strava" }, now);
      } else {
        finishWrite(this.#db, write.id, "done", { activityId: found, via: "lookup" }, now);
      }
      return;
    }
    if (write.kind === "delete") {
      const id = write.targetId as number;
      try {
        await this.#api.getActivity(id);
      } catch (error) {
        if (!is404(error)) throw error;
        this.#recordGone(write.groupId, write.id, id, null);
        return;
      }
      finishWrite(this.#db, write.id, "failed", { stillExists: true, via: "lookup" }, now);
      return;
    }
    if (write.kind === "photo") {
      // Re-attaching could duplicate a photo; never retried, the pair is flagged.
      finishWrite(this.#db, write.id, "failed", { unknown: true }, now);
      if (write.groupId !== null) patchGroup(this.#db, write.groupId, { photosFlagged: true }, now);
      return;
    }
    // Field edits are idempotent: the step that wanted them simply runs again.
    finishWrite(this.#db, write.id, "superseded", null, now);
  }

  async #findByExternalId(externalId: string, aroundMs: number): Promise<number | null> {
    const day = 24 * 3600;
    const activities = await this.#api.listActivities({
      after: Math.floor(aroundMs / 1000) - day,
      before: Math.floor(aroundMs / 1000) + day,
      per_page: 200,
    });
    return activities.find((a) => sameExternalId(a.external_id, externalId))?.id ?? null;
  }

  /** For the UI and tests. */
  group(groupId: string): GroupRow {
    return requireGroup(this.#db, groupId);
  }

  activity(id: number) {
    return getActivity(this.#db, id);
  }
}
