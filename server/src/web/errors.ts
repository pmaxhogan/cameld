/**
 * Typed failures of the strava.com web session. Callers branch on the class
 * (or on `code`), never on message text. Messages carry paths, statuses and
 * field NAMES only: never cookies, CSRF tokens, codes, emails or field values.
 *
 * LoginRequiredError and ChallengeError mean "park the affected work, pause
 * all web actions, notify the owner". Nothing in this module retries them.
 */

export type WebErrorCode =
  | "login_required"
  | "challenge"
  | "browser_unavailable"
  | "timeout"
  | "not_ready"
  | "not_found"
  | "unexpected_response"
  | "verification_failed"
  | "deletion_not_confirmed"
  | "deletion_unauthorized";

export class WebSessionError extends Error {
  override readonly name: string = "WebSessionError";
  readonly code: WebErrorCode;
  constructor(code: WebErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** The session is not logged in (redirected to /login, or login failed). */
export class LoginRequiredError extends WebSessionError {
  override readonly name = "LoginRequiredError";
  constructor(message: string, options?: ErrorOptions) {
    super("login_required", message, options);
  }
}

export type ChallengeKind = "captcha" | "forbidden" | "rate_limited";

/** A captcha or verification page, a 403 or a 429. Never retried blindly. */
export class ChallengeError extends WebSessionError {
  override readonly name = "ChallengeError";
  readonly kind: ChallengeKind;
  constructor(kind: ChallengeKind, message: string) {
    super("challenge", message);
    this.kind = kind;
  }
}

export class BrowserUnavailableError extends WebSessionError {
  override readonly name = "BrowserUnavailableError";
  constructor(message: string, options?: ErrorOptions) {
    super("browser_unavailable", message, options);
  }
}

export class WebTimeoutError extends WebSessionError {
  override readonly name = "WebTimeoutError";
  constructor(operation: string, timeoutMs: number) {
    super("timeout", `web operation ${operation} timed out after ${timeoutMs} ms`);
  }
}

/**
 * The edit form never became complete (Strava's React code had not hydrated
 * it), or a form about to be POSTed lacks a required field. Nothing was sent.
 */
export class WebNotReadyError extends WebSessionError {
  override readonly name = "WebNotReadyError";
  readonly fields: string[];
  constructor(path: string, fields: string[], detail: string) {
    super("not_ready", `${path} form is not ready (${detail}): missing ${fields.join(", ")}`);
    this.fields = fields;
  }
}

export class WebNotFoundError extends WebSessionError {
  override readonly name = "WebNotFoundError";
  constructor(path: string) {
    super("not_found", `strava.com returned 404 for ${path}`);
  }
}

export class WebUnexpectedResponseError extends WebSessionError {
  override readonly name: string = "WebUnexpectedResponseError";
  constructor(message: string) {
    super("unexpected_response", message);
  }
}

/** What an export answered instead of a file (no body: it may hold page content). */
export interface ExportResponseShape {
  status: number;
  contentType: string;
  /** Path (no query) of the final URL after redirects. */
  finalPath: string;
  redirected: boolean;
  size: number;
}

/**
 * An export answered an HTML page or an empty body instead of a file. Carries
 * the response shape so callers can log it and decide whether to retry.
 */
export class WebNoFileError extends WebUnexpectedResponseError {
  override readonly name = "WebNoFileError";
  readonly response: ExportResponseShape;
  constructor(path: string, response: ExportResponseShape) {
    super(
      `${path} did not return a file (${response.status} ${response.contentType || "no content type"}, final path ${response.finalPath})`,
    );
    this.response = response;
  }
}

/** A write was sent but re-reading the form did not show the expected state. */
export class WebVerificationError extends WebSessionError {
  override readonly name = "WebVerificationError";
  readonly fields: string[];
  constructor(activityId: number, fields: string[]) {
    super(
      "verification_failed",
      `activity ${activityId}: re-read form disagrees on ${fields.join(", ")}`,
    );
    this.fields = fields;
  }
}

/** The delete request was sent but the activity still answers. */
export class DeletionNotConfirmedError extends WebSessionError {
  override readonly name = "DeletionNotConfirmedError";
  constructor(activityId: number) {
    super("deletion_not_confirmed", `activity ${activityId} still exists after delete`);
  }
}

/** deleteActivity was called without a valid, unused, matching authorization. */
export class DeletionUnauthorizedError extends WebSessionError {
  override readonly name = "DeletionUnauthorizedError";
  constructor(message: string) {
    super("deletion_unauthorized", message);
  }
}
