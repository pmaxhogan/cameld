/**
 * TEST-ONLY stand-ins for the services in front of and beside cameld, on one
 * loopback port:
 *
 * - a Cloudflare Access double: GET /cdn-cgi/access/certs serves the JWKS of
 *   an RSA key generated at start (never written anywhere), and
 *   GET /sign?email=... returns a token signed with it, issued by this
 *   origin for the e2e AUD (cameld accepts an http team domain only on
 *   loopback);
 * - a KasmVNC double under /vnc/ that answers only with the expected basic
 *   auth, so the suite can check the proxy injects it.
 *
 *   node e2e/support/access-double.ts <port>
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { AUD, VNC_PASSWORD, VNC_USER } from "./constants.ts";

const port = Number(process.argv[2] ?? 8098);
const origin = `http://127.0.0.1:${String(port)}`;
const kid = "e2e-kid";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const expectedAuth = `Basic ${Buffer.from(`${VNC_USER}:${VNC_PASSWORD}`).toString("base64")}`;

function token(email: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", kid, typ: "JWT" });
  const body = b64({ iss: origin, aud: [AUD], email, iat: now, nbf: now, exp: now + 3600 });
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString(
    "base64url",
  );
  return `${head}.${body}.${signature}`;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", origin);
  if (url.pathname === "/cdn-cgi/access/certs") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  if (url.pathname === "/sign") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(token(url.searchParams.get("email") ?? ""));
    return;
  }
  if (url.pathname.startsWith("/vnc/")) {
    if (req.headers.authorization !== expectedAuth || req.headers.cookie !== undefined) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="kasm"' });
      res.end("unauthorized");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>vnc</title><p id=vnc>synthetic remote browser</p>");
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(port, "127.0.0.1");
