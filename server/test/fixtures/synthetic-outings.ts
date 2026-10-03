/**
 * SYNTHETIC outings for the state machine tests. Nothing here comes from a
 * real recording, person or place: each track is a 400 m circle around the
 * fictional origin lat 0.5, lng 0.5 (open ocean, no land for tens of
 * kilometres) plus noise from a seeded PRNG, ids are made up, names are
 * invented ("Quillmere" does not exist), and the photo is a 1x1 transparent
 * PNG. The start is an arbitrary fixed instant (2020-02-02T02:02:02Z).
 */
import { type ActivitySample, writeFitActivity } from "@cameld/shared";
import { SYNTHETIC_PNG } from "../fake-strava/fixtures.ts";
import type { FakeWorld, WorldActivity } from "../fake-strava-api/world.ts";

const DAY_MS = 24 * 3600 * 1000;
const ORIGIN = { lat: 0.5, lng: 0.5 };
export const SYNTHETIC_START = Date.UTC(2020, 1, 2, 2, 2, 2);
const METRES_PER_DEGREE = 111_320;
const RADIUS = 400;

/** mulberry32: tiny deterministic PRNG. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
}

function onCircle(second: number, speed: number, north: number, east: number) {
  const angle = (second * speed) / RADIUS;
  const n = RADIUS * Math.sin(angle) + north;
  const e = RADIUS * Math.cos(angle) + east;
  return {
    lat: ORIGIN.lat + n / METRES_PER_DEGREE,
    lng: ORIGIN.lng + e / (METRES_PER_DEGREE * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  };
}

export interface TrackOptions {
  seed: number;
  /** Start, epoch ms. */
  start: number;
  seconds: number;
  speed?: number;
  /** Position noise in metres. */
  noise?: number;
  /** Clock lag: recorded time = true time - lag. */
  lagSeconds?: number;
  /** First true second recorded. */
  from?: number;
  heartRate?: boolean;
  altitudeBase?: number;
}

/** One synthetic 1 Hz recording on the circle. */
export function syntheticTrack(options: TrackOptions): ActivitySample[] {
  const random = seeded(options.seed);
  const speed = options.speed ?? 3;
  const noise = options.noise ?? 0.3;
  const out: ActivitySample[] = [];
  let distance = 0;
  for (let t = options.from ?? 0; t < options.seconds; t += 1) {
    const p = onCircle(t, speed, gaussian(random) * noise, gaussian(random) * noise);
    const sample: ActivitySample = {
      time: options.start + (t - (options.lagSeconds ?? 0)) * 1000,
      source: "synthetic",
      lat: p.lat,
      lng: p.lng,
      altitude: (options.altitudeBase ?? 20) + 4 * Math.sin(t / 60) + random() * 0.2,
      distance,
    };
    if (options.heartRate === true) {
      sample.heartRate = Math.round(120 + 15 * Math.sin(t / 90) + random() * 3);
      sample.cadence = Math.round(160 + 4 * Math.cos(t / 45) + random() * 2);
    } else {
      sample.speed = speed + random() * 0.05;
    }
    distance += speed;
    out.push(sample);
  }
  return out;
}

/** Minimal TCX v2 serialization (one lap), like a wrist tracker export. */
export function toTcx(samples: readonly ActivitySample[]): string {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const points = samples.map((s) => {
    const parts = [`<Time>${iso(s.time)}</Time>`];
    if (s.lat !== undefined && s.lng !== undefined) {
      parts.push(
        `<Position><LatitudeDegrees>${s.lat}</LatitudeDegrees><LongitudeDegrees>${s.lng}</LongitudeDegrees></Position>`,
      );
    }
    if (s.altitude !== undefined) parts.push(`<AltitudeMeters>${s.altitude}</AltitudeMeters>`);
    if (s.distance !== undefined) parts.push(`<DistanceMeters>${s.distance}</DistanceMeters>`);
    if (s.heartRate !== undefined) {
      parts.push(`<HeartRateBpm><Value>${s.heartRate}</Value></HeartRateBpm>`);
    }
    if (s.cadence !== undefined) parts.push(`<Cadence>${s.cadence}</Cadence>`);
    return `<Trackpoint>${parts.join("")}</Trackpoint>`;
  });
  const first = iso(samples[0]?.time ?? 0);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">',
    `<Activities><Activity Sport="Running"><Id>${first}</Id>`,
    `<Lap StartTime="${first}"><TotalTimeSeconds>${samples.length}</TotalTimeSeconds><Track>`,
    ...points,
    "</Track></Lap></Activity></Activities></TrainingCenterDatabase>",
    "",
  ].join("\n");
}

export interface SyntheticOuting {
  app: WorldActivity;
  fitbit: WorldActivity;
}

export interface OutingOptions {
  /** Days after the fixed synthetic start. */
  day?: number;
  seed?: number;
  /** Fitbit clock lag in seconds. */
  lagSeconds?: number;
  /** Fitbit position noise in metres (large values push the pair to review). */
  fitbitNoiseMeters?: number;
  sport?: string;
  withPhoto?: boolean;
  /** The Fitbit copy has no original file (Strava has none to export). */
  fitbitWithoutOriginal?: boolean;
}

/** Two copies of one fictional run: app (FIT, clean GPS) and Fitbit (TCX, heart rate). */
export function addOuting(world: FakeWorld, options: OutingOptions = {}): SyntheticOuting {
  const day = options.day ?? 0;
  const seed = options.seed ?? 7 + day;
  const start = SYNTHETIC_START + day * DAY_MS;
  const app = syntheticTrack({ seed, start, seconds: 600, from: 10 });
  const fitbit = syntheticTrack({
    seed: seed + 1000,
    start,
    seconds: 580,
    noise: options.fitbitNoiseMeters ?? 1,
    lagSeconds: options.lagSeconds ?? 5,
    heartRate: true,
    altitudeBase: 18,
  });
  const sport = options.sport ?? "Run";
  const fitbitFile = `fitbit_${String(10_000_000_000 + seed)}.tcx`;
  const appActivity = world.add({
    name: "Morning Run",
    description: "Synthetic loop around Quillmere harbour.",
    sportType: sport,
    deviceName: "Strava App",
    externalId: `synthetic-${seed}-activity.fit`,
    gearId: "g9001",
    privateNote: "synthetic app note",
    perceivedExertion: 6,
    preferPerceivedExertion: true,
    original: {
      filename: `synthetic-${seed}-activity.fit`,
      bytes: Buffer.from(writeFitActivity(app, { sport: "running" })),
    },
    samples: app,
    kudos: [{ firstname: "Synthetic", lastname: "Friend" }],
    comments: [{ id: 1, text: "Nice synthetic loop" }],
    photos:
      options.withPhoto === true
        ? [
            {
              uniqueId: `synthetic-photo-${seed}`,
              bytes: SYNTHETIC_PNG,
              createdAt: new Date(start).toISOString(),
            },
          ]
        : [],
  });
  const fitbitActivity = world.add({
    name: "Quillmere Tempo",
    description: null,
    sportType: sport,
    deviceName: "Fitbit",
    externalId: fitbitFile,
    privateNote: "synthetic wrist note",
    original:
      options.fitbitWithoutOriginal === true
        ? null
        : { filename: fitbitFile, bytes: Buffer.from(toTcx(fitbit), "utf8") },
    samples: fitbit,
  });
  return { app: appActivity, fitbit: fitbitActivity };
}

/** A lone recording with no partner, six hours after that day's outing. */
export function addSingle(world: FakeWorld, day: number): WorldActivity {
  const samples = syntheticTrack({
    seed: 900 + day,
    start: SYNTHETIC_START + day * DAY_MS + 6 * 3600 * 1000,
    seconds: 300,
  });
  return world.add({
    name: "Lunch Run",
    sportType: "Run",
    deviceName: "Strava App",
    externalId: `synthetic-single-${day}-activity.fit`,
    original: {
      filename: `synthetic-single-${day}-activity.fit`,
      bytes: Buffer.from(writeFitActivity(samples, { sport: "running" })),
    },
    samples,
  });
}
