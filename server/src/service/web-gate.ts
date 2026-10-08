import type { Logger } from "../logging.ts";
import { ChallengeError, LoginRequiredError } from "../web/errors.ts";
import type { RemediationReport } from "../web/cdp-remediation.ts";
import type { StravaWebSession, WebHealth } from "../web/session.ts";
import type { Metrics } from "./metrics.ts";
import { type Notification, type Notifier, notifySafely } from "./notifier.ts";

/**
 * Gatekeeper for every strava.com web action (ARCHITECTURE.md section 5,
 * "Captcha or verification challenge"). When the session is logged out or
 * challenged, all web actions pause until a health check sees a live session
 * again; API work (backups) is unaffected. The owner is notified once per
 * outage and per kind of outage: a login problem (log in through the VNC
 * view) and an unreachable browser (restart the sidecar) need different
 * actions, so a login outage that turns into a browser outage, or the other
 * way round, notifies again. Without a configured browser the gate is
 * permanently closed.
 */

type OutageKind = "login" | "browser";

function outageKind(reason: string): OutageKind {
  return reason === "browser_unavailable" ? "browser" : "login";
}

function outageNotification(reason: string): Notification {
  if (outageKind(reason) === "browser")
    return {
      kind: "browser_unavailable",
      level: "critical",
      title: "Strava browser is unreachable",
      body: "Web actions are paused: cameld cannot attach to the browser sidecar. Restart the cameld-browser container.",
    };
  return {
    kind: "login_unhealthy",
    level: "warning",
    title: "Strava web login needs attention",
    body: `Web actions are paused (${reason}). Log in through the browser sidecar.`,
  };
}

/** The owner notification for one hung-tab remediation (WebSession onRemediation). */
export function remediationNotification(report: RemediationReport): Notification {
  const closed = report.closed.length;
  if (report.outcome === "recovered")
    return {
      kind: "browser_remediated",
      level: "warning",
      title: "Browser recovered from a hung tab",
      body: `cameld closed ${closed} unresponsive tab${closed === 1 ? "" : "s"} in the browser sidecar and reconnected. Nothing else was touched.`,
    };
  return {
    kind: "browser_restart_needed",
    level: "critical",
    title: "Browser sidecar needs a manual restart",
    body: `cameld could not recover the browser over CDP (closed ${closed} unresponsive tab${closed === 1 ? "" : "s"}). Restart the cameld-browser container; web actions stay paused until then.`,
  };
}

/** WebSession's onRemediation: count it and tell the owner. Never throws. */
export function remediationReporter(deps: {
  notifier: Notifier;
  metrics?: Metrics;
  log?: Logger;
}): (report: RemediationReport) => Promise<void> {
  return async (report) => {
    deps.metrics?.webRemediations.inc({ result: report.outcome });
    await notifySafely(deps.notifier, remediationNotification(report), deps.log);
  };
}

export class WebPausedError extends Error {
  override readonly name = "WebPausedError";
}

export interface WebGateOptions {
  session: StravaWebSession | null;
  notifier: Notifier;
  log?: Logger;
  metrics?: Metrics;
  now?: () => number;
}

export class WebGate {
  readonly #session: StravaWebSession | null;
  readonly #notifier: Notifier;
  readonly #log: Logger | undefined;
  readonly #metrics: Metrics | undefined;
  readonly #now: () => number;
  #healthy: boolean;
  #reason: string | null;
  #notified: OutageKind | null = null;

  constructor(options: WebGateOptions) {
    this.#session = options.session;
    this.#notifier = options.notifier;
    this.#log = options.log;
    this.#metrics = options.metrics;
    this.#now = options.now ?? Date.now;
    // Optimistic until proven otherwise: the first web action or keepalive tells.
    this.#healthy = options.session !== null;
    this.#reason = options.session === null ? "no_browser" : null;
    this.#metrics?.setWebLogin(this.#healthy);
  }

  available(): boolean {
    return this.#session !== null && this.#healthy;
  }

  status(): { healthy: boolean; reason: string | null } {
    return { healthy: this.available(), reason: this.#reason };
  }

  async #markUnhealthy(reason: string): Promise<void> {
    const wasHealthy = this.#healthy;
    this.#healthy = false;
    this.#reason = reason;
    this.#metrics?.setWebLogin(false);
    if (wasHealthy) this.#log?.warn({ reason }, "web session unhealthy; web actions paused");
    const kind = outageKind(reason);
    if (this.#notified === kind) return;
    this.#notified = kind;
    await notifySafely(this.#notifier, outageNotification(reason), this.#log);
  }

  #markHealthy(): void {
    if (!this.#healthy) this.#log?.info("web session healthy again; web actions resume");
    this.#healthy = true;
    this.#reason = null;
    this.#notified = null;
    this.#metrics?.setWebLogin(true);
  }

  /**
   * Run a web action. Throws WebPausedError (nothing sent) while paused. A
   * login or challenge failure pauses the gate and is rethrown.
   */
  async run<T>(action: (session: StravaWebSession) => Promise<T>): Promise<T> {
    const session = this.#session;
    if (session === null || !this.#healthy) {
      throw new WebPausedError(`web actions are paused (${String(this.#reason)})`);
    }
    try {
      return await action(session);
    } catch (error) {
      if (error instanceof LoginRequiredError) await this.#markUnhealthy("login_required");
      else if (error instanceof ChallengeError)
        await this.#markUnhealthy(`challenge_${error.kind}`);
      throw error;
    }
  }

  /**
   * Hourly keepalive. While healthy it loads the dashboard; on expiry it tries
   * ONE automatic login. While unhealthy it only checks health, so a manual
   * login by the owner is noticed without retrying the automatic one.
   */
  async keepAlive(): Promise<WebHealth | null> {
    const session = this.#session;
    if (session === null) return null;
    let health: WebHealth;
    try {
      health = this.#healthy ? await session.keepAlive() : await session.health();
    } catch (error) {
      this.#log?.warn({ err: error }, "web keepalive failed");
      await this.#markUnhealthy("keepalive_failed");
      return null;
    }
    if (health.loggedIn) {
      this.#markHealthy();
      return health;
    }
    if (this.#healthy && health.reason === "login_required") {
      try {
        await session.login();
        this.#markHealthy();
        return { loggedIn: true, reason: null, checkedAt: this.#now() };
      } catch (error) {
        this.#log?.warn({ err: error }, "automatic web login failed");
      }
    }
    await this.#markUnhealthy(String(health.reason));
    return health;
  }
}
