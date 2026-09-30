/**
 * SYNTHETIC test data generator. See README.md in this directory.
 *
 * Produces a made-up outing on a small loop centred on lat 0.5, lng 0.5, a
 * point in open ocean in the Gulf of Guinea. Nothing here is derived from a
 * real recording: positions are a parametric ellipse, the other channels are
 * sine waves plus seeded noise.
 */
import type { ActivitySample } from "../../src/activity/sample.ts";

/** Fictional origin: open water, no land within tens of kilometres. */
export const SYNTHETIC_ORIGIN = { lat: 0.5, lng: 0.5 } as const;

/** A fixed, arbitrary start time (2020-02-02T02:02:02Z). */
export const SYNTHETIC_START = Date.UTC(2020, 1, 2, 2, 2, 2);

/** mulberry32: tiny deterministic PRNG so fixtures are identical on every run. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticTrackOptions {
  seed?: number;
  /** Number of samples, one per second. */
  count?: number;
  start?: number;
  source?: string;
  /** Emit heart rate and cadence (a wrist-like recording). */
  withHeartRate?: boolean;
  /** Emit position, altitude, distance and speed (a GPS recording). */
  withPosition?: boolean;
  /** Indices where the position is dropped (a simulated GPS gap). */
  gpsGap?: readonly [number, number];
}

const METRES_PER_DEGREE = 111_320;

/** Generate a synthetic 1 Hz track around SYNTHETIC_ORIGIN. */
export function syntheticTrack(options: SyntheticTrackOptions = {}): ActivitySample[] {
  const {
    seed = 1,
    count = 120,
    start = SYNTHETIC_START,
    source = "synthetic",
    withHeartRate = true,
    withPosition = true,
    gpsGap,
  } = options;
  const random = seededRandom(seed);
  const radius = 400 / METRES_PER_DEGREE;
  const samples: ActivitySample[] = [];
  let distance = 0;
  let previous: { lat: number; lng: number } | undefined;
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / Math.max(count, 1);
    const sample: ActivitySample = { time: start + i * 1000, source };
    const inGap = gpsGap !== undefined && i >= gpsGap[0] && i < gpsGap[1];
    if (withPosition && !inGap) {
      const lat = SYNTHETIC_ORIGIN.lat + radius * Math.sin(angle) + (random() - 0.5) * 2e-6;
      const lng = SYNTHETIC_ORIGIN.lng + 1.5 * radius * Math.cos(angle) + (random() - 0.5) * 2e-6;
      if (previous !== undefined) {
        const dLat = (lat - previous.lat) * METRES_PER_DEGREE;
        const dLng = (lng - previous.lng) * METRES_PER_DEGREE;
        distance += Math.hypot(dLat, dLng);
      }
      previous = { lat, lng };
      sample.lat = lat;
      sample.lng = lng;
      sample.altitude = 12 + 3 * Math.sin(angle * 2) + random() * 0.4;
      sample.distance = distance;
      sample.speed = 2.8 + 0.4 * Math.sin(angle * 3) + random() * 0.1;
    }
    if (withHeartRate) {
      sample.heartRate = Math.round(128 + 14 * Math.sin(angle) + random() * 4);
      sample.cadence = Math.round(84 + 3 * Math.cos(angle) + random() * 2);
    }
    samples.push(sample);
  }
  return samples;
}
