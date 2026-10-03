import { mkdirSync } from "node:fs";
import { buildApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { migrate, openDatabase } from "./db.ts";
import { createBootLogger, createLogger } from "./logging.ts";
import { createRelayClient } from "./relay/client.ts";
import { Backfill } from "./service/backfill.ts";
import { BackupService } from "./service/backup.ts";
import { ReadBudget } from "./service/budget.ts";
import { Metrics } from "./service/metrics.ts";
import { LogNotifier } from "./service/notifier.ts";
import { Poller } from "./service/poller.ts";
import { HttpSnapshotter, UnavailableSnapshotter } from "./service/snapshotter.ts";
import { WebGate } from "./service/web-gate.ts";
import { FreezeStore } from "./state/freeze.ts";
import { MergeMachine } from "./state/machine.ts";
import { parkedByReason } from "./state/repo.ts";
import { SettingsStore } from "./state/settings.ts";
import { StravaClient } from "./strava/client.ts";
import { RateLimiter, systemClock } from "./strava/rate-limiter.ts";
import { SqliteTokenStore, TokenManager } from "./strava/tokens.ts";
import { WebSession } from "./web/session.ts";

const BACKFILL_INTERVAL_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.stateDir, { recursive: true });
  const log = createLogger(config);
  log.info({ version: config.version, dataDir: config.dataDir }, "cameld starting");

  const db = openDatabase(config.dbPath);
  const applied = migrate(db);
  log.info({ mod: "migrate", applied }, "migrations up to date");

  const clock = systemClock;
  const notifier = new LogNotifier(log);
  const settings = new SettingsStore(db, { log });
  const freeze = new FreezeStore(db, { notifier, log });
  const limiter = new RateLimiter({
    onWait: ({ ms, reason }) => log.warn({ ms, reason }, "strava rate limit wait"),
  });
  const budget = new ReadBudget(db, () => settings.get().backfill);
  let backfill: Backfill | null = null;
  let backupTotals = () => ({ bytes: 0, files: 0 });
  const metrics = new Metrics({
    sources: {
      parkedByReason: () => parkedByReason(db),
      frozen: () => freeze.isFrozen(),
      rateUsage: () => limiter.usage(),
      backupTotals: () => backupTotals(),
      backfill: () =>
        backfill?.progress() ?? { activities: 0, cursorMs: null, done: false, readsToday: 0 },
    },
  });

  const relay =
    config.relay.url !== undefined && config.relay.token !== undefined
      ? createRelayClient({ baseUrl: config.relay.url, token: config.relay.token, logger: log })
      : undefined;
  const session =
    config.browser.cdpUrl === undefined
      ? null
      : new WebSession({
          cdpUrl: config.browser.cdpUrl,
          logger: log.child({ mod: "web" }),
          ...(relay === undefined ? {} : { relay }),
          ...(config.strava.webEmail === undefined ? {} : { email: config.strava.webEmail }),
        });
  const web = new WebGate({ session, notifier, log, metrics });

  const tokenStore = new SqliteTokenStore(db);
  const { clientId, clientSecret, initialRefreshToken } = config.strava;
  const authorized =
    clientId !== undefined &&
    clientSecret !== undefined &&
    (tokenStore.load() !== null || initialRefreshToken !== undefined);

  let poller: Poller | null = null;
  let backfillTimer: NodeJS.Timeout | undefined;
  if (authorized) {
    const tokens = new TokenManager({
      clientId,
      clientSecret,
      store: tokenStore,
      ...(initialRefreshToken === undefined ? {} : { initialRefreshToken }),
      logger: log,
    });
    const api = new StravaClient({ tokens, limiter, logger: log });
    const backup = new BackupService({
      db,
      api,
      web,
      root: `${config.dataDir}/backup`,
      log: log.child({ mod: "backup" }),
      metrics,
    });
    backupTotals = () => backup.totals();
    const snapshotter =
      config.snapshotHelperUrl === undefined
        ? new UnavailableSnapshotter()
        : new HttpSnapshotter({
            url: config.snapshotHelperUrl,
            token: config.snapshotHelperToken,
          });
    const machine = new MergeMachine({
      db,
      api,
      web,
      backup,
      snapshotter,
      notifier,
      freeze,
      settings,
      clock,
      log,
      metrics,
    });
    backfill = new Backfill({
      db,
      api,
      backup,
      machine,
      settings,
      budget,
      clock,
      reportPath: `${config.dataDir}/reports/backfill-dry-run.json`,
      log,
    });
    poller = new Poller({ db, api, backup, machine, web, settings, clock, limiter, metrics, log });
    poller.start();
    const runBackfill = (): void => {
      void backfill
        ?.runBatch()
        .catch((error: unknown) => log.error({ err: error }, "backfill failed"));
    };
    runBackfill();
    backfillTimer = setInterval(runBackfill, BACKFILL_INTERVAL_MS);
  } else {
    log.warn("strava credentials or tokens missing; polling and backfill are not started");
  }

  const app = await buildApp({
    config,
    log,
    metrics,
    data: {
      backfillReport: () => backfill?.report() ?? null,
      status: () => ({
        frozen: freeze.state(),
        web: web.status(),
        backfill: backfill?.progress() ?? null,
        polling: poller !== null,
      }),
    },
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    try {
      poller?.stop();
      clearInterval(backfillTimer);
      await session?.disconnect();
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
