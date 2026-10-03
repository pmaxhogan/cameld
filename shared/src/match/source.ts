/**
 * Recording source fingerprint (docs/MERGE-RULES.md, "Source fingerprint").
 *
 * - "fitbit": `device_name` starts with "Fitbit". Only when `device_name` is
 *   absent, an `external_id` of the form `[fitbit_]<11-19 digits>.tcx` or one
 *   starting with `stripped_health_data_` (old GPX exports) also counts.
 * - "app": `device_name` is exactly "Strava App", or `external_id` ends in
 *   `-activity.fit` (that rule applies whatever the device name says, unless
 *   the name already identified a Fitbit). Older app uploads can have a null
 *   `external_id`; the device name alone is enough then.
 * - "other": everything else (bike computers, watches of other brands).
 *
 * A pair needs two different sources. Other-vs-Fitbit pairs are allowed and
 * follow the same rules, with the other device in the app's role.
 */

export type RecordingSource = "fitbit" | "app" | "other";

export interface SourceHints {
  deviceName?: string | null | undefined;
  externalId?: string | null | undefined;
}

const FITBIT_TCX_EXTERNAL_ID = /^(fitbit_)?\d{11,19}\.tcx$/;
const FITBIT_GPX_EXTERNAL_ID_PREFIX = "stripped_health_data_";
const APP_DEVICE_NAME = "Strava App";
const APP_EXTERNAL_ID_SUFFIX = "-activity.fit";

/** Classify a Strava activity by its `device_name` and `external_id`. */
export function classifySource(hints: SourceHints): RecordingSource {
  const deviceName = hints.deviceName ?? null;
  const externalId = hints.externalId ?? null;
  if (deviceName !== null && deviceName.startsWith("Fitbit")) {
    return "fitbit";
  }
  if (deviceName === APP_DEVICE_NAME) {
    return "app";
  }
  if (externalId !== null && externalId.endsWith(APP_EXTERNAL_ID_SUFFIX)) {
    return "app";
  }
  if (
    deviceName === null &&
    externalId !== null &&
    (FITBIT_TCX_EXTERNAL_ID.test(externalId) ||
      externalId.startsWith(FITBIT_GPX_EXTERNAL_ID_PREFIX))
  ) {
    return "fitbit";
  }
  return "other";
}
