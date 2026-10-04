import type { MatchSettings } from "./match/settings.ts";
import type { MergeSettings } from "./merge/merger.ts";

/**
 * Typed contract between the server's /api routes and the web UI. Types and
 * a few constants only: nothing here runs on import.
 *
 * Every state-changing request carries CSRF_HEADER: CSRF_HEADER_VALUE (or an
 * Origin equal to the public origin). Every write route is audited.
 */

export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_VALUE = "cameld";

/** Typed back by the owner before deletion (or the deletion trial) is switched on. */
export const DELETE_CONFIRM_PHRASE = "delete originals";

export const BACKFILL_MODES = ["off", "backup_only", "dry_run", "live"] as const;
export type BackfillMode = (typeof BACKFILL_MODES)[number];

export interface ApiSettings {
  timing: {
    pollIntervalMs: number;
    keepaliveIntervalMs: number;
    partnerWaitMs: number;
    gracePeriodMs: number;
  };
  match: Omit<MatchSettings, "partnerWaitMs">;
  merge: MergeSettings;
  postUpload: { tolerance: number; startToleranceSeconds: number };
  switches: { hide: boolean; delete: boolean; upload: boolean };
  trial: { enabled: boolean; maxPairs: number };
  backfill: {
    mode: BackfillMode;
    /** Pauses the backfill between activities without changing the mode. */
    paused: boolean;
    dailyReads: number;
    fifteenMinuteReads: number;
    pageSize: number;
  };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

/** PATCH /api/settings body. `confirm` must equal DELETE_CONFIRM_PHRASE to enable deletion. */
export interface SettingsUpdate {
  patch: DeepPartial<ApiSettings>;
  confirm?: string;
}

export interface WindowUsage {
  limit: number;
  usage: number;
}

export interface RateUsage {
  overall: { fifteenMinute: WindowUsage; day: WindowUsage };
  read: { fifteenMinute: WindowUsage; day: WindowUsage };
}

export interface FreezeInfo {
  frozen: boolean;
  reason: string | null;
  evidence: unknown;
  frozenAt: number | null;
}

export interface BackfillProgressInfo {
  activities: number;
  cursorMs: number | null;
  done: boolean;
  readsToday: number;
}

/** One of cameld's own backfill read caps (not Strava's app-wide limits). */
export type BudgetWindow = "daily" | "fifteen_minute";

export interface BackfillInfo {
  mode: BackfillMode;
  paused: boolean;
  running: boolean;
  /** False when Strava is not configured: start is unavailable. */
  available: boolean;
  progress: BackfillProgressInfo;
  /**
   * cameld's own read budget for the backfill (settings.backfill caps), as
   * opposed to `ApiStatus.rate`, which is Strava's app-wide usage across every
   * consumer of the shared Strava app.
   */
  budget: {
    /** Cap per UTC day. */
    dailyReads: number;
    /** Cap per 15-minute window. */
    fifteenMinuteReads: number;
    /** Reads spent today (the same count as progress.readsToday). */
    dailyUsed: number;
    /** Reads spent in the current 15-minute window. */
    fifteenMinuteUsed: number;
    /** Reads allowed right now: the smaller of the two windows' headroom. */
    remaining: number;
    /** The window that sets `remaining` (the one with less headroom). */
    limitedBy: BudgetWindow;
  };
  lastBatch: BackfillBatchInfo | null;
}

export interface BackfillBatchInfo {
  mode: BackfillMode;
  /** off, paused, budget, rate_limited, done, error or running. */
  stopped: string;
  /** With stopped "budget": which of cameld's caps ran out. */
  budgetLimit: BudgetWindow | null;
  activities: number;
  groups: number;
  error: string | null;
  finishedAt: number;
}

/** Original uploaded files of live activities, by status. */
export interface OriginalsInfo {
  present: number;
  /** Not exported yet (includes backingOff). */
  pending: number;
  /** Strava has no original (manual entries): backed up from streams, never deleted. */
  unavailable: number;
  /** Pending activities waiting out a retry backoff after a failed export. */
  backingOff: number;
}

/** GET /api/status */
export interface ApiStatus {
  version: string;
  identity: string;
  frozen: FreezeInfo;
  web: { healthy: boolean; reason: string | null };
  /** True when BROWSER_VNC_URL is configured (the Strava login panel can embed it). */
  browserAvailable: boolean;
  stravaConfigured: boolean;
  polling: boolean;
  rate: RateUsage | null;
  backfill: BackfillInfo;
  counts: Record<string, number>;
  originals: OriginalsInfo;
  trial: { enabled: boolean; maxPairs: number; used: number };
  push: { configured: boolean; publicKey: string | null; subscriptions: number };
  map: { styleUrl: string | null };
}

export interface GroupSummary {
  id: string;
  status: string;
  path: string | null;
  appIds: number[];
  fitbitIds: number[];
  startMs: number;
  sportType: string | null;
  name: string | null;
  parkedReason: string | null;
  mergedActivityId: number | null;
  deletedIds: number[];
  hiddenAt: number | null;
  trial: boolean;
  photosFlagged: boolean;
  lastError: string | null;
  updatedAt: number;
}

export interface ReviewItem extends GroupSummary {
  /** Match summary (decision, reasons, metrics) recorded when the group was scored. */
  match: unknown;
}

export interface GroupEventInfo {
  at: number;
  from: string | null;
  to: string | null;
  event: string;
  evidence: unknown;
}

export interface WriteInfo {
  id: number;
  kind: string;
  targetId: number | null;
  /** The upload's external_id (uploads have no target activity yet). */
  externalId: string | null;
  status: string;
  result: unknown;
  createdAt: number;
  completedAt: number | null;
}

export interface MemberInfo {
  id: number;
  name: string | null;
  sportType: string | null;
  source: string;
  deviceName: string | null;
  startMs: number;
  endMs: number;
  originalStatus: string;
  goneAt: number | null;
  restoredAs: number | null;
}

/** GET /api/groups/:id */
export interface GroupDetail {
  group: GroupSummary;
  match: unknown;
  members: MemberInfo[];
  events: GroupEventInfo[];
  writes: WriteInfo[];
  /** Whether the restore action is allowed for this group's status. */
  restorable: boolean;
  /** True once the merged FIT is built and stored in the backup (tracks can be compared). */
  mergeBuilt: boolean;
}

/** [lng, lat] pairs, as MapLibre wants them. */
export type LngLat = [number, number];

export interface TrackLine {
  label: string;
  coordinates: LngLat[];
  points: number;
}

/** GET /api/groups/:id/tracks */
export interface GroupTracks {
  app: TrackLine | null;
  fitbit: TrackLine | null;
  merged: TrackLine | null;
  /** Why a line is missing (no original in backup, merge preview failed). */
  notes: string[];
}

export interface ReviewDecision {
  decision: "approve" | "reject";
  note: string;
  /** Clock offset to apply on approve, seconds. */
  offsetSeconds?: number;
}

export interface UnfreezeRequest {
  reason: string;
}

export interface RestoreRequest {
  reason: string;
}

export interface RestoreResult {
  groupId: string;
  status: string;
  restored: { id: number; outcome: string; newId: number | null; flags: string[] }[];
  unhidden: number[];
  flags: string[];
}

export interface BackfillControl {
  action: "start" | "pause" | "resume" | "reset";
}

export interface BackfillUpdate {
  mode?: BackfillMode;
  dailyReads?: number;
  fifteenMinuteReads?: number;
  confirm?: string;
}

export interface DryRunEntryInfo {
  groupKey: string;
  startMs: number;
  decision: string;
  report: unknown;
}

/** GET /api/backfill/report */
export interface BackfillReport {
  generatedAt: number;
  progress: BackfillProgressInfo;
  groups: DryRunEntryInfo[];
}

export interface PushSubscriptionBody {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface PushSendSummary {
  configured: boolean;
  total: number;
  sent: number;
  failed: number;
  removed: number;
}

/** Payload of every Web Push message (the service worker reads it). */
export interface PushPayload {
  kind: string;
  level: "info" | "warning" | "critical";
  title: string;
  body: string;
  url: string;
  tag: string;
  ts: number;
}

export interface AuditEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  outcome: string;
  details: unknown;
}

export interface ApiError {
  error: string;
  detail?: string;
}
