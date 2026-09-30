/**
 * The two entry points, written against small interfaces so they are unit
 * testable without the Workers runtime.
 */
import { classify, domainOf, GMAIL_FORWARD_VERIFY_SENDER, isAllowedSender } from "./classify.ts";
import { tokensEqual } from "./crypto.ts";
import { parseMail } from "./parse.ts";
import type { CodeStore } from "./store.ts";

export const MAX_RAW_SIZE_BYTES = 1_048_576;

/** The subset of ForwardableEmailMessage the handler touches. */
export interface InboundMessage {
  readonly raw: ReadableStream<Uint8Array> | ArrayBuffer | string;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface Log {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Workers Logs indexes JSON lines from console. Never logs codes or subjects. */
export const consoleLog: Log = {
  // eslint-disable-next-line no-console
  info: (event, fields) => console.log(JSON.stringify({ level: "info", event, ...fields })),
  // eslint-disable-next-line no-console
  error: (event, fields) => console.error(JSON.stringify({ level: "error", event, ...fields })),
};

/**
 * Every rejection is `setReject` + return: throwing would tempfail and the
 * sending server would retry for ever. Only a storage failure throws, so a
 * transient D1 error gets a retry.
 */
export async function handleEmail(
  message: InboundMessage,
  store: CodeStore,
  now: number,
  log: Log,
): Promise<void> {
  if (message.rawSize > MAX_RAW_SIZE_BYTES) {
    log.info("mail.rejected", { reason: "too_large" });
    message.setReject("message too large");
    return;
  }
  let parsed;
  try {
    parsed = await parseMail(message.raw);
  } catch {
    log.info("mail.rejected", { reason: "unparseable" });
    message.setReject("could not parse message");
    return;
  }
  if (!isAllowedSender(parsed.from)) {
    log.info("mail.rejected", { reason: "sender_not_allowed", domain: domainOf(parsed.from) });
    message.setReject("sender not allowed");
    return;
  }
  const result = classify(parsed);
  const senderDomain =
    parsed.from === GMAIL_FORWARD_VERIFY_SENDER ? "google.com" : domainOf(parsed.from);
  await store.insert({
    kind: result.kind,
    senderDomain,
    subject: parsed.subject,
    code: result.code,
    url: result.url,
    receivedAt: now,
  });
  log.info("mail.accepted", { kind: result.kind, domain: senderDomain });
}

const DOMAIN_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const notFound = (): Response => new Response("not found", { status: 404 });

/**
 * GET /codes/next?sender=<domain>&since=<epoch ms>  -> 200 {code, receivedAt} | 204
 * GET /forwarding-confirmation                     -> 200 {code, url, receivedAt} | 204
 * Anything else is 404. Both routes need `Authorization: Bearer <RELAY_TOKEN>`.
 */
export async function handleHttp(
  request: Request,
  store: CodeStore,
  token: string,
  now: number,
): Promise<Response> {
  const url = new URL(request.url);
  const known = url.pathname === "/codes/next" || url.pathname === "/forwarding-confirmation";
  if (!known || request.method !== "GET") return notFound();

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!(await tokensEqual(presented, token))) {
    return json({ error: "unauthorized" }, 401);
  }

  if (url.pathname === "/forwarding-confirmation") {
    const found = await store.claimForwardConfirmation(now);
    return found === null ? new Response(null, { status: 204 }) : json(found);
  }

  const sender = (url.searchParams.get("sender") ?? "").trim().toLowerCase();
  const sinceRaw = url.searchParams.get("since") ?? "";
  const since = Number(sinceRaw);
  if (
    !DOMAIN_PATTERN.test(sender) ||
    sinceRaw === "" ||
    !Number.isSafeInteger(since) ||
    since < 0
  ) {
    return json({ error: "sender (a domain) and since (epoch ms) are required" }, 400);
  }
  const claimed = await store.claimOtp(sender, since, now);
  return claimed === null ? new Response(null, { status: 204 }) : json(claimed);
}
