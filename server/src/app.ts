import { existsSync } from "node:fs";
import type { Health } from "@cameld/shared";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { Config } from "./config.ts";
import type { Logger } from "./logging.ts";
import type { Metrics } from "./service/metrics.ts";

/**
 * Decides whether a request may reach an /api/* route. The real check
 * (Cloudflare Access JWT plus the backup password) arrives with the UI wave;
 * until then the default denies everything.
 */
export type Authorize = (request: FastifyRequest) => boolean | Promise<boolean>;

export const denyAll: Authorize = () => false;

export interface AppDeps {
  config: Pick<Config, "version" | "webDistDir">;
  log: Logger;
  /** Prometheus metrics, served on /metrics. */
  metrics?: Metrics;
  /** Gate for every /api/* route. Default: deny everything. */
  authorize?: Authorize;
  /** Read-only data for the UI. No route here writes anything. */
  data?: {
    backfillReport(): unknown;
    status(): unknown;
  };
}

/**
 * Exported separately from index.ts so tests can use app.inject() without
 * binding a port. Registration order matters: /healthz first (unauthenticated
 * by design, the Docker healthcheck uses it), API routes next, the SPA
 * fallback last so its catch-all cannot shadow anything.
 *
 * Every /api/* request (including unknown paths) is deny-by-default: an
 * onRequest hook answers 401 unless `authorize` approves it. /healthz and
 * /metrics stay open; metrics carry counts and labels only (outcomes, park
 * reasons, rate buckets), never activity ids, coordinates or secrets.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: deps.log as FastifyBaseLogger,
    trustProxy: true,
  });

  const authorize = deps.authorize ?? denyAll;
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] as string;
    if (path !== "/api" && !path.startsWith("/api/")) return;
    if (!(await authorize(request))) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/healthz", (): Health => ({ ok: true, version: deps.config.version }));

  const metrics = deps.metrics;
  if (metrics !== undefined) {
    app.get("/metrics", async (_request, reply) => {
      const body = await metrics.render();
      return reply.type(metrics.contentType).send(body);
    });
  }
  const data = deps.data;
  if (data !== undefined) {
    app.get("/api/backfill/report", () => data.backfillReport());
    app.get("/api/status", () => data.status());
  }

  const indexHtml = `${deps.config.webDistDir}/index.html`;
  if (existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: deps.config.webDistDir });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split("?")[0] ?? "";
      if (request.method === "GET" && !path.startsWith("/api/") && path !== "/api") {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}
