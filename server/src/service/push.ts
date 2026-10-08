import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PushPayload, PushSendSummary, PushSubscriptionBody } from "@cameld/shared";
import webpush from "web-push";
import type { Logger } from "../logging.ts";
import type { Notification, Notifier } from "./notifier.ts";

/**
 * Web Push (ARCHITECTURE.md section 8, "Notifications"): VAPID keys from the
 * environment, one row per browser subscription in SQLite, and a Notifier
 * that sends every owner notification to every subscription. A 404 or 410
 * from the push service means the subscription is gone and it is deleted;
 * other failures are counted and kept. Sending never throws.
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushResponse {
  statusCode: number;
}

/** The transport, injectable for tests. Rejects with `{ statusCode }` on an HTTP error. */
export type SendPush = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { vapidDetails: VapidKeys; TTL: number; urgency: "normal" | "high"; topic?: string },
) => Promise<PushResponse>;

const defaultSend: SendPush = (subscription, payload, options) =>
  webpush.sendNotification(subscription, payload, options);

const TTL_SECONDS = 6 * 60 * 60;

export function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** True for a well-formed browser subscription (an https endpoint and both keys). */
export function isSubscription(value: unknown): value is PushSubscriptionBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PushSubscriptionBody>;
  if (typeof v.endpoint !== "string" || v.endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(v.endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const keys = v.keys;
  return (
    typeof keys === "object" &&
    keys !== null &&
    typeof keys.p256dh === "string" &&
    typeof keys.auth === "string" &&
    BASE64URL.test(keys.p256dh) &&
    BASE64URL.test(keys.auth) &&
    keys.p256dh.length <= 200 &&
    keys.auth.length <= 100
  );
}

interface SubscriptionRow {
  endpoint_hash: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushService {
  readonly #db: DatabaseSync;
  readonly #vapid: VapidKeys | null;
  readonly #send: SendPush;
  readonly #now: () => number;
  readonly #log: Logger | undefined;

  constructor(options: {
    db: DatabaseSync;
    vapid: VapidKeys | null;
    send?: SendPush;
    now?: () => number;
    log?: Logger;
  }) {
    this.#db = options.db;
    this.#vapid = options.vapid;
    this.#send = options.send ?? defaultSend;
    this.#now = options.now ?? Date.now;
    this.#log = options.log?.child({ mod: "push" });
  }

  configured(): boolean {
    return this.#vapid !== null;
  }

  publicKey(): string | null {
    return this.#vapid?.publicKey ?? null;
  }

  count(): number {
    return (this.#db.prepare("SELECT count(*) AS n FROM push_subscriptions").get() as { n: number })
      .n;
  }

  /** Store (or refresh) a subscription. Returns its endpoint hash. */
  subscribe(subscription: PushSubscriptionBody, userAgent: string | null): string {
    const hash = endpointHash(subscription.endpoint);
    this.#db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint_hash, endpoint, p256dh, auth, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint_hash) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
           user_agent = excluded.user_agent, last_error = NULL, failures = 0`,
      )
      .run(
        hash,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        userAgent?.slice(0, 300) ?? null,
        this.#now(),
      );
    return hash;
  }

  unsubscribe(endpoint: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ?")
      .run(endpointHash(endpoint));
    return Number(result.changes) > 0;
  }

  /** Send one payload to every subscription. Never throws. */
  async sendAll(payload: PushPayload): Promise<PushSendSummary> {
    const summary: PushSendSummary = {
      configured: this.#vapid !== null,
      total: 0,
      sent: 0,
      failed: 0,
      removed: 0,
    };
    const vapid = this.#vapid;
    if (vapid === null) return summary;
    const rows = this.#db
      .prepare("SELECT endpoint_hash, endpoint, p256dh, auth FROM push_subscriptions")
      .all() as unknown as SubscriptionRow[];
    summary.total = rows.length;
    const body = JSON.stringify(payload);
    const topic = payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
    for (const row of rows) {
      try {
        await this.#send(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
          {
            vapidDetails: vapid,
            TTL: TTL_SECONDS,
            urgency: payload.level === "info" ? "normal" : "high",
            ...(topic === "" ? {} : { topic }),
          },
        );
        this.#db
          .prepare(
            "UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL, failures = 0 WHERE endpoint_hash = ?",
          )
          .run(this.#now(), row.endpoint_hash);
        summary.sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode;
        if (status === 404 || status === 410) {
          this.#db
            .prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ?")
            .run(row.endpoint_hash);
          summary.removed += 1;
          continue;
        }
        const reason =
          typeof status === "number" ? `http ${String(status)}` : (error as Error).name;
        this.#db
          .prepare(
            "UPDATE push_subscriptions SET last_error = ?, failures = failures + 1 WHERE endpoint_hash = ?",
          )
          .run(reason, row.endpoint_hash);
        this.#log?.warn({ subscription: row.endpoint_hash, reason }, "push delivery failed");
        summary.failed += 1;
      }
    }
    return summary;
  }
}

/** Where a notification should take the owner when tapped. */
export function notificationUrl(notification: Notification): string {
  if (notification.kind === "review") return "/#/review";
  if (
    notification.kind === "login_unhealthy" ||
    notification.kind === "browser_unavailable" ||
    notification.kind === "browser_remediated" ||
    notification.kind === "browser_restart_needed"
  )
    return "/#/browser";
  if (notification.kind === "backfill_batch" || notification.kind === "trial_done") {
    return "/#/backfill";
  }
  if (notification.groupId !== undefined) {
    return `/#/history/${encodeURIComponent(notification.groupId)}`;
  }
  return "/#/review";
}

export function toPayload(notification: Notification, now: number): PushPayload {
  return {
    kind: notification.kind,
    level: notification.level,
    title: notification.title,
    body: notification.body,
    url: notificationUrl(notification),
    tag:
      notification.groupId === undefined
        ? notification.kind
        : `${notification.kind}-${notification.groupId}`,
    ts: now,
  };
}

/** Delivers every owner notification as a Web Push message. */
export class PushNotifier implements Notifier {
  readonly #push: PushService;
  readonly #now: () => number;
  constructor(push: PushService, now: () => number = Date.now) {
    this.#push = push;
    this.#now = now;
  }
  async notify(notification: Notification): Promise<void> {
    await this.#push.sendAll(toPayload(notification, this.#now()));
  }
}

/** Fan a notification out to several notifiers; one failing does not stop the others. */
export class MultiNotifier implements Notifier {
  readonly #notifiers: Notifier[];
  constructor(notifiers: Notifier[]) {
    this.#notifiers = notifiers;
  }
  async notify(notification: Notification): Promise<void> {
    const results = await Promise.allSettled(this.#notifiers.map((n) => n.notify(notification)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  }
}
