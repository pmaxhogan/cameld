import type { Browser } from "playwright-core";
import { describe, expect, it } from "vitest";

import type { RemediationReport } from "../src/web/cdp-remediation.ts";
import { BrowserUnavailableError, LoginRequiredError, WebTimeoutError } from "../src/web/errors.ts";
import { assertId, DEFAULT_BASE_URL, WebSession } from "../src/web/session.ts";
import { captureLogger } from "./state-helpers.ts";

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

  it("passes a non-timeout failure of the hydration wait through without reading", async () => {
    let evaluated = 0;
    const page = {
      ...stubPage(),
      goto: () => Promise.resolve({ status: () => 200 }),
      url: () => "https://www.strava.com/activities/1/edit",
      content: () => Promise.resolve("<html><body>synthetic</body></html>"),
      waitForFunction: () => Promise.reject(new TypeError("synthetic page crash")),
      evaluate: () => {
        evaluated += 1;
        return Promise.resolve(null);
      },
    };
    const web = session(
      stubBrowser([{ newPage: () => Promise.resolve(page as unknown as StubPage) }]),
    );
    await expect(web.getEditForm(1)).rejects.toThrow("synthetic page crash");
    expect(evaluated).toBe(0);
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

describe("WebSession hung-tab remediation (decision paths, no browser)", () => {
  /** A synthetic DevTools HTTP endpoint: one hung page, one fine page, one browser UI target. */
  function devtools(over: { version?: number; list?: number } = {}) {
    const calls: string[] = [];
    let targets = [
      {
        id: "FINE",
        type: "page",
        url: "https://www.example.test/a",
        webSocketDebuggerUrl: "ws://x/FINE",
      },
      {
        id: "HUNG",
        type: "page",
        url: "https://www.example.test/b",
        webSocketDebuggerUrl: "ws://x/HUNG",
      },
      { id: "UI", type: "browser_ui", url: "chrome://omnibox-popup.top-chrome/" },
    ];
    const reply = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    const fetchStub = ((input: URL) => {
      const path = `${input.pathname}${input.search}`;
      calls.push(path);
      if (path === "/json/version") return reply({}, over.version ?? 200);
      if (path === "/json/list") return reply(targets, over.list ?? 200);
      if (path === "/json/new?about:blank") {
        targets = [...targets, { id: "BLANK", type: "page", url: "about:blank" }];
        return reply({ id: "BLANK" });
      }
      targets = targets.filter((t) => `/json/close/${t.id}` !== path);
      return reply("Target is closing");
    }) as unknown as typeof fetch;
    return { calls, fetchStub, ids: () => targets.map((t) => t.id) };
  }

  const probe = (wsUrl: string | undefined) =>
    Promise.resolve(wsUrl === "ws://x/HUNG" ? ("unresponsive" as const) : ("responsive" as const));

  /** A page whose first navigation proves the connection worked (it reports a login problem). */
  function workingBrowser(): Browser {
    const page = {
      ...stubPage(),
      goto: () => Promise.reject(new LoginRequiredError("synthetic expired session")),
    };
    return stubBrowser([{ newPage: () => Promise.resolve(page as unknown as StubPage) }]);
  }

  function clockAt(start: number) {
    const clock = { t: start, now: () => clock.t, sleep: () => Promise.resolve() };
    return clock;
  }

  it("leaves a browser that does not answer over HTTP alone", async () => {
    const dt = devtools({ version: 500 });
    const reports: unknown[] = [];
    const web = new WebSession({
      cdpUrl: "http://browser.example.test:9222",
      connect: () => Promise.reject(new Error("synthetic connect timeout")),
      cdpFetch: dt.fetchStub,
      probe,
      onRemediation: (r) => {
        reports.push(r);
      },
    });
    expect((await web.health()).reason).toBe("browser_unavailable");
    expect(dt.calls).toEqual(["/json/version"]);
    expect(reports).toEqual([]);
  });

  it("recovers, reports it, and does not remediate again inside the interval", async () => {
    const dt = devtools();
    const { log, lines } = captureLogger();
    const clock = clockAt(1_000_000);
    let connects = 0;
    const reports: RemediationReport[] = [];
    const browser = workingBrowser();
    const web = new WebSession({
      cdpUrl: "http://browser.example.test:9222",
      logger: log,
      clock,
      connect: () => {
        connects += 1;
        return connects === 2
          ? Promise.resolve(browser)
          : Promise.reject(new Error("synthetic hang"));
      },
      cdpFetch: dt.fetchStub,
      probe,
      remediationIntervalMs: 60_000,
      onRemediation: (r) => {
        reports.push(r);
      },
    });
    expect((await web.health()).reason).toBe("login_required");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "recovered", openedBlank: true, stillListed: [] });
    expect(reports[0]?.closed.map((t) => t.id)).toEqual(["HUNG"]);
    expect(dt.ids()).toEqual(["FINE", "UI", "BLANK"]);
    expect(lines.join("")).toContain("browser remediation recovered the CDP connection");

    // Connection lost again inside the interval: plain browser_unavailable, no second remediation.
    await web.disconnect();
    clock.t += 59_999;
    expect((await web.health()).reason).toBe("browser_unavailable");
    expect(reports).toHaveLength(1);
    // After the interval a new remediation runs (nothing hung now, so it fails and says so).
    clock.t += 1;
    expect((await web.health()).reason).toBe("browser_unavailable");
    expect(reports.map((r) => r.outcome)).toEqual(["recovered", "failed"]);
    expect(reports[1]).toMatchObject({
      closed: [],
      error: "connect still fails after remediation",
    });
    expect(lines.join("")).toContain("a manual browser restart is needed");
  });

  it("reports a remediation that could not complete, and survives a failing callback", async () => {
    const dt = devtools({ list: 500 });
    const { log, lines } = captureLogger();
    const reports: RemediationReport[] = [];
    const web = new WebSession({
      cdpUrl: "http://browser.example.test:9222",
      logger: log,
      connect: () => Promise.reject(new Error("synthetic hang")),
      cdpFetch: dt.fetchStub,
      onRemediation: (r) => {
        reports.push(r);
        throw new Error("synthetic notifier bug");
      },
    });
    await expect(web.exportGpx(1)).rejects.toThrow("after remediation");
    expect(reports).toEqual([
      {
        outcome: "failed",
        probed: [],
        openedBlank: false,
        closed: [],
        stillListed: [],
        error: "remediation could not complete",
      },
    ]);
    expect(lines.join("")).toContain("remediation callback failed");
  });

  it("works without a logger or callback", async () => {
    const dt = devtools();
    let connects = 0;
    const browser = workingBrowser();
    const web = new WebSession({
      cdpUrl: "http://browser.example.test:9222",
      connect: () => {
        connects += 1;
        return connects === 2
          ? Promise.resolve(browser)
          : Promise.reject(new Error("synthetic hang"));
      },
      cdpFetch: dt.fetchStub,
      probe,
    });
    expect((await web.health()).reason).toBe("login_required");
    expect(dt.ids()).not.toContain("HUNG");
  });

  it("shares one connection attempt between an operation that timed out and the next", async () => {
    let connects = 0;
    const browser = workingBrowser();
    const web = new WebSession({
      cdpUrl: "http://browser.example.test:9222",
      operationTimeoutMs: 30,
      connect: () => {
        connects += 1;
        return new Promise((resolve) => setTimeout(() => resolve(browser), 80));
      },
    });
    expect((await web.health()).reason).toBe("timeout");
    expect((await web.health()).reason).toBe("timeout");
    await new Promise((r) => setTimeout(r, 100));
    expect(connects).toBe(1);
  });
});
