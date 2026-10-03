import { describe, expect, it } from "vitest";
import { AccessVerifier, teamOrigin } from "../src/auth/access.ts";
import {
  closedGate,
  createGate,
  LoginLimiter,
  missingAuthConfig,
  parseCookies,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  Sessions,
} from "../src/auth/gate.ts";
import { loginPage, reloadPage } from "../src/auth/pages.ts";
import {
  DEFAULT_ITERATIONS,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from "../src/auth/password.ts";
import { createLogger } from "../src/logging.ts";
import { AUD, jwksFetch, OWNER, ownerClaims, signToken, TEAM, testKey } from "./auth-helpers.ts";

const log = createLogger({ logLevel: "silent" });
const T0 = Date.UTC(2020, 1, 2, 2, 2, 2);

function verifier(options: { now?: () => number; fetch?: typeof fetch } = {}) {
  return new AccessVerifier({
    teamDomain: TEAM,
    aud: AUD,
    allowedEmail: " Owner@Example.com ",
    log,
    now: options.now ?? (() => T0),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

describe("teamOrigin", () => {
  it("accepts a bare or https team domain and loopback http only", () => {
    expect(teamOrigin(TEAM)).toBe(`https://${TEAM}`);
    expect(teamOrigin(`https://${TEAM}/`)).toBe(`https://${TEAM}`);
    expect(teamOrigin("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
    expect(teamOrigin("http://localhost:9000")).toBe("http://localhost:9000");
    expect(() => teamOrigin(`http://${TEAM}`)).toThrow(/https/);
    expect(() => teamOrigin("ftp://127.0.0.1")).toThrow(/https/);
  });
});

describe("AccessVerifier", () => {
  it("accepts a valid token for the allowed email and caches the keys", async () => {
    const key = testKey();
    const fetch = jwksFetch(() => [key.jwk]);
    const access = verifier({ fetch });
    expect(await access.verify(signToken(key, ownerClaims(T0)))).toBe(OWNER);
    expect(await access.verify(signToken(key, ownerClaims(T0, { aud: AUD })))).toBe(OWNER);
    expect(fetch.calls).toBe(1);
  });

  it("refuses missing, malformed and wrongly signed tokens", async () => {
    const key = testKey();
    const other = testKey();
    const access = verifier({ fetch: jwksFetch(() => [key.jwk]) });
    const good = signToken(key, ownerClaims(T0));
    const [head, body] = good.split(".") as [string, string];
    const forged = signToken({ ...other, kid: key.kid }, ownerClaims(T0));
    for (const token of [
      undefined,
      "",
      "a.b",
      "!!!.###.$$$",
      `${Buffer.from("[1]").toString("base64url")}.${body}.sig`,
      signToken(key, ownerClaims(T0), { alg: "HS256" }),
      signToken(key, ownerClaims(T0), { kid: 7 }),
      forged,
      `${head}.${Buffer.from(JSON.stringify(ownerClaims(T0, { email: "x@example.com" }))).toString("base64url")}.${good.split(".")[2] as string}`,
    ]) {
      expect(await access.verify(token)).toBeNull();
    }
  });

  it("checks issuer, audience, expiry, not-before and the email claim", async () => {
    const key = testKey();
    const access = verifier({ fetch: jwksFetch(() => [key.jwk]) });
    const now = Math.floor(T0 / 1000);
    for (const claims of [
      ownerClaims(T0, { iss: "https://other.cloudflareaccess.com" }),
      ownerClaims(T0, { aud: ["another-aud"] }),
      ownerClaims(T0, { exp: now - 31 }),
      ownerClaims(T0, { exp: "soon" }),
      ownerClaims(T0, { nbf: now + 31 }),
      ownerClaims(T0, { email: undefined }),
      ownerClaims(T0, { email: "someone-else@example.com" }),
    ]) {
      expect(await access.verify(signToken(key, claims))).toBeNull();
    }
    // Inside the 30 s skew both ways, and no nbf at all.
    expect(await access.verify(signToken(key, ownerClaims(T0, { exp: now - 29 })))).toBe(OWNER);
    expect(await access.verify(signToken(key, ownerClaims(T0, { nbf: undefined })))).toBe(OWNER);
  });

  it("refetches for an unknown kid at most once a minute and after an hour", async () => {
    let now = T0;
    const first = testKey("k1");
    const rotated = testKey("k2");
    let published = [first.jwk];
    const fetch = jwksFetch(() => published);
    const access = verifier({ fetch, now: () => now });
    expect(await access.verify(signToken(first, ownerClaims(now)))).toBe(OWNER);
    published = [first.jwk, rotated.jwk];
    // Unknown kid within a minute of the last fetch: no refetch, refused.
    now += 30_000;
    expect(await access.verify(signToken(rotated, ownerClaims(now)))).toBeNull();
    expect(fetch.calls).toBe(1);
    now += 31_000;
    expect(await access.verify(signToken(rotated, ownerClaims(now)))).toBe(OWNER);
    expect(fetch.calls).toBe(2);
    // Known kid: cached until the hour is up.
    now += 59 * 60_000;
    expect(await access.verify(signToken(first, ownerClaims(now)))).toBe(OWNER);
    expect(fetch.calls).toBe(2);
    now += 2 * 60_000;
    expect(await access.verify(signToken(first, ownerClaims(now)))).toBe(OWNER);
    expect(fetch.calls).toBe(3);
  });

  it("shares one fetch between concurrent requests and skips unusable keys", async () => {
    const key = testKey();
    const fetch = jwksFetch(() => [{ kty: "EC", kid: "ec" }, { kty: "RSA" }, key.jwk]);
    const access = verifier({ fetch });
    const token = signToken(key, ownerClaims(T0));
    const results = await Promise.all([
      access.verify(token),
      access.verify(token),
      access.verify(token),
    ]);
    expect(results).toEqual([OWNER, OWNER, OWNER]);
    expect(fetch.calls).toBe(1);
  });

  it("keeps working on old keys when a refetch fails, and refuses with none", async () => {
    let now = T0;
    const key = testKey();
    let mode: "ok" | "500" | "throw" | "empty" = "ok";
    const fetch = (async () => {
      if (mode === "throw") throw new TypeError("fetch failed");
      if (mode === "500") return new Response("nope", { status: 500 });
      if (mode === "empty") return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const access = verifier({ fetch, now: () => now });
    expect(await access.verify(signToken(key, ownerClaims(now)))).toBe(OWNER);
    mode = "500";
    now += 61 * 60_000;
    expect(await access.verify(signToken(key, ownerClaims(now)))).toBe(OWNER);
    mode = "throw";
    now += 2 * 60_000;
    expect(await access.verify(signToken(key, ownerClaims(now)))).toBe(OWNER);

    mode = "empty";
    const fresh = verifier({ fetch, now: () => now });
    expect(await fresh.verify(signToken(key, ownerClaims(now)))).toBeNull();
    const failing = verifier({
      fetch: (async () => {
        throw new Error("down");
      }) as typeof globalThis.fetch,
    });
    expect(await failing.verify(signToken(key, ownerClaims(T0)))).toBeNull();
  });

  it("uses the global fetch by default", () => {
    expect(new AccessVerifier({ teamDomain: TEAM, aud: AUD, allowedEmail: OWNER })).toBeDefined();
  });
});

describe("password hashes", () => {
  it("round-trips, refuses a wrong password and malformed or weak hashes", async () => {
    const hash = await hashPassword("synthetic correct horse", { iterations: 100_000 });
    expect(hash).toMatch(/^pbkdf2\$sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await verifyPassword("synthetic correct horse", hash)).toBe(true);
    expect(await verifyPassword("synthetic wrong horse", hash)).toBe(false);
    for (const bad of [
      "",
      "pbkdf2$sha1$100000$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
      "pbkdf2$sha256$1000$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
      "pbkdf2$sha256$abc$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
      "pbkdf2$sha256$100000$c2E$aGFzaGhhc2hoYXNoaGFzaA",
      "pbkdf2$sha256$100000$c2FsdHNhbHQ$aGFzaA",
      "pbkdf2$sha256$99999999$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA",
    ]) {
      expect(parsePasswordHash(bad)).toBeNull();
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });

  it("defaults to a strong iteration count", async () => {
    const hash = await hashPassword("synthetic");
    expect(parsePasswordHash(hash)?.iterations).toBe(DEFAULT_ITERATIONS);
  }, 30_000);
});

describe("sessions", () => {
  it("mints a cookie bound to identity, password hash and expiry", () => {
    let now = T0;
    const sessions = new Sessions("s".repeat(32), "hash-a", () => now);
    const cookie = sessions.cookie(OWNER);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(cookie).toContain(`Max-Age=${String(SESSION_TTL_MS / 1000)}`);
    const value = sessions.mint(OWNER);
    expect(sessions.valid(value, OWNER)).toBe(true);
    expect(sessions.valid(value, "other@example.com")).toBe(false);
    expect(new Sessions("s".repeat(32), "hash-b", () => now).valid(value, OWNER)).toBe(false);
    expect(new Sessions("t".repeat(32), "hash-a", () => now).valid(value, OWNER)).toBe(false);
    expect(sessions.valid(undefined, OWNER)).toBe(false);
    expect(sessions.valid("garbage", OWNER)).toBe(false);
    expect(sessions.valid(`${value.split(".")[0] as string}.${"A".repeat(43)}`, OWNER)).toBe(false);
    now += SESSION_TTL_MS;
    expect(sessions.valid(value, OWNER)).toBe(false);
  });

  it("uses the real clock by default", () => {
    const sessions = new Sessions("s".repeat(32), "h");
    expect(sessions.valid(sessions.mint(OWNER), OWNER)).toBe(true);
  });
});

describe("LoginLimiter", () => {
  it("limits per key and globally within the window", () => {
    let now = T0;
    const limiter = new LoginLimiter({ perKey: 2, global: 3, windowMs: 1000, now: () => now });
    expect(limiter.allowed("a")).toBe(true);
    limiter.fail("a");
    limiter.fail("a");
    expect(limiter.allowed("a")).toBe(false);
    expect(limiter.allowed("b")).toBe(true);
    limiter.fail("b");
    expect(limiter.allowed("c")).toBe(false);
    now += 1001;
    expect(limiter.allowed("a")).toBe(true);
    limiter.fail("a");
    limiter.succeed("a");
    expect(limiter.allowed("a")).toBe(true);
    expect(new LoginLimiter({}).allowed("x")).toBe(true);
  });
});

describe("parseCookies", () => {
  it("parses a cookie header, keeping the first of duplicates", () => {
    const cookies = parseCookies("a=1; b = two=2 ; a=3; =x; junk");
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("two=2");
    expect(cookies.size).toBe(2);
    expect(parseCookies(undefined).size).toBe(0);
  });
});

describe("createGate", () => {
  const goodAuth = async () => ({
    cfAccessTeamDomain: TEAM,
    cfAccessAud: AUD,
    allowedEmail: OWNER,
    uiPasswordHash: await hashPassword("synthetic-pass", { iterations: 100_000 }),
    sessionSecret: "x".repeat(40),
  });

  it("names every missing setting and fails closed", async () => {
    const none = {
      cfAccessTeamDomain: undefined,
      cfAccessAud: undefined,
      allowedEmail: undefined,
      uiPasswordHash: undefined,
      sessionSecret: undefined,
    };
    expect(missingAuthConfig(none)).toEqual([
      "CF_ACCESS_TEAM_DOMAIN",
      "CF_ACCESS_AUD",
      "ALLOWED_EMAIL",
      "UI_PASSWORD_HASH",
      "SESSION_SECRET",
    ]);
    expect(missingAuthConfig({ ...(await goodAuth()), sessionSecret: "short" })).toEqual([
      "SESSION_SECRET",
    ]);
    const gate = createGate(none, { log });
    expect(gate).toBe(closedGate);
    expect(createGate(none)).toBe(closedGate);
    expect(await gate.identify({})).toBeNull();
    expect(gate.hasSession({}, OWNER)).toBe(false);
    expect(await gate.login("x", "ip", OWNER)).toEqual({ ok: false, reason: "unconfigured" });
    expect(gate.logoutCookie()).toContain("Max-Age=0");
  });

  it("identifies by header or cookie, logs in, rate limits and checks sessions", async () => {
    const key = testKey();
    const gate = createGate(await goodAuth(), {
      log,
      now: () => T0,
      fetch: jwksFetch(() => [key.jwk]),
      limiter: new LoginLimiter({ perKey: 2, now: () => T0 }),
    });
    const token = signToken(key, ownerClaims(T0));
    expect(await gate.identify({ "cf-access-jwt-assertion": token })).toBe(OWNER);
    expect(await gate.identify({ cookie: `CF_Authorization=${token}` })).toBe(OWNER);
    expect(await gate.identify({ "cf-access-jwt-assertion": [token] })).toBe(OWNER);
    expect(await gate.identify({})).toBeNull();

    expect(await gate.login("wrong", "ip", OWNER)).toEqual({ ok: false, reason: "wrong_password" });
    const ok = await gate.login("synthetic-pass", "ip", OWNER);
    if (!ok.ok) throw new Error("login failed");
    const value = /cameld_session=([^;]+)/.exec(ok.cookie)?.[1] as string;
    expect(gate.hasSession({ cookie: `${SESSION_COOKIE}=${value}` }, OWNER)).toBe(true);
    expect(gate.hasSession({ cookie: `${SESSION_COOKIE}=${value}` }, "x@example.com")).toBe(false);
    expect(gate.hasSession({}, OWNER)).toBe(false);

    await gate.login("wrong", "ip2", OWNER);
    await gate.login("wrong", "ip2", OWNER);
    expect(await gate.login("synthetic-pass", "ip2", OWNER)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(gate.logoutCookie()).toContain("Max-Age=0");
    // Defaults: own limiter and real clock.
    expect(createGate(await goodAuth())).not.toBe(closedGate);
  });
});

describe("pages", () => {
  it("renders the login page with a fixed message and the reload page", () => {
    expect(loginPage()).toContain('action="/login"');
    expect(loginPage()).not.toContain('role="alert"');
    expect(loginPage("wrong_password")).toContain("Wrong password.");
    expect(loginPage("rate_limited")).toContain("Too many attempts");
    expect(loginPage("unconfigured")).toContain("not configured");
    expect(reloadPage()).toContain('http-equiv="refresh"');
  });
});
