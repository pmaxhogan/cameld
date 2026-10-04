import type {
  ApiSettings,
  ApiStatus,
  BackfillInfo,
  GroupDetail,
  GroupSummary,
  GroupTracks,
  ReviewItem,
} from "@cameld/shared";

/**
 * Fully synthetic UI fixtures. Coordinates sit around a made-up spot in the
 * open ocean (lng 0.5, lat 0.5); names and ids are invented.
 */

export function backfillInfo(over: Partial<BackfillInfo> = {}): BackfillInfo {
  return {
    mode: "off",
    paused: false,
    running: false,
    available: true,
    progress: { activities: 12, cursorMs: 1_000_000, done: false, readsToday: 34 },
    budget: {
      dailyReads: 500,
      fifteenMinuteReads: 40,
      dailyUsed: 34,
      fifteenMinuteUsed: 6,
      remaining: 34,
      limitedBy: "fifteen_minute",
    },
    lastBatch: null,
    ...over,
  };
}

export function apiStatus(over: Partial<ApiStatus> = {}): ApiStatus {
  return {
    version: "9.9.9",
    identity: "test-owner",
    frozen: { frozen: false, reason: null, evidence: null, frozenAt: null },
    web: { healthy: true, reason: null },
    browserAvailable: true,
    stravaConfigured: true,
    polling: true,
    rate: {
      overall: { fifteenMinute: { limit: 200, usage: 50 }, day: { limit: 2000, usage: 100 } },
      read: { fifteenMinute: { limit: 100, usage: 25 }, day: { limit: 1000, usage: 0 } },
    },
    backfill: backfillInfo(),
    counts: { done: 3, review: 1 },
    originals: { present: 10, pending: 0, unavailable: 0, backingOff: 0 },
    trial: { enabled: false, maxPairs: 3, used: 0 },
    push: { configured: false, publicKey: null, subscriptions: 0 },
    map: { styleUrl: null },
    ...over,
  };
}

export function settings(): ApiSettings {
  return {
    timing: {
      pollIntervalMs: 60_000,
      keepaliveIntervalMs: 600_000,
      partnerWaitMs: 4 * 3_600_000,
      gracePeriodMs: 48 * 3_600_000,
    },
    match: {
      autoMinOverlap: 0.8,
      maxStartDeltaSeconds: 600,
      gpsAutoMaxMedianMeters: 25,
      gpsReviewMaxMedianMeters: 100,
      alignment: {
        searchRangeSeconds: 120,
        stepSeconds: 1,
        sharpnessDeltaSeconds: 10,
        sharpnessRatio: 5,
        maxResidualMeters: 2,
        maxAutoOffsetSeconds: 15,
        minAlignedPoints: 10,
      },
    },
    merge: {
      speedLimitsMps: { walk: 7, hike: 7, run: 12, ride: 25 },
      defaultSpeedLimitMps: null,
      speedSlackMeters: 10,
      reanchorAfter: 30,
    },
    postUpload: { tolerance: 0.02, startToleranceSeconds: 5 },
    switches: { hide: false, delete: false, upload: true },
    trial: { enabled: false, maxPairs: 3 },
    backfill: {
      mode: "off",
      paused: false,
      dailyReads: 500,
      fifteenMinuteReads: 40,
      pageSize: 50,
    },
  };
}

export function group(over: Partial<GroupSummary> = {}): GroupSummary {
  return {
    id: "g-1",
    status: "review",
    path: "a",
    appIds: [101],
    fitbitIds: [202],
    startMs: 1_000_000,
    sportType: "Run",
    name: "Morning Run",
    parkedReason: "alignment_uncertain",
    mergedActivityId: null,
    deletedIds: [],
    hiddenAt: null,
    trial: false,
    photosFlagged: false,
    lastError: null,
    updatedAt: 2_000_000,
    ...over,
  };
}

export const MATCH = {
  decision: "review",
  reasons: ["alignment_uncertain", "gps_far"],
  metrics: {
    overlapRatio: 0.93,
    startDeltaSeconds: 12,
    proximity: { offsetSeconds: 3, medianMeters: 8.25, p90Meters: 20, pairs: 400 },
    alignment: { status: "uncertain", offsetSeconds: 0, bestOffsetSeconds: 3, sharpness: 1.234 },
  },
};

export function reviewItem(over: Partial<ReviewItem> = {}): ReviewItem {
  return { ...group(), match: MATCH, ...over };
}

export function tracks(over: Partial<GroupTracks> = {}): GroupTracks {
  return {
    app: {
      label: "app",
      coordinates: [
        [0.5, 0.5],
        [0.51, 0.52],
      ],
      points: 2,
    },
    fitbit: {
      label: "fitbit",
      coordinates: [
        [0.5, 0.501],
        [0.511, 0.52],
      ],
      points: 2,
    },
    merged: null,
    notes: ["merge preview unavailable"],
    ...over,
  };
}

export function groupDetail(over: Partial<GroupDetail> = {}): GroupDetail {
  return {
    group: group({ status: "done", mergedActivityId: 303 }),
    match: MATCH,
    members: [
      {
        id: 101,
        name: "Morning Run",
        sportType: "Run",
        source: "app",
        deviceName: "Phone",
        startMs: 1_000_000,
        endMs: 2_000_000,
        originalStatus: "present",
        goneAt: 3_000_000,
        restoredAs: null,
      },
    ],
    events: [
      { at: 1_500_000, from: null, to: "matched", event: "created", evidence: { score: 1 } },
      { at: 1_600_000, from: "matched", to: "done", event: "confirmed", evidence: undefined },
      { at: 1_700_000, from: "done", to: null, event: "note", evidence: null },
    ],
    writes: [
      {
        id: 1,
        kind: "upload",
        targetId: null,
        externalId: "cameld-merge-g-1",
        status: "done",
        result: null,
        createdAt: 1_550_000,
        completedAt: null,
      },
    ],
    restorable: true,
    mergeBuilt: false,
    ...over,
  };
}
