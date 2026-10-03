import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Config } from "../config.ts";
import type { Logger } from "../logging.ts";
import { ACCESS_COOKIE, ACCESS_HEADER, AccessVerifier } from "./access.ts";
import { parsePasswordHash, verifyPassword } from "./password.ts";

/**
 * The two gates in front of the UI and every /api route (ARCHITECTURE.md
 * section 8, "Access"), both required:
 *
 * 1. Cloudflare Access: a verified JWT for ALLOWED_EMAIL (access.ts).
 * 2. The secondary backup password: POST /login checks it against
 *    UI_PASSWORD_HASH and sets a stateless HMAC session cookie for 90 days.
 *
 * The session is bound to the Access identity and to the password hash, so
 * rotating UI_PASSWORD_HASH or SESSION_SECRET revokes every session. Missing
 * configuration fails closed: every request is refused.
 */

export const SESSION_COOKIE = "cameld_session";
export const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
const MIN_SECRET_LENGTH = 32;

export type LoginResult =
  | { ok: true; cookie: string }
  | { ok: false; reason: "wrong_password" | "rate_limited" | "unconfigured" };

export interface Gate {
  /** The verified Cloudflare Access identity of a request, or null. */
  identify(headers: IncomingHttpHeaders): Promise<string | null>;
  /** True when the request carries a valid password session for `identity`. */
  hasSession(headers: IncomingHttpHeaders, identity: string): boolean;
  login(password: string, clientKey: string, identity: string): Promise<LoginResult>;
  /** A Set-Cookie value that clears the session. */
  logoutCookie(): string;
}

/** Refuses everything (the default when auth is not configured). */
export const closedGate: Gate = {
  identify: () => Promise.resolve(null),
  hasSession: () => false,
  login: () => Promise.resolve({ ok: false, reason: "unconfigured" }),
  logoutCookie: () => clearCookie(),
};

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== "" && !out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clearCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/** Stateless HMAC sessions: `<expiresMs>.<base64url HMAC-SHA256>`. */
export class Sessions {
  readonly #secret: string;
  readonly #binding: string;
  readonly #now: () => number;

  constructor(secret: string, passwordHash: string, now: () => number = Date.now) {
    this.#secret = secret;
    this.#binding = passwordHash;
    this.#now = now;
  }

  #sign(expires: number, identity: string): Buffer {
    return createHmac("sha256", this.#secret)
      .update(`cameld.session.v1|${String(expires)}|${identity}|${this.#binding}`)
      .digest();
  }

  mint(identity: string): string {
    const expires = this.#now() + SESSION_TTL_MS;
    return `${String(expires)}.${this.#sign(expires, identity).toString("base64url")}`;
  }

  cookie(identity: string): string {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    return `${SESSION_COOKIE}=${this.mint(identity)}; Max-Age=${String(maxAge)}; Path=/; HttpOnly; Secure; SameSite=Strict`;
  }

  valid(value: string | undefined, identity: string): boolean {
    if (value === undefined) return false;
    const match = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (match === null) return false;
    const expires = Number(match[1]);
    if (expires <= this.#now()) return false;
    const given = Buffer.from(match[2] as string, "base64url");
    return timingSafeEqual(given, this.#sign(expires, identity));
  }
}

/**
 * A simple fixed-window limiter for password attempts: per client key and a
 * global cap that a spoofed client key cannot get around.
 */
export class LoginLimiter {
  readonly #perKey: number;
  readonly #global: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #failures = new Map<string, number[]>();

  constructor(options: {
    perKey?: number;
    global?: number;
    windowMs?: number;
    now?: () => number;
  }) {
    this.#perKey = options.perKey ?? 5;
    this.#global = options.global ?? 20;
    this.#windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  #recent(key: string): number[] {
    const cutoff = this.#now() - this.#windowMs;
    const kept = (this.#failures.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) this.#failures.delete(key);
    else this.#failures.set(key, kept);
    return kept;
  }

  allowed(key: string): boolean {
    return this.#recent(key).length < this.#perKey && this.#recent("*").length < this.#global;
  }

  fail(key: string): void {
    for (const k of [key, "*"]) this.#failures.set(k, [...this.#recent(k), this.#now()]);
  }

  succeed(key: string): void {
    this.#failures.delete(key);
  }
}

export interface GateOptions {
  log?: Logger;
  now?: () => number;
  fetch?: typeof fetch;
  limiter?: LoginLimiter;
}

/** Names (never values) of the auth settings that are missing or unusable. */
export function missingAuthConfig(auth: Config["auth"]): string[] {
  const missing: string[] = [];
  if (auth.cfAccessTeamDomain === undefined) missing.push("CF_ACCESS_TEAM_DOMAIN");
  if (auth.cfAccessAud === undefined) missing.push("CF_ACCESS_AUD");
  if (auth.allowedEmail === undefined) missing.push("ALLOWED_EMAIL");
  if (auth.uiPasswordHash === undefined || parsePasswordHash(auth.uiPasswordHash) === null) {
    missing.push("UI_PASSWORD_HASH");
  }
  if (auth.sessionSecret === undefined || auth.sessionSecret.length < MIN_SECRET_LENGTH) {
    missing.push("SESSION_SECRET");
  }
  return missing;
}

export function createGate(auth: Config["auth"], options: GateOptions = {}): Gate {
  const missing = missingAuthConfig(auth);
  if (missing.length > 0) {
    options.log?.warn({ missing }, "auth is not fully configured; every UI request is refused");
    return closedGate;
  }
  const access = new AccessVerifier({
    teamDomain: auth.cfAccessTeamDomain as string,
    aud: auth.cfAccessAud as string,
    allowedEmail: auth.allowedEmail as string,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const passwordHash = auth.uiPasswordHash as string;
  const sessions = new Sessions(auth.sessionSecret as string, passwordHash, options.now);
  const limiter =
    options.limiter ?? new LoginLimiter({ ...(options.now ? { now: options.now } : {}) });
  const log = options.log?.child({ mod: "auth" });

  return {
    identify(headers) {
      const token =
        headerValue(headers[ACCESS_HEADER]) ??
        parseCookies(headerValue(headers.cookie)).get(ACCESS_COOKIE);
      return access.verify(token);
    },
    hasSession(headers, identity) {
      return sessions.valid(
        parseCookies(headerValue(headers.cookie)).get(SESSION_COOKIE),
        identity,
      );
    },
    async login(password, clientKey, identity) {
      if (!limiter.allowed(clientKey)) {
        log?.warn("password login rate limited");
        return { ok: false, reason: "rate_limited" };
      }
      if (!(await verifyPassword(password, passwordHash))) {
        limiter.fail(clientKey);
        log?.warn("wrong backup password");
        return { ok: false, reason: "wrong_password" };
      }
      limiter.succeed(clientKey);
      log?.info("password session started");
      return { ok: true, cookie: sessions.cookie(identity) };
    },
    logoutCookie: clearCookie,
  };
}
