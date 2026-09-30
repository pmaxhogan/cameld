import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHealth } from "@cameld/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
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
    const app = await buildApp({ config: { version: "1.0.0", webDistDir: dist }, log });
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
