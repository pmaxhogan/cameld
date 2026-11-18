import { isStravaId } from "@cameld/shared";

/**
 * Lossless JSON for Strava API bodies.
 *
 * Strava ids are 64-bit integers, and `JSON.parse` rounds any integer above
 * 2^53 - 1 without a word. This parser reads the digits of the source text
 * instead (the `context.source` of a JSON.parse reviver), so no id is ever
 * rounded, in memory or in a backup written from the parsed value:
 *
 * - an id field (`id`, `activity_id`, `upload_id`, `athlete_id`) holding an
 *   integer becomes its exact decimal string, whatever its size;
 * - where Strava sends a string twin (`id_str`, `upload_id_str`), the twin is
 *   the id, as Strava recommends;
 * - any other integer too large for a JavaScript number becomes its exact
 *   decimal string too (segment effort ids are already that large).
 *
 * Everything else parses as usual. Bodies stored before this parser existed
 * hold the same ids as (then still exact) numbers; parsing them here gives
 * the same strings.
 */

/** Integer fields that identify a Strava object. */
const ID_KEYS: ReadonlySet<string> = new Set(["id", "activity_id", "upload_id", "athlete_id"]);
const STR_SUFFIX = "_str";
const INTEGER = /^-?\d+$/;

interface ReviverContext {
  source?: string;
}

function revive(this: unknown, key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value === "number") {
    const source = context?.source;
    if (source === undefined || !INTEGER.test(source)) return value;
    if (ID_KEYS.has(key) && isStravaId(source)) return source;
    return Number.isSafeInteger(value) ? value : source;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const twin of Object.keys(record)) {
      if (!twin.endsWith(STR_SUFFIX)) continue;
      const target = twin.slice(0, -STR_SUFFIX.length);
      if (ID_KEYS.has(target) && isStravaId(record[twin])) record[target] = record[twin];
    }
  }
  return value;
}

/** Parse a Strava API body (or a stored copy of one) without losing any id. */
export function parseStravaJson(text: string): unknown {
  return JSON.parse(text, revive as (this: unknown, key: string, value: unknown) => unknown);
}
