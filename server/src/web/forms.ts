/**
 * The activity edit form as name/value entries, exactly as the browser would
 * submit it (FormData order, Rails conventions). Writes start from the full
 * set of current entries and change only the named fields, so a save never
 * resets a field cameld did not mean to touch.
 *
 * Rails reads the LAST value of a repeated non-array name. Checkboxes are a
 * hidden "0" followed by the checkbox "1" when checked.
 */

export type FormEntries = [string, string][];

export const FIELD = {
  privateNote: "activity[private_note]",
  visibility: "activity[visibility]",
  perceivedExertion: "activity[perceived_exertion]",
  preferPerceivedExertion: "activity[prefer_perceived_exertion]",
  hideFromHome: "activity[hide_from_home]",
} as const;

export const VISIBILITIES = ["everyone", "followers_only", "only_me"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface EditFormValues {
  privateNote: string;
  visibility: Visibility | null;
  /** 1 to 10, or null when unset. */
  perceivedExertion: number | null;
  preferPerceivedExertion: boolean;
  /** "Mute": keep the activity out of home feeds. */
  hideFromHome: boolean;
}

/** Fields that are about the request, not the activity. */
const TRANSPORT_FIELDS = new Set(["_method", "authenticity_token"]);

/** Last value of `name` (Rails semantics), or null when absent. */
export function lastValue(entries: FormEntries, name: string): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as [string, string];
    if (entry[0] === name) return entry[1];
  }
  return null;
}

/** Newlines as the browser normalizes textarea content on submit. */
export function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Checkbox values Strava and Rails use for "on" ("true" on the live site). */
const ON_VALUES = new Set(["true", "1", "on"]);

function isOn(value: string | null): boolean {
  return value !== null && ON_VALUES.has(value.trim().toLowerCase());
}

/**
 * Fields a complete (hydrated) edit form always carries. Strava renders the
 * visibility radios client-side; a form read or POSTed without them would
 * reset the activity's visibility.
 */
export const REQUIRED_FIELDS = ["authenticity_token", FIELD.visibility, FIELD.privateNote] as const;

/**
 * Required fields absent from `entries`. The token and visibility must also
 * be non-empty; an empty private note is a real value.
 */
export function missingRequiredFields(entries: FormEntries): string[] {
  return REQUIRED_FIELDS.filter((name) => {
    const value = lastValue(entries, name);
    return value === null || (name !== FIELD.privateNote && value === "");
  });
}

export function readValues(entries: FormEntries): EditFormValues {
  const visibility = lastValue(entries, FIELD.visibility);
  const exertion = Number.parseInt(lastValue(entries, FIELD.perceivedExertion) ?? "", 10);
  return {
    privateNote: normalizeText(lastValue(entries, FIELD.privateNote) ?? ""),
    visibility: VISIBILITIES.includes(visibility as Visibility) ? (visibility as Visibility) : null,
    perceivedExertion: Number.isInteger(exertion) ? exertion : null,
    preferPerceivedExertion: lastValue(entries, FIELD.preferPerceivedExertion) === "1",
    hideFromHome: isOn(lastValue(entries, FIELD.hideFromHome)),
  };
}

/**
 * Replace every entry named `name` with one entry holding `value`, kept at
 * the position of the first occurrence; appended when absent.
 */
export function setEntry(entries: FormEntries, name: string, value: string): FormEntries {
  const out: FormEntries = [];
  let placed = false;
  for (const entry of entries) {
    if (entry[0] !== name) out.push(entry);
    else if (!placed) {
      out.push([name, value]);
      placed = true;
    }
  }
  if (!placed) out.push([name, value]);
  return out;
}

/**
 * Body of a Rails form POST: `_method`, the form's authenticity_token, then
 * every activity entry with `changes` applied.
 */
export function buildSubmission(
  entries: FormEntries,
  authenticityToken: string,
  method: "patch" | "delete",
  changes: FormEntries = [],
): FormEntries {
  let fields = entries.filter(([name]) => !TRANSPORT_FIELDS.has(name));
  for (const [name, value] of changes) fields = setEntry(fields, name, value);
  return [["_method", method], ["authenticity_token", authenticityToken], ...fields];
}

/**
 * Field names whose value differs between two snapshots, ignoring transport
 * fields. Compares Rails' effective (last) value per name, text normalized.
 */
export function changedFields(before: FormEntries, after: FormEntries): string[] {
  const names = new Set(
    [...before, ...after].map(([name]) => name).filter((name) => !TRANSPORT_FIELDS.has(name)),
  );
  const differ: string[] = [];
  for (const name of names) {
    const a = lastValue(before, name);
    const b = lastValue(after, name);
    if (a === null || b === null ? a !== b : normalizeText(a) !== normalizeText(b))
      differ.push(name);
  }
  return differ;
}

/** Distinct photo uuids present as `photos[<uuid>][...]` entries. */
export function photoIds(entries: FormEntries): string[] {
  const ids = new Set<string>();
  for (const [name] of entries) {
    const match = /^photos\[([^\]]+)\]\[/.exec(name);
    if (match !== null) ids.add(match[1] as string);
  }
  return [...ids];
}
