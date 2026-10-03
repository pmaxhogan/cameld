import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHealth } from "@cameld/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, isApiPath } from "../src/app.ts";
import { createLogger } from "../src/logging.ts";

const log = createLogger({ logLevel: "silent" });
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET /healthz", () => {
  it("returns ok and the configured version with no credentials", async () => {
    const app = await buildApp({
      config: { version: "9.9.9-test", webDistDir: join(tmpdir(), "does-not-exist") },
      log,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: "9.9.9-test" });
    expect(parseHealth(response.json())).not.toBeNull();
  });
});

describe("web serving", () => {
  it("serves the SPA and falls back to index.html, but 404s unknown /api paths", async () => {
    const dist = mkdtempSync(join(tmpdir(), "cameld-web-"));
    writeFileSync(join(dist, "index.html"), "<html><body>spa</body></html>");
    const app = await buildApp({
      config: { version: "1.0.0", webDistDir: dist },
      log,
      authorize: () => true,
    });
    apps.push(app);

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("spa");

    const deep = await app.inject({ method: "GET", url: "/history/42?x=1" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("spa");

    const api = await app.inject({ method: "GET", url: "/api/nope" });
    expect(api.statusCode).toBe(404);

    const post = await app.inject({ method: "POST", url: "/whatever" });
    expect(post.statusCode).toBe(404);
  });

  it("has no SPA routes when the web build is absent", async () => {
    const app = await buildApp({
      config: { version: "1.0.0", webDistDir: join(tmpdir(), "does-not-exist") },
      log,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(404);
  });
});

describe("metrics and read-only data routes", () => {
  it("serves /metrics and the data endpoints only when wired, and nothing writable", async () => {
    const { Metrics } = await import("../src/service/metrics.ts");
    const metrics = new Metrics({
      defaultMetrics: false,
      sources: {
        parkedByReason: () => ({}),
        frozen: () => false,
        rateUsage: () => null,
        backupTotals: () => ({ bytes: 0, files: 0 }),
        backfill: () => ({ activities: 0, cursorMs: null, done: false, readsToday: 0 }),
      },
    });
    const app = await buildApp({
      config: { version: "1.0.0", webDistDir: join(tmpdir(), "does-not-exist") },
      log,
      metrics,
      data: { backfillReport: () => ({ groups: [] }), status: () => ({ frozen: false }) },
      authorize: () => Promise.resolve(true),
    });
    apps.push(app);
    const scraped = await app.inject({ method: "GET", url: "/metrics" });
    expect(scraped.statusCode).toBe(200);
    expect(scraped.headers["content-type"]).toContain("text/plain");
    expect(scraped.body).toContain("cameld_writes_frozen 0");
    expect((await app.inject({ method: "GET", url: "/api/backfill/report" })).json()).toEqual({
      groups: [],
    });
    expect((await app.inject({ method: "GET", url: "/api/status" })).json()).toEqual({
      frozen: false,
    });
    expect((await app.inject({ method: "POST", url: "/api/status" })).statusCode).toBe(404);

    const bare = await buildApp({
      config: { version: "1.0.0", webDistDir: join(tmpdir(), "does-not-exist") },
      log,
    });
    apps.push(bare);
    expect((await bare.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
  });
});

describe("/api auth", () => {
  it("denies every /api route by default but leaves /healthz and /metrics open", async () => {
    const { Metrics } = await import("../src/service/metrics.ts");
    const metrics = new Metrics({
      defaultMetrics: false,
      sources: {
        parkedByReason: () => ({}),
        frozen: () => false,
        rateUsage: () => null,
        backupTotals: () => ({ bytes: 0, files: 0 }),
        backfill: () => ({ activities: 0, cursorMs: null, done: false, readsToday: 0 }),
      },
    });
    const app = await buildApp({
      config: { version: "1.0.0", webDistDir: join(tmpdir(), "does-not-exist") },
      log,
      metrics,
      data: { backfillReport: () => ({ groups: [] }), status: () => ({ frozen: false }) },
    });
    apps.push(app);
    for (const url of ["/api/status", "/api/backfill/report"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
    }
    for (const url of [
      "/%61pi/status",
      "//api/status",
      "/api/status/",
      "/API/status",
      "/api",
      "/api/unknown",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect([401, 404]).toContain(response.statusCode);
    }
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
  });
});

describe("odd /api spellings with the SPA served", () => {
  it("never serves data or the SPA for encoded, doubled or upper-case /api paths", async () => {
    const dist = mkdtempSync(join(tmpdir(), "cameld-web-"));
    writeFileSync(join(dist, "index.html"), "<html><body>spa</body></html>");
    const app = await buildApp({
      config: { version: "1.0.0", webDistDir: dist },
      log,
      data: { backfillReport: () => ({ groups: [] }), status: () => ({ frozen: false }) },
    });
    apps.push(app);
    for (const url of ["/%61pi/status", "//api/status", "/api/status/", "/API/status"]) {
      const response = await app.inject({ method: "GET", url });
      expect([401, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain("frozen");
      expect(response.body).not.toContain("spa");
    }
    expect((await app.inject({ method: "GET", url: "/history" })).body).toContain("spa");
  });
});

describe("isApiPath", () => {
  it("normalizes encoding, case and slashes, and treats undecodable paths as api", () => {
    expect(isApiPath("/%61pi/x?y=1")).toBe(true);
    expect(isApiPath("//API//x")).toBe(true);
    expect(isApiPath("/%E0%A4%A")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isApiPath("/history")).toBe(false);
  });
});
