import {
  ChallengeError,
  LoginRequiredError,
  WebNotFoundError,
  WebSessionError,
  WebUnexpectedResponseError,
} from "./errors.ts";

/**
 * Pure classification of what strava.com answered. Shared by page
 * navigations and in-page fetches so both detect expiry and challenges the
 * same way. Nothing here retries: a challenge is reported, never worked
 * around. Answers from any other host go through `classifyUpload` instead.
 */

/** Paths Strava sends a logged-out browser to. */
export function isLoginPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/session/new" ||
    pathname === "/register"
  );
}

/**
 * Markers of a captcha or bot-verification interstitial (reCAPTCHA
 * challenge frame, Cloudflare managed challenge, a generic "verify you are
 * human" page). The invisible reCAPTCHA script on the real login page is NOT
 * a marker: the login page is classified as LoginRequired first.
 */
const CHALLENGE_MARKERS: readonly RegExp[] = [
  /<title>[^<]*(captcha|security check|just a moment|attention required)[^<]*<\/title>/i,
  /recaptcha\/[a-z]+\/bframe/i,
  /class="[^"]*\bg-recaptcha\b/i,
  /\bcf-chl-/i,
  /challenge-platform/i,
  /verify (that )?you are (a )?human/i,
];

export function looksLikeChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => marker.test(html));
}

export interface Observed {
  status: number;
  /** Final URL after redirects. */
  url: string;
  /** Body text when it is HTML, otherwise "". */
  html: string;
}

export interface ClassifyOptions {
  /** Treat 404 as a normal answer (delete verification). Default false. */
  allowNotFound?: boolean;
  /** Path of the request, for error messages (never the query string). */
  path: string;
}

/** Null when the answer is usable; otherwise the typed error to throw. */
export function classify(observed: Observed, options: ClassifyOptions): WebSessionError | null {
  const { pathname } = new URL(observed.url);
  if (isLoginPath(pathname) || observed.status === 401)
    return new LoginRequiredError(`strava.com sent ${options.path} to the login page`);
  if (observed.status === 429)
    return new ChallengeError("rate_limited", `strava.com returned 429 for ${options.path}`);
  if (looksLikeChallenge(observed.html))
    return new ChallengeError("captcha", `strava.com served a challenge for ${options.path}`);
  if (observed.status === 403)
    return new ChallengeError("forbidden", `strava.com returned 403 for ${options.path}`);
  if (observed.status === 404)
    return options.allowNotFound ? null : new WebNotFoundError(options.path);
  if (observed.status >= 400 || observed.status < 200)
    return new WebUnexpectedResponseError(
      `strava.com returned ${observed.status} for ${options.path}`,
    );
  return null;
}

/**
 * The `<Code>` of an S3-style XML error body (SignatureDoesNotMatch,
 * AccessDenied, RequestExpired, ...), or null. Nothing else of the body is
 * ever kept: it can echo the signature, the signed string and the object key.
 */
export function uploadErrorCode(body: string): string | null {
  const match = /<Error>[\s\S]*?<Code>\s*([A-Za-z][A-Za-z0-9]{0,63})\s*<\/Code>/.exec(
    body.slice(0, 4096),
  );
  return match === null ? null : (match[1] as string);
}

/**
 * Classification of what the photo upload host (the presigned target, never
 * strava.com) answered. Its statuses say nothing about the strava.com
 * session, so none of them is a login or a challenge: any non-2xx is an
 * unexpected response that names the status and the error code only, never
 * the URL (it carries the signature) or the object key.
 */
export function classifyUpload(status: number, body: string): WebUnexpectedResponseError | null {
  if (status >= 200 && status < 300) return null;
  const code = uploadErrorCode(body);
  return new WebUnexpectedResponseError(
    `photo upload host returned ${status}${code === null ? "" : ` (${code})`}`,
  );
}

/** Filename from a Content-Disposition header (RFC 6266 `filename*` preferred). */
export function parseContentDisposition(header: string | undefined): string | null {
  if (header === undefined) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended !== null) {
    try {
      return sanitizeFilename(decodeURIComponent((extended[2] as string).trim()));
    } catch {
      // Malformed percent-encoding: fall through to the plain parameter.
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted !== null) return sanitizeFilename((quoted[1] as string).replace(/\\(.)/g, "$1"));
  const bare = /filename\s*=\s*([^;\s]+)/i.exec(header);
  return bare === null ? null : sanitizeFilename(bare[1] as string);
}

/** Strip any directory part so a hostile header cannot steer a later write. */
function sanitizeFilename(name: string): string | null {
  const parts = name.split(/[\\/]/);
  const base = (parts[parts.length - 1] as string).trim();
  return base === "" || base === "." || base === ".." ? null : base;
}
