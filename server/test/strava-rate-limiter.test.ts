import { describe, expect, it } from "vitest";
import {
  type Clock,
  RateLimiter,
  nextFifteenMinuteBoundary,
  nextMidnightUtc,
  systemClock,
} from "../src/strava/rate-limiter.ts";
import { fakeClock } from "./strava-helpers.ts";

function headers(map: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => map[name.toLowerCase()] ?? null };
}

describe("boundaries", () => {
  it("finds the next quarter hour and midnight in UTC", () => {
    expect(nextFifteenMinuteBoundary(Date.parse("2030-01-01T10:07:30Z"))).toBe(
      Date.parse("2030-01-01T10:15:00Z"),
    );
    expect(nextFifteenMinuteBoundary(Date.parse("2030-01-01T10:45:00Z"))).toBe(
      Date.parse("2030-01-01T11:00:00Z"),
    );
    expect(nextMidnightUtc(Date.parse("2030-01-01T23:59:59Z"))).toBe(
      Date.parse("2030-01-02T00:00:00Z"),
    );
  });
});

describe("RateLimiter", () => {
  it("counts reads against both budgets and writes against overall only", async () => {
    const limiter = new RateLimiter({ clock: fakeClock("2030-01-01T10:00:00Z") });
    await limiter.acquire("read");
    await limiter.acquire("write");
    const u = limiter.usage();
    expect(u.overall.fifteenMinute).toEqual({ limit: 200, usage: 2 });
    expect(u.overall.day).toEqual({ limit: 2000, usage: 2 });
    expect(u.read.fifteenMinute).toEqual({ limit: 100, usage: 1 });
    expect(u.read.day).toEqual({ limit: 1000, usage: 1 });
  });

  it("adopts header limits and usage", () => {
    const limiter = new RateLimiter({ clock: fakeClock("2030-01-01T10:00:00Z") });
    limiter.update(
      headers({
        "x-ratelimit-limit": "300,3000",
        "x-ratelimit-usage": "12,340",
        "x-readratelimit-limit": "120, 1200",
        "x-readratelimit-usage": "7,80",
      }),
    );
    const u = limiter.usage();
    expect(u.overall.fifteenMinute).toEqual({ limit: 300, usage: 12 });
    expect(u.overall.day).toEqual({ limit: 3000, usage: 340 });
    expect(u.read.fifteenMinute).toEqual({ limit: 120, usage: 7 });
    expect(u.read.day).toEqual({ limit: 1200, usage: 80 });
  });

  it("ignores missing or malformed headers", () => {
    const limiter = new RateLimiter({ clock: fakeClock("2030-01-01T10:00:00Z") });
    limiter.update(headers({ "x-ratelimit-usage": "abc,def", "x-readratelimit-limit": "5" }));
    limiter.update(headers({}));
    expect(limiter.usage().overall.fifteenMinute).toEqual({ limit: 200, usage: 0 });
    expect(limiter.usage().read.fifteenMinute.limit).toBe(100);
  });

  it("waits for the next quarter hour when the read window is exhausted", async () => {
    const clock = fakeClock("2030-01-01T10:07:30Z");
    const waits: string[] = [];
    const limiter = new RateLimiter({
      clock,
      safetyMargin: 2,
      onWait: (info) => waits.push(info.reason),
    });
    limiter.update(headers({ "x-readratelimit-usage": "98,500" }));
    await limiter.acquire("read");
    expect(clock.t).toBe(Date.parse("2030-01-01T10:15:00Z"));
    expect(waits).toEqual(["read 15-minute limit"]);
    expect(limiter.usage().read.fifteenMinute.usage).toBe(1);
  });

  it("lets writes through when only the read window is exhausted", async () => {
    const clock = fakeClock("2030-01-01T10:07:30Z");
    const limiter = new RateLimiter({ clock, safetyMargin: 0 });
    limiter.update(headers({ "x-readratelimit-usage": "100,500" }));
    await limiter.acquire("write");
    expect(clock.sleeps).toEqual([]);
  });

  it("waits for midnight UTC when the daily budget is exhausted", async () => {
    const clock = fakeClock("2030-01-01T22:10:00Z");
    const limiter = new RateLimiter({ clock, safetyMargin: 0 });
    limiter.update(headers({ "x-ratelimit-usage": "10,2000" }));
    await limiter.acquire("write");
    expect(clock.t).toBe(Date.parse("2030-01-02T00:00:00Z"));
    expect(limiter.usage().overall.day.usage).toBe(1);
  });

  it("picks the later reset when both windows are exhausted", async () => {
    const clock = fakeClock("2030-01-01T22:10:00Z");
    const limiter = new RateLimiter({ clock, safetyMargin: 0 });
    limiter.update(
      headers({ "x-ratelimit-usage": "200,2000", "x-readratelimit-usage": "100,1000" }),
    );
    await limiter.acquire("read");
    expect(clock.t).toBe(Date.parse("2030-01-02T00:00:00Z"));
  });

  it("honors the safety margin", async () => {
    const clock = fakeClock("2030-01-01T10:00:00Z");
    const limiter = new RateLimiter({ clock, safetyMargin: 10 });
    limiter.update(headers({ "x-ratelimit-usage": "189,500" }));
    await limiter.acquire("write");
    expect(clock.sleeps).toEqual([]);
    await limiter.acquire("write");
    expect(clock.t).toBe(Date.parse("2030-01-01T10:15:00Z"));
  });

  it("resets local counts when a window rolls over", async () => {
    const clock = fakeClock("2030-01-01T10:14:00Z");
    const limiter = new RateLimiter({ clock });
    await limiter.acquire("read");
    clock.t = Date.parse("2030-01-01T10:16:00Z");
    expect(limiter.usage().overall.fifteenMinute.usage).toBe(0);
    expect(limiter.usage().overall.day.usage).toBe(1);
    clock.t = Date.parse("2030-01-02T00:01:00Z");
    expect(limiter.usage().overall.day.usage).toBe(0);
    expect(limiter.usage().read.day.usage).toBe(0);
  });

  it("treats a 429 as exhausting the 15-minute window", async () => {
    const clock = fakeClock("2030-01-01T10:01:00Z");
    const limiter = new RateLimiter({ clock });
    limiter.markRateLimited("read");
    expect(limiter.usage().read.fifteenMinute.usage).toBe(100);
    expect(limiter.usage().overall.fifteenMinute.usage).toBe(200);
    await limiter.acquire("read");
    expect(clock.t).toBe(Date.parse("2030-01-01T10:15:00Z"));

    const w = new RateLimiter({ clock: fakeClock("2030-01-01T10:01:00Z") });
    w.markRateLimited("write");
    expect(w.usage().read.fifteenMinute.usage).toBe(0);
    expect(w.usage().overall.fifteenMinute.usage).toBe(200);
  });

  it("uses the system clock by default", async () => {
    const limiter = new RateLimiter();
    await limiter.acquire("read");
    expect(limiter.usage().read.fifteenMinute.usage).toBe(1);
    await systemClock.sleep(1);
    expect(systemClock.now()).toBeGreaterThan(0);
    const c: Clock = systemClock;
    expect(typeof c.sleep).toBe("function");
  });
});
