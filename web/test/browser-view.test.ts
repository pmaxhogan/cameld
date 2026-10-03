import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import BrowserView from "../src/views/BrowserView.vue";
import { apiStatus } from "./fixtures.ts";
import { byTestId, click, mountUi, stubApi } from "./helpers.ts";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

function mountBrowser(status = apiStatus()): void {
  const wrapper = mountUi(BrowserView, { props: { status } });
  unmount = () => wrapper.unmount();
}

describe("BrowserView", () => {
  it("explains when the browser is not configured", () => {
    mountBrowser(apiStatus({ browserAvailable: false }));
    expect(byTestId("browser-unavailable")?.textContent).toContain("BROWSER_VNC_URL");
    expect(byTestId("browser-frame")).toBeNull();
  });

  it("embeds the VNC client, checks the login and reloads", async () => {
    const { calls } = stubApi({ "POST /api/web/check": { body: { healthy: true, reason: null } } });
    mountBrowser(apiStatus({ web: { healthy: false, reason: "logged out" } }));
    const frame = byTestId("browser-frame") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(
      "/browser/?autoconnect=1&resize=remote&reconnect=1&path=browser/websockify",
    );
    expect(frame.getAttribute("allow")).toBe("clipboard-read; clipboard-write");
    expect(frame.getAttribute("title")).toBe("Strava login browser");
    expect(byTestId("browser-health")?.textContent).toContain("login unhealthy");
    expect(byTestId("browser-fullscreen")?.getAttribute("target")).toBe("_blank");
    click("browser-check");
    await flushPromises();
    expect(calls[0]!.method).toBe("POST");
    click("browser-reload");
    await flushPromises();
    expect(frame.getAttribute("src")).toMatch(/&r=\d+$/);
  });

  it("shows a healthy login and check failures", async () => {
    stubApi({ "POST /api/web/check": { status: 503, body: { error: "browser_down" } } });
    mountBrowser();
    expect(byTestId("browser-health")?.textContent).toContain("login healthy");
    click("browser-check");
    await flushPromises();
    expect(byTestId("browser-error")?.textContent).toContain("browser_down");
  });
});
