import type { PushSendSummary, PushSubscriptionBody } from "@cameld/shared";
import { apiPost } from "./api.ts";

/** Web Push client: service worker registration plus subscribe and unsubscribe. */

export function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

/** Decodes a base64url VAPID public key into the bytes PushManager wants. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/** The browser's current subscription, or null when push is off here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (reg === undefined) return null;
  return reg.pushManager.getSubscription();
}

/** Asks for permission, subscribes, and registers the subscription with the server. */
export async function enablePush(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(`notification permission ${permission}`);
  const reg = await registration();
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await apiPost<{ ok: true }>("/api/push/subscribe", subscription.toJSON() as PushSubscriptionBody);
}

/** Unsubscribes this browser and tells the server to forget it. */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription === null) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await apiPost<{ removed: boolean }>("/api/push/unsubscribe", { endpoint });
}

export function sendTestPush(): Promise<PushSendSummary> {
  return apiPost<PushSendSummary>("/api/push/test");
}
