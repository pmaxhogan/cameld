import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Every environment variable cameld reads, validated once at boot. This module
 * is the ONLY reader of process.env: everything else receives a Config.
 * Anything that is not a deployment fundamental belongs in the settings store.
 *
 * Credentials (Strava client secret, web login, session secret, VAPID keys)
 * are optional here because Wave 1 does not use them yet; later waves make the
 * relevant ones required where the feature needs them.
 */

const optionalString = z
  .string()
  .transform((raw) => raw.trim())
  .transform((raw) => (raw === "" ? undefined : raw))
  .optional();

/** Empty string (as in a blank .env.example line) means "use the default". */
const blankAsUnset = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(65535).default(8080)),
  HOST: z.preprocess(blankAsUnset, z.string().min(1).default("0.0.0.0")),
  DATA_DIR: z.preprocess(blankAsUnset, z.string().min(1).default("/data")),
  LOG_LEVEL: z.preprocess(
    blankAsUnset,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),
  PUBLIC_URL: z.preprocess(blankAsUnset, z.string().url().default("http://localhost:8080")),
  /** Injected at image build time (docker build --build-arg CAMELD_VERSION). */
  CAMELD_VERSION: z.preprocess(blankAsUnset, z.string().min(1).default("0.1.0")),
  /** Where the built single page app lives. Defaults to web/dist next to server/. */
  WEB_DIST_DIR: z.preprocess(blankAsUnset, z.string().min(1).optional()),

  STRAVA_CLIENT_ID: optionalString,
  STRAVA_CLIENT_SECRET: optionalString,
  STRAVA_WEB_EMAIL: optionalString,
  STRAVA_WEB_PASSWORD: optionalString,

  CF_ACCESS_TEAM_DOMAIN: optionalString,
  CF_ACCESS_AUD: optionalString,
  ALLOWED_EMAIL: optionalString,
  UI_PASSWORD_HASH: optionalString,
  SESSION_SECRET: optionalString,

  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: optionalString,

  SNAPSHOT_HELPER_URL: optionalString,
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  nodeEnv: Env["NODE_ENV"];
  port: number;
  host: string;
  version: string;
  dataDir: string;
  stateDir: string;
  dbPath: string;
  logLevel: Env["LOG_LEVEL"];
  /** Public origin without a trailing slash. */
  publicUrl: string;
  /** Absolute path to the built SPA. The app serves it when it exists. */
  webDistDir: string;
  strava: {
    clientId: string | undefined;
    clientSecret: string | undefined;
    webEmail: string | undefined;
    webPassword: string | undefined;
  };
  auth: {
    cfAccessTeamDomain: string | undefined;
    cfAccessAud: string | undefined;
    allowedEmail: string | undefined;
    uiPasswordHash: string | undefined;
    sessionSecret: string | undefined;
  };
  push: {
    vapidPublicKey: string | undefined;
    vapidPrivateKey: string | undefined;
    vapidSubject: string | undefined;
  };
  snapshotHelperUrl: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Parse and validate the environment. Throws ConfigError with an actionable
 * message rather than booting into a half-configured state. Error messages
 * list variable names and problems only, never values.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment:\n${details}`);
  }
  const env = parsed.data;

  const dataDir = resolve(env.DATA_DIR);
  const stateDir = `${dataDir}/state`;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    version: env.CAMELD_VERSION,
    dataDir,
    stateDir,
    dbPath: `${stateDir}/cameld.db`,
    logLevel: env.LOG_LEVEL,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
    webDistDir: resolve(
      env.WEB_DIST_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
    ),
    strava: {
      clientId: env.STRAVA_CLIENT_ID,
      clientSecret: env.STRAVA_CLIENT_SECRET,
      webEmail: env.STRAVA_WEB_EMAIL,
      webPassword: env.STRAVA_WEB_PASSWORD,
    },
    auth: {
      cfAccessTeamDomain: env.CF_ACCESS_TEAM_DOMAIN,
      cfAccessAud: env.CF_ACCESS_AUD,
      allowedEmail: env.ALLOWED_EMAIL,
      uiPasswordHash: env.UI_PASSWORD_HASH,
      sessionSecret: env.SESSION_SECRET,
    },
    push: {
      vapidPublicKey: env.VAPID_PUBLIC_KEY,
      vapidPrivateKey: env.VAPID_PRIVATE_KEY,
      vapidSubject: env.VAPID_SUBJECT,
    },
    snapshotHelperUrl: env.SNAPSHOT_HELPER_URL,
  };
}
