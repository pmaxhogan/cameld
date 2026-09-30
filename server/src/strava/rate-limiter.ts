/**
 * Strava rate limiter. Strava enforces an overall limit (default 200 per 15
 * minutes, 2000 per day) and a stricter read limit for GET requests (default
 * 100 per 15 minutes, 1000 per day). Windows reset at :00/:15/:30/:45 UTC and
 * at midnight UTC. A request that is rejected still counts, so callers wait
 * before spending the last few requests (the safety margin).
 */

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export type RequestKind = "read" | "write";

export interface WindowUsage {
  limit: number;
  usage: number;
}

export interface BucketUsage {
  fifteenMinute: WindowUsage;
  day: WindowUsage;
}

export interface RateLimitUsage {
  overall: BucketUsage;
  read: BucketUsage;
}

export interface RateLimiterOptions {
  clock?: Clock;
  /** Requests kept in reserve in every window. Default 5. */
  safetyMargin?: number;
  /** Called when the limiter is about to wait (for logging). */
  onWait?: (info: { ms: number; reason: string }) => void;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Window {
  limit: number;
  usage: number;
  /** Epoch ms of the window start the usage belongs to. */
  windowStart: number;
}

function parsePair(value: string | null | undefined): [number, number] | null {
  if (value === null || value === undefined) return null;
  const parts = value.split(",").map((part) => Number.parseInt(part.trim(), 10));
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return null;
  return [a, b];
}

export function nextFifteenMinuteBoundary(nowMs: number): number {
  return Math.floor(nowMs / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS + FIFTEEN_MIN_MS;
}

export function nextMidnightUtc(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS;
}

export class RateLimiter {
  readonly #clock: Clock;
  readonly #margin: number;
  readonly #onWait: ((info: { ms: number; reason: string }) => void) | undefined;
  readonly #windows: Record<"overall15" | "overallDay" | "read15" | "readDay", Window>;

  constructor(options: RateLimiterOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#margin = options.safetyMargin ?? 5;
    this.#onWait = options.onWait;
    const now = this.#clock.now();
    const w15 = Math.floor(now / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
    const wDay = Math.floor(now / DAY_MS) * DAY_MS;
    this.#windows = {
      overall15: { limit: 200, usage: 0, windowStart: w15 },
      overallDay: { limit: 2000, usage: 0, windowStart: wDay },
      read15: { limit: 100, usage: 0, windowStart: w15 },
      readDay: { limit: 1000, usage: 0, windowStart: wDay },
    };
  }

  #roll(): void {
    const now = this.#clock.now();
    const w15 = Math.floor(now / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
    const wDay = Math.floor(now / DAY_MS) * DAY_MS;
    for (const key of ["overall15", "read15"] as const) {
      const win = this.#windows[key];
      if (win.windowStart !== w15) {
        win.windowStart = w15;
        win.usage = 0;
      }
    }
    for (const key of ["overallDay", "readDay"] as const) {
      const win = this.#windows[key];
      if (win.windowStart !== wDay) {
        win.windowStart = wDay;
        win.usage = 0;
      }
    }
  }

  #blocked(win: Window): boolean {
    return win.usage + this.#margin >= win.limit;
  }

  /** Milliseconds to wait before a request of this kind may be sent (0 = go). */
  #waitMs(kind: RequestKind): { ms: number; reason: string } {
    this.#roll();
    const now = this.#clock.now();
    const w = this.#windows;
    let until = 0;
    let reason = "";
    const consider = (win: Window, resetAt: number, label: string): void => {
      if (this.#blocked(win) && resetAt > until) {
        until = resetAt;
        reason = label;
      }
    };
    consider(w.overall15, nextFifteenMinuteBoundary(now), "overall 15-minute limit");
    consider(w.overallDay, nextMidnightUtc(now), "overall daily limit");
    if (kind === "read") {
      consider(w.read15, nextFifteenMinuteBoundary(now), "read 15-minute limit");
      consider(w.readDay, nextMidnightUtc(now), "read daily limit");
    }
    return { ms: until === 0 ? 0 : Math.max(until - now, 1), reason };
  }

  /**
   * Wait until a request may be sent, then reserve a slot for it. Reads count
   * toward both the overall and the read budgets; writes toward overall only.
   */
  async acquire(kind: RequestKind): Promise<void> {
    for (;;) {
      const { ms, reason } = this.#waitMs(kind);
      if (ms === 0) break;
      this.#onWait?.({ ms, reason });
      await this.#clock.sleep(ms);
    }
    const w = this.#windows;
    w.overall15.usage += 1;
    w.overallDay.usage += 1;
    if (kind === "read") {
      w.read15.usage += 1;
      w.readDay.usage += 1;
    }
  }

  /** Adopt Strava's own view of usage and limits from response headers. */
  update(headers: { get(name: string): string | null }): void {
    this.#roll();
    const w = this.#windows;
    const apply = (limitHeader: string, usageHeader: string, w15: Window, wDay: Window): void => {
      const limit = parsePair(headers.get(limitHeader));
      const usage = parsePair(headers.get(usageHeader));
      if (limit !== null) {
        w15.limit = limit[0];
        wDay.limit = limit[1];
      }
      if (usage !== null) {
        w15.usage = usage[0];
        wDay.usage = usage[1];
      }
    };
    apply("x-ratelimit-limit", "x-ratelimit-usage", w.overall15, w.overallDay);
    apply("x-readratelimit-limit", "x-readratelimit-usage", w.read15, w.readDay);
  }

  /**
   * A 429 means a window is exhausted whatever our counters said. Treat the
   * 15-minute windows as full so the next acquire waits for the boundary. If
   * the daily counters already show exhaustion the daily wait applies.
   */
  markRateLimited(kind: RequestKind): void {
    this.#roll();
    const w = this.#windows;
    w.overall15.usage = Math.max(w.overall15.usage, w.overall15.limit);
    if (kind === "read") w.read15.usage = Math.max(w.read15.usage, w.read15.limit);
  }

  /** Current usage, for metrics. */
  usage(): RateLimitUsage {
    this.#roll();
    const w = this.#windows;
    const bucket = (a: Window, b: Window): BucketUsage => ({
      fifteenMinute: { limit: a.limit, usage: a.usage },
      day: { limit: b.limit, usage: b.usage },
    });
    return {
      overall: bucket(w.overall15, w.overallDay),
      read: bucket(w.read15, w.readDay),
    };
  }
}
