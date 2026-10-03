import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { CSRF_HEADER, CSRF_HEADER_VALUE, type Health } from "@cameld/shared";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { closedGate, type Gate } from "./auth/gate.ts";
import { type LoginMessage, loginPage, reloadPage } from "./auth/pages.ts";
import { BROWSER_PREFIX, refuse, type VncProxy } from "./browser/proxy.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logging.ts";
import type { Metrics } from "./service/metrics.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** The verified Cloudflare Access email ("" until the gate has run). */
    identity: string;
    /** True once both gates (Access and the password session) passed. */
    authenticated: boolean;
  }
}

/** Paths that skip both gates: the Docker healthcheck and the Prometheus scrape. */
const OPEN_PATHS = new Set(["/healthz", "/metrics"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for anything that is or decodes to an /api path, in any case or slash spelling. */
export function isApiPath(url: string): boolean {
  const path = normalizePath(url);
  return path === null || path === "/api" || path.startsWith("/api/");
}

/** Decoded, slash-collapsed, lower-case path; null when it cannot be decoded. */
export function normalizePath(url: string): string | null {
  let path = url.split("?")[0] as string;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  return path.replace(/\/{2,}/g, "/").toLowerCase();
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface AppDeps {
  config: Pick<Config, "version" | "webDistDir" | "publicUrl">;
  log: Logger;
  /** Prometheus metrics, served on /metrics. */
  metrics?: Metrics;
  /** Cloudflare Access plus the backup password. Default: refuse everything. */
  gate?: Gate;
  /** Registers the /api routes; they run only behind both gates. */
  api?: (api: FastifyInstance) => void | Promise<void>;
  /** Same-origin proxy for the browser sidecar's VNC client at /browser/. */
  browser?: VncProxy;
}

/**
 * Exported separately from index.ts so tests can use app.inject() without
 * binding a port.
 *
 * Every request except GET /healthz and /metrics passes a global onRequest
 * gate, registered before any route: a verified Cloudflare Access identity
 * first, then (except for the /login page itself) a valid password session.
 * Without a session /api answers 401 and pages redirect to /login. Unsafe
 * methods additionally need the CSRF header or a same-origin Origin. The /api
 * plugin keeps its own deny-by-default hook as a second line.
 *
 * /healthz and /metrics are open by design; metrics carry counts and labels
 * only (outcomes, park reasons, rate buckets), never activity ids,
 * coordinates or secrets.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: deps.log as FastifyBaseLogger,
    trustProxy: true,
  });
  const gate = deps.gate ?? closedGate;
  const publicOrigin = new URL(deps.config.publicUrl).origin;

  app.decorateRequest("identity", "");
  app.decorateRequest("authenticated", false);

  const sameOrigin = (headers: IncomingMessage["headers"]): boolean =>
    headerValue(headers[CSRF_HEADER]) === CSRF_HEADER_VALUE ||
    headerValue(headers.origin) === publicOrigin;

  app.addHook("onRequest", async (request, reply) => {
    const rawPath = request.url.split("?")[0] as string;
    if (OPEN_PATHS.has(rawPath) && SAFE_METHODS.has(request.method)) return;
    const api = isApiPath(request.url);
    const identity = await gate.identify(request.headers);
    if (identity === null) {
      return reply.code(401).header("cache-control", "no-store").send({ error: "unauthorized" });
    }
    request.identity = identity;
    if (!SAFE_METHODS.has(request.method) && !sameOrigin(request.headers)) {
      return reply.code(403).send({ error: "csrf" });
    }
    if (rawPath === "/login") return;
    if (gate.hasSession(request.headers, identity)) {
      request.authenticated = true;
      return;
    }
    if (api || !SAFE_METHODS.has(request.method)) {
      return reply.code(401).header("cache-control", "no-store").send({ error: "unauthorized" });
    }
    if (headerValue(request.headers["sec-fetch-site"]) === "cross-site") {
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(reloadPage());
    }
    return reply.redirect("/login", 303);
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
  });

  app.get("/healthz", (): Health => ({ ok: true, version: deps.config.version }));

  const metrics = deps.metrics;
  if (metrics !== undefined) {
    app.get("/metrics", async (_request, reply) => {
      const body = await metrics.render();
      return reply.type(metrics.contentType).send(body);
    });
  }

  registerLogin(app, gate);

  // Every /api route lives in this encapsulated plugin. Its hook is a second
  // line behind the global gate: nothing reaches a handler unauthenticated.
  await app.register(
    async (api) => {
      api.addHook("onRequest", async (request, reply) => {
        // Unreachable while the global gate works; kept as a second line.
        /* v8 ignore next */
        if (!request.authenticated) return reply.code(401).send({ error: "unauthorized" });
      });
      api.post("/auth/logout", (_request, reply) =>
        reply.code(204).header("set-cookie", gate.logoutCookie()).send(),
      );
      if (deps.api !== undefined) await deps.api(api);
    },
    { prefix: "/api" },
  );

  const browser = deps.browser;
  if (browser !== undefined) {
    app.get("/browser", (_request, reply) => reply.redirect(BROWSER_PREFIX, 302));
    app.get(`${BROWSER_PREFIX}*`, (request, reply) => browser.handle(request, reply));
    app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      void authorizeUpgrade(request, gate, publicOrigin).then((allowed) => {
        if (allowed) browser.upgrade(request, socket, head);
        else refuse(socket, 401, "Unauthorized");
      });
    });
    app.addHook("onClose", () => browser.close());
  }

  const indexHtml = `${deps.config.webDistDir}/index.html`;
  if (existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: deps.config.webDistDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !isApiPath(request.url)) {
        return reply.header("cache-control", "no-cache").sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}

/**
 * WebSocket upgrades bypass Fastify's routing and hooks, so the same checks
 * run here on the raw request: /browser/ only, an Origin equal to the public
 * origin (cross-site WebSocket hijacking), Access identity and session.
 */
async function authorizeUpgrade(
  request: IncomingMessage,
  gate: Gate,
  publicOrigin: string,
): Promise<boolean> {
  if (!(request.url as string).startsWith(BROWSER_PREFIX)) return false;
  if (headerValue(request.headers.origin) !== publicOrigin) return false;
  const identity = await gate.identify(request.headers);
  return identity !== null && gate.hasSession(request.headers, identity);
}

function sendLogin(reply: FastifyReply, status: number, message: LoginMessage): FastifyReply {
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(loginPage(message));
}

/** GET /login and the password form POST. Both still require Cloudflare Access. */
function registerLogin(app: FastifyInstance, gate: Gate): void {
  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 4096 },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      },
    );
    scope.get("/login", (request: FastifyRequest, reply) => {
      if (gate.hasSession(request.headers, request.identity)) return reply.redirect("/", 303);
      return sendLogin(reply, 200, null);
    });
    scope.post("/login", async (request: FastifyRequest, reply) => {
      const body = request.body as Record<string, unknown> | undefined;
      const password = typeof body?.password === "string" ? body.password : "";
      const result = await gate.login(password, request.ip, request.identity);
      if (result.ok) return reply.header("set-cookie", result.cookie).redirect("/", 303);
      const status =
        result.reason === "rate_limited" ? 429 : result.reason === "unconfigured" ? 503 : 401;
      return sendLogin(reply, status, result.reason);
    });
  });
}
