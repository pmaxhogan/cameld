/**
 * A Strava object id (activity, athlete, upload) as a canonical decimal
 * string: digits only, no leading zero.
 *
 * Strava is moving these ids to the full 64-bit range, where a JavaScript
 * number silently rounds (anything above 2^53 - 1). So an id is never a
 * number anywhere in cameld: not in memory, not in JSON, not in the UI. The
 * one place it is an integer is SQLite, whose INTEGER is a signed 64-bit
 * value, which is also the largest id cameld accepts.
 */
export type StravaId = string;

/** The largest id that fits a signed 64-bit integer (and so an SQLite INTEGER). */
export const MAX_STRAVA_ID = "9223372036854775807";

const CANONICAL = /^[1-9]\d{0,18}$/;

export function isStravaId(value: unknown): value is StravaId {
  if (typeof value !== "string" || !CANONICAL.test(value)) return false;
  // Same length and both canonical: string order is numeric order.
  return value.length < MAX_STRAVA_ID.length || value <= MAX_STRAVA_ID;
}

/**
 * Normalize an id from any boundary. Accepts a canonical decimal string, or a
 * number that is still exact (rows and JSON written before ids were strings).
 * Throws on anything else: a rounded or malformed id must never be used.
 */
export function toStravaId(value: unknown, what = "id"): StravaId {
  if (isStravaId(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "bigint" && isStravaId(value.toString())) return value.toString();
  throw new TypeError(`${what} is not a valid Strava id`);
}

/** Numeric order of two canonical ids (shorter is smaller, then digit by digit). */
export function compareStravaIds(a: StravaId, b: StravaId): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
