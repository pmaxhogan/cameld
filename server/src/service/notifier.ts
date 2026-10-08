import type { Logger } from "../logging.ts";

/**
 * Owner notifications. Every notification is written as a structured log line
 * (Loki alerts on it) and, when VAPID keys are configured, sent as Web Push
 * (service/push.ts). Sending a notification must never break the flow that
 * raised it: use `notifySafely`.
 */

export type NotificationLevel = "info" | "warning" | "critical";

export type NotificationKind =
  | "frozen"
  | "unfrozen"
  | "parked"
  | "review"
  | "merged"
  | "login_unhealthy"
  | "browser_unavailable"
  | "browser_remediated"
  | "browser_restart_needed"
  | "deletion_unconfirmed"
  | "restore_flagged"
  | "photos_flagged"
  | "backup_failed"
  | "merge_failed"
  | "backfill_batch"
  | "trial_done"
  | "test";

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
