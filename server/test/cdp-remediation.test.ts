import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CdpHttp,
  type CdpTarget,
  httpBase,
  isCandidate,
  planRemediation,
  probeTarget,
  type ProbeResult,
  remediateHungTabs,
  remediationAllowed,
  safeUrl,
} from "../src/web/cdp-remediation.ts";
import { captureLogger } from "./state-helpers.ts";

/**
 * The decision logic and the DevTools HTTP/websocket plumbing of hung-tab
 * remediation, without a browser. A tiny stand-in DevTools server serves
 * /json/* and speaks just enough websocket for the probe. All targets are
 * synthetic.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type WsMode = "answer" | "events_then_answer" | "silent" | "drop" | "no_upgrade";

interface StubDevtools {
  base: string;
  targets: CdpTarget[];
  requests: string[];
  /** Ids /json/close accepts but keeps listing. */
  sticky: Set<string>;
  newTargetBody: unknown;
  listBody: unknown;
  failVersion: boolean;
  wsMode: WsMode;
}

let server: Server;
const sockets = new Set<Socket>();
const stub: StubDevtools = {
  base: "",
  targets: [],
  requests: [],
  sticky: new Set(),
  newTargetBody: undefined,
  listBody: undefined,
  failVersion: false,
  wsMode: "answer",
};

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function onUpgrade(request: IncomingMessage, socket: Socket): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
  if (stub.wsMode === "no_upgrade") return; // never answers the handshake
  const key = request.headers["sec-websocket-key"] as string;
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  if (stub.wsMode === "drop") {
    socket.end(Buffer.from([0x88, 0x00]));
    return;
  }
  socket.once("data", () => {
    if (stub.wsMode === "silent") return;
    if (stub.wsMode === "events_then_answer") {
      socket.write(textFrame("not json"));
      socket.write(textFrame('{"method":"Inspector.workerScriptLoaded","params":{}}'));
    }
    socket.write(textFrame('{"id":1,"result":{"result":{"type":"number","value":1}}}'));
  });
}

function target(id: string, type: string, url: string): CdpTarget {
  return {
    id,
    type,
    url,
    webSocketDebuggerUrl: `${stub.base.replace("http", "ws")}/devtools/page/${id}`,
  };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "/";
    stub.requests.push(`${request.method ?? "GET"} ${url}`);
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url === "/json/version") {
      if (stub.failVersion) return json({ error: "nope" }, 500);
      return json({ Browser: "Synthetic/1.0" });
    }
    if (url === "/json/list") return json(stub.listBody ?? stub.targets);
    if (url === "/json/new?about:blank" && request.method === "PUT") {
      const created = target(`blank-${stub.targets.length}`, "page", "about:blank");
      stub.targets.push(created);
      return json(stub.newTargetBody ?? created);
    }
    const close = /^\/json\/close\/(.+)$/.exec(url);
    if (close !== null) {
      const id = decodeURIComponent(close[1] as string);
      if (!stub.sticky.has(id)) stub.targets = stub.targets.filter((t) => t.id !== id);
      response.end("Target is closing");
      return undefined;
    }
    return json({ error: "not found" }, 404);
  });
  server.on("upgrade", onUpgrade);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  stub.base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  stub.targets = [
    target("TAB-OK", "page", "https://www.example.test/dashboard?token=synthetic#x"),
    target("TAB-HUNG", "page", "https://www.example.test/feed"),
    target("UI-1", "browser_ui", "chrome://omnibox-popup.top-chrome/"),
    target("SW-1", "service_worker", "chrome-extension://abcdef/background.js"),
    target("NEWTAB", "page", "chrome://newtab/"),
  ];
  stub.requests = [];
  stub.sticky = new Set();
  stub.newTargetBody = undefined;
  stub.listBody = undefined;
  stub.failVersion = false;
  stub.wsMode = "answer";
});

const http = () => new CdpHttp({ cdpUrl: stub.base });
const byId =
  (results: Record<string, ProbeResult>) =>
  (wsUrl: string | undefined): Promise<ProbeResult> => {
    const id = (wsUrl ?? "").split("/").pop() as string;
    return Promise.resolve(results[id] ?? "responsive");
  };

describe("decision logic", () => {
  it("closes exactly the unresponsive probes and opens a blank tab only then", () => {
    expect(
      planRemediation([
        { id: "a", url: "x", result: "responsive" },
        { id: "b", url: "x", result: "unresponsive" },
        { id: "c", url: "x", result: "unreachable" },
        { id: "d", url: "x", result: "unresponsive" },
      ]),
    ).toEqual({ openBlank: true, close: ["b", "d"] });
    expect(
      planRemediation([
        { id: "a", url: "x", result: "responsive" },
        { id: "c", url: "x", result: "unreachable" },
      ]),
    ).toEqual({ openBlank: false, close: [] });
    expect(planRemediation([])).toEqual({ openBlank: false, close: [] });
  });

  it("only treats ordinary web pages as candidates", () => {
    expect(isCandidate({ id: "1", type: "page", url: "https://www.example.test/" })).toBe(true);
    expect(isCandidate({ id: "2", type: "page", url: "about:blank" })).toBe(true);
    expect(isCandidate({ id: "3", type: "browser_ui", url: "chrome://omnibox-popup/" })).toBe(
      false,
    );
    expect(isCandidate({ id: "4", type: "page", url: "chrome://newtab/" })).toBe(false);
    expect(isCandidate({ id: "5", type: "page", url: "devtools://devtools/x" })).toBe(false);
    expect(isCandidate({ id: "6", type: "service_worker", url: "https://x.test/sw.js" })).toBe(
      false,
    );
    expect(isCandidate({ id: "7", type: "iframe", url: "https://x.test/" })).toBe(false);
  });

  it("rate limits remediation", () => {
    expect(remediationAllowed(null, 0, 1000)).toBe(true);
    expect(remediationAllowed(5000, 5999, 1000)).toBe(false);
    expect(remediationAllowed(5000, 6000, 1000)).toBe(true);
  });

  it("logs only the origin and path of a target", () => {
    expect(safeUrl("https://www.example.test/a/b?token=secret#frag")).toBe(
      "https://www.example.test/a/b",
    );
    expect(safeUrl("about:blank")).toBe("about:blank");
    expect(safeUrl("not a url")).toBe("(unparseable)");
  });

  it("derives the DevTools HTTP base from http and ws CDP URLs", () => {
    expect(httpBase("http://browser.example.test:9222").toString()).toBe(
      "http://browser.example.test:9222/",
    );
    expect(httpBase("ws://browser.example.test:9222/x?y=1#z").toString()).toBe(
      "http://browser.example.test:9222/x/",
    );
    expect(httpBase("wss://browser.example.test/").toString()).toBe(
      "https://browser.example.test/",
    );
  });
});

describe("CdpHttp", () => {
  it("tells whether the browser answers", async () => {
    expect(await http().answers()).toBe(true);
    stub.failVersion = true;
    expect(await http().answers()).toBe(false);
    expect(await new CdpHttp({ cdpUrl: "http://127.0.0.1:9", timeoutMs: 1000 }).answers()).toBe(
      false,
    );
  });

  it("lists well-formed targets only", async () => {
    stub.listBody = [{ id: "a", type: "page", url: "about:blank" }, { id: 1 }, null, "x"];
    expect(await http().list()).toEqual([{ id: "a", type: "page", url: "about:blank" }]);
    stub.listBody = { not: "a list" };
    await expect(http().list()).rejects.toThrow("not a list");
  });

  it("refuses a /json/new answer without an id", async () => {
    stub.newTargetBody = { nope: true };
    await expect(http().openBlank()).rejects.toThrow("no target id");
  });

  it("reports an error status without the query string", async () => {
    await expect(new CdpHttp({ cdpUrl: `${stub.base}/missing` }).openBlank()).rejects.toThrow(
      "devtools PUT /json/new answered 404",
    );
  });
});

describe("probeTarget", () => {
  const ws = () => `${stub.base.replace("http", "ws")}/devtools/page/X`;

  it("answers responsive when the page evaluates, ignoring events and non-JSON frames", async () => {
    expect(await probeTarget(ws(), 2000)).toBe("responsive");
    stub.wsMode = "events_then_answer";
    expect(await probeTarget(ws(), 2000)).toBe("responsive");
  });

  it("answers unresponsive only when an open socket stays silent", async () => {
    stub.wsMode = "silent";
    expect(await probeTarget(ws(), 300)).toBe("unresponsive");
  });

  it("answers unreachable when the socket never opens, is dropped or cannot be made", async () => {
    stub.wsMode = "no_upgrade";
    expect(await probeTarget(ws(), 300)).toBe("unreachable");
    stub.wsMode = "drop";
    expect(await probeTarget(ws(), 2000)).toBe("unreachable");
    expect(await probeTarget("ws://127.0.0.1:9/devtools/page/X", 2000)).toBe("unreachable");
    expect(await probeTarget("not a url", 2000)).toBe("unreachable");
    expect(await probeTarget(undefined, 2000)).toBe("unreachable");
    expect(await probeTarget("", 2000)).toBe("unreachable");
  });
});

describe("remediateHungTabs", () => {
  it("opens a blank tab first, closes only the hung page, never touches browser UI", async () => {
    const { log, lines } = captureLogger();
    const probed: string[] = [];
    const result = await remediateHungTabs({
      http: http(),
      log,
      probe: (wsUrl, timeoutMs) => {
        probed.push(String(wsUrl).split("/").pop() as string);
        expect(timeoutMs).toBe(5000);
        return byId({ "TAB-HUNG": "unresponsive" })(wsUrl);
      },
    });
    expect(probed.sort()).toEqual(["TAB-HUNG", "TAB-OK"]);
    expect(result).toEqual({
      probed: [
        { id: "TAB-OK", url: "https://www.example.test/dashboard", result: "responsive" },
        { id: "TAB-HUNG", url: "https://www.example.test/feed", result: "unresponsive" },
      ],
      openedBlank: true,
      closed: [{ id: "TAB-HUNG", url: "https://www.example.test/feed", result: "unresponsive" }],
      stillListed: [],
    });
    const writes = stub.requests.filter((r) => !r.endsWith("/json/list"));
    expect(writes).toEqual(["PUT /json/new?about:blank", "GET /json/close/TAB-HUNG"]);
    expect(stub.targets.map((t) => t.id)).toEqual(["TAB-OK", "UI-1", "SW-1", "NEWTAB", "blank-5"]);
    const text = lines.join("");
    expect(text).toContain("closed an unresponsive browser tab");
    expect(text).not.toContain("token=synthetic");
  });

  it("changes nothing when every page answers or proves nothing", async () => {
    const result = await remediateHungTabs({
      http: http(),
      probeTimeoutMs: 10,
      probe: byId({ "TAB-OK": "unreachable" }),
    });
    expect(result.openedBlank).toBe(false);
    expect(result.closed).toEqual([]);
    expect(stub.requests).toEqual(["GET /json/list"]);
  });

  it("reports a closed tab that is still listed when the wait runs out", async () => {
    stub.sticky.add("TAB-HUNG");
    const sleeps: number[] = [];
    const result = await remediateHungTabs({
      http: http(),
      closeWaitMs: 50,
      probe: byId({ "TAB-HUNG": "unresponsive" }),
      sleep: (ms) => {
        sleeps.push(ms);
        return new Promise((r) => setTimeout(r, 30));
      },
    });
    expect(result.stillListed).toEqual(["TAB-HUNG"]);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("uses the real probe and timer by default", async () => {
    stub.wsMode = "silent";
    stub.targets = [target("ONLY", "page", "https://www.example.test/feed")];
    stub.sticky.add("ONLY");
    const result = await remediateHungTabs({ http: http(), probeTimeoutMs: 200, closeWaitMs: 300 });
    expect(result.closed.map((t) => t.id)).toEqual(["ONLY"]);
    expect(result.stillListed).toEqual(["ONLY"]);
    expect(stub.targets.map((t) => t.url)).toContain("about:blank");
  });
});
