import type { Logger } from "../logging.ts";

/**
 * Owner notifications. Web Push arrives with the UI; until then the default
 * implementation writes a structured log line (Loki alerts on it). Sending a
 * notification must never break the flow that raised it: use `notifySafely`.
 */

export type NotificationLevel = "info" | "warning" | "critical";

export type NotificationKind =
  | "frozen"
  | "unfrozen"
  | "parked"
  | "review"
  | "merged"
  | "login_unhealthy"
  | "deletion_unconfirmed"
  | "restore_flagged"
  | "photos_flagged"
  | "backup_failed";

export interface Notification {
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  body: string;
  groupId?: string;
  activityId?: number;
}

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

export class LogNotifier implements Notifier {
  readonly #log: Logger;
  constructor(log: Logger) {
    this.#log = log.child({ mod: "notify" });
  }
  notify(notification: Notification): Promise<void> {
    const level = notification.level === "info" ? "info" : "warn";
    this.#log[level]({ notification }, notification.title);
    return Promise.resolve();
  }
}

/** Deliver a notification; a failing notifier is logged, never thrown. */
export async function notifySafely(
  notifier: Notifier,
  notification: Notification,
  log?: Logger,
): Promise<void> {
  try {
    await notifier.notify(notification);
  } catch (error) {
    log?.error({ err: error, kind: notification.kind }, "notification failed");
  }
}
