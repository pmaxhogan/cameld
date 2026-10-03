import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { parseHealth } from "@cameld/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, isApiPath, normalizePath } from "../src/app.ts";
import type { Gate } from "../src/auth/gate.ts";
import { VncProxy } from "../src/browser/proxy.ts";
import { createLogger } from "../src/logging.ts";
import { Metrics } from "../src/service/metrics.ts";

const log = createLogger({ logLevel: "silent" });
const apps: FastifyInstance[] = [];
const servers: Server[] = [];
const OWNER = "owner@example.com";
const PUBLIC = "https://cameld.example.com";
const noDist = join(tmpdir(), "does-not-exist");

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** A gate double: Access via a header, the session via a cookie, a fixed password. */
const gate: Gate = {
  identify: (headers) =>
    Promise.resolve(headers["cf-access-jwt-assertion"] === "valid" ? OWNER : null),
  hasSession: (headers, identity) =>
    identity === OWNER && (headers.cookie ?? "").includes("cameld_session=good"),
  login: (password) => {
    if (password === "synthetic-pass") {
      return Promise.resolve({ ok: true, cookie: "cameld_session=good; Path=/" });
    }
    if (password === "flood") return Promise.resolve({ ok: false, reason: "rate_limited" });
    if (password === "nothing") return Promise.resolve({ ok: false, reason: "unconfigured" });
    return Promise.resolve({ ok: false, reason: "wrong_password" });
  },
  logoutCookie: () => "cameld_session=; Max-Age=0",
};

const ACCESS = { "cf-access-jwt-assertion": "valid" };
const SIGNED_IN = { ...ACCESS, cookie: "cameld_session=good" };
const CSRF = { "x-requested-with": "cameld" };

function metrics(): Metrics {
  return new Metrics({
    defaultMetrics: false,
    sources: {
      parkedByReason: () => ({}),
      frozen: () => false,
      rateUsage: () => null,
      backupTotals: () => ({ bytes: 0, files: 0 }),
      backfill: () => ({ activities: 0, cursorMs: null, done: false, readsToday: 0 }),
    },
  });
}

function spa(): string {
  const dist = mkdtempSync(join(tmpdir(), "cameld-web-"));
  writeFileSync(join(dist, "index.html"), "<html><body>spa</body></html>");
  return dist;
}

async function app(options: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const instance = await buildApp({
    config: { version: "1.0.0", webDistDir: noDist, publicUrl: PUBLIC },
    log,
    gate,
    api: (api) => {
      api.get("/status", () => ({ frozen: false }));
      api.post("/echo", (request) => ({ identity: request.identity }));
    },
    ...options,
  });
  apps.push(instance);
  return instance;
}

describe("open paths", () => {
  it("serves /healthz and /metrics with no credentials, and nothing else", async () => {
    const a = await app({ metrics: metrics() });
    const health = await a.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(parseHealth(health.json())).toEqual({ ok: true, version: "1.0.0" });
    expect(health.headers["x-frame-options"]).toBe("DENY");
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    const scraped = await a.inject({ method: "GET", url: "/metrics" });
    expect(scraped.statusCode).toBe(200);
    expect(scraped.body).toContain("cameld_writes_frozen 0");
    for (const url of ["/healthz/", "//healthz", "/healthz/x", "/metrics?x", "/"]) {
      const response = await a.inject({ method: "GET", url });
      if (url === "/metrics?x") expect(response.statusCode).toBe(200);
      else expect(response.statusCode).toBe(401);
    }
    expect((await a.inject({ method: "POST", url: "/healthz" })).statusCode).toBe(401);
  });

  it("has no /metrics without metrics", async () => {
    const a = await app();
    expect(
      (await a.inject({ method: "GET", url: "/metrics", headers: SIGNED_IN })).statusCode,
    ).toBe(404);
  });
});

describe("the gate", () => {
  it("denies everything by default (no gate configured)", async () => {
    const a = await buildApp({
      config: { version: "1", webDistDir: spa(), publicUrl: PUBLIC },
      log,
    });
    apps.push(a);
    for (const url of ["/", "/api/status", "/login", "/assets/x.js"]) {
      const response = await a.inject({ method: "GET", url, headers: SIGNED_IN });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("needs Cloudflare Access for every page and /api route, including /login", async () => {
    const a = await app({ config: { version: "1", webDistDir: spa(), publicUrl: PUBLIC } });
    for (const url of ["/", "/history", "/api/status", "/login", "/%61pi/status"]) {
      const response = await a.inject({
        method: "GET",
        url,
        headers: { cookie: "cameld_session=good" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("with Access but no session: /api is 401 and pages go to /login", async () => {
    const a = await app({ config: { version: "1", webDistDir: spa(), publicUrl: PUBLIC } });
    const api = await a.inject({ method: "GET", url: "/api/status", headers: ACCESS });
    expect(api.statusCode).toBe(401);
    const page = await a.inject({ method: "GET", url: "/history", headers: ACCESS });
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toBe("/login");
    const crossSite = await a.inject({
      method: "GET",
      url: "/",
      headers: { ...ACCESS, "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.statusCode).toBe(200);
    expect(crossSite.body).toContain('http-equiv="refresh"');
    const post = await a.inject({ method: "POST", url: "/other", headers: { ...ACCESS, ...CSRF } });
    expect(post.statusCode).toBe(401);
  });

  it("needs the CSRF header or a same-origin Origin on unsafe methods", async () => {
    const a = await app();
    const bare = await a.inject({ method: "POST", url: "/api/echo", headers: SIGNED_IN });
    expect(bare.statusCode).toBe(403);
    expect(bare.json()).toEqual({ error: "csrf" });
    const foreign = await a.inject({
      method: "POST",
      url: "/api/echo",
      headers: { ...SIGNED_IN, origin: "https://evil.example.com" },
    });
    expect(foreign.statusCode).toBe(403);
    const header = await a.inject({
      method: "POST",
      url: "/api/echo",
      headers: { ...SIGNED_IN, ...CSRF },
    });
    expect(header.json()).toEqual({ identity: OWNER });
    const origin = await a.inject({
      method: "POST",
      url: "/api/echo",
      headers: { ...SIGNED_IN, origin: PUBLIC },
    });
    expect(origin.statusCode).toBe(200);
  });

  it("serves the SPA and /api with both gates passed", async () => {
    const a = await app({ config: { version: "1", webDistDir: spa(), publicUrl: PUBLIC } });
    for (const url of ["/", "/history/42?x=1"]) {
      const response = await a.inject({ method: "GET", url, headers: SIGNED_IN });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("spa");
      expect(response.headers["x-frame-options"]).toBe("DENY");
    }
    expect(
      (await a.inject({ method: "GET", url: "/api/status", headers: SIGNED_IN })).json(),
    ).toEqual({ frozen: false });
    expect(
      (await a.inject({ method: "GET", url: "/api/nope", headers: SIGNED_IN })).statusCode,
    ).toBe(404);
    const post = await a.inject({
      method: "POST",
      url: "/whatever",
      headers: { ...SIGNED_IN, ...CSRF },
    });
    expect(post.statusCode).toBe(404);
    for (const url of [
      "/%61pi/status",
      "//api/status",
      "/api/status/",
      "/API/status",
      "/%E0%A4%A",
    ]) {
      const response = await a.inject({ method: "GET", url, headers: SIGNED_IN });
      expect(response.statusCode).not.toBe(500);
      expect(response.body).not.toContain("spa");
    }
  });

  it("has no SPA routes when the web build is absent", async () => {
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/", headers: SIGNED_IN })).statusCode).toBe(404);
  });

  it("works without any /api routes registered", async () => {
    const a = await buildApp({
      config: { version: "1", webDistDir: noDist, publicUrl: PUBLIC },
      log,
      gate,
    });
    apps.push(a);
    expect(
      (await a.inject({ method: "GET", url: "/api/status", headers: SIGNED_IN })).statusCode,
    ).toBe(404);
  });
});

describe("login", () => {
  const form = (password: string | null, extra: Record<string, string> = {}) => ({
    method: "POST" as const,
    url: "/login",
    headers: {
      ...ACCESS,
      origin: PUBLIC,
      "content-type": "application/x-www-form-urlencoded",
      ...extra,
    },
    payload: password === null ? "" : `password=${encodeURIComponent(password)}`,
  });

  it("serves the login page behind Access, or sends a signed-in owner home", async () => {
    const a = await app();
    const page = await a.inject({ method: "GET", url: "/login", headers: ACCESS });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain('action="/login"');
    const home = await a.inject({ method: "GET", url: "/login", headers: SIGNED_IN });
    expect(home.statusCode).toBe(303);
    expect(home.headers.location).toBe("/");
  });

  it("sets the session on the right password and refuses the rest", async () => {
    const a = await app();
    const ok = await a.inject(form("synthetic-pass"));
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/");
    expect(ok.headers["set-cookie"]).toContain("cameld_session=good");
    const wrong = await a.inject(form("nope"));
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain("Wrong password.");
    expect((await a.inject(form(null))).statusCode).toBe(401);
    expect((await a.inject(form("flood"))).statusCode).toBe(429);
    expect((await a.inject(form("nothing"))).statusCode).toBe(503);
    const crossOrigin = await a.inject(
      form("synthetic-pass", { origin: "https://evil.example.com" }),
    );
    expect(crossOrigin.statusCode).toBe(403);
    const noAccess = await a.inject({ ...form("synthetic-pass"), headers: { origin: PUBLIC } });
    expect(noAccess.statusCode).toBe(401);
  });

  it("logs out by clearing the cookie", async () => {
    const a = await app();
    const out = await a.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { ...SIGNED_IN, ...CSRF },
    });
    expect(out.statusCode).toBe(204);
    expect(out.headers["set-cookie"]).toContain("Max-Age=0");
  });
});

describe("the browser proxy behind the gate", () => {
  async function setup() {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`vnc ${req.url as string} ${req.headers.authorization ?? "none"}`);
    });
    upstream.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
      socket.on("end", () => socket.destroy());
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
      );
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const browser = new VncProxy({
      upstream: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`,
      user: "kasm_user",
      password: "synthetic-vnc-password",
    });
    const a = await app({ browser });
    await a.listen({ port: 0, host: "127.0.0.1" });
    return { a, port: (a.server.address() as AddressInfo).port };
  }

  function upgrade(port: number, path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path,
        agent: false,
        headers: { connection: "Upgrade", upgrade: "websocket", ...headers },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode as number);
      });
      req.on("response", (res) => {
        res.resume();
        res.socket.destroy();
        resolve(res.statusCode as number);
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("proxies pages only with both gates and injects the credentials", async () => {
    const { a } = await setup();
    expect((await a.inject({ method: "GET", url: "/browser/", headers: ACCESS })).statusCode).toBe(
      303,
    );
    const redirect = await a.inject({ method: "GET", url: "/browser", headers: SIGNED_IN });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe("/browser/");
    const page = await a.inject({ method: "GET", url: "/browser/vnc.html", headers: SIGNED_IN });
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/^vnc \/vnc.html Basic /);
    expect(page.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("upgrades websockets only for the public origin with both gates", async () => {
    const { port } = await setup();
    const good = { ...SIGNED_IN, origin: PUBLIC };
    expect(await upgrade(port, "/browser/websockify", good)).toBe(101);
    expect(
      await upgrade(port, "/browser/websockify", { ...good, origin: "https://evil.example.com" }),
    ).toBe(401);
    expect(await upgrade(port, "/browser/websockify", { ...ACCESS, origin: PUBLIC })).toBe(401);
    expect(
      await upgrade(port, "/browser/websockify", { cookie: "cameld_session=good", origin: PUBLIC }),
    ).toBe(401);
    expect(await upgrade(port, "/api/status", good)).toBe(401);
  });
});

describe("path helpers", () => {
  it("normalizes encoding, case and slashes, and treats undecodable paths as api", () => {
    expect(isApiPath("/%61pi/x?y=1")).toBe(true);
    expect(isApiPath("//API//x")).toBe(true);
    expect(isApiPath("/%E0%A4%A")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isApiPath("/history")).toBe(false);
    expect(normalizePath("//A//b?x")).toBe("/a/b");
    expect(normalizePath("/%E0%A4%A")).toBeNull();
  });
});
