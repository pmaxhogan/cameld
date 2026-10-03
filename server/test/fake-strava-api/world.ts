import { gunzipSync } from "node:zlib";
import {
  type ActivitySample,
  readFitActivity,
  readGpxActivity,
  readTcxActivity,
} from "@cameld/shared";
import { mergeFigures } from "../../src/state/build.ts";
import type { Visibility } from "../../src/web/forms.ts";

/**
 * The state of a fake Strava, shared by the fake API server (server.ts) and
 * the in-memory fake web session (web-session.ts). SYNTHETIC data only: the
 * fixtures that fill it are generated around the fictional origin lat 0.5,
 * lng 0.5 (open ocean) with made-up ids and names.
 *
 * Upload processing mirrors what was observed live: an upload that overlaps
 * an existing activity in time is rejected as a duplicate, and the error is
 * HTML naming the Strava app copy: `duplicate of <a href='/activities/N'>`.
 */

export const FAKE_ATHLETE_ID = 515151;

export interface WorldPhoto {
  uniqueId: string;
  bytes: Buffer;
  createdAt: string;
}

export interface WorldActivity {
  id: number;
  name: string;
  description: string | null;
  sportType: string;
  startMs: number;
  elapsedSeconds: number;
  distance: number;
  deviceName: string | null;
  externalId: string | null;
  gearId: string | null;
  commute: boolean;
  trainer: boolean;
  hideFromHome: boolean;
  privateNote: string;
  visibility: Visibility;
  perceivedExertion: number | null;
  preferPerceivedExertion: boolean;
  photos: WorldPhoto[];
  kudos: { firstname: string; lastname: string }[];
  comments: { id: number; text: string }[];
  original: { filename: string; bytes: Buffer } | null;
  samples: ActivitySample[];
  exists: boolean;
}

export interface WorldUpload {
  id: number;
  externalId: string;
  status: "processing" | "ready" | "error";
  error: string | null;
  activityId: number | null;
  /** Polls left before the upload leaves "processing". */
  pollsLeft: number;
}

export type DuplicatePolicy = (incoming: {
  startMs: number;
  endMs: number;
  externalId: string;
}) => number | null;

export function parseUploaded(bytes: Buffer, dataType: string): ActivitySample[] {
  const raw = dataType.endsWith(".gz") ? gunzipSync(bytes) : bytes;
  const format = dataType.replace(".gz", "");
  if (format === "fit") return readFitActivity(new Uint8Array(raw), { source: "upload" }).samples;
  const text = raw.toString("utf8");
  return format === "tcx"
    ? readTcxActivity(text, { source: "upload" }).samples
    : readGpxActivity(text, { source: "upload" }).samples;
}

export class FakeWorld {
  readonly activities = new Map<number, WorldActivity>();
  readonly uploads = new Map<number, WorldUpload>();
  nextActivityId = 9_400_001;
  nextUploadId = 77_000_001;
  /** Polls an upload stays "processing". */
  processingPolls = 1;
  /** Multiplies the distance Strava reports for uploads (tolerance tests). */
  uploadDistanceFactor = 1;
  /** Drop heart rate from uploaded activities' streams (tolerance tests). */
  dropUploadHeartRate = false;
  /** Reject every upload with this processing error. */
  uploadError: string | null = null;
  /** Decides duplicates. Default: the live rule (see module comment). */
  duplicatePolicy: DuplicatePolicy = (incoming) => this.defaultDuplicate(incoming);
  /** Hook called before every API request is handled (for intent-ordering assertions). */
  onRequest: ((method: string, path: string) => void) | undefined;
  readonly requests: { method: string; path: string }[] = [];
  /** Answer a request with this HTTP status instead (null = handle normally). */
  failStatus: ((method: string, path: string) => number | null) | undefined;
  /** Another fake (the strava.com web pages) may delete activities too. */
  goneElsewhere: ((id: number) => boolean) | undefined;
  /** Called for every activity an upload creates. */
  onCreated: ((activity: WorldActivity) => void) | undefined;
  /** Replace the streams answer for an activity (tolerance tests). */
  streamsOverride: ((id: number) => unknown) | undefined;

  /** The live rule: same external id, or overlapping time; names the app copy first. */
  defaultDuplicate(incoming: {
    startMs: number;
    endMs: number;
    externalId: string;
  }): number | null {
    const live = this.live();
    const same = live.find((a) => a.externalId === incoming.externalId);
    if (same !== undefined) return same.id;
    const overlapping = live.filter(
      (a) => a.startMs < incoming.endMs && incoming.startMs < a.startMs + a.elapsedSeconds * 1000,
    );
    const app = overlapping.find((a) => a.deviceName === "Strava App");
    return (app ?? overlapping[0])?.id ?? null;
  }

  add(activity: Partial<WorldActivity> & Pick<WorldActivity, "name" | "sportType">): WorldActivity {
    const samples = activity.samples ?? [];
    const figures = mergeFigures(samples);
    const full: WorldActivity = {
      id: activity.id ?? this.nextActivityId++,
      description: null,
      startMs: figures.startMs,
      elapsedSeconds: figures.elapsedSeconds,
      distance: figures.distanceMeters,
      deviceName: null,
      externalId: null,
      gearId: null,
      commute: false,
      trainer: false,
      hideFromHome: false,
      privateNote: "",
      visibility: "everyone",
      perceivedExertion: null,
      preferPerceivedExertion: false,
      photos: [],
      kudos: [],
      comments: [],
      original: null,
      exists: true,
      ...activity,
      samples,
    };
    this.activities.set(full.id, full);
    return full;
  }

  get(id: number): WorldActivity | undefined {
    const activity = this.activities.get(id);
    return activity?.exists === true && this.goneElsewhere?.(id) !== true ? activity : undefined;
  }

  live(): WorldActivity[] {
    return [...this.activities.values()].filter((a) => this.get(a.id) !== undefined);
  }

  createUpload(input: {
    bytes: Buffer;
    dataType: string;
    externalId: string;
    name: string | null;
    filename: string;
  }): WorldUpload {
    const id = this.nextUploadId++;
    const upload: WorldUpload = {
      id,
      externalId: input.externalId,
      status: "processing",
      error: null,
      activityId: null,
      pollsLeft: this.processingPolls,
    };
    this.uploads.set(id, upload);
    let samples: ActivitySample[];
    try {
      samples = parseUploaded(input.bytes, input.dataType);
    } catch {
      upload.status = "error";
      upload.error = "There was an error processing your activity.";
      return upload;
    }
    const figures = mergeFigures(samples);
    const endMs = figures.startMs + figures.elapsedSeconds * 1000;
    const duplicateOf = this.duplicatePolicy({
      startMs: figures.startMs,
      endMs,
      externalId: input.externalId,
    });
    if (this.uploadError !== null) {
      upload.status = "error";
      upload.error = this.uploadError;
    } else if (duplicateOf !== null) {
      const existing = this.activities.get(duplicateOf);
      upload.status = "error";
      upload.error = `${input.filename} duplicate of <a href='/activities/${duplicateOf}' target='_blank'>${existing?.name ?? "Activity"}</a>`;
    } else {
      const activity = this.add({
        name: input.name ?? "Synthetic Upload",
        sportType: "Workout",
        externalId: input.externalId,
        original: { filename: input.filename, bytes: input.bytes },
        samples: this.dropUploadHeartRate
          ? samples.map(({ heartRate: _hr, ...rest }) => rest)
          : samples,
      });
      activity.distance *= this.uploadDistanceFactor;
      this.onCreated?.(activity);
      upload.status = "ready";
      upload.activityId = activity.id;
    }
    return upload;
  }

  /** What GET /uploads/:id answers (advancing processing by one poll). */
  pollUpload(id: number): WorldUpload | undefined {
    const upload = this.uploads.get(id);
    if (upload !== undefined && upload.pollsLeft > 0) upload.pollsLeft -= 1;
    return upload;
  }

  uploadsWithExternalId(externalId: string): WorldUpload[] {
    return [...this.uploads.values()].filter((u) => u.externalId === externalId);
  }
}
