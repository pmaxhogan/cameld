import { z } from "zod";

/**
 * The normalized activity sample model. Every reader (FIT, GPX, TCX) produces
 * these and the FIT writer consumes them, so the merge logic never has to know
 * which file format a recording came from.
 *
 * Units are SI and fixed:
 * - `time`      epoch milliseconds (UTC)
 * - `lat/lng`   decimal degrees, WGS84
 * - `altitude`  metres above the WGS84 ellipsoid / sea level as recorded
 * - `heartRate` beats per minute
 * - `cadence`   revolutions or steps per minute, as the device reports it
 * - `distance`  cumulative metres since the start of the recording
 * - `speed`     metres per second
 *
 * Every measurement is optional because the devices differ: a phone has no
 * heart rate, an indoor session has no position. Position is all or nothing:
 * `lat` and `lng` are either both present or both absent.
 *
 * `source` records where the sample came from (for example "wrist", "phone",
 * or an activity reference). It is model-level provenance only: the FIT format
 * has no per-record slot for it, so it does not survive a FIT round trip and a
 * reader stamps every sample it produces with the source it was given.
 */
export const activitySampleSchema = z
  .object({
    time: z.number().int(),
    source: z.string().min(1),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    altitude: z.number().finite().optional(),
    heartRate: z.number().min(0).optional(),
    cadence: z.number().min(0).optional(),
    distance: z.number().min(0).optional(),
    speed: z.number().min(0).optional(),
  })
  .strict()
  .refine((sample) => (sample.lat === undefined) === (sample.lng === undefined), {
    message: "lat and lng must be both present or both absent",
    path: ["lat"],
  });

export type ActivitySample = z.infer<typeof activitySampleSchema>;

/** The measurement fields of a sample, in a stable order. */
export const SAMPLE_FIELDS = [
  "lat",
  "lng",
  "altitude",
  "heartRate",
  "cadence",
  "distance",
  "speed",
] as const;

export type SampleField = (typeof SAMPLE_FIELDS)[number];

/** File formats the readers understand. */
export type ActivityFormat = "fit" | "gpx" | "tcx";

/** What a reader returns: the samples plus the few activity-level facts it found. */
export interface ParsedActivity {
  format: ActivityFormat;
  /** Sport as the file names it (a FIT sport name, a GPX type, a TCX Sport attribute). */
  sport: string | undefined;
  /**
   * Start time in epoch ms: the declared start where the format has one (FIT
   * session, TCX Id), otherwise the first sample, otherwise GPX metadata time.
   */
  startTime: number | undefined;
  /** Samples in file order. Readers never sort, drop or invent samples. */
  samples: ActivitySample[];
}

/** Options every reader takes. */
export interface ReadOptions {
  /** Provenance tag stamped on every sample (see ActivitySample.source). */
  source: string;
}

/** Parse an unknown value as a list of samples, or throw a ZodError. */
export function parseActivitySamples(value: unknown): ActivitySample[] {
  return z.array(activitySampleSchema).parse(value);
}
