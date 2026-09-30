/**
 * SYNTHETIC fast-check arbitraries. See README.md in this directory.
 *
 * Every value is drawn from the full range the FIT writer accepts (see
 * src/fit/quantization.ts), so the property tests cover extremes a real
 * recording would never reach, not just plausible outings.
 */
import fc from "fast-check";
import type { ActivitySample } from "../../src/activity/sample.ts";
import { FIT_QUANTIZATION } from "../../src/fit/quantization.ts";

const q = FIT_QUANTIZATION;

const optional = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
  fc.option(arb, { nil: undefined, freq: 4 });

const double = (min: number, max: number): fc.Arbitrary<number> =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

/** Measurement fields of one sample; time is assigned by sampleListArb. */
const sampleBodyArb = fc.record({
  position: optional(
    // Longitude stops short of +180: FIT stores 180 as -180 (same meridian),
    // which is covered by a dedicated unit test rather than the property.
    fc.record({ lat: double(q.lat.min, q.lat.max), lng: double(q.lng.min, 179.9999) }),
  ),
  altitude: optional(double(q.altitude.min, q.altitude.max)),
  heartRate: optional(double(q.heartRate.min, q.heartRate.max)),
  cadence: optional(double(q.cadence.min, q.cadence.max)),
  distance: optional(double(q.distance.min, q.distance.max)),
  speed: optional(double(q.speed.min, q.speed.max)),
});

/**
 * Non-empty lists of samples in non-decreasing time order, anywhere in the
 * FIT timestamp range, with millisecond jitter so rounding is exercised.
 */
export const sampleListArb: fc.Arbitrary<ActivitySample[]> = fc
  .tuple(
    fc.integer({ min: q.time.min + 1000, max: q.time.max - 10_000_000 }),
    fc.array(fc.tuple(fc.integer({ min: 0, max: 5000 }), sampleBodyArb), {
      minLength: 1,
      maxLength: 40,
    }),
  )
  .map(([start, bodies]) => {
    let time = start;
    return bodies.map(([step, body]) => {
      time += step;
      const sample: ActivitySample = { time, source: "synthetic" };
      if (body.position !== undefined) {
        sample.lat = body.position.lat;
        sample.lng = body.position.lng;
      }
      if (body.altitude !== undefined) sample.altitude = body.altitude;
      if (body.heartRate !== undefined) sample.heartRate = body.heartRate;
      if (body.cadence !== undefined) sample.cadence = body.cadence;
      if (body.distance !== undefined) sample.distance = body.distance;
      if (body.speed !== undefined) sample.speed = body.speed;
      return sample;
    });
  });
