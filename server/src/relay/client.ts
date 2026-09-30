import type { Logger } from "../logging.ts";
import { type Clock, systemClock } from "../strava/rate-limiter.ts";

/**
 * Client for the email-code relay Worker (see relay/ and docs/ARCHITECTURE.md
 * section 3). The strava.com web login asks Strava to email a code, records
 * `since` just before, then waits here for the relay to have received it.
 */

export class RelayError extends Error {
  override readonly name: string = "RelayError";
}

/** The relay refused the token. Polling cannot fix this, so it is thrown at once. */
export class RelayAuthError extends RelayError {
  override readonly name = "RelayAuthError";
}

export class RelayTimeoutError extends RelayError {
  override readonly name = "RelayTimeoutError";
}

export interface RelayCode {
  code: string;
  /** Epoch ms at which the relay received the mail. */
  receivedAt: number;
}

export interface ForwardingConfirmation {
  code: string | null;
  url: string | null;
  receivedAt: number;
}

export interface WaitForCodeOptions {
  /** Sender domain, e.g. "strava.com". */
  sender: string;
  /** Epoch ms; only codes received strictly after this are returned. */
  since: number;
  timeoutMs: number;
}

export interface RelayClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  clock?: Clock;
  logger?: Logger;
  /** Default 5000. */
  pollIntervalMs?: number;
}

export interface RelayClient {
  /** Poll until a code arrives; throws RelayTimeoutError after `timeoutMs`. */
  waitForCode(options: WaitForCodeOptions): Promise<RelayCode>;
  /** Claim Gmail's forwarding confirmation, once. Null when none is waiting. */
  getForwardingConfirmation(): Promise<ForwardingConfirmation | null>;
}

export const DEFAULT_POLL_INTERVAL_MS = 5000;

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const fetchFn = options.fetch ?? fetch;
  const clock = options.clock ?? systemClock;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const log = options.logger?.child({ module: "relay" });

  /** One GET. Returns the parsed body, or null on 204. Never puts the token in errors. */
  async function get<T>(path: string): Promise<T | null> {
    const response = await fetchFn(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${options.token}` },
    });
    if (response.status === 204) return null;
    if (response.status === 401) throw new RelayAuthError("relay rejected the token");
    if (!response.ok)
      throw new RelayError(`relay returned ${response.status} for ${path.split("?")[0]}`);
    return (await response.json()) as T;
  }

  return {
    async waitForCode({ sender, since, timeoutMs }) {
      const query = new URLSearchParams({ sender, since: String(since) });
      const deadline = clock.now() + timeoutMs;
      for (;;) {
        try {
          const found = await get<RelayCode>(`/codes/next?${query.toString()}`);
          if (found !== null) {
            log?.info({ sender, waitedMs: clock.now() - since }, "relay code received");
            return found;
          }
        } catch (error) {
          if (error instanceof RelayAuthError) throw error;
          // Transient (network, 5xx): keep polling until the deadline.
          log?.warn({ err: error }, "relay poll failed");
        }
        const remaining = deadline - clock.now();
        if (remaining <= 0) {
          throw new RelayTimeoutError(`no ${sender} code arrived within ${timeoutMs} ms`);
        }
        await clock.sleep(Math.min(interval, remaining));
      }
    },

    getForwardingConfirmation() {
      return get<ForwardingConfirmation>("/forwarding-confirmation");
    },
  };
}
