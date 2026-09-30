import { describe, expect, it } from "vitest";

import { importDataKey, open, seal, tokensEqual } from "../src/crypto.ts";
import { handleEmail, handleHttp, type Log, MAX_RAW_SIZE_BYTES } from "../src/handlers.ts";
import { htmlToText, parseMail } from "../src/parse.ts";
import { CodeStore } from "../src/store.ts";
import { memoryDb, rawMail, TEST_DATA_KEY } from "./helpers.ts";

const TOKEN = "synthetic-test-token";
const T0 = Date.parse("2030-01-01T00:00:00Z");

function silentLog(): Log & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    info: (event) => events.push(event),
    error: (event) => events.push(event),
  };
}

async function setup() {
  const db = memoryDb();
  let n = 0;
  const store = new CodeStore(db, await importDataKey(TEST_DATA_KEY), () => `id-${++n}`);
  return { db, store };
}

function message(raw: string, rawSize = raw.length) {
  const rejected: string[] = [];
  return { raw, rawSize, rejected, setReject: (reason: string) => rejected.push(reason) };
}

const get = (path: string, token: string | null = TOKEN, method = "GET") =>
  new Request(`https://relay.example.test${path}`, {
    method,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

describe("crypto", () => {
  it("round-trips and binds the AAD", async () => {
    const key = await importDataKey(TEST_DATA_KEY);
    const sealed = await seal(key, "123456", "aad-1");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(await open(key, sealed, "aad-1")).toBe("123456");
    await expect(open(key, sealed, "aad-2")).rejects.toThrow();
    await expect(open(key, "v9:abc", "aad-1")).rejects.toThrow(/envelope/);
  });

  it("rejects a key of the wrong length", async () => {
    await expect(importDataKey(Buffer.alloc(16).toString("base64"))).rejects.toThrow(/32 bytes/);
  });

  it("compares tokens", async () => {
    expect(await tokensEqual("abc", "abc")).toBe(true);
    expect(await tokensEqual("abd", "abc")).toBe(false);
    expect(await tokensEqual("", "")).toBe(false);
  });
});

describe("parse", () => {
  it("flattens HTML-only mail", async () => {
    const parsed = await parseMail(
      rawMail({
        from: "No-Reply@Strava.com",
        subject: "Your code",
        html: "<html><head><style>p{}</style></head><body><p>Code:&nbsp;<b>246810</b></p>&#65;&amp;</body></html>",
      }),
    );
    expect(parsed.from).toBe("no-reply@strava.com");
    expect(parsed.text).toContain("246810");
    expect(parsed.text).toContain("A&");
    expect(parsed.text).not.toContain("p{}");
  });

  it("htmlToText leaves invalid numeric entities alone", () => {
    expect(htmlToText("x &#0; &lt;y&gt; &quot;")).toBe('x &#0; <y> "');
  });
});

describe("email handler", () => {
  it("stores a sealed Strava code and the HTTP API claims it exactly once", async () => {
    const { db, store } = await setup();
    const msg = message(
      rawMail({ from: "no-reply@strava.com", subject: "Your code", text: "Code is 135790" }),
    );
    const log = silentLog();
    await handleEmail(msg, store, T0, log);
    expect(msg.rejected).toEqual([]);
    expect(log.events).toEqual(["mail.accepted"]);

    const row = db.raw.prepare("SELECT * FROM codes").get() as Record<string, unknown>;
    expect(row["kind"]).toBe("otp");
    expect(JSON.stringify(row)).not.toContain("135790");
    expect(JSON.stringify(row)).not.toContain("Your code");

    const first = await handleHttp(
      get(`/codes/next?sender=strava.com&since=${T0 - 1}`),
      store,
      TOKEN,
      T0 + 1000,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ code: "135790", receivedAt: T0 });
    const again = await handleHttp(
      get(`/codes/next?sender=strava.com&since=${T0 - 1}`),
      store,
      TOKEN,
      T0 + 2000,
    );
    expect(again.status).toBe(204);
  });

  it("rejects a disallowed sender, oversize and unparseable mail", async () => {
    const { db, store } = await setup();
    const gmail = message(
      rawMail({ from: "someone@gmail.example", subject: "Your Strava code is 123456" }),
    );
    await handleEmail(gmail, store, T0, silentLog());
    expect(gmail.rejected).toEqual(["sender not allowed"]);

    const big = message("x", MAX_RAW_SIZE_BYTES + 1);
    await handleEmail(big, store, T0, silentLog());
    expect(big.rejected).toEqual(["message too large"]);

    const broken = message("");
    broken.raw = new ReadableStream({
      start(controller) {
        controller.error(new Error("synthetic stream failure"));
      },
    }) as unknown as string;
    await handleEmail(broken, store, T0, silentLog());
    expect(broken.rejected).toEqual(["could not parse message"]);

    expect(db.raw.prepare("SELECT count(*) AS n FROM codes").get()).toEqual({ n: 0 });
  });

  it("claims oldest first, only newer than since, honours TTL and sender", async () => {
    const { store } = await setup();
    const add = (code: string, at: number, domain = "strava.com") =>
      store.insert({
        kind: "otp",
        senderDomain: domain,
        subject: "",
        code,
        url: null,
        receivedAt: at,
      });
    await add("111111", T0);
    await add("222222", T0 + 10);
    await add("333333", T0 + 20);
    await add("444444", T0 + 30, "other.example");

    expect(await store.claimOtp("strava.com", T0, T0 + 100)).toEqual({
      code: "222222",
      receivedAt: T0 + 10,
    });
    expect(await store.claimOtp("strava.com", T0, T0 + 100)).toEqual({
      code: "333333",
      receivedAt: T0 + 20,
    });
    expect(await store.claimOtp("strava.com", T0, T0 + 100)).toBeNull();
    // 111111 is older than since; it is also expired ten minutes later.
    expect(await store.claimOtp("strava.com", T0 - 1, T0 + 10 * 60 * 1000 + 1)).toBeNull();
  });

  it("stores and serves the Gmail forwarding confirmation once", async () => {
    const { store } = await setup();
    await handleEmail(
      message(
        rawMail({
          from: "forwarding-noreply@google.com",
          subject: "Gmail Forwarding Confirmation",
          text: "Confirmation code: 876543210\nhttps://mail-settings.google.com/mail/vf-synthetic",
        }),
      ),
      store,
      T0,
      silentLog(),
    );
    const res = await handleHttp(get("/forwarding-confirmation"), store, TOKEN, T0 + 60_000);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: "876543210",
      url: "https://mail-settings.google.com/mail/vf-synthetic",
      receivedAt: T0,
    });
    const again = await handleHttp(get("/forwarding-confirmation"), store, TOKEN, T0 + 60_000);
    expect(again.status).toBe(204);
  });

  it("keeps codeless mail as a sealed 'other' row and purges expired secrets", async () => {
    const { db, store } = await setup();
    await handleEmail(
      message(rawMail({ from: "no-reply@strava.com", subject: "Weekly summary", text: "Hi" })),
      store,
      T0,
      silentLog(),
    );
    await store.insert({
      kind: "otp",
      senderDomain: "strava.com",
      subject: "s",
      code: "999999",
      url: null,
      receivedAt: T0,
    });
    const kinds = () =>
      db.raw.prepare("SELECT kind, payload_enc IS NULL AS empty FROM codes ORDER BY id").all() as {
        kind: string;
        empty: number;
      }[];
    expect(kinds().map((k) => k.kind)).toEqual(["other", "otp"]);

    await store.purge(T0 + 11 * 60 * 1000);
    expect(kinds()).toEqual([
      { kind: "other", empty: 1 },
      { kind: "other", empty: 1 },
    ]);
    await store.purge(T0 + 9 * 24 * 60 * 60 * 1000);
    expect(kinds()).toEqual([]);
  });
});

describe("http", () => {
  it("404s unknown routes and non-GET methods, before auth", async () => {
    const { store } = await setup();
    expect((await handleHttp(get("/", null), store, TOKEN, T0)).status).toBe(404);
    expect((await handleHttp(get("/codes", TOKEN), store, TOKEN, T0)).status).toBe(404);
    expect((await handleHttp(get("/codes/next", TOKEN, "POST"), store, TOKEN, T0)).status).toBe(
      404,
    );
  });

  it("401s a missing or wrong token", async () => {
    const { store } = await setup();
    const path = `/codes/next?sender=strava.com&since=${T0}`;
    expect((await handleHttp(get(path, null), store, TOKEN, T0)).status).toBe(401);
    expect((await handleHttp(get(path, "wrong"), store, TOKEN, T0)).status).toBe(401);
    const basic = new Request(`https://relay.example.test${path}`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    expect((await handleHttp(basic, store, TOKEN, T0)).status).toBe(401);
  });

  it("400s bad query parameters", async () => {
    const { store } = await setup();
    for (const query of [
      "sender=strava.com",
      "sender=strava.com&since=abc",
      "sender=strava.com&since=-5",
      "sender=nodot&since=1",
      "sender=%25.com&since=1",
      "since=1",
    ]) {
      const res = await handleHttp(get(`/codes/next?${query}`), store, TOKEN, T0);
      expect(res.status, query).toBe(400);
    }
  });
});
