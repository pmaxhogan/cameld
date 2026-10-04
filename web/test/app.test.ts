import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import { status, statusError } from "../src/status.ts";
import { apiStatus, groupDetail, settings } from "./fixtures.ts";
import { byTestId, click, mountUi, stubApi, type Reply } from "./helpers.ts";

vi.mock("maplibre-gl", () => ({
  Map: class {
    on(): void {}
    remove(): void {}
  },
}));

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  status.value = null;
  statusError.value = null;
  location.hash = "";
});

const ROUTES: Record<string, Reply> = {
  "GET /api/review": { body: [] },
  "GET /api/groups": { body: [] },
  "GET /api/groups/g-1": { body: groupDetail() },
  "GET /api/backfill": { body: apiStatus().backfill },
  "GET /api/backfill/report": { body: { generatedAt: 0, progress: {}, groups: [] } },
  "GET /api/settings": { body: settings() },
};

async function mountApp(statusReply: Reply | (() => Reply) = { body: apiStatus() }) {
  const api = stubApi({ ...ROUTES, "GET /api/status": statusReply });
  const wrapper = mountUi(App);
  unmount = () => wrapper.unmount();
  await flushPromises();
  return api;
}

async function go(hash: string): Promise<void> {
  location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await flushPromises();
}

describe("App", () => {
  it("loads status into the header and shows the review queue by default", async () => {
    await mountApp();
    expect(byTestId("identity")?.textContent).toBe("test-owner");
    expect(byTestId("version")?.textContent).toBe("v9.9.9");
    for (const name of ["review", "history", "backfill", "settings", "browser"]) {
      expect(byTestId(`nav-${name}`)?.getAttribute("href")).toBe(`#/${name}`);
    }
    expect(byTestId("nav-review")?.classList.contains("active")).toBe(true);
    expect(byTestId("review-empty")).not.toBeNull();
    expect(byTestId("frozen-banner")).toBeNull();
    expect(byTestId("push-enable") ?? byTestId("push-unsupported")).toBeNull();
  });

  it("shows the frozen banner and push controls", async () => {
    await mountApp({
      body: apiStatus({
        frozen: { frozen: true, reason: "checksum mismatch", evidence: {}, frozenAt: 1 },
        push: { configured: true, publicKey: null, subscriptions: 0 },
      }),
    });
    expect(byTestId("frozen-banner")?.textContent).toContain("checksum mismatch");
    expect(byTestId("push-unsupported")).not.toBeNull();
  });

  it("routes between every area", async () => {
    await mountApp({
      body: apiStatus({ push: { configured: true, publicKey: "AQID", subscriptions: 1 } }),
    });
    await go("#/history");
    expect(byTestId("history-table")).not.toBeNull();
    await go("#/history/g-1");
    expect(byTestId("group-detail")).not.toBeNull();
    await go("#/backfill");
    expect(byTestId("backfill-progress")).not.toBeNull();
    await go("#/settings");
    expect(byTestId("settings-save")).not.toBeNull();
    await go("#/browser");
    expect(byTestId("browser-frame")).not.toBeNull();
    expect(byTestId("nav-browser")?.classList.contains("active")).toBe(true);
    await go("#/no-such-page");
    expect(byTestId("not-found-path")?.textContent).toBe("#/no-such-page");
    expect(byTestId("review-empty")).toBeNull();
    const links = [...byTestId("not-found")!.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toContain("#/review");
    expect(links).toContain("#/history");
  });

  it("shows a git sha version shortened in the footer, not the header", async () => {
    await mountApp({ body: apiStatus({ version: "abcdef0123456789abcdef0123456789abcdef01" }) });
    const version = byTestId("version")!;
    expect(version.textContent).toBe("vabcdef0");
    expect(version.closest("footer")).not.toBeNull();
    expect(version.getAttribute("title")).toContain("abcdef0123456789");
    expect(document.querySelector("header")?.textContent).not.toContain("abcdef0");
  });

  it("shows a loading state and a status error", async () => {
    await mountApp({ status: 500, body: { error: "db_down" } });
    expect(byTestId("app-loading")).not.toBeNull();
    expect(byTestId("status-error")?.textContent).toContain("db_down");
  });

  it("polls status every 30 s and after writes, and stops on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const statusReply = vi.fn(() => ({ body: apiStatus() }));
    const { calls } = await mountApp(statusReply);
    expect(statusReply).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    await flushPromises();
    expect(statusReply).toHaveBeenCalledTimes(2);
    await go("#/browser");
    stubApi({ "GET /api/status": statusReply, "POST /api/web/check": { body: {} } });
    click("browser-check");
    await flushPromises();
    expect(statusReply).toHaveBeenCalledTimes(3);
    expect(calls.length).toBeGreaterThan(0);
    unmount?.();
    unmount = null;
    vi.advanceTimersByTime(60_000);
    await flushPromises();
    expect(statusReply).toHaveBeenCalledTimes(3);
  });

  it("logs out to the login page even when the call fails", async () => {
    await mountApp();
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, hash: "" });
    stubApi({ "POST /api/auth/logout": { status: 204 }, "GET /api/status": { body: apiStatus() } });
    click("logout");
    await flushPromises();
    expect(assign).toHaveBeenCalledWith("/login");
    stubApi({ "POST /api/auth/logout": { status: 500, body: { error: "x" } } });
    click("logout");
    await flushPromises();
    expect(assign).toHaveBeenCalledTimes(2);
  });
});
