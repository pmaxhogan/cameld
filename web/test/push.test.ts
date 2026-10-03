import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushSupported,
  sendTestPush,
  urlBase64ToUint8Array,
} from "../src/push.ts";
import { stubApi } from "./helpers.ts";

interface FakeSub {
  endpoint: string;
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => unknown;
}

function fakeSub(): FakeSub {
  return {
    endpoint: "https://push.example/abc",
    unsubscribe: vi.fn(() => Promise.resolve(true)),
    toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }),
  };
}

/** Installs a fake service worker container; `existing` is the current subscription. */
function installWorker(existing: FakeSub | null, registered = true) {
  const subscribe = vi.fn(() => Promise.resolve(fakeSub()));
  const reg = { pushManager: { subscribe, getSubscription: () => Promise.resolve(existing) } };
  const register = vi.fn(() => Promise.resolve(reg));
  vi.stubGlobal("navigator", {
    serviceWorker: {
      register,
      ready: Promise.resolve(reg),
      getRegistration: () => Promise.resolve(registered ? reg : undefined),
    },
  });
  return { subscribe, register };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("push", () => {
  it("detects support", () => {
    vi.stubGlobal("navigator", {});
    expect(pushSupported()).toBe(false);
    installWorker(null);
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", class {});
    vi.stubGlobal("isSecureContext", true);
    expect(pushSupported()).toBe(true);
    vi.stubGlobal("isSecureContext", false);
    expect(pushSupported()).toBe(false);
  });

  it("decodes base64url keys", () => {
    expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array("-_8")]).toEqual([251, 255]);
  });

  it("subscribes after permission and registers the subscription", async () => {
    const { calls } = stubApi({ "POST /api/push/subscribe": { body: { ok: true } } });
    const { subscribe, register } = installWorker(null);
    vi.stubGlobal("Notification", { requestPermission: () => Promise.resolve("granted") });
    await enablePush("AQID");
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(calls[0]!.body).toMatchObject({ endpoint: "https://push.example/abc" });
  });

  it("refuses when permission is denied", async () => {
    installWorker(null);
    vi.stubGlobal("Notification", { requestPermission: () => Promise.resolve("denied") });
    await expect(enablePush("AQID")).rejects.toThrow("notification permission denied");
  });

  it("reads and removes the current subscription", async () => {
    const { calls } = stubApi({ "POST /api/push/unsubscribe": { body: { removed: true } } });
    installWorker(null, false);
    expect(await currentSubscription()).toBeNull();
    await disablePush();
    expect(calls).toHaveLength(0);

    const sub = fakeSub();
    installWorker(sub);
    expect(await currentSubscription()).toBe(sub);
    await disablePush();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(calls[0]!.body).toEqual({ endpoint: "https://push.example/abc" });
  });

  it("sends a test push", async () => {
    stubApi({ "POST /api/push/test": { body: { configured: true, total: 1, sent: 1 } } });
    await expect(sendTestPush()).resolves.toMatchObject({ sent: 1 });
  });
});
