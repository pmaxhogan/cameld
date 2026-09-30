/**
 * Sender allowlist and code extraction. Pure: no Worker globals, so the unit
 * tests import it directly.
 *
 * The allowlist is checked against the parsed `From:` header, never the SMTP
 * envelope sender: a Gmail filter's "Forward it to" rewrites the envelope to
 * Gmail's own address but leaves the header alone.
 */

/** The exact sender of Gmail's "confirm this forwarding address" email. */
export const GMAIL_FORWARD_VERIFY_SENDER = "forwarding-noreply@google.com";

/** Domains whose login-code mail is accepted. Matching is label-anchored. */
export const CODE_SENDER_DOMAINS = ["strava.com"] as const;

export type MailKind = "otp" | "forward_verify" | "other";

/** Time to live per kind, in milliseconds. */
export const TTL_MS: Record<MailKind, number> = {
  otp: 10 * 60 * 1000,
  // The owner confirms Gmail forwarding by hand, possibly hours later.
  forward_verify: 24 * 60 * 60 * 1000,
  other: 24 * 60 * 60 * 1000,
};

/** Bounds every regex below to linear work over a small string. */
export const MAX_CLASSIFY_CHARS = 65_536;

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/**
 * Exact match, or a match anchored at a label boundary: `strava.com` allows
 * `strava.com` and `mail.strava.com`, never `strava.com.attacker.example` or
 * `notstrava.com`.
 */
export function domainAllowed(domain: string, allowlist: readonly string[]): boolean {
  const host = domain.trim().toLowerCase();
  if (host === "") return false;
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase();
    return entry !== "" && (host === entry || host.endsWith(`.${entry}`));
  });
}

/** Whether a message with this `From:` header address is accepted at all. */
export function isAllowedSender(from: string): boolean {
  const address = from.trim().toLowerCase();
  if (address === GMAIL_FORWARD_VERIFY_SENDER) return true;
  return domainAllowed(domainOf(address), CODE_SENDER_DOMAINS);
}

export interface Classification {
  kind: MailKind;
  code: string | null;
  /** Only for forward_verify: the confirmation link, pinned to Google's host. */
  url: string | null;
}

interface Candidate {
  value: string;
  index: number;
}

/** A six digit run: Strava's login code shape. */
const OTP_DIGITS = /(?<![\d-])\d{6}(?![\d-])/g;
/** Gmail's forwarding confirmation code is longer than an OTP. */
const FORWARD_VERIFY_DIGITS = /\b\d{6,12}\b/g;
const OTP_ANCHORS = /\b(?:code|verification|verify|one[- ]time|otp|passcode)\b/gi;
const FORWARD_ANCHORS = /\b(?:code|confirmation)\b/gi;
const FOLLOWED_BY_MINUTES = /^[\s-]*(?:minutes?|mins?)\b/i;
const URL_PATTERN = /https:\/\/mail-settings\.google\.com\/[^\s<>"')]+/i;
const REDIRECTOR_PARAMS = ["q", "url", "continue"] as const;

function candidates(text: string, pattern: RegExp): Candidate[] {
  return [...text.matchAll(pattern)]
    .map((match) => ({ value: match[0], index: match.index }))
    .filter((c) => !FOLLOWED_BY_MINUTES.test(text.slice(c.index + c.value.length, c.index + 20)));
}

/**
 * The candidate nearest AFTER an anchor word ("code is 123456"), falling back
 * to the nearest in either direction, then to the first candidate when no
 * anchor word appears at all. Null when there is no candidate.
 */
export function pickNearest(found: Candidate[], anchors: number[]): string | null {
  const first = found[0];
  if (first === undefined) return null;
  if (anchors.length === 0) return first.value;
  let forward: Candidate | undefined;
  let forwardDistance = Infinity;
  let any = first;
  let anyDistance = Infinity;
  for (const candidate of found) {
    for (const anchor of anchors) {
      const distance = candidate.index - anchor;
      if (distance >= 0 && distance < forwardDistance) {
        forwardDistance = distance;
        forward = candidate;
      }
      if (Math.abs(distance) < anyDistance) {
        anyDistance = Math.abs(distance);
        any = candidate;
      }
    }
  }
  return (forward ?? any).value;
}

function anchorsOf(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(pattern)].map((match) => match.index);
}

/**
 * Extract a Strava login code. The subject is searched first on its own (a
 * code in the subject line is unambiguous), then subject and body together.
 */
export function extractOtp(subject: string, text: string): string | null {
  const subjectCode = candidates(subject, OTP_DIGITS)[0];
  if (subjectCode !== undefined) return subjectCode.value;
  const body = text.slice(0, MAX_CLASSIFY_CHARS);
  const found = candidates(body, OTP_DIGITS);
  const anchors = anchorsOf(body, OTP_ANCHORS);
  // A six digit number with no code-ish word anywhere is not trusted.
  if (anchors.length === 0) return null;
  return pickNearest(found, anchors);
}

function safeForwardUrl(text: string): string | null {
  const candidate = URL_PATTERN.exec(text)?.[0];
  if (candidate === undefined) return null;
  const url = new URL(candidate);
  return REDIRECTOR_PARAMS.some((param) => url.searchParams.has(param)) ? null : candidate;
}

export function classify(mail: { from: string; subject: string; text: string }): Classification {
  const from = mail.from.trim().toLowerCase();
  if (from === GMAIL_FORWARD_VERIFY_SENDER) {
    const combined = `${mail.subject}\n${mail.text}`.slice(0, MAX_CLASSIFY_CHARS);
    const code = pickNearest(
      candidates(combined, FORWARD_VERIFY_DIGITS),
      anchorsOf(combined, FORWARD_ANCHORS),
    );
    return { kind: "forward_verify", code, url: safeForwardUrl(combined) };
  }
  const code = extractOtp(mail.subject, mail.text);
  return code === null
    ? { kind: "other", code: null, url: null }
    : { kind: "otp", code, url: null };
}
