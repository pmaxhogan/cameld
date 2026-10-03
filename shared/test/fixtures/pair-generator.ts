/**
 * SYNTHETIC two-device pair generator. See README.md in this directory.
 *
 * Simulates one made-up outing recorded twice: an "app" copy (clean GPS,
 * altitude, distance, speed, no heart rate) and a "fitbit" copy (noisy GPS,
 * heart rate, cadence, its own altitude and distance) whose clock lags by a
 * chosen number of seconds. The true path is a circle of 400 m radius
 * centred on the fictional origin lat 0.5, lng 0.5 (open ocean), walked at a
 * constant speed. Every channel is a formula plus seeded noise; nothing is
 * derived from a real recording, person or place.
 */
import fc from "fast-check";
import type { ActivitySample } from "../../src/activity/sample.ts";
import { SYNTHETIC_ORIGIN, SYNTHETIC_START, seededRandom } from "./synthetic-track.ts";

const METRES_PER_DEGREE = 111_320;
const RADIUS_METERS = 400;

export interface SyntheticSpike {
  /** True second (from the outing start) where the spike begins. */
  at: number;
  /** Number of consecutive Fitbit fixes displaced. */
  length: number;
  /** Displacement in metres (north-east). */
  meters: number;
}

export interface SyntheticPairOptions {
  seed: number;
  /** True outing length in seconds. */
  durationSeconds: number;
  /** Walking speed along the circle, m/s. */
  speedMps: number;
  /** Fitbit clock lag: its recorded time = true time - lag. */
  lagSeconds: number;
  /** Seconds after the true start the app starts, and before the end it stops. */
  appStartDelay: number;
  appEndEarly: number;
  fitbitStartDelay: number;
  fitbitEndEarly: number;
  /** Standard deviation of the Fitbit position noise, metres. */
  fitbitNoiseMeters: number;
  /** True-second range [from, to) where the app has no fix. */
  appGap?: readonly [number, number] | undefined;
  /** Every Nth app second gets a second record 400 ms later (0 = never). */
  appDuplicateEvery?: number | undefined;
  /** Every Nth Fitbit second gets an identical copy 300 ms later (0 = never). */
  fitbitDuplicateEvery?: number | undefined;
  /** Every Nth Fitbit second has no fix (0 = never). */
  fitbitMissingFixEvery?: number | undefined;
  spikes?: readonly SyntheticSpike[] | undefined;
}

export interface SyntheticPair {
  app: ActivitySample[];
  fitbit: ActivitySample[];
}

function truePosition(second: number, speedMps: number): { lat: number; lng: number } {
  const angle = (second * speedMps) / RADIUS_METERS;
  return displace(
    SYNTHETIC_ORIGIN,
    RADIUS_METERS * Math.sin(angle),
    RADIUS_METERS * Math.cos(angle),
  );
}

function displace(
  point: { lat: number; lng: number },
  northMeters: number,
  eastMeters: number,
): { lat: number; lng: number } {
  const lat = point.lat + northMeters / METRES_PER_DEGREE;
  const lng = point.lng + eastMeters / (METRES_PER_DEGREE * Math.cos((point.lat * Math.PI) / 180));
  return { lat, lng };
}

/** Standard normal draw (Box-Muller) from a seeded uniform source. */
function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const inRange = (second: number, range: readonly [number, number] | undefined): boolean =>
  range !== undefined && second >= range[0] && second < range[1];

/** Build a synthetic two-device recording of one fictional outing. */
export function syntheticPair(options: SyntheticPairOptions): SyntheticPair {
  const random = seededRandom(options.seed);
  const { durationSeconds: duration, speedMps } = options;
  const app: ActivitySample[] = [];
  let appDistance = 0;
  for (let t = options.appStartDelay; t < duration - options.appEndEarly; t += 1) {
    const sample: ActivitySample = { time: SYNTHETIC_START + t * 1000, source: "app" };
    if (!inRange(t, options.appGap)) {
      const p = displace(truePosition(t, speedMps), gaussian(random) * 0.3, gaussian(random) * 0.3);
      sample.lat = p.lat;
      sample.lng = p.lng;
    }
    sample.altitude = 20 + 4 * Math.sin(t / 60) + random() * 0.2;
    sample.distance = appDistance;
    sample.speed = speedMps + random() * 0.05;
    appDistance += speedMps;
    app.push(sample);
    const every = options.appDuplicateEvery ?? 0;
    if (every > 0 && t % every === 0) {
      const extra: ActivitySample = { ...sample, time: sample.time + 400 };
      extra.altitude = sample.altitude + 0.6;
      if (sample.lat !== undefined) {
        const moved = displace({ lat: sample.lat, lng: sample.lng! }, 0.5, 0.5);
        extra.lat = moved.lat;
        extra.lng = moved.lng;
      }
      app.push(extra);
    }
  }

  const fitbit: ActivitySample[] = [];
  let fitbitDistance = 0;
  for (let t = options.fitbitStartDelay; t < duration - options.fitbitEndEarly; t += 1) {
    const time = SYNTHETIC_START + (t - options.lagSeconds) * 1000;
    const sample: ActivitySample = { time, source: "fitbit" };
    const missEvery = options.fitbitMissingFixEvery ?? 0;
    if (!(missEvery > 0 && t % missEvery === 0)) {
      const spike = (options.spikes ?? []).find((s) => t >= s.at && t < s.at + s.length);
      const shift = spike?.meters ?? 0;
      const p = displace(
        truePosition(t, speedMps),
        gaussian(random) * options.fitbitNoiseMeters + shift,
        gaussian(random) * options.fitbitNoiseMeters + shift,
      );
      sample.lat = p.lat;
      sample.lng = p.lng;
    }
    sample.altitude = 18 + 4 * Math.sin(t / 60) + gaussian(random) * 2;
    sample.heartRate = Math.round(110 + 20 * Math.sin(t / 90) + random() * 3);
    sample.cadence = Math.round(100 + 4 * Math.cos(t / 45) + random() * 2);
    sample.distance = fitbitDistance;
    fitbitDistance += speedMps * (0.9 + random() * 0.3);
    fitbit.push(sample);
    const copyEvery = options.fitbitDuplicateEvery ?? 0;
    if (copyEvery > 0 && t % copyEvery === 0) {
      fitbit.push({ ...sample, time: sample.time + 300 });
    }
  }
  return { app, fitbit };
}

/**
 * Random pair options: offsets, early and late starts on both sides, app GPS
 * gaps, sub-second duplicates on both sides, missing Fitbit fixes, noise and position
 * spikes (some long enough to force a re-anchor).
 */
export const syntheticPairOptionsArb: fc.Arbitrary<SyntheticPairOptions> = fc
  .record({
    seed: fc.integer({ min: 1, max: 1_000_000 }),
    durationSeconds: fc.integer({ min: 60, max: 400 }),
    speedMps: fc.double({ min: 0.8, max: 4, noNaN: true }),
    lagSeconds: fc.integer({ min: -20, max: 20 }),
    appStartDelay: fc.integer({ min: 0, max: 40 }),
    appEndEarly: fc.integer({ min: 0, max: 40 }),
    fitbitStartDelay: fc.integer({ min: 0, max: 40 }),
    fitbitEndEarly: fc.integer({ min: 0, max: 40 }),
    fitbitNoiseMeters: fc.double({ min: 0, max: 30, noNaN: true }),
    appGap: fc.option(
      fc
        .tuple(fc.integer({ min: 0, max: 300 }), fc.integer({ min: 1, max: 120 }))
        .map(([from, length]): [number, number] => [from, from + length]),
      { nil: undefined },
    ),
    appDuplicateEvery: fc.integer({ min: 0, max: 15 }),
    fitbitDuplicateEvery: fc.integer({ min: 0, max: 6 }),
    fitbitMissingFixEvery: fc.integer({ min: 0, max: 9 }),
    spikes: fc.array(
      fc.record({
        at: fc.integer({ min: 0, max: 380 }),
        length: fc.integer({ min: 1, max: 45 }),
        meters: fc.integer({ min: 50, max: 3000 }),
      }),
      { maxLength: 3 },
    ),
  })
  .filter(
    (o) =>
      o.appStartDelay + o.appEndEarly < o.durationSeconds &&
      o.fitbitStartDelay + o.fitbitEndEarly < o.durationSeconds,
  );
