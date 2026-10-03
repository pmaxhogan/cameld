import type { Browser } from "playwright-core";
import { describe, expect, it } from "vitest";

import { BrowserUnavailableError, WebTimeoutError } from "../src/web/errors.ts";
import { assertId, DEFAULT_BASE_URL, WebSession } from "../src/web/session.ts";

/**
 * Edge paths of WebSession that a real browser cannot be made to hit on
 * demand: a browser without a default context, a page that opens after the
 * deadline, a page whose close hangs, and a programming error inside an
 * operation. The browser here is a hand-rolled stand-in.
 */

interface StubPage {
  closed: boolean;
  setDefaultTimeout(ms: number): void;
  goto(): Promise<never>;
  close(): Promise<void>;
}

function stubPage(close: () => Promise<void> = () => Promise.resolve()): StubPage {
  const page: StubPage = {
    closed: false,
    setDefaultTimeout: () => undefined,
    goto: () => Promise.reject(new TypeError("synthetic programming error")),
    close: async () => {
      await close();
      page.closed = true;
    },
  };
  return page;
}

function stubBrowser(contexts: { newPage(): Promise<StubPage> }[]): Browser {
  return {
    contexts: () => contexts,
    isConnected: () => true,
    close: () => Promise.resolve(),
  } as unknown as Browser;
}

function session(browser: Browser, extra: { operationTimeoutMs?: number } = {}) {
  return new WebSession({
    cdpUrl: "http://browser.example.test:9222",
    connect: () => Promise.resolve(browser),
    ...extra,
  });
}

describe("WebSession edge paths", () => {
  it("defaults to www.strava.com", () => {
    expect(DEFAULT_BASE_URL).toBe("https://www.strava.com");
  });

  it("validates ids", () => {
    expect(() => assertId(1)).not.toThrow();
    expect(() => assertId(0)).toThrow("activity id must be a positive integer");
    expect(() => assertId(Number.MAX_SAFE_INTEGER + 1, "athlete id")).toThrow(/athlete id/);
  });

  it("refuses a browser without a default context", async () => {
    const web = session(stubBrowser([]));
    await expect(web.getEditForm(1)).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(await web.health()).toMatchObject({ loggedIn: false, reason: "browser_unavailable" });
  });

  it("rethrows programming errors from health instead of calling them unhealthy", async () => {
    const page = stubPage();
    const web = session(stubBrowser([{ newPage: () => Promise.resolve(page) }]));
    await expect(web.health()).rejects.toThrow(TypeError);
    expect(page.closed).toBe(true);
  });

  it("closes a page that finished opening after the deadline", async () => {
    const page = stubPage();
    const late = new Promise<StubPage>((resolve) => setTimeout(() => resolve(page), 150));
    const web = session(stubBrowser([{ newPage: () => late }]), { operationTimeoutMs: 20 });
    await expect(web.exportGpx(1)).rejects.toBeInstanceOf(WebTimeoutError);
    await late;
    await new Promise((r) => setTimeout(r, 20));
    expect(page.closed).toBe(true);
  });

  it("does not wait forever on a page that will not close", async () => {
    const page = stubPage(() => new Promise<void>(() => undefined));
    const web = new WebSession({
      cdpUrl: "http://browser.example.test:9222",
      connect: () => Promise.resolve(stubBrowser([{ newPage: () => Promise.resolve(page) }])),
      pageCloseTimeoutMs: 20,
    });
    await expect(web.getEditForm(1)).rejects.toThrow(TypeError);
  });

  it("disconnect without a connection is a no-op", async () => {
    await new WebSession({ cdpUrl: "http://browser.example.test:9222" }).disconnect();
  });

  it("reuses one connection across operations", async () => {
    let connects = 0;
    const browser = stubBrowser([{ newPage: () => Promise.resolve(stubPage()) }]);
    const web = new WebSession({
      cdpUrl: "http://browser.example.test:9222",
      connect: () => {
        connects += 1;
        return Promise.resolve(browser);
      },
    });
    await expect(web.getEditForm(1)).rejects.toThrow(TypeError);
    await expect(web.getEditForm(2)).rejects.toThrow(TypeError);
    expect(connects).toBe(1);
    await web.disconnect();
  });
});
