import pino, { type DestinationStream, type Logger } from "pino";
import type { Config } from "./config.ts";

export type { Logger };

/** Paths whose values must never reach a log line. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['cf-access-jwt-assertion']",
  "res.headers['set-cookie']",
  "authorization",
  "cookie",
  "password",
  "token",
  "secret",
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.token",
  "*.secret",
  "*.access_token",
  "*.refresh_token",
];

/**
 * pino only, never console.*. NDJSON on stdout for the container log driver
 * (Alloy ships it to Loki). The optional destination exists for tests.
 */
export function createLogger(
  config: Pick<Config, "logLevel">,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: config.logLevel,
      base: { name: "cameld" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    },
    destination ?? pino.destination({ fd: 1, sync: false }),
  );
}

/** stdout-only logger for failures that happen before config loads. */
export function createBootLogger(level: string = "info"): Logger {
  return pino({ level, base: { name: "cameld" }, timestamp: pino.stdTimeFunctions.isoTime });
}
