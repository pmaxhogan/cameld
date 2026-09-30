import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db.ts";
import { createLogger } from "../src/logging.ts";
import {
  SqliteTokenStore,
  type StoredTokens,
  StravaAuthError,
  TokenManager,
  type TokenStore,
} from "../src/strava/tokens.ts";

const NOW_MS = Date.parse("2030-01-01T00:00:00Z");
const NOW_S = NOW_MS / 1000;

function memoryStore(initial: StoredTokens | null): TokenStore & { saves: StoredTokens[] } {
  let value = initial;
  const saves: StoredTokens[] = [];
  return {
    saves,
    load: () => value,
    save: (tokens) => {
      value = tokens;
      saves.push(tokens);
    },
  };
}

function tokenResponse(access: string, refresh: string, expiresAt: number): Response {
  return Response.json({ access_token: access, refresh_token: refresh, expires_at: expiresAt });
}

describe("SqliteTokenStore", () => {
  it("round-trips and overwrites the single row", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const store = new SqliteTokenStore(db);
    expect(store.load()).toBeNull();
    store.save({ accessToken: "a1", refreshToken: "r1", expiresAt: 100 });
    expect(store.load()).toEqual({ accessToken: "a1", refreshToken: "r1", expiresAt: 100 });
    store.save({ accessToken: "a2", refreshToken: "r2", expiresAt: 200 });
    expect(store.load()).toEqual({ accessToken: "a2", refreshToken: "r2", expiresAt: 200 });
    const count = db.prepare("SELECT COUNT(*) AS n FROM strava_tokens").get();
    expect(count?.n).toBe(1);
    db.close();
  });
});

describe("TokenManager", () => {
  it("returns the stored token without a request when it has time left", async () => {
    const store = memoryStore({ accessToken: "fresh", refreshToken: "r", expiresAt: NOW_S + 3600 });
    const mgr = new TokenManager({
      clientId: "cid",
      clientSecret: "secret",
      store,
      fetch: () => Promise.reject(new Error("no request expected")),
      now: () => NOW_MS,
    });
    expect(await mgr.getAccessToken()).toBe("fresh");
  });

  it("refreshes under ten minutes, persists the rotated token, sends a form body", async () => {
    const store = memoryStore({
      accessToken: "old",
      refreshToken: "r-old",
      expiresAt: NOW_S + 599,
    });
    const calls: { url: string; body: string }[] = [];
    const mgr = new TokenManager({
      clientId: "cid",
      clientSecret: "secret",
      store,
      fetch: (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return Promise.resolve(tokenResponse("new", "r-new", NOW_S + 21600));
      },
      now: () => NOW_MS,
    });
    expect(await mgr.getAccessToken()).toBe("new");
    expect(store.saves).toEqual([
      { accessToken: "new", refreshToken: "r-new", expiresAt: NOW_S + 21600 },
    ]);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).not.toContain("secret");
    expect(call?.url).not.toContain("r-old");
    const form = new URLSearchParams(call?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("r-old");
    expect(form.get("client_id")).toBe("cid");
  });

  it("is single-flight across concurrent callers", async () => {
    const store = memoryStore({ accessToken: "old", refreshToken: "r", expiresAt: 0 });
    let calls = 0;
    const mgr = new TokenManager({
      clientId: "c",
      clientSecret: "s",
      store,
      fetch: () => {
        calls += 1;
        return Promise.resolve(tokenResponse("new", "r2", NOW_S + 21600));
      },
      now: () => NOW_MS,
    });
    const results = await Promise.all([
      mgr.getAccessToken(),
      mgr.getAccessToken(),
      mgr.forceRefresh(),
    ]);
    expect(results).toEqual(["new", "new", "new"]);
    expect(calls).toBe(1);
    expect(store.saves).toHaveLength(1);
    await mgr.forceRefresh();
    expect(calls).toBe(2);
  });

  it("seeds from the initial refresh token when the store is empty", async () => {
    const store = memoryStore(null);
    let sent = "";
    const mgr = new TokenManager({
      clientId: "c",
      clientSecret: "s",
      store,
      initialRefreshToken: "seed-token",
      fetch: (_url, init) => {
        sent = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
        return Promise.resolve(tokenResponse("a", "r-next", NOW_S + 21600));
      },
      now: () => NOW_MS,
    });
    expect(await mgr.getAccessToken()).toBe("a");
    expect(sent).toBe("seed-token");
    expect(store.load()?.refreshToken).toBe("r-next");
  });

  it("fails clearly with no token at all", async () => {
    const mgr = new TokenManager({ clientId: "c", clientSecret: "s", store: memoryStore(null) });
    await expect(mgr.getAccessToken()).rejects.toBeInstanceOf(StravaAuthError);
    const empty = new TokenManager({
      clientId: "c",
      clientSecret: "s",
      store: memoryStore(null),
      initialRefreshToken: "",
    });
    await expect(empty.getAccessToken()).rejects.toThrow("No Strava refresh token");
  });

  it("does not persist or leak tokens on failures", async () => {
    const stored = { accessToken: "ACCESS-SECRET", refreshToken: "REFRESH-SECRET", expiresAt: 0 };
    const cases: (() => Promise<Response>)[] = [
      () => Promise.resolve(new Response("nope REFRESH-SECRET", { status: 400 })),
      () => Promise.reject(new Error("boom REFRESH-SECRET")),
      () => Promise.resolve(new Response("not json", { status: 200 })),
      () => Promise.resolve(Response.json({ access_token: "x" })),
      () => Promise.resolve(Response.json(null)),
    ];
    for (const fn of cases) {
      const store = memoryStore(stored);
      const mgr = new TokenManager({
        clientId: "c",
        clientSecret: "s",
        store,
        fetch: fn,
        now: () => NOW_MS,
      });
      const error = await mgr.getAccessToken().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StravaAuthError);
      expect((error as Error).message).not.toMatch(/SECRET/);
      expect(store.saves).toEqual([]);
    }
  });

  it("records the HTTP status on auth errors", async () => {
    const mgr = new TokenManager({
      clientId: "c",
      clientSecret: "s",
      store: memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 0 }),
      fetch: () => Promise.resolve(new Response("{}", { status: 401 })),
    });
    await expect(mgr.getAccessToken()).rejects.toMatchObject({ status: 401 });
  });

  it("never logs token values", async () => {
    const lines: string[] = [];
    const logger = createLogger(
      { logLevel: "debug" },
      { write: (line: string) => void lines.push(line) },
    );
    const mgr = new TokenManager({
      clientId: "c",
      clientSecret: "s",
      store: memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: 0 }),
      fetch: () => Promise.resolve(tokenResponse("ACC-VALUE", "REF-VALUE", NOW_S + 21600)),
      now: () => NOW_MS,
      logger,
    });
    await mgr.getAccessToken();
    const joined = lines.join("");
    expect(joined).toContain("strava token refreshed");
    expect(joined).not.toMatch(/ACC-VALUE|REF-VALUE/);
  });

  it("uses real fetch and Date.now by default when the token is fresh", async () => {
    const store = memoryStore({
      accessToken: "ok",
      refreshToken: "r",
      expiresAt: Math.floor(Date.now() / 1000) + 7200,
    });
    const mgr = new TokenManager({ clientId: "c", clientSecret: "s", store });
    expect(await mgr.getAccessToken()).toBe("ok");
  });
});
