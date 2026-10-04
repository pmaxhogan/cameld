import type { ApiSettings } from "@cameld/shared";

/**
 * The settings form as data: each numeric field and switch is a path into
 * ApiSettings, so the save patch can be built from "what changed" generically.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface FieldDef {
  id: string;
  label: string;
  testid: string;
  path: readonly string[];
  /** Server value = form value * scale (hours to ms). */
  scale: number;
  /** Round the server value to a whole number. */
  integer: boolean;
  /** One line under the input explaining what the number does. */
  help: string;
  /** The value is a 0..1 fraction: show it as a percentage next to the input. */
  fraction?: boolean;
}

export const FIELDS: readonly FieldDef[] = [
  {
    id: "grace",
    label: "Grace period before deletion (hours)",
    testid: "setting-grace-hours",
    path: ["timing", "gracePeriodMs"],
    scale: HOUR_MS,
    integer: true,
    help: "How long the originals stay hidden after a verified merge before they may be deleted.",
  },
  {
    id: "partnerWait",
    label: "Wait for the partner recording (hours)",
    testid: "setting-partner-wait-hours",
    path: ["timing", "partnerWaitMs"],
    scale: HOUR_MS,
    integer: true,
    help: "How long to wait for the second recording before treating an activity as single.",
  },
  {
    id: "autoOverlap",
    label: "Minimum overlap for an automatic match (fraction)",
    testid: "setting-auto-overlap",
    path: ["match", "autoMinOverlap"],
    scale: 1,
    integer: false,
    help: "Share of the shorter recording's time both must cover. 0.8 = 80%.",
    fraction: true,
  },
  {
    id: "maxStartDelta",
    label: "Largest start difference (seconds)",
    testid: "setting-max-start-delta",
    path: ["match", "maxStartDeltaSeconds"],
    scale: 1,
    integer: true,
    help: "Recordings that start further apart than this are never paired.",
  },
  {
    id: "gpsAuto",
    label: "Median GPS distance for an automatic merge (m)",
    testid: "setting-gps-auto",
    path: ["match", "gpsAutoMaxMedianMeters"],
    scale: 1,
    integer: false,
    help: "At or below this median distance between the tracks, the pair merges automatically.",
  },
  {
    id: "gpsReview",
    label: "Median GPS distance still worth a review (m)",
    testid: "setting-gps-review",
    path: ["match", "gpsReviewMaxMedianMeters"],
    scale: 1,
    integer: false,
    help: "Between the automatic limit and this, the pair goes to the review queue. Above it: no match.",
  },
  {
    id: "maxAutoOffset",
    label: "Largest clock offset applied automatically (seconds)",
    testid: "setting-max-auto-offset",
    path: ["match", "alignment", "maxAutoOffsetSeconds"],
    scale: 1,
    integer: true,
    help: "A larger measured clock offset sends the pair to review instead of being applied.",
  },
  {
    id: "uploadTolerance",
    label: "Post-upload check tolerance (fraction, 0.05 = 5%)",
    testid: "setting-upload-tolerance",
    path: ["postUpload", "tolerance"],
    scale: 1,
    integer: false,
    help: "How far the uploaded activity's point count, distance and elapsed time may differ from the merged file (Strava resamples). A fraction: 0.05 = 5%.",
    fraction: true,
  },
];

export interface SwitchDef {
  id: "hide" | "upload" | "delete" | "trial";
  label: string;
  testid: string;
  path: readonly string[];
  /** Turning it on deletes originals: needs the typed confirmation. */
  dangerous: boolean;
  /** What the switch does and what it depends on. "{maxPairs}" is filled in. */
  help: string;
}

export const SWITCHES: readonly SwitchDef[] = [
  {
    id: "hide",
    label: "Hide originals after the merge",
    testid: "switch-hide",
    path: ["switches", "hide"],
    dangerous: false,
    help: 'Applies only after a merged upload has passed the post-upload check: both originals are then set to "Only me" for the grace period. Off: they stay visible until deleted.',
  },
  {
    id: "upload",
    label: "Upload merged activities",
    testid: "switch-upload",
    path: ["switches", "upload"],
    dangerous: false,
    help: "Off: groups stop before the merged upload and nothing is written to Strava. Hiding and deleting only ever follow a verified upload.",
  },
  {
    id: "delete",
    label: "Delete originals after the grace period",
    testid: "switch-delete",
    path: ["switches", "delete"],
    dangerous: true,
    help: "Deletes both originals once the grace period is over. Also needed for Path B: Strava rejects a merged upload as a duplicate while the originals exist, so those pairs stay parked until deletion is on.",
  },
  {
    id: "trial",
    label: "Deletion trial (a few pairs only)",
    testid: "switch-trial",
    path: ["trial", "enabled"],
    dangerous: true,
    help: "Allows deletion (including Path B) for at most {maxPairs} pairs while the delete switch stays off, to prove the whole path once. Later pairs park as usual.",
  },
];

/** "0.05" as "5%" for fraction fields; "" when the value is not a number. */
export function percentHint(value: number | string | undefined): string {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return "";
  return `= ${String(Number((n * 100).toFixed(2)))}%`;
}

export type Values = Record<string, number | string>;
export type Toggles = Record<string, boolean>;

export function readPath(source: unknown, path: readonly string[]): unknown {
  let node = source;
  for (const key of path) node = (node as Record<string, unknown>)[key];
  return node;
}

/** Sets `value` at `path`, creating the intermediate objects. */
export function setPath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    node[key] ??= {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1] as string] = value;
}

export function fieldValues(settings: ApiSettings): Values {
  const values: Values = {};
  for (const field of FIELDS)
    values[field.id] = (readPath(settings, field.path) as number) / field.scale;
  return values;
}

export function switchValues(settings: ApiSettings): Toggles {
  const toggles: Toggles = {};
  for (const sw of SWITCHES) toggles[sw.id] = readPath(settings, sw.path) as boolean;
  return toggles;
}

export interface PatchResult {
  patch: Record<string, unknown>;
  invalid: string[];
  changed: number;
}

/** The patch holding only the fields that differ from `settings`. */
export function buildPatch(settings: ApiSettings, values: Values, toggles: Toggles): PatchResult {
  const patch: Record<string, unknown> = {};
  const invalid: string[] = [];
  let changed = 0;
  for (const field of FIELDS) {
    const raw = values[field.id];
    const value = typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isFinite(value)) {
      invalid.push(field.label);
      continue;
    }
    const server = value * field.scale;
    const next = field.integer ? Math.round(server) : server;
    if (next === readPath(settings, field.path)) continue;
    setPath(patch, field.path, next);
    changed += 1;
  }
  for (const sw of SWITCHES) {
    if (toggles[sw.id] === readPath(settings, sw.path)) continue;
    setPath(patch, sw.path, toggles[sw.id]);
    changed += 1;
  }
  return { patch, invalid, changed };
}
