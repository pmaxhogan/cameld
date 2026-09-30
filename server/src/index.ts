import { mkdirSync } from "node:fs";
import { buildApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { migrate, openDatabase } from "./db.ts";
import { createBootLogger, createLogger } from "./logging.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.stateDir, { recursive: true });
  const log = createLogger(config);
  log.info({ version: config.version, dataDir: config.dataDir }, "cameld starting");

  const db = openDatabase(config.dbPath);
  const applied = migrate(db);
  log.info({ mod: "migrate", applied }, "migrations up to date");

  const app = await buildApp({ config, log });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    try {
      await app.close();
      db.close();
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, host: config.host }, "cameld listening");
}

main().catch((error: unknown) => {
  // The real logger may not exist yet, so fall back to a stdout-only one.
  const log = createBootLogger();
  if (error instanceof ConfigError) log.fatal(error.message);
  else log.fatal({ err: error }, "failed to start");
  process.exit(1);
});
