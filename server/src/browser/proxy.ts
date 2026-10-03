import {
  Agent as HttpAgent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "../logging.ts";

/**
 * Same-origin proxy for the browser sidecar's KasmVNC web client
 * (docs/STRAVA-WEB.md, "Login"). The UI embeds /browser/ in an iframe, so the
 * owner logs in to strava.com through cameld's own origin and therefore
 * through Cloudflare Access and the password gate. The proxy:
 *
 * - forwards GET/HEAD and WebSocket upgrades only, under /browser/ only. The
 *   upstream URL is built by cloning the configured base and setting its
 *   pathname and search (never by relative resolution) from a path that has
 *   no scheme, backslash, leading slash, dot segment or control character,
 *   and is checked to still sit under the base origin and path before the
 *   credentials are attached;
 * - rebuilds request headers from an allowlist, so the owner's cookies, the
 *   Access JWT and the Origin never reach the sidecar, and injects the
 *   sidecar's basic-auth credentials server side (the browser never sees
 *   them, and they never appear in a URL or a log line);
 * - verifies the sidecar's TLS certificate: its self-signed certificate is
 *   the only trust anchor of this agent (BROWSER_VNC_CA_FILE), and
 *   optionally its SHA-256 fingerprint is pinned (BROWSER_VNC_CERT_SHA256),
 *   in which case the pin replaces the host name check. Plain http is
 *   accepted for a loopback upstream only (tests);
 * - drops Set-Cookie and WWW-Authenticate from responses and allows framing
 *   by the same origin only.
 */

export const BROWSER_PREFIX = "/browser/";

const REQUEST_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "range",
  "user-agent",
];
const UPGRADE_HEADERS = [
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
];
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "transfer-encoding",
];
const SWITCH_HEADERS = [
  "upgrade",
  "connection",
  "sec-websocket-accept",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
];
const TIMEOUT_MS = 30_000;

export class BrowserProxyConfigError extends Error {
  override readonly name = "BrowserProxyConfigError";
}

export interface VncProxyOptions {
  /** Upstream origin (and optional base path), e.g. https://cameld-browser:6901 */
  upstream: string;
  user?: string | undefined;
  password?: string | undefined;
  /** PEM of the sidecar's (self-signed) certificate or its CA. Required for https. */
  ca?: string | undefined;
  /** SHA-256 fingerprint of the sidecar certificate, hex with or without colons. */
  certSha256?: string | undefined;
  log?: Logger | undefined;
  /** Upstream idle timeout. Default 30 s. */
  timeoutMs?: number;
}

/** "AB:CD:..." form of a hex or colon fingerprint, or null when malformed. */
export function normalizeFingerprint(value: string): string | null {
  const hex = value.replace(/[:\s]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return (hex.match(/../g) as string[]).join(":");
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function pick(headers: IncomingHttpHeaders, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

const UNSAFE_PATH = /[\\\r\n\0]/;
const UNSAFE_SEARCH = /[\r\n\0#]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** True when a relative upstream path (raw or decoded) is safe to append to the base. */
function safeRelativePath(path: string): boolean {
  if (SCHEME.test(path) || UNSAFE_PATH.test(path) || path.startsWith("/")) return false;
  return !path.split("/").some((segment) => segment === ".." || segment === ".");
}

export class VncProxy {
  readonly #base: URL;
  readonly #authorization: string | undefined;
  readonly #agent: HttpAgent;
  readonly #request: typeof httpRequest;
  readonly #log: Logger | undefined;
  readonly #timeoutMs: number;

  constructor(options: VncProxyOptions) {
    this.#base = new URL(options.upstream.replace(/\/*$/, "/"));
    this.#base.search = "";
    this.#base.hash = "";
    const https = this.#base.protocol === "https:";
    if (!https && !(this.#base.protocol === "http:" && isLoopback(this.#base.hostname))) {
      throw new BrowserProxyConfigError("BROWSER_VNC_URL must be https (http only for loopback)");
    }
    if (https) {
      if (options.ca === undefined || options.ca.trim() === "") {
        throw new BrowserProxyConfigError(
          "BROWSER_VNC_CA_FILE is required for an https BROWSER_VNC_URL",
        );
      }
      const pin =
        options.certSha256 === undefined ? null : normalizeFingerprint(options.certSha256);
      if (options.certSha256 !== undefined && pin === null) {
        throw new BrowserProxyConfigError("BROWSER_VNC_CERT_SHA256 is not a SHA-256 fingerprint");
      }
      this.#agent = new HttpsAgent({
        keepAlive: true,
        ca: options.ca,
        rejectUnauthorized: true,
        checkServerIdentity: (host: string, cert: PeerCertificate) => {
          if (pin === null) return checkServerIdentity(host, cert);
          if (cert.fingerprint256 === pin) return undefined;
          return new Error("browser sidecar certificate does not match the pinned fingerprint");
        },
      });
      this.#request = httpsRequest as typeof httpRequest;
    } else {
      this.#agent = new HttpAgent({ keepAlive: true });
      this.#request = httpRequest;
    }
    this.#authorization =
      options.user === undefined
        ? undefined
        : `Basic ${Buffer.from(`${options.user}:${options.password ?? ""}`).toString("base64")}`;
    this.#log = options.log?.child({ mod: "browser-proxy" });
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  /** Upstream URL for a /browser/... request URL, or null when it is not allowed. */
  target(url: string): URL | null {
    if (!url.startsWith(BROWSER_PREFIX)) return null;
    const rest = url.slice(BROWSER_PREFIX.length);
    const queryAt = rest.indexOf("?");
    const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
    const search = queryAt === -1 ? "" : rest.slice(queryAt);
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (!safeRelativePath(path) || !safeRelativePath(decoded) || UNSAFE_SEARCH.test(search)) {
      return null;
    }
    const target = new URL(this.#base.href);
    target.pathname = `${this.#base.pathname}${path}`;
    target.search = search;
    // Defence in depth: the checks above already guarantee this.
    /* v8 ignore next 3 */
    if (target.origin !== this.#base.origin || !target.pathname.startsWith(this.#base.pathname)) {
      return null;
    }
    return target;
  }

  #headers(incoming: IncomingHttpHeaders, upgrade: boolean): Record<string, string> {
    const headers = pick(
      incoming,
      upgrade ? [...REQUEST_HEADERS, ...UPGRADE_HEADERS] : REQUEST_HEADERS,
    );
    headers.host = this.#base.host;
    if (this.#authorization !== undefined) headers.authorization = this.#authorization;
    return headers;
  }

  #responseHeaders(upstream: IncomingMessage): Record<string, string> {
    const headers = pick(upstream.headers, RESPONSE_HEADERS);
    const location = upstream.headers.location;
    if (typeof location === "string" && location.startsWith("/") && !location.startsWith("//")) {
      headers.location = `${BROWSER_PREFIX}${location.slice(1)}`;
    }
    headers["x-frame-options"] = "SAMEORIGIN";
    headers["content-security-policy"] = "frame-ancestors 'self'";
    headers["x-content-type-options"] = "nosniff";
    headers["cache-control"] = "no-store";
    headers["referrer-policy"] = "same-origin";
    return headers;
  }

  #warn(error: Error, message: string): void {
    this.#log?.warn({ err: { name: error.name, message: error.message } }, message);
  }

  /** Proxy one GET/HEAD request. The reply is hijacked and streamed. */
  handle(request: FastifyRequest, reply: FastifyReply): void {
    const target = this.target(request.url);
    if (target === null) {
      void reply.code(400).send({ error: "bad_browser_path" });
      return;
    }
    reply.hijack();
    const out = reply.raw;
    const upstream = this.#request(target, {
      method: request.method,
      headers: this.#headers(request.headers, false),
      agent: this.#agent,
      timeout: this.#timeoutMs,
    });
    upstream.on("response", (response) => {
      out.writeHead(response.statusCode as number, this.#responseHeaders(response));
      response.pipe(out);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("browser upstream timed out")));
    upstream.on("error", (error) => {
      this.#warn(error, "browser proxy failed");
      if (out.headersSent) {
        out.destroy();
        return;
      }
      out.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      out.end(JSON.stringify({ error: "browser_unreachable" }));
    });
    upstream.end();
  }

  /** Proxy one WebSocket upgrade (the caller has already authenticated it). */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = this.target(request.url as string);
    if (target === null) {
      refuse(socket, 400, "Bad Request");
      return;
    }
    const upstream = this.#request(target, {
      method: "GET",
      headers: this.#headers(request.headers, true),
      agent: this.#agent,
      timeout: this.#timeoutMs,
    });
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      upstream.setTimeout(0);
      const lines = Object.entries(pick(response.headers, SWITCH_HEADERS)).map(
        ([name, value]) => `${name}: ${value}`,
      );
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      /* v8 ignore next -- bytes pipelined after the upgrade headers; rare in practice */
      if (head.length > 0) upstreamSocket.write(head);
      // Either side ending or failing tears down both (no half-open sockets).
      const teardown = (): void => {
        socket.destroy();
        upstreamSocket.destroy();
      };
      for (const event of ["error", "end", "close"]) {
        upstreamSocket.on(event, teardown);
        socket.on(event, teardown);
      }
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on("response", (response) => {
      response.resume();
      upstream.destroy();
      refuse(socket, 502, "Bad Gateway");
    });
    upstream.on("timeout", () => upstream.destroy(new Error("browser upstream timed out")));
    upstream.on("error", (error) => {
      this.#warn(error, "browser websocket failed");
      refuse(socket, 502, "Bad Gateway");
    });
    upstream.end();
  }

  close(): void {
    this.#agent.destroy();
  }
}

/** Answer a raw upgrade request with an error status and close it. */
export function refuse(socket: Duplex, status: number, text: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(
    `HTTP/1.1 ${String(status)} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}
