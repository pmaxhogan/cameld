import { createPublicKey, type KeyObject, verify, type webcrypto } from "node:crypto";
import type { Logger } from "../logging.ts";

/**
 * Cloudflare Access verification (ARCHITECTURE.md section 8, "Access").
 * Access puts a signed JWT on every request it lets through, in the
 * `Cf-Access-Jwt-Assertion` header and the `CF_Authorization` cookie. cameld
 * does not trust the tunnel alone: it checks the RS256 signature against the
 * team's published keys and requires
 *
 * - `iss` = the team domain origin,
 * - `aud` containing the application AUD tag,
 * - `exp` in the future and `nbf` in the past (30 s skew),
 * - an `email` claim equal to ALLOWED_EMAIL (case-insensitive). Access policy
 *   is the first line; this check means a policy mistake alone cannot let
 *   another identity in. Service tokens carry no email and are refused.
 *
 * Keys are cached for an hour and refetched early (at most once a minute)
 * when a token names an unknown key id, which is how a rotation shows up.
 */

export const ACCESS_HEADER = "cf-access-jwt-assertion";
export const ACCESS_COOKIE = "CF_Authorization";

const SKEW_SECONDS = 30;
const KEYS_TTL_MS = 60 * 60 * 1000;
const MIN_REFETCH_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

export interface AccessOptions {
  /** e.g. "team.cloudflareaccess.com" (an https:// prefix is accepted). */
  teamDomain: string;
  aud: string;
  allowedEmail: string;
  log?: Logger;
  now?: () => number;
  fetch?: typeof fetch;
}

type Jwk = webcrypto.JsonWebKey & { kid?: string };

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * The issuer origin for a configured team domain. Plain http is accepted only
 * for a loopback host, which exists for the end to end test double.
 */
export function teamOrigin(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/+$/, "");
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN must be an https origin");
  }
  return url.origin;
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AccessVerifier {
  readonly #issuer: string;
  readonly #certsUrl: string;
  readonly #aud: string;
  readonly #email: string;
  readonly #log: Logger | undefined;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  #keys = new Map<string, KeyObject>();
  #fetchedAt = Number.NEGATIVE_INFINITY;
  #attemptedAt = Number.NEGATIVE_INFINITY;
  #inflight: Promise<void> | null = null;

  constructor(options: AccessOptions) {
    this.#issuer = teamOrigin(options.teamDomain);
    this.#certsUrl = `${this.#issuer}/cdn-cgi/access/certs`;
    this.#aud = options.aud;
    this.#email = options.allowedEmail.trim().toLowerCase();
    this.#log = options.log?.child({ mod: "access" });
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? fetch;
  }

  /** One key fetch at a time; concurrent callers share it. Never rejects. */
  #refresh(): Promise<void> {
    if (this.#inflight === null) {
      const run = this.#load();
      this.#inflight = run;
      void run.then(() => {
        this.#inflight = null;
      });
    }
    return this.#inflight;
  }

  async #load(): Promise<void> {
    this.#attemptedAt = this.#now();
    try {
      const response = await this.#fetch(this.#certsUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`certs answered ${String(response.status)}`);
      const body = (await response.json()) as { keys?: Jwk[] };
      const keys = new Map<string, KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      }
      this.#keys = keys;
      this.#fetchedAt = this.#now();
    } catch (error) {
      // Keep the old keys; a later request retries after MIN_REFETCH_MS.
      this.#log?.warn({ err: error }, "could not fetch the Cloudflare Access keys");
    }
  }

  async #key(kid: string): Promise<KeyObject | undefined> {
    const now = this.#now();
    const stale = now - this.#fetchedAt >= KEYS_TTL_MS || !this.#keys.has(kid);
    if (this.#inflight !== null) await this.#inflight;
    else if (stale && now - this.#attemptedAt >= MIN_REFETCH_MS) await this.#refresh();
    return this.#keys.get(kid);
  }

  /** The verified, allowed email of the token, or null. Never throws. */
  async verify(token: string | undefined): Promise<string | null> {
    if (token === undefined || token === "") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    let header: unknown;
    let claims: unknown;
    try {
      header = decodeSegment(headerPart);
      claims = decodeSegment(payloadPart);
    } catch {
      return null;
    }
    if (!isRecord(header) || !isRecord(claims)) return null;
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const key = await this.#key(header.kid);
    if (key === undefined) return null;
    const signed = verify(
      "sha256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      key,
      Buffer.from(signaturePart, "base64url"),
    );
    if (!signed) return null;
    return this.#checkClaims(claims);
  }

  #checkClaims(claims: Record<string, unknown>): string | null {
    const nowSeconds = this.#now() / 1000;
    if (claims.iss !== this.#issuer) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.#aud)) return null;
    if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < nowSeconds) return null;
    if (typeof claims.nbf === "number" && claims.nbf - SKEW_SECONDS > nowSeconds) return null;
    if (typeof claims.email !== "string") return null;
    const email = claims.email.trim().toLowerCase();
    return email === this.#email ? email : null;
  }
}
