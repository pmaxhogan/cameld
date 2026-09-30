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
  body: BodyInit | null | undefined;
}

type Handler = (req: Recorded, n: number) => Response | Promise<Response>;

function setup(handler: Handler, opts: { retries?: number } = {}) {
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
    ...(opts.retries === undefined ? {} : { maxRateLimitRetries: opts.retries }),
  });
  return { client, limiter, clock, requests };
}

describe("parseDuplicateOf and classifyUpload", () => {
  it("parses duplicate errors", () => {
    expect(parseDuplicateOf("merged.fit duplicate of activity 4242424242")).toBe(4242424242);
    expect(parseDuplicateOf("Duplicate Of Activity 7")).toBe(7);
    expect(parseDuplicateOf("something else")).toBeNull();
    expect(parseDuplicateOf(null)).toBeNull();
    expect(parseDuplicateOf(undefined)).toBeNull();
  });

  it("classifies uploads", () => {
    expect(classifyUpload({ id: 1, status: "Your activity is still being processed." })).toBeNull();
    expect(classifyUpload({ id: 1, error: "", activity_id: null })).toBeNull();
    expect(classifyUpload({ id: 1, activity_id: 9 })).toMatchObject({
      kind: "ready",
      activityId: 9,
    });
    expect(classifyUpload({ id: 1, error: "x.fit duplicate of activity 55" })).toMatchObject({
      kind: "duplicate",
      duplicateOf: 55,
    });
    expect(classifyUpload({ id: 1, error: "Malformed file" })).toMatchObject({
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
    await client.getActivity(11);
    await client.getActivity(11, true);
    await client.getStreams(12);
    await client.getStreams(12, ["time", "heartrate"]);
    await client.getActivityPhotos(13);
    await client.getKudoers(14);
    await client.getComments(15);
    await client.getLaps(16);
    await client.getAthlete();
    await client.getUpload(17);

    const summary = requests.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`);
    expect(summary).toEqual([
      "GET /api/v3/athlete/activities?after=100&before=200&page=2&per_page=50",
      "GET /api/v3/athlete/activities",
      "GET /api/v3/activities/11?include_all_efforts=false",
      "GET /api/v3/activities/11?include_all_efforts=true",
      "GET /api/v3/activities/12/streams?keys=time%2Cdistance%2Clatlng%2Caltitude%2Cvelocity_smooth%2Cheartrate%2Ccadence%2Cwatts%2Ctemp%2Cmoving%2Cgrade_smooth&key_by_type=true",
      "GET /api/v3/activities/12/streams?keys=time%2Cheartrate&key_by_type=true",
      "GET /api/v3/activities/13/photos?photo_sources=true&size=2048",
      "GET /api/v3/activities/14/kudos",
      "GET /api/v3/activities/15/comments",
      "GET /api/v3/activities/16/laps",
      "GET /api/v3/athlete",
      "GET /api/v3/uploads/17",
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
    const error = await client.getActivity(1).catch((e: unknown) => e);
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
      n === 1 ? new Response("slow down", { status: 429 }) : Response.json({ id: 1 }),
    );
    await expect(client.getAthlete()).resolves.toEqual({ id: 1 });
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
    const { client, limiter } = setup(() => Response.json({ id: 1 }));
    await client.updateActivity(1, { name: "x" });
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
    const { client, requests } = setup(() => Response.json({ id: 5 }));
    await client.updateActivity(5, {
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
    const { client, requests } = setup(() => Response.json({ id: 77, status: "processing" }));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const upload = await client.createUpload({
      file: bytes,
      data_type: "fit",
      external_id: "cameld-test-1",
      name: "Merged",
      description: "Desc",
    });
    expect(upload.id).toBe(77);
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
    const { client, requests } = setup(() => Response.json({ id: 1 }));
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
      { id: 9, status: "Your activity is still being processed." },
      { id: 9, status: "Your activity is still being processed." },
      { id: 9, status: "Your activity is ready.", activity_id: 321 },
    ];
    const { client, clock, requests } = setup((req) => {
      if (req.method === "POST") return Response.json({ id: 9, status: "queued" });
      return Response.json(statuses.shift());
    });
    const result = await client.uploadAndWait(
      { file: new Uint8Array([1]), data_type: "fit", external_id: "e" },
      { intervalMs: 10 },
    );
    expect(result).toMatchObject({ kind: "ready", uploadId: 9, activityId: 321 });
    expect(clock.sleeps).toEqual([1000, 1000, 1000]);
    expect(requests.map((r) => r.method)).toEqual(["POST", "GET", "GET", "GET"]);
  });

  it("returns a typed duplicate result instead of throwing", async () => {
    const { client } = setup(() =>
      Response.json({ id: 3, error: "e.fit duplicate of activity 998877", activity_id: null }),
    );
    const result = await client.uploadAndWait({
      file: new Uint8Array([1]),
      data_type: "fit",
      external_id: "e",
    });
    expect(result).toMatchObject({ kind: "duplicate", duplicateOf: 998877, uploadId: 3 });
  });

  it("returns a duplicate found while polling, and other errors as error results", async () => {
    let calls = 0;
    const { client } = setup(() => {
      calls += 1;
      if (calls === 1) return Response.json({ id: 4, status: "processing" });
      return Response.json({ id: 4, error: "Unsupported file" });
    });
    const result = await client.uploadAndWait({
      file: new Uint8Array([1]),
      data_type: "tcx",
      external_id: "e",
    });
    expect(result).toEqual({
      kind: "error",
      uploadId: 4,
      error: "Unsupported file",
      upload: { id: 4, error: "Unsupported file" },
    });
  });

  it("times out when Strava keeps processing", async () => {
    const { client } = setup(() => Response.json({ id: 8, status: "processing" }));
    const error = await client
      .waitForUpload({ id: 8, status: "processing" }, { intervalMs: 1000, timeoutMs: 3000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadTimeoutError);
    expect((error as UploadTimeoutError).uploadId).toBe(8);
  });

  it("uses default poll options", async () => {
    const { client } = setup(() => Response.json({ id: 8, activity_id: 1 }));
    const result = await client.waitForUpload({ id: 8 });
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
