import { createHash } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  request,
  type Server,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import selfsigned from "selfsigned";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BROWSER_PREFIX,
  BrowserProxyConfigError,
  normalizeFingerprint,
  refuse,
  VncProxy,
} from "../src/browser/proxy.ts";
import { createLogger } from "../src/logging.ts";

const log = createLogger({ logLevel: "silent" });
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    closers.push(
      () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    );
  });
}

/** A fake KasmVNC: echoes requests, answers websocket upgrades, records what it saw. */
function fakeUpstream(server: Server, seen: Seen[]): void {
  server.on("request", (req, res) => {
    seen.push({ url: req.url as string, headers: req.headers });
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { location: "/vnc.html" });
      res.end();
      return;
    }
    if (req.url?.startsWith("/absolute")) {
      res.writeHead(302, { location: "https://elsewhere.example/" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "upstream=1",
      "www-authenticate": 'Basic realm="kasm"',
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    });
    res.end(`page ${req.url as string}`);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    seen.push({ url: req.url as string, headers: req.headers });
    socket.on("end", () => socket.destroy());
    if (req.url?.includes("refuse")) {
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: abc\r\n\r\nhello-from-upstream",
    );
    if (head.length > 0) socket.write(head);
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  });
}

async function proxyApp(proxy: VncProxy): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify({ loggerInstance: log });
  app.get(`${BROWSER_PREFIX}*`, (req, reply) => proxy.handle(req, reply));
  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
    proxy.upgrade(req, socket, head),
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(async () => {
    proxy.close();
    await app.close();
  });
  return { app, port: (app.server.address() as AddressInfo).port };
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode as number, headers: res.headers, body }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Send a raw websocket upgrade and collect what comes back for a moment. */
function upgrade(port: number, path: string, send = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        cookie: "cameld_session=secret",
      },
    });
    req.on("upgrade", (res, socket, head) => {
      let text = `${String(res.statusCode)} ${head.toString()}`;
      socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
      if (send !== "") socket.write(send);
      setTimeout(() => {
        socket.destroy();
        resolve(text);
      }, 150);
    });
    req.on("response", (res) => {
      res.resume();
      res.socket.destroy();
      resolve(String(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("VncProxy.target", () => {
  const proxy = new VncProxy({ upstream: "http://127.0.0.1:6901/kasm/", log });
  closers.push(() => proxy.close());

  it("maps /browser/<path> under the base path, keeping the query", () => {
    expect(proxy.target("/browser/")?.href).toBe("http://127.0.0.1:6901/kasm/");
    expect(proxy.target("/browser/vnc.html?autoconnect=1&path=browser/websockify")?.href).toBe(
      "http://127.0.0.1:6901/kasm/vnc.html?autoconnect=1&path=browser/websockify",
    );
    expect(proxy.target("/browser/core/util.js")?.pathname).toBe("/kasm/core/util.js");
  });

  it("refuses anything that could leave the upstream origin or base path", () => {
    for (const path of [
      "/elsewhere",
      "/browser/http:evil.example/",
      "/browser/https://evil.example/",
      "/browser//evil.example/",
      "/browser/\\\\evil.example",
      "/browser/%5C%5Cevil.example",
      "/browser/%2e%2e/",
      "/browser/..%2f",
      "/browser/a/../../x",
      "/browser/./x",
      "/browser/%2F%2Fevil.example",
      "/browser/javascript:alert(1)",
      "/browser/a%0d%0aHost:%20evil",
      "/browser/a%00",
      "/browser/%E0%A4%A",
      "/browser/x?a=1%0d%0a#frag",
      "/browser/x?a\r\nb",
    ]) {
      expect(proxy.target(path), path).toBeNull();
    }
  });
});

describe("VncProxy configuration", () => {
  it("refuses plain http to a non-loopback host, https without a CA and a bad pin", () => {
    expect(() => new VncProxy({ upstream: "http://cameld-browser:6901" })).toThrow(
      BrowserProxyConfigError,
    );
    expect(() => new VncProxy({ upstream: "ftp://127.0.0.1/" })).toThrow(BrowserProxyConfigError);
    expect(() => new VncProxy({ upstream: "https://cameld-browser:6901" })).toThrow(/CA_FILE/);
    expect(() => new VncProxy({ upstream: "https://cameld-browser:6901", ca: "  " })).toThrow(
      /CA_FILE/,
    );
    expect(
      () => new VncProxy({ upstream: "https://cameld-browser:6901", ca: "pem", certSha256: "abc" }),
    ).toThrow(/CERT_SHA256/);
  });

  it("normalizes fingerprints in hex or colon form", () => {
    const hex = "ab".repeat(32);
    const colon = normalizeFingerprint(hex);
    expect(colon).toBe(Array(32).fill("AB").join(":"));
    expect(normalizeFingerprint(colon as string)).toBe(colon);
    expect(normalizeFingerprint("zz")).toBeNull();
  });
});

describe("VncProxy over http (loopback)", () => {
  it("injects basic auth, drops the owner's headers and filters the response", async () => {
    const seen: Seen[] = [];
    const upstreamServer = createHttpServer();
    fakeUpstream(upstreamServer, seen);
    const upstreamPort = await listen(upstreamServer);
    const proxy = new VncProxy({
      upstream: `http://127.0.0.1:${String(upstreamPort)}`,
      user: "kasm_user",
      password: "synthetic-vnc-password",
      log,
    });
    const { port } = await proxyApp(proxy);

    const page = await get(port, "/browser/vnc.html?autoconnect=1", {
      cookie: "cameld_session=secret; CF_Authorization=jwt",
      "cf-access-jwt-assertion": "jwt",
      origin: "https://cameld.example.com",
      accept: "text/html",
    });
    expect(page.status).toBe(200);
    expect(page.body).toBe("page /vnc.html?autoconnect=1");
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(page.headers["www-authenticate"]).toBeUndefined();
    expect(page.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(page.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(page.headers["cache-control"]).toBe("no-store");

    const forwarded = seen[0]?.headers ?? {};
    expect(forwarded.authorization).toBe(
      `Basic ${Buffer.from("kasm_user:synthetic-vnc-password").toString("base64")}`,
    );
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded["cf-access-jwt-assertion"]).toBeUndefined();
    expect(forwarded.origin).toBeUndefined();
    expect(forwarded.host).toBe(`127.0.0.1:${String(upstreamPort)}`);
    expect(forwarded.accept).toBe("text/html");

    const redirect = await get(port, "/browser/redirect");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("/browser/vnc.html");
    const absolute = await get(port, "/browser/absolute");
    expect(absolute.headers.location).toBeUndefined();

    expect((await get(port, "/browser/%2e%2e/")).status).toBe(400);
  });

  it("never sends a request (with credentials or not) to another origin", async () => {
    const evilSeen: Seen[] = [];
    const evil = createHttpServer();
    fakeUpstream(evil, evilSeen);
    const evilPort = await listen(evil);
    const seen: Seen[] = [];
    const upstreamServer = createHttpServer();
    fakeUpstream(upstreamServer, seen);
    const upstreamPort = await listen(upstreamServer);
    const proxy = new VncProxy({
      upstream: `http://127.0.0.1:${String(upstreamPort)}/base/`,
      user: "kasm_user",
      password: "synthetic-vnc-password",
    });
    const { port } = await proxyApp(proxy);
    const evilHost = `127.0.0.1:${String(evilPort)}`;
    for (const path of [
      `/browser/http:${evilHost}/`,
      `/browser/http://${evilHost}/`,
      `/browser//${evilHost}/`,
      `/browser/%2F%2F${evilHost}/`,
      `/browser/\\\\${evilHost}`,
      `/browser/%5C%5C${evilHost}`,
      "/browser/%2e%2e/",
      "/browser/..%2f",
      "/browser/a/../../x",
    ]) {
      const response = await get(port, path);
      // Either refused outright, or (for a path Node normalizes first) served under the base.
      if (response.status !== 400) expect(seen.at(-1)?.url.startsWith("/base/")).toBe(true);
    }
    expect(await upgrade(port, `/browser/http://${evilHost}/websockify`)).toBe("400");
    expect(evilSeen).toEqual([]);
    for (const request of seen) expect(request.url.startsWith("/base/")).toBe(true);
  });

  it("answers 502 when the sidecar is unreachable, with no detail", async () => {
    const closed = createHttpServer();
    const deadPort = await listen(closed);
    await new Promise<void>((done) => closed.close(() => done()));
    const proxy = new VncProxy({ upstream: `http://127.0.0.1:${String(deadPort)}`, log });
    const { port } = await proxyApp(proxy);
    const response = await get(port, "/browser/");
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: "browser_unreachable" });
    expect(await upgrade(port, "/browser/websockify")).toBe("502");
  });

  it("splices websocket upgrades both ways with credentials injected", async () => {
    const seen: Seen[] = [];
    const upstreamServer = createHttpServer();
    fakeUpstream(upstreamServer, seen);
    const upstreamPort = await listen(upstreamServer);
    const proxy = new VncProxy({
      upstream: `http://127.0.0.1:${String(upstreamPort)}`,
      user: "kasm_user",
    });
    const { port } = await proxyApp(proxy);
    const text = await upgrade(port, "/browser/websockify", "ping");
    expect(text.startsWith("101 ")).toBe(true);
    expect(text).toContain("hello-from-upstream");
    expect(text).toContain("ping");
    const forwarded = seen.at(-1)?.headers ?? {};
    expect(forwarded.authorization).toBe(`Basic ${Buffer.from("kasm_user:").toString("base64")}`);
    expect(forwarded.cookie).toBeUndefined();
    expect(forwarded["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");

    expect(await upgrade(port, "/browser/refuse")).toBe("502");
    expect(await upgrade(port, "/browser/..%2f")).toBe("400");
  });

  it("times out a stalled sidecar, before and after the headers", async () => {
    const stalled = createHttpServer((req, res) => {
      if (req.url === "/half") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
      }
      // Never finishes.
    });
    const held: Duplex[] = [];
    stalled.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
      // Never answers the upgrade.
      held.push(socket);
    });
    const upstreamPort = await listen(stalled);
    closers.push(() => held.forEach((socket) => socket.destroy()));
    const proxy = new VncProxy({
      upstream: `http://127.0.0.1:${String(upstreamPort)}`,
      timeoutMs: 100,
      log,
    });
    const { port } = await proxyApp(proxy);
    expect((await get(port, "/browser/")).status).toBe(502);
    await expect(get(port, "/browser/half")).rejects.toThrow();
    expect(await upgrade(port, "/browser/websockify")).toBe("502");
  });

  it("refuse() closes a socket that can no longer be written", () => {
    let destroyed = false;
    const socket = {
      writable: false,
      destroy: () => {
        destroyed = true;
      },
    } as unknown as Duplex;
    refuse(socket, 400, "Bad Request");
    expect(destroyed).toBe(true);
  });
});

describe("VncProxy over https with the sidecar's self-signed certificate", () => {
  let pems: { cert: string; private: string };
  let other: { cert: string };
  let fingerprint: string;

  beforeAll(async () => {
    const attrs = [{ name: "commonName", value: "localhost" }];
    const options = {
      keySize: 2048,
      extensions: [
        { name: "basicConstraints", cA: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
      ],
    };
    pems = await selfsigned.generate(attrs, options);
    other = await selfsigned.generate(attrs, options);
    const der = Buffer.from(
      pems.cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
      "base64",
    );
    fingerprint = createHash("sha256").update(der).digest("hex");
  });

  async function tlsUpstream(): Promise<{ port: number; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createHttpsServer({ key: pems.private, cert: pems.cert });
    fakeUpstream(server as unknown as Server, seen);
    const port = await listen(server as unknown as Server);
    return { port, seen };
  }

  it("connects with the certificate as the only CA and a matching pin (http and websocket)", async () => {
    const { port: upstreamPort } = await tlsUpstream();
    const proxy = new VncProxy({
      upstream: `https://127.0.0.1:${String(upstreamPort)}`,
      ca: pems.cert,
      certSha256: fingerprint,
      user: "kasm_user",
      password: "synthetic-vnc-password",
    });
    const { port } = await proxyApp(proxy);
    expect((await get(port, "/browser/")).body).toBe("page /");
    expect((await upgrade(port, "/browser/websockify")).startsWith("101 ")).toBe(true);
  });

  it("refuses a certificate that does not match the pin", async () => {
    const { port: upstreamPort, seen } = await tlsUpstream();
    const proxy = new VncProxy({
      upstream: `https://127.0.0.1:${String(upstreamPort)}`,
      ca: pems.cert,
      certSha256: "00".repeat(32),
      user: "kasm_user",
      password: "synthetic-vnc-password",
    });
    const { port } = await proxyApp(proxy);
    expect((await get(port, "/browser/")).status).toBe(502);
    expect(await upgrade(port, "/browser/websockify")).toBe("502");
    expect(seen).toEqual([]);
  });

  it("refuses a certificate the configured CA did not issue", async () => {
    const { port: upstreamPort, seen } = await tlsUpstream();
    const proxy = new VncProxy({
      upstream: `https://localhost:${String(upstreamPort)}`,
      ca: other.cert,
      user: "kasm_user",
      password: "synthetic-vnc-password",
    });
    const { port } = await proxyApp(proxy);
    expect((await get(port, "/browser/")).status).toBe(502);
    expect(seen).toEqual([]);
  });

  it("without a pin, checks the host name against the trusted certificate", async () => {
    const { port: upstreamPort } = await tlsUpstream();
    const good = new VncProxy({
      upstream: `https://localhost:${String(upstreamPort)}`,
      ca: pems.cert,
    });
    const { port } = await proxyApp(good);
    expect((await get(port, "/browser/")).status).toBe(200);
    const wrongName = new VncProxy({
      upstream: `https://127.0.0.1:${String(upstreamPort)}`,
      ca: pems.cert,
    });
    const second = await proxyApp(wrongName);
    expect((await get(second.port, "/browser/")).status).toBe(502);
  });
});
