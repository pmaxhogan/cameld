import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logging.ts";
import {
  StravaApiError,
  StravaClient,
  StravaRateLimitedError,
  UploadTimeoutError,
  classifyUpload,
  parseDuplicateOf,
} from "../src/strava/client.ts";
import { RateLimiter } from "../src/strava/rate-limiter.ts";
import type { StravaUpload } from "../src/strava/types.ts";
import { fakeClock } from "./strava-helpers.ts";

interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: RequestInit["body"];
}

type Handler = (req: Recorded, n: number) => Response | Promise<Response>;

function setup(handler: Handler, opts: { retries?: number } = {}) {
  const logged: string[] = [];
  const logger = createLogger(
    { logLevel: "debug" },
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        logged.push(chunk.toString());
        done();
      },
    }),
  );
  const clock = fakeClock("2030-01-01T10:00:00Z");
  const limiter = new RateLimiter({ clock, safetyMargin: 0 });
  const requests: Recorded[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    requests.push(req);
    return Promise.resolve(handler(req, requests.length));
  };
  const client = new StravaClient({
    tokens: { getAccessToken: () => Promise.resolve("tok-abc") },
    limiter,
    fetch: fetchFn,
    baseUrl: "https://strava.example.invalid/api/v3",
    clock,
    logger,
    ...(opts.retries === undefined ? {} : { maxRateLimitRetries: opts.retries }),
  });
  return { client, limiter, clock, requests, logged };
}

describe("request logging", () => {
  it("logs method, path, status and rate usage, never the token, the query or the body", async () => {
    const { client, logged } = setup((req) =>
      req.url.pathname.endsWith("/streams")
        ? new Response("synthetic refusal text", { status: 500 })
        : Response.json({ id: "9100000000000000007", name: "Synthetic Name" }),
    );
    await client.getActivity("9100000000000000007");
    await expect(client.getStreams("9100000000000000007")).rejects.toBeInstanceOf(StravaApiError);
    const lines = logged.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      mod: "strava-api",
      msg: "strava api request",
      method: "GET",
      path: "/activities/9100000000000000007",
      status: 200,
      attempt: 0,
    });
    expect(lines[0]?.usage).toMatchObject({ read: { day: expect.anything() } });
    expect(lines[1]).toMatchObject({
      msg: "strava api request refused",
      path: "/activities/9100000000000000007/streams",
      status: 500,
    });
    const text = logged.join("");
    for (const leak of [
      "tok-abc",
      "Bearer",
      "include_all_efforts",
      "key_by_type",
      "Synthetic Name",
    ])
      expect(text).not.toContain(leak);
    expect(text).not.toContain("synthetic refusal text");
  });
});

describe("parseDuplicateOf and classifyUpload", () => {
  it("parses duplicate errors", () => {
    expect(parseDuplicateOf("merged.fit duplicate of activity 9100000004242424242")).toBe(
      "9100000004242424242",
    );
    expect(parseDuplicateOf("Duplicate Of Activity 9100000000000000007")).toBe(
      "9100000000000000007",
    );
    expect(parseDuplicateOf("something else")).toBeNull();
    expect(parseDuplicateOf(null)).toBeNull();
    expect(parseDuplicateOf(undefined)).toBeNull();
  });

  it("parses the html duplicate form strava really sends, taking the id from the href", () => {
    expect(
      parseDuplicateOf(
        "merged.fit duplicate of <a href='/activities/9100000000000012345' target='_blank'>Evening Walk</a>",
      ),
    ).toBe("9100000000000012345");
    expect(
      parseDuplicateOf(
        'x.fit duplicate of <a class="x" href="/activities/9100000000000000987">Walk 42</a>',
      ),
    ).toBe("9100000000000000987");
    expect(
      parseDuplicateOf(
        "x duplicate of <a href='https://www.strava.com/activities/9100000000000031337'>Activity 7</a>",
      ),
    ).toBe("9100000000000031337");
    expect(parseDuplicateOf("duplicate of <a href=/activities/9100000000000000055>Run</a>")).toBe(
      "9100000000000000055",
    );
    // Link text digits are never mistaken for the id.
    expect(parseDuplicateOf("duplicate of <a href='/athletes/9'>Activity 77</a>")).toBeNull();
    expect(parseDuplicateOf("duplicate of activity 0")).toBeNull();
    expect(
      classifyUpload({
        id: "9100000000000000003",
        error: "a duplicate of <a href='/activities/9100000000000000042'>Walk</a>",
      }),
    ).toMatchObject({ kind: "duplicate", duplicateOf: "9100000000000000042" });
  });

  it("classifies uploads", () => {
    expect(
      classifyUpload({
        id: "9100000000000000001",
        status: "Your activity is still being processed.",
      }),
    ).toBeNull();
    expect(classifyUpload({ id: "9100000000000000001", error: "", activity_id: null })).toBeNull();
    expect(
      classifyUpload({ id: "9100000000000000001", activity_id: "9100000000000000009" }),
    ).toMatchObject({
      kind: "ready",
      activityId: "9100000000000000009",
    });
    expect(
      classifyUpload({
        id: "9100000000000000001",
        error: "x.fit duplicate of activity 9100000000000000055",
      }),
    ).toMatchObject({
      kind: "duplicate",
      duplicateOf: "9100000000000000055",
    });
    expect(classifyUpload({ id: "9100000000000000001", error: "Malformed file" })).toMatchObject({
      kind: "error",
      error: "Malformed file",
    });
  });
});

describe("StravaClient reads", () => {
  it("sends bearer auth and builds the documented queries", async () => {
    const { client, requests } = setup(() => Response.json([]));
    await client.listActivities({ after: 100, before: 200, page: 2, per_page: 50 });
    await client.listActivities();
    await client.getActivity("9100000000000000011");
    await client.getActivity("9100000000000000011", true);
    await client.getStreams("9100000000000000012");
    await client.getStreams("9100000000000000012", ["time", "heartrate"]);
    await client.getActivityPhotos("9100000000000000013");
    await client.getKudoers("9100000000000000014");
    await client.getComments("9100000000000000015");
    await client.getLaps("9100000000000000016");
    await client.getAthlete();
    await client.getUpload("9100000000000000017");

    const summary = requests.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`);
    expect(summary).toEqual([
      "GET /api/v3/athlete/activities?after=100&before=200&page=2&per_page=50",
      "GET /api/v3/athlete/activities",
      "GET /api/v3/activities/9100000000000000011?include_all_efforts=false",
      "GET /api/v3/activities/9100000000000000011?include_all_efforts=true",
      "GET /api/v3/activities/9100000000000000012/streams?keys=time%2Cdistance%2Clatlng%2Caltitude%2Cvelocity_smooth%2Cheartrate%2Ccadence%2Cwatts%2Ctemp%2Cmoving%2Cgrade_smooth&key_by_type=true",
      "GET /api/v3/activities/9100000000000000012/streams?keys=time%2Cheartrate&key_by_type=true",
      "GET /api/v3/activities/9100000000000000013/photos?photo_sources=true&size=2048",
      "GET /api/v3/activities/9100000000000000014/kudos",
      "GET /api/v3/activities/9100000000000000015/comments",
      "GET /api/v3/activities/9100000000000000016/laps",
      "GET /api/v3/athlete",
      "GET /api/v3/uploads/9100000000000000017",
    ]);
    for (const r of requests) expect(r.headers.get("authorization")).toBe("Bearer tok-abc");
  });

  it("feeds response headers into the limiter for metrics", async () => {
    const { client, limiter } = setup(
      () =>
        new Response("{}", {
          headers: {
            "x-ratelimit-limit": "200,2000",
            "x-ratelimit-usage": "20,300",
            "x-readratelimit-limit": "100,1000",
            "x-readratelimit-usage": "10,150",
          },
        }),
    );
    await client.getAthlete();
    const u = limiter.usage();
    expect(u.overall.fifteenMinute.usage).toBe(20);
    expect(u.read.day.usage).toBe(150);
  });

  it("throws a typed error with a truncated body on failure", async () => {
    const { client } = setup(() => new Response("x".repeat(1000), { status: 404 }));
    const error = await client.getActivity("9100000000000000001").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StravaApiError);
    expect((error as StravaApiError).status).toBe(404);
    expect((error as StravaApiError).message.length).toBeLessThan(400);
    expect((error as StravaApiError).message).not.toContain("tok-abc");
  });

  it("survives an unreadable error body", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error("broken"));
      },
    });
    const { client } = setup(() => new Response(stream, { status: 500 }));
    await expect(client.getAthlete()).rejects.toMatchObject({ status: 500 });
  });
});

describe("StravaClient rate limiting", () => {
  it("treats 429 as an exhausted window, waits for the boundary and retries", async () => {
    const { client, clock, requests } = setup((_req, n) =>
      n === 1
        ? new Response("slow down", { status: 429 })
        : Response.json({ id: "9100000000000000001" }),
    );
    await expect(client.getAthlete()).resolves.toEqual({ id: "9100000000000000001" });
    expect(requests).toHaveLength(2);
    expect(clock.t).toBe(Date.parse("2030-01-01T10:15:00Z"));
  });

  it("throws a typed error when 429 persists past the retry budget", async () => {
    const { client, requests } = setup(() => new Response("no", { status: 429 }), { retries: 1 });
    await expect(client.getAthlete()).rejects.toBeInstanceOf(StravaRateLimitedError);
    expect(requests).toHaveLength(2);
    const zero = setup(() => new Response("no", { status: 429 }), { retries: 0 });
    await expect(zero.client.getAthlete()).rejects.toMatchObject({ status: 429 });
    expect(zero.requests).toHaveLength(1);
  });

  it("uses the write budget only for writes", async () => {
    const { client, limiter } = setup(() => Response.json({ id: "9100000000000000001" }));
    await client.updateActivity("9100000000000000001", { name: "x" });
    expect(limiter.usage().read.fifteenMinute.usage).toBe(0);
    expect(limiter.usage().overall.fifteenMinute.usage).toBe(1);
  });

  it("logs a warning on 429 without secrets", async () => {
    const lines: string[] = [];
    const logger = createLogger(
      { logLevel: "debug" },
      { write: (l: string) => void lines.push(l) },
    );
    let n = 0;
    const clock = fakeClock("2030-01-01T10:00:00Z");
    const client = new StravaClient({
      tokens: { getAccessToken: () => Promise.resolve("tok-abc") },
      limiter: new RateLimiter({ clock }),
      fetch: () =>
        Promise.resolve(++n === 1 ? new Response("", { status: 429 }) : Response.json({})),
      clock,
      logger,
    });
    await client.getAthlete();
    expect(lines.join("")).toContain("strava rate limit hit");
    expect(lines.join("")).not.toContain("tok-abc");
  });
});

describe("StravaClient writes and uploads", () => {
  it("updates an activity with a JSON PUT", async () => {
    const { client, requests } = setup(() => Response.json({ id: "9100000000000000005" }));
    await client.updateActivity("9100000000000000005", {
      name: "n",
      description: "d",
      sport_type: "Run",
      commute: false,
      trainer: true,
      gear_id: "g1",
      hide_from_home: true,
    });
    const req = requests[0];
    expect(req?.method).toBe("PUT");
    expect(req?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(req?.body))).toEqual({
      name: "n",
      description: "d",
      sport_type: "Run",
      commute: false,
      trainer: true,
      gear_id: "g1",
      hide_from_home: true,
    });
  });

  it("posts multipart uploads with the file bytes and fields", async () => {
    const { client, requests } = setup(() =>
      Response.json({ id: "9100000000000000077", status: "processing" }),
    );
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const upload = await client.createUpload({
      file: bytes,
      data_type: "fit",
      external_id: "cameld-test-1",
      name: "Merged",
      description: "Desc",
    });
    expect(upload.id).toBe("9100000000000000077");
    const req = requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.headers.has("content-type")).toBe(false);
    const form = req?.body as FormData;
    expect(form.get("data_type")).toBe("fit");
    expect(form.get("external_id")).toBe("cameld-test-1");
    expect(form.get("name")).toBe("Merged");
    expect(form.get("description")).toBe("Desc");
    const file = form.get("file") as File;
    expect(file.name).toBe("cameld-test-1.fit");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it("omits optional upload fields and honors a filename", async () => {
    const { client, requests } = setup(() => Response.json({ id: "9100000000000000001" }));
    await client.createUpload({
      file: new Uint8Array(),
      data_type: "gpx",
      external_id: "e",
      filename: "track.gpx",
    });
    const form = requests[0]?.body as FormData;
    expect(form.has("name")).toBe(false);
    expect(form.has("description")).toBe(false);
    expect((form.get("file") as File).name).toBe("track.gpx");
  });

  it("polls no faster than once a second until the activity is ready", async () => {
    const statuses: StravaUpload[] = [
      { id: "9100000000000000009", status: "Your activity is still being processed." },
      { id: "9100000000000000009", status: "Your activity is still being processed." },
      {
        id: "9100000000000000009",
        status: "Your activity is ready.",
        activity_id: "9100000000000000321",
      },
    ];
    const { client, clock, requests } = setup((req) => {
      if (req.method === "POST")
        return Response.json({ id: "9100000000000000009", status: "queued" });
      return Response.json(statuses.shift());
    });
    const result = await client.uploadAndWait(
      { file: new Uint8Array([1]), data_type: "fit", external_id: "e" },
      { intervalMs: 10 },
    );
    expect(result).toMatchObject({
      kind: "ready",
      uploadId: "9100000000000000009",
      activityId: "9100000000000000321",
    });
    expect(clock.sleeps).toEqual([1000, 1000, 1000]);
    expect(requests.map((r) => r.method)).toEqual(["POST", "GET", "GET", "GET"]);
  });

  it("returns a typed duplicate result instead of throwing", async () => {
    const { client } = setup(() =>
      Response.json({
        id: "9100000000000000003",
        error: "e.fit duplicate of activity 9100000000000998877",
        activity_id: null,
      }),
    );
    const result = await client.uploadAndWait({
      file: new Uint8Array([1]),
      data_type: "fit",
      external_id: "e",
    });
    expect(result).toMatchObject({
      kind: "duplicate",
      duplicateOf: "9100000000000998877",
      uploadId: "9100000000000000003",
    });
  });

  it("returns a duplicate found while polling, and other errors as error results", async () => {
    let calls = 0;
    const { client } = setup(() => {
      calls += 1;
      if (calls === 1) return Response.json({ id: "9100000000000000004", status: "processing" });
      return Response.json({ id: "9100000000000000004", error: "Unsupported file" });
    });
    const result = await client.uploadAndWait({
      file: new Uint8Array([1]),
      data_type: "tcx",
      external_id: "e",
    });
    expect(result).toEqual({
      kind: "error",
      uploadId: "9100000000000000004",
      error: "Unsupported file",
      upload: { id: "9100000000000000004", error: "Unsupported file" },
    });
  });

  it("times out when Strava keeps processing", async () => {
    const { client } = setup(() =>
      Response.json({ id: "9100000000000000008", status: "processing" }),
    );
    const error = await client
      .waitForUpload(
        { id: "9100000000000000008", status: "processing" },
        { intervalMs: 1000, timeoutMs: 3000 },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadTimeoutError);
    expect((error as UploadTimeoutError).uploadId).toBe("9100000000000000008");
  });

  it("uses default poll options", async () => {
    const { client } = setup(() =>
      Response.json({ id: "9100000000000000008", activity_id: "9100000000000000001" }),
    );
    const result = await client.waitForUpload({ id: "9100000000000000008" });
    expect(result.kind).toBe("ready");
  });
});

describe("defaults", () => {
  it("constructs with only required options", () => {
    const client = new StravaClient({
      tokens: { getAccessToken: () => Promise.resolve("t") },
      limiter: new RateLimiter(),
    });
    expect(client).toBeInstanceOf(StravaClient);
  });
});
