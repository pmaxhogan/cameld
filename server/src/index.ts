import { mkdirSync, readFileSync } from "node:fs";
import { buildApp } from "./app.ts";
import { createGate } from "./auth/gate.ts";
import { VncProxy } from "./browser/proxy.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { migrate, openDatabase } from "./db.ts";
import { createBootLogger, createLogger } from "./logging.ts";
import { createRelayClient } from "./relay/client.ts";
import { Backfill } from "./service/backfill.ts";
import { BackupService } from "./service/backup.ts";
import { ReadBudget } from "./service/budget.ts";
import { Metrics } from "./service/metrics.ts";
import { LogNotifier, notifySafely } from "./service/notifier.ts";
import { MultiNotifier, PushNotifier, PushService } from "./service/push.ts";
import { Poller } from "./service/poller.ts";
import { HttpSnapshotter, UnavailableSnapshotter } from "./service/snapshotter.ts";
import { remediationReporter, WebGate } from "./service/web-gate.ts";
import { FreezeStore } from "./state/freeze.ts";
import { MergeMachine } from "./state/machine.ts";
import { originalCounts, parkedByReason } from "./state/repo.ts";
import { SettingsStore } from "./state/settings.ts";
import { StravaClient } from "./strava/client.ts";
import { RateLimiter, systemClock } from "./strava/rate-limiter.ts";
import { SqliteTokenStore, TokenManager } from "./strava/tokens.ts";
import { registerUiRoutes } from "./ui/routes.ts";
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
  const { vapidPublicKey, vapidPrivateKey, vapidSubject } = config.push;
  const push = new PushService({
    db,
    vapid:
      vapidPublicKey !== undefined && vapidPrivateKey !== undefined && vapidSubject !== undefined
        ? { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject }
        : null,
    log,
  });
  if (!push.configured()) log.warn("VAPID keys missing; Web Push is off");
  const notifier = new MultiNotifier([new LogNotifier(log), new PushNotifier(push)]);
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
      originals: () => originalCounts(db, clock.now()),
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
          onRemediation: remediationReporter({ notifier, metrics, log }),
        });
  const web = new WebGate({ session, notifier, log, metrics });

  const tokenStore = new SqliteTokenStore(db);
  const { clientId, clientSecret, initialRefreshToken } = config.strava;
  const authorized =
    clientId !== undefined &&
    clientSecret !== undefined &&
    (tokenStore.load() !== null || initialRefreshToken !== undefined);

  let poller: Poller | null = null;
  let machine: MergeMachine | null = null;
  let runBackfill: (() => void) | undefined;
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
    machine = new MergeMachine({
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
    runBackfill = (): void => {
      void backfill
        ?.runBatch()
        .then(async (result) => {
          if (result.activities > 0 || result.stopped === "done") {
            await notifySafely(
              notifier,
              {
                kind: "backfill_batch",
                level: result.stopped === "error" ? "warning" : "info",
                title: "Backfill batch finished",
                body: `${String(result.activities)} activities, ${String(result.groups)} groups (${result.mode}, stopped: ${result.stopped})`,
              },
              log,
            );
          }
        })
        .catch((error: unknown) => log.error({ err: error }, "backfill failed"));
    };
    runBackfill();
    backfillTimer = setInterval(runBackfill, BACKFILL_INTERVAL_MS);
  } else {
    log.warn("strava credentials or tokens missing; polling and backfill are not started");
  }

  let browser: VncProxy | undefined;
  if (config.browser.vncUrl !== undefined) {
    try {
      browser = new VncProxy({
        upstream: config.browser.vncUrl,
        user: config.browser.vncUser,
        password: config.browser.vncPassword,
        ca:
          config.browser.vncCaFile === undefined
            ? undefined
            : readFileSync(config.browser.vncCaFile, "utf8"),
        certSha256: config.browser.vncCertSha256,
        log,
      });
    } catch (error) {
      log.error({ err: error }, "browser VNC proxy not started; the Strava login panel is off");
    }
  }

  const app = await buildApp({
    config,
    log,
    metrics,
    gate: createGate(config.auth, { log }),
    ...(browser === undefined ? {} : { browser }),
    api: (api) =>
      registerUiRoutes(api, {
        db,
        version: config.version,
        mapStyleUrl: config.mapStyleUrl,
        backupRoot: `${config.dataDir}/backup`,
        settings,
        freeze,
        web,
        push,
        budget,
        limiter,
        machine,
        backfill,
        runBackfill,
        browserAvailable: browser !== undefined,
        polling: () => poller !== null,
        log,
      }),
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
