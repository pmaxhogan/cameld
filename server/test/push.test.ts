import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db.ts";
import { createLogger } from "../src/logging.ts";
import type { Notification, Notifier } from "../src/service/notifier.ts";
import {
  endpointHash,
  isSubscription,
  MultiNotifier,
  notificationUrl,
  PushNotifier,
  PushService,
  type SendPush,
  toPayload,
} from "../src/service/push.ts";

/** Synthetic VAPID material and push endpoints; nothing here is a real key or service. */
const VAPID = {
  publicKey: "BSyntheticPublicKey",
  privateKey: "synthetic-private-key",
  subject: "mailto:owner@example.com",
};
const KEYS = { p256dh: "BSyntheticP256dhKey_-", auth: "c3ludGhldGljLWF1dGg" };
const sub = (n: number) => ({ endpoint: `https://push.example.com/send/${String(n)}`, keys: KEYS });

function db() {
  const d = openDatabase(":memory:");
  migrate(d);
  return d;
}

describe("isSubscription", () => {
  it("accepts a well-formed https subscription only", () => {
    expect(isSubscription(sub(1))).toBe(true);
    for (const bad of [
      null,
      "x",
      {},
      { endpoint: 5, keys: KEYS },
      { endpoint: "not a url", keys: KEYS },
      { endpoint: "http://push.example.com/x", keys: KEYS },
      { endpoint: `https://push.example.com/${"x".repeat(2100)}`, keys: KEYS },
      { endpoint: "https://push.example.com/x" },
      { endpoint: "https://push.example.com/x", keys: null },
      { endpoint: "https://push.example.com/x", keys: { p256dh: "a b", auth: "ok" } },
      { endpoint: "https://push.example.com/x", keys: { p256dh: "ok", auth: 1 } },
      { endpoint: "https://push.example.com/x", keys: { p256dh: "a".repeat(201), auth: "ok" } },
      { endpoint: "https://push.example.com/x", keys: { p256dh: "ok", auth: "a".repeat(101) } },
    ]) {
      expect(isSubscription(bad)).toBe(false);
    }
  });
});

describe("PushService", () => {
  it("stores, refreshes and removes subscriptions by endpoint hash", () => {
    const push = new PushService({ db: db(), vapid: VAPID, now: () => 1 });
    expect(push.configured()).toBe(true);
    expect(push.publicKey()).toBe(VAPID.publicKey);
    expect(push.subscribe(sub(1), "Synthetic UA")).toBe(endpointHash(sub(1).endpoint));
    push.subscribe(sub(1), null);
    push.subscribe(sub(2), "x".repeat(400));
    expect(push.count()).toBe(2);
    expect(push.unsubscribe(sub(1).endpoint)).toBe(true);
    expect(push.unsubscribe(sub(1).endpoint)).toBe(false);
    expect(push.count()).toBe(1);
  });

  it("sends to every subscription, prunes gone ones and counts failures", async () => {
    const d = db();
    const sent: { endpoint: string; payload: string; urgency: string; topic?: string }[] = [];
    const send: SendPush = (subscription, payload, options) => {
      const n = subscription.endpoint.split("/").pop();
      if (n === "2") return Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 }));
      if (n === "3") return Promise.reject(Object.assign(new Error("nf"), { statusCode: 404 }));
      if (n === "4") return Promise.reject(Object.assign(new Error("busy"), { statusCode: 503 }));
      if (n === "5") return Promise.reject(new TypeError("fetch failed"));
      sent.push({
        endpoint: subscription.endpoint,
        payload,
        urgency: options.urgency,
        ...(options.topic ? { topic: options.topic } : {}),
      });
      return Promise.resolve({ statusCode: 201 });
    };
    const push = new PushService({
      db: d,
      vapid: VAPID,
      send,
      now: () => 5,
      log: createLogger({ logLevel: "silent" }),
    });
    for (const n of [1, 2, 3, 4, 5]) push.subscribe(sub(n), null);
    const payload = toPayload({ kind: "frozen", level: "critical", title: "t", body: "b" }, 7);
    expect(await push.sendAll(payload)).toEqual({
      configured: true,
      total: 5,
      sent: 1,
      failed: 2,
      removed: 2,
    });
    expect(sent).toEqual([
      {
        endpoint: sub(1).endpoint,
        payload: JSON.stringify(payload),
        urgency: "high",
        topic: "frozen",
      },
    ]);
    expect(push.count()).toBe(3);
    const failures = d
      .prepare(
        "SELECT last_error, failures FROM push_subscriptions WHERE failures > 0 ORDER BY last_error",
      )
      .all();
    expect(failures).toEqual([
      { last_error: "TypeError", failures: 1 },
      { last_error: "http 503", failures: 1 },
    ]);
    // An info payload with an empty topic after cleaning.
    await push.sendAll({ ...payload, level: "info", tag: "!!!" });
    expect(sent.at(-1)?.urgency).toBe("normal");
    expect(sent.at(-1)?.topic).toBeUndefined();
  });

  it("does nothing without VAPID keys", async () => {
    const push = new PushService({ db: db(), vapid: null });
    expect(push.configured()).toBe(false);
    expect(push.publicKey()).toBeNull();
    push.subscribe(sub(1), null);
    expect(
      await push.sendAll(toPayload({ kind: "test", level: "info", title: "t", body: "b" }, 1)),
    ).toEqual({
      configured: false,
      total: 0,
      sent: 0,
      failed: 0,
      removed: 0,
    });
  });

  it("uses web-push by default (which refuses synthetic keys)", async () => {
    const push = new PushService({ db: db(), vapid: VAPID });
    push.subscribe(sub(1), null);
    const summary = await push.sendAll(
      toPayload({ kind: "test", level: "info", title: "t", body: "b" }, 1),
    );
    expect(summary.failed).toBe(1);
  });
});

describe("payloads and notifiers", () => {
  const base: Notification = { kind: "parked", level: "warning", title: "T", body: "B" };

  it("links each kind to the right screen", () => {
    expect(notificationUrl({ ...base, kind: "review", groupId: "g-1" })).toBe("/#/review");
    expect(notificationUrl({ ...base, kind: "login_unhealthy" })).toBe("/#/browser");
    expect(notificationUrl({ ...base, kind: "backfill_batch" })).toBe("/#/backfill");
    expect(notificationUrl({ ...base, kind: "trial_done", groupId: "g" })).toBe("/#/backfill");
    expect(notificationUrl({ ...base, groupId: "g 1" })).toBe("/#/history/g%201");
    expect(notificationUrl(base)).toBe("/#/review");
    expect(toPayload({ ...base, groupId: "g-1" }, 9)).toEqual({
      kind: "parked",
      level: "warning",
      title: "T",
      body: "B",
      url: "/#/history/g-1",
      tag: "parked-g-1",
      ts: 9,
    });
  });

  it("PushNotifier sends, MultiNotifier fans out and reports a failure", async () => {
    const payloads: unknown[] = [];
    const push = new PushService({
      db: db(),
      vapid: VAPID,
      send: (_s, payload) => {
        payloads.push(JSON.parse(payload));
        return Promise.resolve({ statusCode: 201 });
      },
    });
    push.subscribe(sub(1), null);
    await new PushNotifier(push, () => 3).notify(base);
    await new PushNotifier(push).notify(base);
    expect(payloads).toHaveLength(2);
    const seen: string[] = [];
    const ok: Notifier = { notify: (n) => (seen.push(n.kind), Promise.resolve()) };
    const bad: Notifier = { notify: () => Promise.reject(new Error("down")) };
    await new MultiNotifier([ok, ok]).notify(base);
    await expect(new MultiNotifier([bad, ok]).notify(base)).rejects.toThrow("down");
    expect(seen).toEqual(["parked", "parked", "parked"]);
  });
});
