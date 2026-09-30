/**
 * Pure metadata merge for two recordings of the same outing (rules L14-L16).
 *
 * Precedence: the "app" copy (the phone recording) wins every conflict; the
 * "other" copy (the wrist recording) only fills gaps. Every conflict is
 * recorded so nothing is silently dropped.
 */

export interface ActivityMetadata {
  name: string | null;
  description: string | null;
  sportType: string | null;
  gearId: string | null;
  commute: boolean | null;
  trainer: boolean | null;
}

export type MetadataField = keyof ActivityMetadata;

export interface MetadataConflict {
  field: MetadataField;
  /** The value that ended up in the merge. */
  kept: string | boolean | null;
  /** The value from the other copy that was not used as-is. */
  dropped: string | boolean | null;
  /** Which copy the kept value came from. */
  keptFrom: "app" | "other";
}

export interface MergedMetadata extends ActivityMetadata {
  conflicts: MetadataConflict[];
}

const SPORT_WORDS = [
  "run",
  "ride",
  "walk",
  "hike",
  "swim",
  "workout",
  "weight training",
  "yoga",
  "pilates",
  "crossfit",
  "hiit",
  "elliptical",
  "stair-stepper",
  "virtual ride",
  "virtual run",
  "e-bike ride",
  "e-mountain bike ride",
  "mountain bike ride",
  "gravel ride",
  "trail run",
  "nordic ski",
  "alpine ski",
  "backcountry ski",
  "snowboard",
  "snowshoe",
  "kayaking",
  "canoeing",
  "rowing",
  "stand up paddling",
  "surfing",
  "kitesurf",
  "windsurf",
  "sail",
  "golf",
  "skateboard",
  "inline skate",
  "ice skate",
  "rock climb",
  "tennis",
  "pickleball",
  "badminton",
  "table tennis",
  "squash",
  "soccer",
  "handcycle",
  "wheelchair",
  "velomobile",
  "racquetball",
  "skiing",
  "activity",
];

const ENGLISH_TIMES = "morning|afternoon|evening|night|lunch";

const ENGLISH_DEFAULT = new RegExp(
  `^(?:${ENGLISH_TIMES})\\s+(?:${SPORT_WORDS.map(escapeRegex).join("|")})$`,
);

/** Localized defaults, matched after lowercasing and stripping diacritics. */
const LOCALIZED_DEFAULTS: RegExp[] = [
  // German: "Morgendlicher Lauf", "Abendlicher Spaziergang", "Mittagslauf"
  /^(?:morgendlich|mittaglich|nachmittaglich|abendlich|nachtlich)(?:er|e|es)\s+(?:lauf|radfahrt|spaziergang|wanderung|schwimmen|training|workout|fahrt)$/,
  /^(?:morgen|mittag|nachmittag|abend|nacht)s?(?:lauf|radfahrt|spaziergang|wanderung|training)$/,
  // French: "Course a pied le matin", "Sortie velo en soiree"
  /^(?:course a pied|sortie velo|sortie a velo|marche|randonnee|natation|entrainement)\s+(?:le matin|a midi|dans l'apres-midi|l'apres-midi|en soiree|le soir|la nuit|pendant la pause dejeuner)$/,
  // Spanish: "Carrera por la manana", "Paseo en bicicleta por la tarde"
  /^(?:carrera|paseo en bicicleta|paseo en bici|caminata|senderismo|natacion|entrenamiento|bicicleta)\s+(?:por la manana|a mediodia|por la tarde|por la noche|de manana|de tarde|de noche)$/,
  // Italian: "Corsa mattutina", "Giro in bici serale"
  /^(?:corsa|giro in bici|camminata|escursione|nuoto|allenamento)\s+(?:mattutin[ao]|pomeridian[ao]|serale|notturn[ao]|di mezzogiorno|a pranzo|al mattino|nel pomeriggio|di sera|di notte)$/,
  // Portuguese: "Corrida matinal", "Pedalada da tarde"
  /^(?:corrida|pedalada|caminhada|trilha|natacao|treino)\s+(?:matinal|da manha|do meio-dia|da tarde|vespertina|da noite|noturna)$/,
  // Dutch: "Ochtendrit", "Avondloop"
  /^(?:ochtend|middag|avond|nacht|lunch)(?:loop|rit|wandeling|hike|training|workout|fietstocht|zwemtraining)$/,
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTitle(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when the name is empty or one of the titles Strava generates on its own
 * ("Morning Run", "Lunch Ride", localized equivalents). Custom titles that
 * merely contain such words ("Morning coffee ride") are not defaults.
 */
export function isStravaDefaultTitle(name: string | null | undefined): boolean {
  if (name === null || name === undefined) return true;
  const normalized = normalizeTitle(name);
  if (normalized === "") return true;
  if (ENGLISH_DEFAULT.test(normalized)) return true;
  return LOCALIZED_DEFAULTS.some((pattern) => pattern.test(normalized));
}

const FOOTER = /\bfrom\s+wandrer\b/i;
const STAT_DIGIT = /\d/;
const STAT_WORDS =
  /\b(?:new|miles?|mi|km|kilometers?|streets?|roads?|segments?|total|explored)\b|%/i;
const WANDRER_URL = /^\s*(?:https?:\/\/)?(?:www\.)?wandrer\.earth\S*\s*$/i;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/**
 * Remove blocks added by the Wandrer coverage tool: a stats paragraph such as
 * "12.3 new miles ... -- From Wandrer" or a bare "From Wandrer" footer. The
 * block and the blank lines around it go; everything else is kept verbatim.
 */
export function stripWandrerBlock(description: string): string {
  let lines = description.replace(/\r\n?/g, "\n").split("\n");
  for (;;) {
    const footer = lines.findIndex((line) => FOOTER.test(line));
    if (footer === -1) break;
    let start = footer;
    while (start > 0) {
      const previous = lines[start - 1] as string;
      if (isBlank(previous) || !(STAT_DIGIT.test(previous) && STAT_WORDS.test(previous))) break;
      start -= 1;
    }
    let end = footer;
    while (end + 1 < lines.length && WANDRER_URL.test(lines[end + 1] as string)) end += 1;
    let before = start;
    while (before > 0 && isBlank(lines[before - 1] as string)) before -= 1;
    let after = end + 1;
    while (after < lines.length && isBlank(lines[after] as string)) after += 1;
    const head = lines.slice(0, before);
    const tail = lines.slice(after);
    lines = head.length > 0 && tail.length > 0 ? [...head, "", ...tail] : [...head, ...tail];
  }
  return lines.join("\n").trim();
}

function present(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === "" ? null : value;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Merge two descriptions, preserving both unique texts. Wandrer blocks are
 * stripped first. Identical or contained text is not duplicated.
 */
export function mergeDescriptions(app: string | null, other: string | null): string | null {
  const a = present(app === null ? null : stripWandrerBlock(app));
  const b = present(other === null ? null : stripWandrerBlock(other));
  if (a === null) return b;
  if (b === null) return a;
  const sa = squash(a);
  const sb = squash(b);
  if (sa.includes(sb)) return a;
  if (sb.includes(sa)) return b;
  return `${a.trim()}\n\n${b.trim()}`;
}

function mergeText(
  field: "sportType" | "gearId",
  app: string | null,
  other: string | null,
  conflicts: MetadataConflict[],
): string | null {
  const a = present(app);
  const b = present(other);
  if (a === null) return b;
  if (b !== null && b !== a) {
    conflicts.push({ field, kept: a, dropped: b, keptFrom: "app" });
  }
  return a;
}

/**
 * Flags: Strava reports false for "never set", so false cannot outrank true.
 * A flag set on either copy is kept (never lose a deliberate setting); when the
 * copies disagree the difference is recorded. null means unknown.
 */
function mergeFlag(
  field: "commute" | "trainer",
  app: boolean | null,
  other: boolean | null,
  conflicts: MetadataConflict[],
): boolean | null {
  if (app === null) return other;
  if (other === null || app === other) return app;
  const kept = app || other;
  conflicts.push({
    field,
    kept,
    dropped: kept === app ? other : app,
    keptFrom: kept === app ? "app" : "other",
  });
  return kept;
}

/** Merge two copies of the same outing's metadata. The app copy wins conflicts. */
export function mergeMetadata(app: ActivityMetadata, other: ActivityMetadata): MergedMetadata {
  const conflicts: MetadataConflict[] = [];
  const appDefault = isStravaDefaultTitle(app.name);
  const otherDefault = isStravaDefaultTitle(other.name);
  const appName = present(app.name);
  const otherName = present(other.name);

  let name: string | null;
  let extraFromTitle: string | null = null;
  if (!appDefault && !otherDefault) {
    name = appName;
    if (otherName !== null && squash(otherName) !== squash(appName as string)) {
      extraFromTitle = otherName;
      conflicts.push({ field: "name", kept: appName, dropped: otherName, keptFrom: "app" });
    }
  } else if (appDefault && !otherDefault) {
    name = otherName;
  } else {
    // App custom and other default, or both default: the app copy wins.
    name = appName ?? otherName;
  }

  let description = mergeDescriptions(app.description, other.description);
  if (extraFromTitle !== null) {
    const line = `Also recorded as: ${extraFromTitle}`;
    description = description === null ? line : `${description}\n\n${line}`;
  }

  return {
    name,
    description,
    sportType: mergeText("sportType", app.sportType, other.sportType, conflicts),
    gearId: mergeText("gearId", app.gearId, other.gearId, conflicts),
    commute: mergeFlag("commute", app.commute, other.commute, conflicts),
    trainer: mergeFlag("trainer", app.trainer, other.trainer, conflicts),
    conflicts,
  };
}
