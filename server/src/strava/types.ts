import type { StravaId } from "@cameld/shared";

/**
 * Typed subset of the Strava v3 API that cameld uses. Ids are decimal strings:
 * the client parses every body with parseStravaJson (json.ts), which never
 * turns an id into a (rounding) JavaScript number.
 */

export interface StravaAthlete {
  id: StravaId;
  id_str?: string;
  username?: string | null;
  firstname?: string;
  lastname?: string;
  [key: string]: unknown;
}

export interface StravaSummaryActivity {
  id: StravaId;
  id_str?: string;
  athlete?: { id?: StravaId; [key: string]: unknown };
  name: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  device_name?: string;
  external_id?: string | null;
  trainer?: boolean;
  commute?: boolean;
  gear_id?: string | null;
  [key: string]: unknown;
}

export interface StravaDetailedActivity extends StravaSummaryActivity {
  description?: string | null;
  private_note?: string | null;
  photo_count?: number;
  /** True for a manual entry (no recorded file). */
  manual?: boolean;
  /** Null when the activity was not created from an upload. */
  upload_id?: StravaId | null;
  laps?: StravaLap[];
  segment_efforts?: unknown[];
}

export interface StravaLap {
  id: StravaId;
  name?: string;
  elapsed_time: number;
  moving_time?: number;
  start_index?: number;
  end_index?: number;
  distance?: number;
  [key: string]: unknown;
}

export const STREAM_KEYS = [
  "time",
  "distance",
  "latlng",
  "altitude",
  "velocity_smooth",
  "heartrate",
  "cadence",
  "watts",
  "temp",
  "moving",
  "grade_smooth",
] as const;

export type StreamKey = (typeof STREAM_KEYS)[number];

export interface StravaStream<T = number | boolean | [number, number]> {
  data: T[];
  series_type?: string;
  original_size?: number;
  resolution?: string;
}

export type StravaStreams = Partial<Record<StreamKey, StravaStream>>;

export interface StravaPhoto {
  unique_id?: string;
  urls?: Record<string, string>;
  [key: string]: unknown;
}

export interface StravaKudoer {
  firstname?: string;
  lastname?: string;
  [key: string]: unknown;
}

export interface StravaComment {
  id: StravaId;
  text: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface ListActivitiesParams {
  /** Epoch seconds. */
  after?: number;
  /** Epoch seconds. */
  before?: number;
  page?: number;
  per_page?: number;
}

export interface UpdateActivityFields {
  name?: string;
  description?: string;
  sport_type?: string;
  commute?: boolean;
  trainer?: boolean;
  gear_id?: string;
  hide_from_home?: boolean;
}

export type UploadDataType = "fit" | "fit.gz" | "tcx" | "tcx.gz" | "gpx" | "gpx.gz";

export interface CreateUploadParams {
  file: Uint8Array;
  data_type: UploadDataType;
  external_id: string;
  name?: string;
  description?: string;
  /** File name sent with the multipart body. Defaults to external_id.data_type. */
  filename?: string;
}

export interface StravaUpload {
  id: StravaId;
  id_str?: string;
  external_id?: string | null;
  error?: string | null;
  status?: string;
  activity_id?: StravaId | null;
}

/** Outcome of an upload once Strava has finished (or refused) processing it. */
export type UploadResult =
  | { kind: "ready"; uploadId: StravaId; activityId: StravaId; upload: StravaUpload }
  | {
      kind: "duplicate";
      uploadId: StravaId;
      /** The existing activity Strava says this upload duplicates. */
      duplicateOf: StravaId;
      error: string;
      upload: StravaUpload;
    }
  | { kind: "error"; uploadId: StravaId; error: string; upload: StravaUpload };
