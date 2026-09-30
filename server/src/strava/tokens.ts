import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logging.ts";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Access token expiry, epoch seconds. */
  expiresAt: number;
}

/**
 * Persistence for the OAuth tokens. `save` must be atomic: after it returns
 * the new refresh token is durable, and a crash can never leave a half-written
 * or missing token.
 */
export interface TokenStore {
  load(): StoredTokens | null;
  save(tokens: StoredTokens): void;
}

export class SqliteTokenStore implements TokenStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  load(): StoredTokens | null {
    const row = this.#db
      .prepare("SELECT access_token, refresh_token, expires_at FROM strava_tokens WHERE id = 1")
      .get();
    if (row === undefined) return null;
    return {
      accessToken: row.access_token as string,
      refreshToken: row.refresh_token as string,
      expiresAt: row.expires_at as number,
    };
  }

  save(tokens: StoredTokens): void {
    // A single upsert statement is atomic in SQLite; WAL + synchronous default
    // keeps it durable across a process crash.
    this.#db
      .prepare(
        `INSERT INTO strava_tokens (id, access_token, refresh_token, expires_at, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(tokens.accessToken, tokens.refreshToken, tokens.expiresAt, new Date().toISOString());
  }
}

export class StravaAuthError extends Error {
  override readonly name = "StravaAuthError";
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

export interface TokenManagerOptions {
  clientId: string;
  clientSecret: string;
  store: TokenStore;
  /** Used only when the store is empty (first run). */
  initialRefreshToken?: string;
  fetch?: typeof fetch;
  /** Epoch milliseconds. */
  now?: () => number;
  /** Refresh when fewer than this many seconds remain. Default 600. */
  refreshWindowSeconds?: number;
  tokenUrl?: string;
  logger?: Logger;
}

const DEFAULT_TOKEN_URL = "https://www.strava.com/oauth/token";

/**
 * Hands out a valid access token, refreshing when under ten minutes remain.
 * Refresh is single-flight: concurrent callers share one request, so the
 * rotated refresh token is never spent twice. The new refresh token is
 * persisted before the access token is returned. Tokens are never logged and
 * never appear in error messages.
 */
export class TokenManager {
  readonly #opts: TokenManagerOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #inflight: Promise<StoredTokens> | null = null;

  constructor(options: TokenManagerOptions) {
    this.#opts = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const current = this.#opts.store.load();
    const windowSeconds = this.#opts.refreshWindowSeconds ?? 600;
    if (current !== null && current.expiresAt - this.#now() / 1000 >= windowSeconds) {
      return current.accessToken;
    }
    return (await this.#refresh(current)).accessToken;
  }

  /** Force a refresh (for example after a 401). */
  async forceRefresh(): Promise<string> {
    return (await this.#refresh(this.#opts.store.load())).accessToken;
  }

  #refresh(current: StoredTokens | null): Promise<StoredTokens> {
    if (this.#inflight !== null) return this.#inflight;
    const refreshToken = current?.refreshToken ?? this.#opts.initialRefreshToken;
    if (refreshToken === undefined || refreshToken === "") {
      return Promise.reject(new StravaAuthError("No Strava refresh token is available"));
    }
    const promise = this.#doRefresh(refreshToken).finally(() => {
      this.#inflight = null;
    });
    this.#inflight = promise;
    return promise;
  }

  async #doRefresh(refreshToken: string): Promise<StoredTokens> {
    const body = new URLSearchParams({
      client_id: this.#opts.clientId,
      client_secret: this.#opts.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    let response: Response;
    try {
      response = await this.#fetch(this.#opts.tokenUrl ?? DEFAULT_TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
      });
    } catch {
      throw new StravaAuthError("Strava token refresh failed: network error");
    }
    if (!response.ok) {
      throw new StravaAuthError(
        `Strava token refresh failed with HTTP ${response.status}`,
        response.status,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new StravaAuthError("Strava token refresh returned an unreadable body");
    }
    const data = json as Record<string, unknown> | null;
    const access = data?.access_token;
    const refresh = data?.refresh_token;
    const expires = data?.expires_at;
    if (
      typeof access !== "string" ||
      typeof refresh !== "string" ||
      typeof expires !== "number" ||
      access === "" ||
      refresh === ""
    ) {
      throw new StravaAuthError("Strava token refresh returned an unexpected shape");
    }
    const tokens: StoredTokens = { accessToken: access, refreshToken: refresh, expiresAt: expires };
    // Persist the rotated refresh token before anything else can use it.
    this.#opts.store.save(tokens);
    this.#opts.logger?.info({ expiresAt: expires }, "strava token refreshed");
    return tokens;
  }
}
