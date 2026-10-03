import { randomUUID } from "node:crypto";
import { type Browser, chromium, type Page } from "playwright-core";

import type { Logger } from "../logging.ts";
import { RelayError, type RelayClient } from "../relay/client.ts";
import { type Clock, systemClock } from "../strava/rate-limiter.ts";
import { classify, isLoginPath, looksLikeChallenge, parseContentDisposition } from "./classify.ts";
import { DeletionAuthorization } from "./deletion-authorization.ts";
import {
  BrowserUnavailableError,
  DeletionNotConfirmedError,
  LoginRequiredError,
  WebSessionError,
  WebTimeoutError,
  WebUnexpectedResponseError,
  WebVerificationError,
} from "./errors.ts";
import {
  buildSubmission,
  changedFields,
  type EditFormValues,
  FIELD,
  type FormEntries,
  lastValue,
  normalizeText,
  photoIds,
  readValues,
  VISIBILITIES,
  type Visibility,
} from "./forms.ts";
import { type InPageBody, inPageFetch, readActivityForm } from "./in-page.ts";

/**
 * The strava.com web session (docs/STRAVA-WEB.md). Drives the cameld-browser
 * sidecar, a real Chrome with a persistent logged-in profile, over CDP.
 *
 * Rules this class enforces:
 * - Every operation opens a NEW page in the browser's default context and
 *   closes only that page. It never closes the browser, never touches other
 *   tabs and never logs out (`disconnect()` only drops the CDP connection;
 *   an integration test proves the browser and its cookies survive it).
 * - Operations are serialized: one page at a time, in call order.
 * - Requests are sent by cameld itself (in-page fetch, credentials included)
 *   to exact URLs built from a validated numeric id. It never clicks links:
 *   the Log Out link uses the same `data-method=delete` as activity delete.
 * - Login expiry and challenges throw LoginRequiredError / ChallengeError.
 *   Nothing retries them; the caller parks work and notifies the owner.
 */

export interface ExportedFile {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

export interface EditForm {
  activityId: number;
  /** CSRF token for request headers (meta tag, else the form token). Never log it. */
  csrfToken: string;
  /** The form's own authenticity_token. Never log it. */
  authenticityToken: string;
  /** Every submittable entry, in browser order. */
  entries: FormEntries;
  values: EditFormValues;
}

export type HealthReason =
  | "login_required"
  | "challenge"
  | "athlete_menu_missing"
  | "browser_unavailable"
  | "timeout"
  | "unexpected_response";

export interface WebHealth {
  loggedIn: boolean;
  /** Null when logged in. */
  reason: HealthReason | null;
  checkedAt: number;
}

export interface DeletionResult {
  activityId: number;
  confirmedAt: number;
}

export interface DownloadedPhoto {
  bytes: Buffer;
  contentType: string;
}

export interface AttachPhotoInput {
  bytes: Buffer;
  contentType: string;
  /** When the photo was taken (from the backup's photo metadata). */
  takenAt: Date;
  /** Owner's athlete id (from the API), required by the metadata call. */
  athleteId: number;
}

export interface AttachPhotoResult {
  uuid: string;
  /** True when the re-read edit form lists the new photo. */
  verified: boolean;
}

/** What the rest of cameld depends on; the state machine tests use a fake. */
export interface StravaWebSession {
  health(): Promise<WebHealth>;
  keepAlive(): Promise<WebHealth>;
  login(): Promise<void>;
  exportOriginal(activityId: number): Promise<ExportedFile>;
  exportGpx(activityId: number): Promise<ExportedFile>;
  getEditForm(activityId: number): Promise<EditForm>;
  setVisibility(activityId: number, visibility: Visibility): Promise<EditFormValues>;
  setPrivateNote(activityId: number, text: string): Promise<EditFormValues>;
  setPerceivedExertion(
    activityId: number,
    exertion: number | null,
    prefer?: boolean,
  ): Promise<EditFormValues>;
  deleteActivity(activityId: number, authorization: DeletionAuthorization): Promise<DeletionResult>;
  downloadPhoto(url: string): Promise<DownloadedPhoto>;
  attachPhoto(activityId: number, photo: AttachPhotoInput): Promise<AttachPhotoResult>;
  disconnect(): Promise<void>;
}

export interface WebSessionOptions {
  /** BROWSER_CDP_URL. */
  cdpUrl: string;
  /** Default https://www.strava.com. Tests point this at the fake server. */
  baseUrl?: string;
  logger?: Logger;
  clock?: Clock;
  /** Login automation; without both, login() throws LoginRequiredError. */
  relay?: RelayClient;
  email?: string;
  /** Photo downloads (plain GET, no session). Default global fetch. */
  fetch?: typeof fetch;
  /** Whole-operation budget. Default 120000. */
  operationTimeoutMs?: number;
  /** Per navigation / action. Default 30000. */
  navigationTimeoutMs?: number;
  /** How long login waits for the emailed code. Default 300000. */
  codeTimeoutMs?: number;
  /**
   * Present only for a logged-in athlete. UNVERIFIED against the live site:
   * confirm on the first real session and adjust.
   */
  athleteMenuSelector?: string;
  /** Page every non-edit operation starts from. Default /dashboard. */
  landingPath?: string;
  /** Bound on closing a page, which can hang on a wedged page. Default 5000. */
  pageCloseTimeoutMs?: number;
  /** Injection point for tests. Default chromium.connectOverCDP. */
  connect?: (cdpUrl: string, timeoutMs: number) => Promise<Browser>;
}

export const DEFAULT_BASE_URL = "https://www.strava.com";
export const DEFAULT_ATHLETE_MENU_SELECTOR =
  '[data-log-category="user-menu"], .user-menu, #athlete-menu, [data-testid="user-menu"]';
const CODE_SENDER = "strava.com";

export function assertId(value: number, what = "activity id"): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${what} must be a positive integer`);
}

function timeoutAfter(ms: number, error: () => Error): { promise: Promise<never>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

interface Fetched {
  status: number;
  url: string;
  headers: Record<string, string>;
  bytes: Buffer;
}

export class WebSession implements StravaWebSession {
  readonly #options: WebSessionOptions;
  readonly #baseUrl: string;
  readonly #clock: Clock;
  readonly #log: Logger | undefined;
  readonly #operationTimeoutMs: number;
  readonly #navigationTimeoutMs: number;
  readonly #codeTimeoutMs: number;
  readonly #menuSelector: string;
  readonly #landingPath: string;
  readonly #pageCloseTimeoutMs: number;
  #browser: Browser | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #loginAttempted = false;

  constructor(options: WebSessionOptions) {
    this.#options = options;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#clock = options.clock ?? systemClock;
    this.#log = options.logger?.child({ module: "web-session" });
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 120_000;
    this.#navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
    this.#codeTimeoutMs = options.codeTimeoutMs ?? 300_000;
    this.#menuSelector = options.athleteMenuSelector ?? DEFAULT_ATHLETE_MENU_SELECTOR;
    this.#landingPath = options.landingPath ?? "/dashboard";
    this.#pageCloseTimeoutMs = options.pageCloseTimeoutMs ?? 5000;
  }

  // ---------------------------------------------------------------- health

  /** Logged in = /dashboard is not redirected to /login and the athlete menu is present. */
  health(): Promise<WebHealth> {
    return this.#run("health", this.#operationTimeoutMs, async (page) => {
      try {
        await this.#navigate(page, "/dashboard");
        const menu = await page.locator(this.#menuSelector).count();
        if (menu === 0) return this.#health("athlete_menu_missing");
        this.#loginAttempted = false;
        return this.#health(null);
      } catch (error) {
        if (error instanceof WebSessionError) return this.#health(healthReason(error));
        throw error;
      }
    }).catch((error: unknown) => {
      // Connection and timeout failures surface as unhealthy, not as throws.
      if (error instanceof WebSessionError) return this.#health(healthReason(error));
      throw error;
    });
  }

  /** Hourly keep-alive: loading /dashboard refreshes the session. */
  async keepAlive(): Promise<WebHealth> {
    const result = await this.health();
    if (result.loggedIn) this.#log?.info("strava web session alive");
    else this.#log?.warn({ reason: result.reason }, "strava web session unhealthy");
    return result;
  }

  #health(reason: HealthReason | null): WebHealth {
    return { loggedIn: reason === null, reason, checkedAt: this.#clock.now() };
  }

  // ----------------------------------------------------------------- login

  /**
   * One automated login attempt: email, then the emailed code via the relay.
   * If Strava refuses request_otp (reCAPTCHA), the code never arrives, or the
   * code is rejected, throws LoginRequiredError. After a failed attempt every
   * further call throws at once until a health check sees a live session
   * again (the owner logged in through the sidecar's VNC).
   *
   * UNVERIFIED against the live site: the selectors and the use of Enter to
   * submit each step.
   */
  login(): Promise<void> {
    const { relay, email } = this.#options;
    if (relay === undefined || email === undefined)
      return Promise.reject(new LoginRequiredError("automated login is not configured"));
    if (this.#loginAttempted)
      return Promise.reject(
        new LoginRequiredError("automated login already failed; the owner must log in"),
      );
    this.#loginAttempted = true;
    const budget = this.#codeTimeoutMs + 4 * this.#navigationTimeoutMs;
    return this.#run("login", budget, async (page) => {
      const response = await page.goto(`${this.#baseUrl}/login`, { waitUntil: "load" });
      if (!isLoginPath(new URL(page.url()).pathname)) {
        // Already logged in (the profile still had a session).
        await this.#assertLoggedIn(page);
        this.#loginAttempted = false;
        return;
      }
      if (looksLikeChallenge(await page.content()) || response?.status() === 403)
        throw new LoginRequiredError("strava.com challenged the login page");

      const since = this.#clock.now();
      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      await emailInput.fill(email);
      const otpResponse = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/login/request_otp" && r.request().method() === "POST",
      );
      await emailInput.press("Enter");
      const otp = await otpResponse;
      if (!otp.ok()) {
        this.#log?.warn({ status: otp.status() }, "strava refused request_otp");
        throw new LoginRequiredError(`strava.com refused request_otp with ${otp.status()}`);
      }

      let code: string;
      try {
        ({ code } = await relay.waitForCode({
          sender: CODE_SENDER,
          since,
          timeoutMs: this.#codeTimeoutMs,
        }));
      } catch (error) {
        if (error instanceof RelayError)
          throw new LoginRequiredError("login code did not arrive through the relay", {
            cause: error,
          });
        throw error;
      }

      const codeInput = page
        .locator('input[autocomplete="one-time-code"], input[name="otp"], input[name="code"]')
        .first();
      await codeInput.fill(code);
      await Promise.all([
        page.waitForURL((url) => !isLoginPath(url.pathname), {
          timeout: this.#navigationTimeoutMs,
        }),
        codeInput.press("Enter"),
      ]).catch((error: unknown) => {
        throw new LoginRequiredError("strava.com did not accept the login code", { cause: error });
      });
      await this.#assertLoggedIn(page);
      this.#loginAttempted = false;
      this.#log?.info("strava web login succeeded");
    });
  }

  async #assertLoggedIn(page: Page): Promise<void> {
    await this.#navigate(page, "/dashboard");
    if ((await page.locator(this.#menuSelector).count()) === 0)
      throw new LoginRequiredError("logged-in athlete menu is missing");
  }

  // ---------------------------------------------------------------- export

  async exportOriginal(activityId: number): Promise<ExportedFile> {
    return this.#export(activityId, "export_original", "bin");
  }

  async exportGpx(activityId: number): Promise<ExportedFile> {
    return this.#export(activityId, "export_gpx", "gpx");
  }

  async #export(activityId: number, action: string, extension: string): Promise<ExportedFile> {
    assertId(activityId);
    const path = `/activities/${activityId}/${action}`;
    return this.#run(action, this.#operationTimeoutMs, async (page) => {
      await this.#navigate(page, this.#landingPath);
      const response = await this.#fetch(page, "GET", path, { kind: "none" });
      const contentType = response.headers["content-type"] ?? "application/octet-stream";
      if (contentType.startsWith("text/html") || response.bytes.length === 0)
        throw new WebUnexpectedResponseError(`${path} did not return a file`);
      const filename =
        parseContentDisposition(response.headers["content-disposition"]) ??
        `${activityId}.${extension}`;
      this.#log?.info({ activityId, action, size: response.bytes.length }, "exported file");
      return { bytes: response.bytes, filename, contentType };
    });
  }

  // ------------------------------------------------------------------ edit

  async getEditForm(activityId: number): Promise<EditForm> {
    assertId(activityId);
    return this.#run("get_edit_form", this.#operationTimeoutMs, (page) =>
      this.#readForm(page, activityId),
    );
  }

  async setVisibility(activityId: number, visibility: Visibility): Promise<EditFormValues> {
    if (!VISIBILITIES.includes(visibility)) throw new RangeError("unknown visibility");
    return this.#update(activityId, "set_visibility", [[FIELD.visibility, visibility]]);
  }

  async setPrivateNote(activityId: number, text: string): Promise<EditFormValues> {
    return this.#update(activityId, "set_private_note", [[FIELD.privateNote, text]]);
  }

  /** `exertion` 1 to 10, or null to clear it. `prefer` uses it over heart-rate effort. */
  async setPerceivedExertion(
    activityId: number,
    exertion: number | null,
    prefer = true,
  ): Promise<EditFormValues> {
    if (exertion !== null && (!Number.isInteger(exertion) || exertion < 1 || exertion > 10))
      throw new RangeError("perceived exertion must be an integer from 1 to 10");
    return this.#update(activityId, "set_perceived_exertion", [
      [FIELD.perceivedExertion, exertion === null ? "" : String(exertion)],
      [FIELD.preferPerceivedExertion, prefer ? "1" : "0"],
    ]);
  }

  /**
   * Read the form, POST it back with `_method=patch`, the CSRF token and
   * EVERY existing entry except `changes`, then re-read and verify that the
   * changed fields hold the new values and nothing else moved.
   */
  async #update(
    activityId: number,
    operation: string,
    changes: FormEntries,
  ): Promise<EditFormValues> {
    assertId(activityId);
    return this.#run(operation, this.#operationTimeoutMs, async (page) => {
      const before = await this.#readForm(page, activityId);
      await this.#submit(page, before, "patch", changes);
      const after = await this.#readForm(page, activityId);
      const expected = new Map(changes);
      const wrong = changedFields(before.entries, after.entries).filter(
        (name) => !expected.has(name),
      );
      for (const [name, value] of changes) {
        if (normalizeText(lastValue(after.entries, name) ?? "") !== normalizeText(value))
          wrong.push(name);
      }
      if (wrong.length > 0) throw new WebVerificationError(activityId, wrong);
      this.#log?.info(
        { activityId, operation, fields: changes.map(([name]) => name) },
        "activity edited",
      );
      return after.values;
    });
  }

  async #readForm(page: Page, activityId: number): Promise<EditForm> {
    const path = `/activities/${activityId}/edit`;
    await this.#navigate(page, path);
    const snapshot = await page.evaluate(readActivityForm, `/activities/${activityId}`);
    const authenticityToken =
      snapshot === null ? null : lastValue(snapshot.entries, "authenticity_token");
    if (snapshot === null || authenticityToken === null || authenticityToken === "")
      throw new WebUnexpectedResponseError(`${path} has no activity form`);
    return {
      activityId,
      csrfToken: snapshot.csrfToken ?? authenticityToken,
      authenticityToken,
      entries: snapshot.entries,
      values: readValues(snapshot.entries),
    };
  }

  async #submit(
    page: Page,
    form: EditForm,
    method: "patch" | "delete",
    changes: FormEntries = [],
    allowNotFound = false,
  ): Promise<Fetched> {
    return this.#fetch(
      page,
      "POST",
      `/activities/${form.activityId}`,
      {
        kind: "form",
        entries: buildSubmission(form.entries, form.authenticityToken, method, changes),
      },
      { "x-csrf-token": form.csrfToken, accept: "text/html" },
      allowNotFound,
    );
  }

  // ---------------------------------------------------------------- delete

  /**
   * Delete one activity. `authorization` is checked and spent BEFORE anything
   * is sent (see deletion-authorization.ts); only the state machine mints it.
   * Sends `POST /activities/<id>` with `_method=delete` and the CSRF token,
   * never clicks a link, then confirms the activity answers 404 or redirects
   * away. Throws DeletionNotConfirmedError when it still answers.
   */
  async deleteActivity(
    activityId: number,
    authorization: DeletionAuthorization,
  ): Promise<DeletionResult> {
    assertId(activityId);
    DeletionAuthorization.consume(authorization, activityId, this.#clock.now());
    return this.#run("delete_activity", this.#operationTimeoutMs, async (page) => {
      const form = await this.#readForm(page, activityId);
      this.#log?.warn(
        { activityId, reason: authorization.reason, snapshot: authorization.snapshot },
        "deleting strava activity",
      );
      await this.#submit(page, form, "delete", [], true);
      const path = `/activities/${activityId}`;
      const check = await this.#fetch(page, "GET", path, { kind: "none" }, {}, true);
      const stillThere = check.status !== 404 && new URL(check.url).pathname === path;
      if (stillThere) throw new DeletionNotConfirmedError(activityId);
      this.#log?.warn({ activityId }, "strava activity deleted");
      return { activityId, confirmedAt: this.#clock.now() };
    });
  }

  // ---------------------------------------------------------------- photos

  /** Full-size photo from the API's photo list: a plain GET, no session needed. */
  async downloadPhoto(url: string): Promise<DownloadedPhoto> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new RangeError("photo url must be http(s)");
    const fetchFn = this.#options.fetch ?? fetch;
    const response = await fetchFn(parsed);
    if (!response.ok)
      throw new WebUnexpectedResponseError(`photo download returned ${response.status}`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /**
   * Attach a photo the way the edit page's JS does. UNVERIFIED until the
   * first real upload (docs/STRAVA-WEB.md): the metadata body (media_type 1
   * for a photo, location null), the presigned upload host and headers, and
   * whether the edit form lists the new photo afterwards (hence `verified`).
   *
   * 1. `PUT /photos/metadata` -> `{uri, header}`
   * 2. `PUT <uri>` with the bytes and the returned headers
   * 3. save the edit form with `photos[<uuid>][rank|media_type|caption]`
   */
  async attachPhoto(activityId: number, photo: AttachPhotoInput): Promise<AttachPhotoResult> {
    assertId(activityId);
    assertId(photo.athleteId, "athlete id");
    if (Number.isNaN(photo.takenAt.getTime())) throw new RangeError("takenAt is not a date");
    return this.#run("attach_photo", this.#operationTimeoutMs, async (page) => {
      const form = await this.#readForm(page, activityId);
      const uuid = randomUUID();
      const meta = await this.#fetch(
        page,
        "PUT",
        "/photos/metadata",
        {
          kind: "json",
          text: JSON.stringify({
            athlete_id: photo.athleteId,
            uuid,
            taken_at: photo.takenAt.toISOString(),
            media_type: 1,
            location: null,
          }),
        },
        {
          "content-type": "application/json",
          accept: "application/json",
          "x-csrf-token": form.csrfToken,
        },
      );
      const target = parseUploadTarget(meta.bytes);
      await this.#fetch(
        page,
        "PUT",
        target.uri,
        { kind: "bytes", base64: photo.bytes.toString("base64") },
        { "content-type": photo.contentType, ...target.header },
        false,
        "omit",
      );
      const rank = photoIds(form.entries).length + 1;
      await this.#submit(page, form, "patch", [
        [`photos[${uuid}][rank]`, String(rank)],
        [`photos[${uuid}][media_type]`, "1"],
        [`photos[${uuid}][caption]`, ""],
      ]);
      const after = await this.#readForm(page, activityId);
      const verified = photoIds(after.entries).includes(uuid);
      this.#log?.info({ activityId, verified }, "photo attached");
      return { uuid, verified };
    });
  }

  // ------------------------------------------------------------ plumbing

  /**
   * Drop the CDP connection. On a connectOverCDP browser, Browser.close()
   * only disconnects: the sidecar Chrome, its tabs and its cookies survive.
   */
  async disconnect(): Promise<void> {
    await this.#queue;
    const browser = this.#browser;
    this.#browser = null;
    if (browser !== null && browser.isConnected()) await browser.close();
  }

  /** Serialize: each operation starts after the previous one settled. */
  #run<T>(operation: string, timeoutMs: number, work: (page: Page) => Promise<T>): Promise<T> {
    const result = this.#queue.then(() => this.#execute(operation, timeoutMs, work));
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #execute<T>(
    operation: string,
    timeoutMs: number,
    work: (page: Page) => Promise<T>,
  ): Promise<T> {
    const deadline = timeoutAfter(timeoutMs, () => new WebTimeoutError(operation, timeoutMs));
    const state: { page: Page | null; settled: boolean } = { page: null, settled: false };
    try {
      const opened = (async () => {
        const browser = await this.#connection();
        const context = browser.contexts()[0];
        if (context === undefined)
          throw new BrowserUnavailableError("browser has no default context");
        const page = await context.newPage();
        state.page = page;
        // The deadline passed while the page was opening: close it right away.
        if (state.settled) await closeQuietly(page, this.#pageCloseTimeoutMs);
        page.setDefaultTimeout(this.#navigationTimeoutMs);
        return work(page);
      })();
      return await Promise.race([opened, deadline.promise]);
    } catch (error) {
      if (error instanceof WebSessionError)
        this.#log?.warn({ operation, code: error.code, err: error }, "web operation failed");
      throw error;
    } finally {
      state.settled = true;
      deadline.cancel();
      if (state.page !== null) await closeQuietly(state.page, this.#pageCloseTimeoutMs);
    }
  }

  async #connection(): Promise<Browser> {
    if (this.#browser !== null && this.#browser.isConnected()) return this.#browser;
    const connect =
      this.#options.connect ??
      ((url: string, timeout: number) => chromium.connectOverCDP(url, { timeout }));
    try {
      const browser = await connect(this.#options.cdpUrl, this.#navigationTimeoutMs);
      this.#browser = browser;
      return browser;
    } catch (error) {
      throw new BrowserUnavailableError("cannot reach the browser over CDP", { cause: error });
    }
  }

  async #navigate(page: Page, path: string): Promise<void> {
    const response = await page.goto(`${this.#baseUrl}${path}`, { waitUntil: "domcontentloaded" });
    const status = response === null ? 200 : response.status();
    const html = await page.content();
    const error = classify({ status, url: page.url(), html }, { path });
    if (error !== null) throw error;
  }

  async #fetch(
    page: Page,
    method: string,
    target: string,
    body: InPageBody,
    headers: Record<string, string> = {},
    allowNotFound = false,
    credentials: "include" | "omit" = "include",
  ): Promise<Fetched> {
    const url = new URL(target, this.#baseUrl).toString();
    const response = await page.evaluate(inPageFetch, {
      url,
      method,
      headers,
      body,
      credentials,
    });
    const bytes = Buffer.from(response.bodyBase64, "base64");
    const isHtml = (response.headers["content-type"] ?? "").startsWith("text/html");
    const path = new URL(url).pathname;
    const error = classify(
      { status: response.status, url: response.url, html: isHtml ? bytes.toString("utf8") : "" },
      { path, allowNotFound },
    );
    if (error !== null) throw error;
    return { status: response.status, url: response.url, headers: response.headers, bytes };
  }
}

function healthReason(error: WebSessionError): HealthReason {
  switch (error.code) {
    case "login_required":
    case "challenge":
    case "browser_unavailable":
    case "timeout":
      return error.code;
    default:
      return "unexpected_response";
  }
}

/** page.close() on a wedged page can hang; bound it and swallow failures. */
async function closeQuietly(page: Page, timeoutMs: number): Promise<void> {
  const bound = timeoutAfter(timeoutMs, () => new Error("page close timed out"));
  try {
    await Promise.race([page.close(), bound.promise]);
  } catch {
    // The page is already gone or the browser went away; nothing to undo.
  } finally {
    bound.cancel();
  }
}

/** Validate the `{uri, header}` answer of PUT /photos/metadata. */
export function parseUploadTarget(body: Buffer): { uri: string; header: Record<string, string> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new WebUnexpectedResponseError("photo metadata answer is not JSON");
  }
  const { uri, header = {} } = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    uri?: unknown;
    header?: unknown;
  };
  if (
    typeof uri !== "string" ||
    typeof header !== "object" ||
    header === null ||
    !Object.values(header).every((value) => typeof value === "string")
  )
    throw new WebUnexpectedResponseError("photo metadata answer has no upload target");
  return { uri, header: header as Record<string, string> };
}
