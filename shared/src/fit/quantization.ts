/**
 * FIT record quantization. FIT stores every value as a scaled integer, so a
 * write then read round trip is exact only up to these steps. The property
 * test in shared/test/fit-roundtrip.test.ts proves that every sample comes
 * back within half a step of what was written.
 *
 * | Field     | FIT field (base type)          | Step            | Max round-trip error | Representable range           |
 * |-----------|--------------------------------|-----------------|----------------------|-------------------------------|
 * | time      | timestamp (uint32 s)           | 1 s             | 0.5 s                | 1998-07-01 .. 2126-02-06 (UTC)|
 * | lat       | position_lat (sint32 semicirc) | 180/2^31 deg    | ~4.2e-8 deg (~5 mm)  | -90 .. 90                     |
 * | lng       | position_long (sint32 semicirc)| 180/2^31 deg    | ~4.2e-8 deg (~5 mm)  | -180 .. 180 (180 == -180)     |
 * | altitude  | enhanced_altitude (uint32)     | 0.2 m           | 0.1 m                | -500 .. ~8.59e8 m             |
 * | heartRate | heart_rate (uint8)             | 1 bpm           | 0.5 bpm              | 0 .. 254                      |
 * | cadence   | cadence (uint8)                | 1 rpm           | 0.5 rpm              | 0 .. 254                      |
 * | distance  | distance (uint32)              | 0.01 m          | 0.005 m              | 0 .. 42949672.94 m            |
 * | speed     | enhanced_speed (uint32)        | 0.001 m/s       | 0.0005 m/s           | 0 .. 4294967.294 m/s          |
 *
 * Timestamps below 0x10000000 FIT seconds mean "seconds since device power
 * on" in the FIT protocol, not absolute time, so they are refused. The
 * uint32 maximum is the invalid marker, so the last usable second is one less.
 * Out-of-range values are refused by the writer rather than clamped: clamping
 * would silently change data.
 */

/** 1989-12-31T00:00:00Z, the FIT epoch, in Unix epoch milliseconds. */
export const FIT_EPOCH_MS = 631_065_600_000;

/** Semicircles per degree: 2^31 / 180. */
export const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

export interface FieldQuantum {
  /** Size of one step in the model's units. */
  step: number;
  /** Smallest value the writer accepts. */
  min: number;
  /** Largest value the writer accepts. */
  max: number;
}

const UINT32_MAX_VALID = 0xfffffffe;

export const FIT_QUANTIZATION = {
  time: {
    step: 1000,
    min: FIT_EPOCH_MS + 0x10000000 * 1000,
    max: FIT_EPOCH_MS + UINT32_MAX_VALID * 1000,
  },
  lat: { step: 1 / SEMICIRCLES_PER_DEGREE, min: -90, max: 90 },
  lng: { step: 1 / SEMICIRCLES_PER_DEGREE, min: -180, max: 180 },
  altitude: { step: 0.2, min: -500, max: UINT32_MAX_VALID / 5 - 500 },
  heartRate: { step: 1, min: 0, max: 254 },
  cadence: { step: 1, min: 0, max: 254 },
  distance: { step: 0.01, min: 0, max: UINT32_MAX_VALID / 100 },
  speed: { step: 0.001, min: 0, max: UINT32_MAX_VALID / 1000 },
} as const satisfies Record<string, FieldQuantum>;

export type QuantizedField = keyof typeof FIT_QUANTIZATION;

/** Degrees to FIT semicircles. 180 degrees of longitude wraps to -180 (same meridian). */
export function degreesToSemicircles(degrees: number): number {
  const semicircles = Math.round(degrees * SEMICIRCLES_PER_DEGREE);
  return semicircles === 2 ** 31 ? -(2 ** 31) : semicircles;
}

/** FIT semicircles to degrees. */
export function semicirclesToDegrees(semicircles: number): number {
  return semicircles / SEMICIRCLES_PER_DEGREE;
}

/** Epoch ms to whole FIT seconds (rounded to the nearest second). */
export function epochMsToFitSeconds(ms: number): number {
  return Math.round((ms - FIT_EPOCH_MS) / 1000);
}

/** Whole FIT seconds to epoch ms. */
export function fitSecondsToEpochMs(seconds: number): number {
  return seconds * 1000 + FIT_EPOCH_MS;
}
