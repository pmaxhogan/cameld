import type { Logger } from "../logging.ts";

/**
 * Hung-tab remediation for the cameld-browser sidecar (docs/STRAVA-WEB.md,
 * "Hung tabs"). After a sidecar restart a restored tab can stop answering
 * CDP: `connectOverCDP` attaches to every page and waits for each one to
 * initialize, so ONE wedged renderer makes every connect time out while the
 * HTTP endpoints (`/json/version`, `/json/list`) still answer.
 *
 * The fix, all over the DevTools HTTP endpoints and per-target websockets:
 * probe every `page` target with `Runtime.evaluate("1")`, open `about:blank`
 * FIRST (so the window never loses its last tab and Chrome never exits),
 * then close only the pages that failed the probe. `browser_ui`, service
 * workers and every other target type are never probed or touched, and a
 * page that answered is never closed.
 *
 * This is the one narrow exception to "never touch other tabs". It runs only
 * from WebSession's connection step, which already sits inside the session's
 * one-operation-at-a-time queue.
 */

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * responsive: the page answered the probe. unresponsive: its websocket
 * opened but the probe got no answer in time (a wedged renderer).
 * unreachable: no websocket URL, or the socket failed, never opened or was
 * dropped by the browser; that proves nothing about the page, so it is not
 * closed.
 */
export type ProbeResult = "responsive" | "unresponsive" | "unreachable";

export interface ProbedTarget {
  id: string;
  /** Origin and path only: query strings and fragments are dropped. */
  url: string;
  result: ProbeResult;
}

export interface RemediationPlan {
  /** Open about:blank before closing anything. True exactly when something is closed. */
  openBlank: boolean;
  close: string[];
}

export interface RemediationReport {
  /** recovered: the retried connect succeeded. failed: it did not (or remediation broke). */
  outcome: "recovered" | "failed";
  probed: ProbedTarget[];
  openedBlank: boolean;
  closed: ProbedTarget[];
  /** Ids that were closed but were still listed when the wait ran out. */
  stillListed: string[];
  /** Short reason when the outcome is failed. Never carries credentials. */
  error?: string;
}

/** Default floor between two remediations. */
export const DEFAULT_REMEDIATION_INTERVAL_MS = 30 * 60_000;
/** Default bound on one page probe. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

const NEVER_CLOSE_SCHEMES = ["chrome:", "chrome-untrusted:", "devtools:", "chrome-extension:"];

/** Only ordinary web pages are candidates: never browser UI, workers or chrome:// pages. */
export function isCandidate(target: CdpTarget): boolean {
  if (target.type !== "page") return false;
  return !NEVER_CLOSE_SCHEMES.some((scheme) => target.url.startsWith(scheme));
}

/** Pure decision: close what failed the probe, and open a blank tab first if anything is closed. */
export function planRemediation(probed: readonly ProbedTarget[]): RemediationPlan {
  const close = probed.filter((p) => p.result === "unresponsive").map((p) => p.id);
  return { openBlank: close.length > 0, close };
}

/** Pure rate limit: true when no remediation ran within `intervalMs` before `now`. */
export function remediationAllowed(
  lastAt: number | null,
  now: number,
  intervalMs: number,
): boolean {
  return lastAt === null || now - lastAt >= intervalMs;
}

/** Origin and path of a target URL, for logs. about:blank and other opaque URLs stay as is. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.origin === "null") return `${parsed.protocol}${parsed.pathname}`;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

/** The DevTools HTTP base for a CDP URL (`ws://` and `wss://` map to http and https). */
export function httpBase(cdpUrl: string): URL {
  const url = new URL(cdpUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.search = "";
  url.hash = "";
  return url;
}

export interface CdpHttpOptions {
  cdpUrl: string;
  fetch?: typeof fetch;
  /** Bound on each HTTP call. Default 5000. */
  timeoutMs?: number;
}

/** The DevTools HTTP endpoints of one browser. */
export class CdpHttp {
  readonly #base: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: CdpHttpOptions) {
    this.#base = httpBase(options.cdpUrl);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  async #call(path: string, method = "GET"): Promise<Response> {
    const response = await this.#fetch(new URL(path, this.#base), {
      method,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok)
      throw new Error(`devtools ${method} /${path.split("?")[0]} answered ${response.status}`);
    return response;
  }

  /** True when `/json/version` answers: the browser process is up even if CDP attach hangs. */
  async answers(): Promise<boolean> {
    try {
      await (await this.#call("json/version")).arrayBuffer();
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<CdpTarget[]> {
    const body: unknown = await (await this.#call("json/list")).json();
    if (!Array.isArray(body)) throw new Error("devtools /json/list is not a list");
    return body.filter(
      (t): t is CdpTarget =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as CdpTarget).id === "string" &&
        typeof (t as CdpTarget).type === "string" &&
        typeof (t as CdpTarget).url === "string",
    );
  }

  /** `PUT /json/new?about:blank`; returns the new target's id. */
  async openBlank(): Promise<string> {
    const body = (await (await this.#call("json/new?about:blank", "PUT")).json()) as {
      id?: unknown;
    };
    if (typeof body.id !== "string") throw new Error("devtools /json/new returned no target id");
    return body.id;
  }

  async close(id: string): Promise<void> {
    await (await this.#call(`json/close/${encodeURIComponent(id)}`)).arrayBuffer();
  }
}

/**
 * Ask one page target to evaluate `1` over its own websocket. Answers are
 * matched by id (other targets emit events first). The socket is closed on
 * every path.
 */
export function probeTarget(wsUrl: string | undefined, timeoutMs: number): Promise<ProbeResult> {
  if (wsUrl === undefined || wsUrl === "") return Promise.resolve("unreachable");
  let socket: WebSocket;
  try {
    socket = new WebSocket(wsUrl);
  } catch {
    return Promise.resolve("unreachable");
  }
  return new Promise((resolve) => {
    let opened = false;
    const finish = (result: ProbeResult): void => {
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    // Only silence on an OPEN socket counts as unresponsive.
    const timer = setTimeout(() => finish(opened ? "unresponsive" : "unreachable"), timeoutMs);
    socket.addEventListener("open", () => {
      opened = true;
      socket.send(
        JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1" } }),
      );
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (isAnswer(event.data)) finish("responsive");
    });
    // The browser dropped the socket: that is not proof of a wedged page.
    socket.addEventListener("close", () => finish("unreachable"));
  });
}

function isAnswer(data: unknown): boolean {
  try {
    return (JSON.parse(String(data)) as { id?: unknown }).id === 1;
  } catch {
    return false;
  }
}

export interface RemediateOptions {
  http: CdpHttp;
  probeTimeoutMs?: number;
  /** How long to wait for closed targets to leave /json/list. Default 5000. */
  closeWaitMs?: number;
  log?: Logger | undefined;
  /** Injection point for tests. Default probeTarget. */
  probe?: (wsUrl: string | undefined, timeoutMs: number) => Promise<ProbeResult>;
  sleep?: (ms: number) => Promise<void>;
}

export interface TabRemediation {
  probed: ProbedTarget[];
  openedBlank: boolean;
  closed: ProbedTarget[];
  stillListed: string[];
}

/** Probe every candidate page, open about:blank, close the unresponsive ones, wait for them to go. */
export async function remediateHungTabs(options: RemediateOptions): Promise<TabRemediation> {
  const { http } = options;
  const probe = options.probe ?? probeTarget;
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const candidates = (await http.list()).filter(isCandidate);
  const probed = await Promise.all(
    candidates.map(async (t) => ({
      id: t.id,
      url: safeUrl(t.url),
      result: await probe(t.webSocketDebuggerUrl, timeoutMs),
    })),
  );
  const plan = planRemediation(probed);
  if (plan.openBlank) {
    const blank = await http.openBlank();
    options.log?.warn({ target: blank }, "opened a blank tab before closing unresponsive tabs");
  }
  const closed: ProbedTarget[] = [];
  for (const id of plan.close) {
    const target = probed.find((p) => p.id === id) as ProbedTarget;
    await http.close(id);
    closed.push(target);
    options.log?.warn(
      { target: id, url: target.url, reason: "no answer to Runtime.evaluate" },
      "closed an unresponsive browser tab",
    );
  }
  let stillListed: string[] = [];
  if (plan.close.length > 0) {
    const deadline = Date.now() + (options.closeWaitMs ?? 5000);
    for (;;) {
      const listed = new Set((await http.list()).map((t) => t.id));
      stillListed = plan.close.filter((id) => listed.has(id));
      if (stillListed.length === 0 || Date.now() >= deadline) break;
      await sleep(200);
    }
  }
  return { probed, openedBlank: plan.openBlank, closed, stillListed };
}
