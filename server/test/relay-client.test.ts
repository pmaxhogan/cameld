import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logging.ts";
import {
  createRelayClient,
  RelayAuthError,
  RelayError,
  RelayTimeoutError,
} from "../src/relay/client.ts";
import { fakeClock } from "./strava-helpers.ts";

const TOKEN = "synthetic-relay-token";

type Reply = Response | Error;

function scripted(replies: Reply[]) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
    });
    const next = replies.shift() ?? new Response(null, { status: 204 });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { calls, fetchFn: fetchFn as typeof fetch };
}

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger(
    { logLevel: "debug" },
    new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    }),
  );
  return { lines, logger };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("relay client waitForCode", () => {
  it("polls every 5 s until a code arrives", async () => {
    const clock = fakeClock("2030-01-01T00:00:00Z");
    const { calls, fetchFn } = scripted([
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      ok({ code: "123456", receivedAt: clock.t + 9000 }),
    ]);
    const { lines, logger } = captureLogger();
    const client = createRelayClient({
      baseUrl: "https://relay.example.test/",
      token: TOKEN,
      fetch: fetchFn,
      clock,
      logger,
    });
    const since = clock.t - 1;
    const code = await client.waitForCode({ sender: "strava.com", since, timeoutMs: 60_000 });
    expect(code.code).toBe("123456");
    expect(clock.sleeps).toEqual([5000, 5000]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      url: `https://relay.example.test/codes/next?sender=strava.com&since=${since}`,
      auth: `Bearer ${TOKEN}`,
    });
    expect(lines.join("")).not.toContain("123456");
    expect(lines.join("")).not.toContain(TOKEN);
  });

  it("keeps polling through transient failures, then times out", async () => {
    const clock = fakeClock("2030-01-01T00:00:00Z");
    const { calls, fetchFn } = scripted([
      new Error("network down"),
      new Response("boom", { status: 502 }),
    ]);
    const { lines, logger } = captureLogger();
    const client = createRelayClient({
      baseUrl: "https://relay.example.test",
      token: TOKEN,
      fetch: fetchFn,
      clock,
      logger,
      pollIntervalMs: 4000,
    });
    await expect(
      client.waitForCode({ sender: "strava.com", since: clock.t, timeoutMs: 10_000 }),
    ).rejects.toBeInstanceOf(RelayTimeoutError);
    // 4 s, 4 s, then the 2 s left before the deadline.
    expect(clock.sleeps).toEqual([4000, 4000, 2000]);
    expect(calls).toHaveLength(4);
    expect(lines.join("")).toContain("relay poll failed");
    expect(lines.join("")).not.toContain(TOKEN);
  });

  it("fails fast on a rejected token", async () => {
    const clock = fakeClock("2030-01-01T00:00:00Z");
    const { fetchFn } = scripted([new Response("{}", { status: 401 })]);
    const client = createRelayClient({
      baseUrl: "https://relay.example.test",
      token: TOKEN,
      fetch: fetchFn,
      clock,
    });
    const attempt = client.waitForCode({ sender: "strava.com", since: 0, timeoutMs: 60_000 });
    await expect(attempt).rejects.toBeInstanceOf(RelayAuthError);
    expect(clock.sleeps).toEqual([]);
  });

  it("works without a logger or injected clock", async () => {
    const { fetchFn } = scripted([ok({ code: "654321", receivedAt: 1 })]);
    const client = createRelayClient({
      baseUrl: "https://relay.example.test",
      token: TOKEN,
      fetch: fetchFn,
    });
    await expect(
      client.waitForCode({ sender: "strava.com", since: 0, timeoutMs: 1000 }),
    ).resolves.toEqual({ code: "654321", receivedAt: 1 });
  });

  it("logs nothing without a logger on a transient failure", async () => {
    const clock = fakeClock("2030-01-01T00:00:00Z");
    const { fetchFn } = scripted([new Error("x")]);
    const client = createRelayClient({
      baseUrl: "https://relay.example.test",
      token: TOKEN,
      fetch: fetchFn,
      clock,
    });
    await expect(
      client.waitForCode({ sender: "strava.com", since: 0, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(RelayTimeoutError);
  });
});

describe("relay client getForwardingConfirmation", () => {
  it("returns the confirmation, null on 204, and errors without the query or token", async () => {
    const { calls, fetchFn } = scripted([
      ok({ code: "987654321", url: null, receivedAt: 5 }),
      new Response(null, { status: 204 }),
      new Response("nope", { status: 500 }),
    ]);
    const client = createRelayClient({
      baseUrl: "https://relay.example.test",
      token: TOKEN,
      fetch: fetchFn,
    });
    await expect(client.getForwardingConfirmation()).resolves.toEqual({
      code: "987654321",
      url: null,
      receivedAt: 5,
    });
    await expect(client.getForwardingConfirmation()).resolves.toBeNull();
    const failure = client.getForwardingConfirmation();
    await expect(failure).rejects.toBeInstanceOf(RelayError);
    await expect(failure).rejects.toThrow("relay returned 500 for /forwarding-confirmation");
    expect(calls[0]?.url).toBe("https://relay.example.test/forwarding-confirmation");
  });
});
