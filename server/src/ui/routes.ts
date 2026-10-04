import type { DatabaseSync } from "node:sqlite";
import {
  type ApiSettings,
  type ApiStatus,
  type AuditEntry,
  BACKFILL_MODES,
  type BackfillInfo,
  type BackfillReport,
  DELETE_CONFIRM_PHRASE,
  type GroupDetail,
  type GroupSummary,
  type ReviewItem,
} from "@cameld/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Logger } from "../logging.ts";
import { type Backfill, dryRunEntries } from "../service/backfill.ts";
import type { ReadBudget } from "../service/budget.ts";
import { endpointHash, isSubscription, type PushService } from "../service/push.ts";
import type { WebGate } from "../service/web-gate.ts";
import type { FreezeStore } from "../state/freeze.ts";
import { isRestorable, type MergeMachine, NotRestorableError } from "../state/machine.ts";
import {
  GROUP_STATUSES,
  type GroupRow,
  type GroupStatus,
  getActivity,
  getGroup,
  groupEvents,
  listGroups,
  originalCounts,
  trialPairsUsed,
  writesFor,
} from "../state/repo.ts";
import { approveReview, rejectReview, ReviewError } from "../state/review.ts";
import {
  type Settings,
  SettingsError,
  type SettingsPatch,
  type SettingsStore,
} from "../state/settings.ts";
import type { RateLimiter } from "../strava/rate-limiter.ts";
import { groupTracks } from "./tracks.ts";

/**
 * The UI's /api routes (registered inside the authenticated /api plugin of
 * app.ts, so both gates already passed). Every write route is recorded in the
 * audit_log table with the Access identity, the target and how it ended.
 * Bodies are validated with zod; errors answer `{ error, detail? }`.
 */

export interface UiDeps {
  db: DatabaseSync;
  version: string;
  mapStyleUrl: string | null;
  backupRoot: string;
  settings: SettingsStore;
  freeze: FreezeStore;
  web: WebGate;
  push: PushService;
  budget: ReadBudget;
  limiter?: RateLimiter | undefined;
  /** Null when Strava is not configured: restore and backfill start are unavailable. */
  machine: MergeMachine | null;
  backfill: Backfill | null;
  /** Start one backfill batch now (in the background). */
  runBackfill?: (() => void) | undefined;
  browserAvailable: boolean;
  polling: () => boolean;
  now?: () => number;
  log?: Logger | undefined;
}

type Outcome = "ok" | "refused" | "failed";

export function audit(
  db: DatabaseSync,
  entry: {
    at: number;
    actor: string;
    action: string;
    target: string | null;
    outcome: Outcome;
    details: unknown;
  },
): void {
  db.prepare(
    "INSERT INTO audit_log (at, actor, action, target, outcome, details) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    entry.at,
    entry.actor,
    entry.action,
    entry.target,
    entry.outcome,
    JSON.stringify(entry.details ?? null),
  );
}

export function auditEntries(db: DatabaseSync, limit: number): AuditEntry[] {
  const rows = db
    .prepare(
      "SELECT id, at, actor, action, target, outcome, details FROM audit_log ORDER BY id DESC LIMIT ?",
    )
    .all(limit) as {
    id: number;
    at: number;
    actor: string;
    action: string;
    target: string | null;
    outcome: string;
    details: string;
  }[];
  return rows.map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }));
}

/** A failure the route answers with a status and a fixed error code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  constructor(status: number, code: string, detail?: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function summary(db: DatabaseSync, group: GroupRow): GroupSummary {
  const first = getActivity(db, group.appIds[0] ?? group.fitbitIds[0] ?? -1);
  return {
    id: group.id,
    status: group.status,
    path: group.path,
    appIds: group.appIds,
    fitbitIds: group.fitbitIds,
    startMs: group.startMs,
    sportType: first?.sportType ?? null,
    name: first?.name ?? null,
    parkedReason: group.parkedReason,
    mergedActivityId: group.mergedActivityId,
    deletedIds: group.deletedIds,
    hiddenAt: group.hiddenAt,
    trial: group.trial,
    photosFlagged: group.photosFlagged,
    lastError: group.lastError,
    updatedAt: group.updatedAt,
  };
}

function requireGroupOr404(db: DatabaseSync, id: string): GroupRow {
  const group = getGroup(db, id);
  if (group === null) throw new HttpError(404, "not_found");
  return group;
}

const reason = z.string().trim().min(3).max(500);
const note = z.string().trim().max(1000);

const reviewSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note,
    offsetSeconds: z.number().int().min(-3600).max(3600).optional(),
  })
  .strict();
const reasonSchema = z.object({ reason }).strict();
const settingsSchema = z
  .object({ patch: z.record(z.string(), z.unknown()), confirm: z.string().optional() })
  .strict();
const backfillUpdateSchema = z
  .object({
    mode: z.enum(BACKFILL_MODES).optional(),
    dailyReads: z.number().int().min(0).max(100_000).optional(),
    fifteenMinuteReads: z.number().int().min(0).max(10_000).optional(),
    confirm: z.string().optional(),
  })
  .strict();
const controlSchema = z.object({ action: z.enum(["start", "pause", "resume", "reset"]) }).strict();
const unsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2048) }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_request",
      result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}

/** True when the patch turns deletion (or the deletion trial) from off to on. */
export function enablesDeletion(current: Settings, patch: SettingsPatch): boolean {
  const deleteOn = patch.switches?.delete === true && !current.switches.delete;
  const trialOn = patch.trial?.enabled === true && !current.trial.enabled;
  return deleteOn || trialOn;
}

export function registerUiRoutes(api: FastifyInstance, deps: UiDeps): void {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log?.child({ mod: "ui" });

  /**
   * Wrap a write route: run it, audit the outcome (never the body's
   * secrets), and map known errors to statuses.
   */
  function write<T>(
    action: string,
    run: (request: FastifyRequest) => Promise<{ target: string | null; details: unknown; body: T }>,
    targetOf: (request: FastifyRequest) => string | null = () => null,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.identity;
      try {
        const result = await run(request);
        audit(db, {
          at: now(),
          actor,
          action,
          target: result.target,
          outcome: "ok",
          details: result.details,
        });
        return result.body;
      } catch (error) {
        const known = toHttpError(error);
        audit(db, {
          at: now(),
          actor,
          action,
          target: targetOf(request),
          outcome: known.status >= 500 ? "failed" : "refused",
          details: { error: known.code, detail: known.detail ?? null },
        });
        if (!(error instanceof HttpError)) log?.error({ err: error, action }, "ui write failed");
        return reply.code(known.status).send({
          error: known.code,
          ...(known.detail === undefined ? {} : { detail: known.detail }),
        });
      }
    };
  }

  const paramId = (request: FastifyRequest): string => (request.params as { id: string }).id;

  const backfillInfo = (): BackfillInfo => {
    const settings = deps.settings.get().backfill;
    const last = deps.backfill?.lastBatch() ?? null;
    return {
      mode: settings.mode,
      paused: settings.paused,
      running: deps.backfill?.running() ?? false,
      available: deps.backfill !== null,
      progress: deps.backfill?.progress() ?? {
        activities: 0,
        cursorMs: null,
        done: false,
        readsToday: deps.budget.readsToday(),
      },
      budget: deps.budget.usage(),
      lastBatch: last,
    };
  };

  // ---------------------------------------------------------------- reads

  api.get("/status", (request): ApiStatus => {
    const counts: Record<string, number> = {};
    const rows = db
      .prepare("SELECT status, count(*) AS n FROM merge_groups GROUP BY status")
      .all() as { status: string; n: number }[];
    for (const row of rows) counts[row.status] = row.n;
    const settings = deps.settings.get();
    return {
      version: deps.version,
      identity: request.identity,
      frozen: deps.freeze.state(),
      web: deps.web.status(),
      browserAvailable: deps.browserAvailable,
      stravaConfigured: deps.machine !== null,
      polling: deps.polling(),
      rate: deps.limiter?.usage() ?? null,
      backfill: backfillInfo(),
      counts,
      originals: originalCounts(db, now()),
      trial: {
        enabled: settings.trial.enabled,
        maxPairs: settings.trial.maxPairs,
        used: trialPairsUsed(db),
      },
      push: {
        configured: deps.push.configured(),
        publicKey: deps.push.publicKey(),
        subscriptions: deps.push.count(),
      },
      map: { styleUrl: deps.mapStyleUrl },
    };
  });

  api.get("/settings", (): ApiSettings => deps.settings.get());

  api.get("/review", (): ReviewItem[] =>
    listGroups(db, ["review"]).map((group) => ({ ...summary(db, group), match: group.match })),
  );

  api.get("/groups", (request): GroupSummary[] => {
    const query = request.query as { status?: string; limit?: string };
    const wanted = (query.status ?? "")
      .split(",")
      .filter((s): s is GroupStatus => (GROUP_STATUSES as readonly string[]).includes(s));
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000);
    const groups = wanted.length > 0 ? listGroups(db, wanted) : listGroups(db);
    return groups
      .sort((a, b) => b.startMs - a.startMs)
      .slice(0, limit)
      .map((group) => summary(db, group));
  });

  api.get("/groups/:id", (request, reply) => {
    const group = getGroup(db, paramId(request));
    if (group === null) return reply.code(404).send({ error: "not_found" });
    const detail: GroupDetail = {
      group: summary(db, group),
      match: group.match,
      members: [...group.appIds, ...group.fitbitIds].flatMap((id) => {
        const a = getActivity(db, id);
        return a === null
          ? []
          : [
              {
                id: a.id,
                name: a.name,
                sportType: a.sportType,
                source: a.source,
                deviceName: a.deviceName,
                startMs: a.startMs,
                endMs: a.endMs,
                originalStatus: a.originalStatus,
                goneAt: a.goneAt,
                restoredAs: a.restoredAs,
              },
            ];
      }),
      events: groupEvents(db, group.id),
      writes: writesFor(db, { groupId: group.id }).map((w) => ({
        id: w.id,
        kind: w.kind,
        targetId: w.targetId,
        externalId: w.externalId,
        status: w.status,
        result: w.result,
        createdAt: w.createdAt,
        completedAt: w.completedAt,
      })),
      restorable: isRestorable(group),
      mergeBuilt: group.mergedPath !== null,
    };
    return detail;
  });

  api.get("/groups/:id/tracks", async (request, reply) => {
    const group = getGroup(db, paramId(request));
    if (group === null) return reply.code(404).send({ error: "not_found" });
    return groupTracks(db, deps.backupRoot, group, deps.settings.get().merge);
  });

  api.get("/backfill", (): BackfillInfo => backfillInfo());

  api.get(
    "/backfill/report",
    (): BackfillReport =>
      deps.backfill?.report() ?? {
        generatedAt: now(),
        progress: backfillInfo().progress,
        groups: dryRunEntries(db),
      },
  );

  api.get("/audit", (request): AuditEntry[] => {
    const limit = Math.min(
      Math.max(Number((request.query as { limit?: string }).limit) || 50, 1),
      500,
    );
    return auditEntries(db, limit);
  });

  // ---------------------------------------------------------------- writes

  api.patch(
    "/settings",
    write("settings.update", async (request) => {
      const body = parse(settingsSchema, request.body);
      const patch = body.patch as SettingsPatch;
      const current = deps.settings.get();
      if (enablesDeletion(current, patch) && body.confirm !== DELETE_CONFIRM_PHRASE) {
        throw new HttpError(
          409,
          "confirm_required",
          "type the confirmation phrase to enable deletion",
        );
      }
      const next = deps.settings.update(patch);
      return { target: Object.keys(patch).join(","), details: { patch }, body: next };
    }),
  );

  api.post(
    "/freeze/unfreeze",
    write("freeze.unfreeze", async (request) => {
      const body = parse(reasonSchema, request.body);
      const before = deps.freeze.state();
      if (!(await deps.freeze.unfreeze(`${body.reason} (by ${request.identity})`))) {
        throw new HttpError(409, "not_frozen");
      }
      return {
        target: null,
        details: { reason: body.reason, was: before.reason },
        body: deps.freeze.state(),
      };
    }),
  );

  api.post(
    "/review/:id",
    write(
      "review.decide",
      async (request) => {
        const id = paramId(request);
        const body = parse(reviewSchema, request.body);
        requireGroupOr404(db, id);
        const text = body.note === "" ? null : body.note;
        if (body.decision === "approve")
          approveReview(db, id, now(), body.offsetSeconds ?? 0, text);
        else rejectReview(db, id, now(), text);
        return {
          target: id,
          details: body,
          body: summary(db, requireGroupOr404(db, id)),
        };
      },
      paramId,
    ),
  );

  api.post(
    "/groups/:id/restore",
    write(
      "group.restore",
      async (request) => {
        const id = paramId(request);
        const body = parse(reasonSchema, request.body);
        requireGroupOr404(db, id);
        if (deps.machine === null) throw new HttpError(503, "strava_unavailable");
        const result = await deps.machine.restoreGroup(
          id,
          `${body.reason} (by ${request.identity})`,
        );
        return { target: id, details: { reason: body.reason, result }, body: result };
      },
      paramId,
    ),
  );

  api.patch(
    "/backfill",
    write("backfill.update", async (request) => {
      const body = parse(backfillUpdateSchema, request.body);
      const { confirm: _confirm, ...patch } = body;
      deps.settings.update({ backfill: patch });
      return { target: null, details: patch, body: backfillInfo() };
    }),
  );

  api.post(
    "/backfill/control",
    write("backfill.control", async (request) => {
      const { action } = parse(controlSchema, request.body);
      if (action === "pause") deps.settings.update({ backfill: { paused: true } });
      if (action === "resume") deps.settings.update({ backfill: { paused: false } });
      if (action === "reset") {
        if (deps.backfill === null) throw new HttpError(503, "strava_unavailable");
        deps.backfill.reset();
      }
      if (action === "start") {
        if (deps.backfill === null || deps.runBackfill === undefined) {
          throw new HttpError(503, "strava_unavailable");
        }
        if (deps.settings.get().backfill.mode === "off") {
          throw new HttpError(409, "backfill_off", "choose a backfill mode first");
        }
        deps.settings.update({ backfill: { paused: false } });
        deps.runBackfill();
      }
      return { target: null, details: { action }, body: backfillInfo() };
    }),
  );

  api.post(
    "/push/subscribe",
    write("push.subscribe", async (request) => {
      if (!deps.push.configured()) throw new HttpError(412, "push_not_configured");
      if (!isSubscription(request.body)) throw new HttpError(400, "invalid_subscription");
      const userAgent = request.headers["user-agent"] ?? null;
      const hash = deps.push.subscribe(request.body, userAgent);
      return { target: hash, details: null, body: { ok: true } };
    }),
  );

  api.post(
    "/push/unsubscribe",
    write("push.unsubscribe", async (request) => {
      const { endpoint } = parse(unsubscribeSchema, request.body);
      const removed = deps.push.unsubscribe(endpoint);
      return { target: endpointHash(endpoint), details: { removed }, body: { removed } };
    }),
  );

  api.post(
    "/push/test",
    write("push.test", async () => {
      if (!deps.push.configured()) throw new HttpError(412, "push_not_configured");
      const sent = await deps.push.sendAll({
        kind: "test",
        level: "info",
        title: "cameld test notification",
        body: "Push notifications work.",
        url: "/#/review",
        tag: "test",
        ts: now(),
      });
      return { target: null, details: sent, body: sent };
    }),
  );

  api.post(
    "/web/check",
    write("web.check", async () => {
      await deps.web.keepAlive();
      const status = deps.web.status();
      return { target: null, details: status, body: status };
    }),
  );
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof SettingsError) return new HttpError(400, "invalid_settings", error.message);
  if (error instanceof ReviewError) return new HttpError(409, "not_reviewable", error.message);
  if (error instanceof NotRestorableError)
    return new HttpError(409, "not_restorable", error.message);
  return new HttpError(500, "internal_error");
}
