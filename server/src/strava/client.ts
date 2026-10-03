import type { Logger } from "../logging.ts";
import { type Clock, type RateLimiter, type RequestKind, systemClock } from "./rate-limiter.ts";
import {
  type CreateUploadParams,
  type ListActivitiesParams,
  STREAM_KEYS,
  type StravaAthlete,
  type StravaComment,
  type StravaDetailedActivity,
  type StravaKudoer,
  type StravaLap,
  type StravaPhoto,
  type StravaStreams,
  type StravaSummaryActivity,
  type StravaUpload,
  type StreamKey,
  type UpdateActivityFields,
  type UploadResult,
} from "./types.ts";

export class StravaApiError extends Error {
  override readonly name: string = "StravaApiError";
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, detail: string) {
    super(`Strava API ${status} on ${path}${detail === "" ? "" : `: ${detail}`}`);
    this.status = status;
    this.path = path;
  }
}

export class StravaRateLimitedError extends StravaApiError {
  override readonly name = "StravaRateLimitedError";
}

export class UploadTimeoutError extends Error {
  override readonly name = "UploadTimeoutError";
  readonly uploadId: number;
  constructor(uploadId: number) {
    super(`Strava upload ${uploadId} was still processing when polling stopped`);
    this.uploadId = uploadId;
  }
}

export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
}

export interface StravaClientOptions {
  tokens: AccessTokenSource;
  limiter: RateLimiter;
  fetch?: typeof fetch;
  baseUrl?: string;
  clock?: Clock;
  logger?: Logger;
  /** Retries after a 429 (each waits for the window to reset). Default 1. */
  maxRateLimitRetries?: number;
}

export interface PollOptions {
  /** Poll interval, never below 1000 ms. Default 1000. */
  intervalMs?: number;
  /** Give up after this long. Default 120000. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://www.strava.com/api/v3";
/** Plain form: "... duplicate of activity 123". */
const DUPLICATE_PLAIN = /duplicate of activity (\d+)/i;
/**
 * HTML form Strava really sends: "... duplicate of <a href='/activities/123'
 * ...>Evening Walk</a>". The id comes from the href (quoted either way, with
 * or without an origin), never from the link text.
 */
const DUPLICATE_LINK =
  /duplicate of\s*<a\b[^>]*?\bhref\s*=\s*["']?(?:https?:\/\/[^/"'\s>]+)?\/activities\/(\d+)/i;

function toId(digits: string): number | null {
  const id = Number.parseInt(digits, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Extract the existing activity id from an upload duplicate error, in either
 * form Strava uses: plain text ("duplicate of activity 123") or an HTML link
 * ("duplicate of <a href='/activities/123'>Evening Walk</a>").
 */
export function parseDuplicateOf(error: string | null | undefined): number | null {
  if (error === null || error === undefined) return null;
  const match = DUPLICATE_LINK.exec(error) ?? DUPLICATE_PLAIN.exec(error);
  return match === null ? null : toId(match[1] as string);
}

/** Classify a finished upload. Returns null while Strava is still processing it. */
export function classifyUpload(upload: StravaUpload): UploadResult | null {
  const error = upload.error ?? null;
  if (error !== null && error !== "") {
    const duplicateOf = parseDuplicateOf(error);
    if (duplicateOf !== null) {
      return { kind: "duplicate", uploadId: upload.id, duplicateOf, error, upload };
    }
    return { kind: "error", uploadId: upload.id, error, upload };
  }
  if (upload.activity_id !== null && upload.activity_id !== undefined) {
    return { kind: "ready", uploadId: upload.id, activityId: upload.activity_id, upload };
  }
  return null;
}

type Query = Record<string, string | number | boolean | undefined>;

export class StravaClient {
  readonly #opts: StravaClientOptions;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #clock: Clock;

  constructor(options: StravaClientOptions) {
    this.#opts = options;
    this.#fetch = options.fetch ?? fetch;
    this.#base = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#clock = options.clock ?? systemClock;
  }

  async #request<T>(
    method: string,
    path: string,
    init: { query?: Query; body?: string | FormData; contentType?: string } = {},
  ): Promise<T> {
    const kind: RequestKind = method === "GET" ? "read" : "write";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.size === 0 ? "" : `?${params.toString()}`;
    const url = `${this.#base}${path}${qs}`;
    const retries = this.#opts.maxRateLimitRetries ?? 1;
    for (let attempt = 0; ; attempt += 1) {
      await this.#opts.limiter.acquire(kind);
      const token = await this.#opts.tokens.getAccessToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      };
      if (init.contentType !== undefined) headers["content-type"] = init.contentType;
      const response = await this.#fetch(url, { method, headers, body: init.body ?? null });
      this.#opts.limiter.update(response.headers);
      if (response.status === 429) {
        this.#opts.limiter.markRateLimited(kind);
        this.#opts.logger?.warn({ path }, "strava rate limit hit");
        await response.body?.cancel();
        if (attempt < retries) continue;
        throw new StravaRateLimitedError(429, path, "rate limit exceeded");
      }
      if (!response.ok) {
        const detail = await response.text().then(
          (text) => text.slice(0, 300),
          () => "",
        );
        throw new StravaApiError(response.status, path, detail);
      }
      return (await response.json()) as T;
    }
  }

  #get<T>(path: string, query?: Query): Promise<T> {
    return this.#request<T>("GET", path, query === undefined ? {} : { query });
  }

  getAthlete(): Promise<StravaAthlete> {
    return this.#get("/athlete");
  }

  listActivities(params: ListActivitiesParams = {}): Promise<StravaSummaryActivity[]> {
    return this.#get("/athlete/activities", { ...params });
  }

  getActivity(id: number, includeAllEfforts = false): Promise<StravaDetailedActivity> {
    return this.#get(`/activities/${id}`, { include_all_efforts: includeAllEfforts });
  }

  getStreams(id: number, keys: readonly StreamKey[] = STREAM_KEYS): Promise<StravaStreams> {
    return this.#get(`/activities/${id}/streams`, { keys: keys.join(","), key_by_type: true });
  }

  getActivityPhotos(id: number, size = 2048): Promise<StravaPhoto[]> {
    return this.#get(`/activities/${id}/photos`, { photo_sources: true, size });
  }

  getKudoers(id: number): Promise<StravaKudoer[]> {
    return this.#get(`/activities/${id}/kudos`);
  }

  getComments(id: number): Promise<StravaComment[]> {
    return this.#get(`/activities/${id}/comments`);
  }

  getLaps(id: number): Promise<StravaLap[]> {
    return this.#get(`/activities/${id}/laps`);
  }

  updateActivity(id: number, fields: UpdateActivityFields): Promise<StravaDetailedActivity> {
    return this.#request("PUT", `/activities/${id}`, {
      body: JSON.stringify(fields),
      contentType: "application/json",
    });
  }

  createUpload(params: CreateUploadParams): Promise<StravaUpload> {
    const form = new FormData();
    form.set("data_type", params.data_type);
    form.set("external_id", params.external_id);
    if (params.name !== undefined) form.set("name", params.name);
    if (params.description !== undefined) form.set("description", params.description);
    const filename = params.filename ?? `${params.external_id}.${params.data_type}`;
    form.set("file", new Blob([params.file as Uint8Array<ArrayBuffer>]), filename);
    return this.#request("POST", "/uploads", { body: form });
  }

  getUpload(id: number): Promise<StravaUpload> {
    return this.#get(`/uploads/${id}`);
  }

  /**
   * Poll an upload until Strava finishes or refuses it. A duplicate refusal is
   * returned as a typed result, not thrown. Throws UploadTimeoutError if it is
   * still processing when the timeout passes.
   */
  async waitForUpload(initial: StravaUpload, options: PollOptions = {}): Promise<UploadResult> {
    const interval = Math.max(options.intervalMs ?? 1000, 1000);
    const timeout = options.timeoutMs ?? 120_000;
    const deadline = this.#clock.now() + timeout;
    let upload = initial;
    for (;;) {
      const done = classifyUpload(upload);
      if (done !== null) return done;
      if (this.#clock.now() + interval > deadline) throw new UploadTimeoutError(upload.id);
      await this.#clock.sleep(interval);
      upload = await this.getUpload(upload.id);
    }
  }

  /** Create an upload and wait for the outcome. */
  async uploadAndWait(
    params: CreateUploadParams,
    options: PollOptions = {},
  ): Promise<UploadResult> {
    return this.waitForUpload(await this.createUpload(params), options);
  }
}
