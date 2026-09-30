import { existsSync } from "node:fs";
import type { Health } from "@cameld/shared";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import type { Logger } from "./logging.ts";

export interface AppDeps {
  config: Pick<Config, "version" | "webDistDir">;
  log: Logger;
}

/**
 * Exported separately from index.ts so tests can use app.inject() without
 * binding a port. Registration order matters: /healthz first (unauthenticated
 * by design, the Docker healthcheck uses it), API routes next, the SPA
 * fallback last so its catch-all cannot shadow anything.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: deps.log as FastifyBaseLogger,
    trustProxy: true,
  });

  app.get("/healthz", (): Health => ({ ok: true, version: deps.config.version }));

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
