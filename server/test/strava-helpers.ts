import type { Clock } from "../src/strava/rate-limiter.ts";

/** Deterministic clock: sleep advances time instantly and records the wait. */
export function fakeClock(startIso: string): Clock & { t: number; sleeps: number[] } {
  const clock = {
    t: Date.parse(startIso),
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
  };
  return clock;
}
