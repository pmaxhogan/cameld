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
}

export const FIELDS: readonly FieldDef[] = [
  {
    id: "grace",
    label: "Grace period before deletion (hours)",
    testid: "setting-grace-hours",
    path: ["timing", "gracePeriodMs"],
    scale: HOUR_MS,
    integer: true,
  },
  {
    id: "partnerWait",
    label: "Wait for the partner recording (hours)",
    testid: "setting-partner-wait-hours",
    path: ["timing", "partnerWaitMs"],
    scale: HOUR_MS,
    integer: true,
  },
  {
    id: "autoOverlap",
    label: "Minimum overlap for an automatic match (0 to 1)",
    testid: "setting-auto-overlap",
    path: ["match", "autoMinOverlap"],
    scale: 1,
    integer: false,
  },
  {
    id: "maxStartDelta",
    label: "Largest start difference (seconds)",
    testid: "setting-max-start-delta",
    path: ["match", "maxStartDeltaSeconds"],
    scale: 1,
    integer: true,
  },
  {
    id: "gpsAuto",
    label: "Median GPS distance for an automatic merge (m)",
    testid: "setting-gps-auto",
    path: ["match", "gpsAutoMaxMedianMeters"],
    scale: 1,
    integer: false,
  },
  {
    id: "gpsReview",
    label: "Median GPS distance still worth a review (m)",
    testid: "setting-gps-review",
    path: ["match", "gpsReviewMaxMedianMeters"],
    scale: 1,
    integer: false,
  },
  {
    id: "maxAutoOffset",
    label: "Largest clock offset applied automatically (seconds)",
    testid: "setting-max-auto-offset",
    path: ["match", "alignment", "maxAutoOffsetSeconds"],
    scale: 1,
    integer: true,
  },
  {
    id: "uploadTolerance",
    label: "Post-upload check tolerance (0 to 1)",
    testid: "setting-upload-tolerance",
    path: ["postUpload", "tolerance"],
    scale: 1,
    integer: false,
  },
];

export interface SwitchDef {
  id: "hide" | "upload" | "delete" | "trial";
  label: string;
  testid: string;
  path: readonly string[];
  /** Turning it on deletes originals: needs the typed confirmation. */
  dangerous: boolean;
}

export const SWITCHES: readonly SwitchDef[] = [
  {
    id: "hide",
    label: "Hide originals after the merge",
    testid: "switch-hide",
    path: ["switches", "hide"],
    dangerous: false,
  },
  {
    id: "upload",
    label: "Upload merged activities",
    testid: "switch-upload",
    path: ["switches", "upload"],
    dangerous: false,
  },
  {
    id: "delete",
    label: "Delete originals after the grace period",
    testid: "switch-delete",
    path: ["switches", "delete"],
    dangerous: true,
  },
  {
    id: "trial",
    label: "Deletion trial (a few pairs only)",
    testid: "switch-trial",
    path: ["trial", "enabled"],
    dangerous: true,
  },
];

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
