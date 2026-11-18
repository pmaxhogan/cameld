import { describe, expect, it } from "vitest";
import { classifyUpload, parseDuplicateOf, StravaClient } from "../src/strava/client.ts";
import { RateLimiter } from "../src/strava/rate-limiter.ts";
import { fakeClock } from "./strava-helpers.ts";

/**
 * The client seam with 64-bit ids. SYNTHETIC bodies only, written as the
 * live API writes them: ids are bare JSON integers above 2^53.
 */
const ACTIVITY = "9100000000000000101";
const ACTIVITY_NEXT = "9100000000000000102";
const ATHLETE = "9100000000000515151";
const UPLOAD = "9100000000000600101";

function clientAnswering(bodies: Record<string, string>) {
  const paths: string[] = [];
  const clock = fakeClock("2020-02-02T12:00:00Z");
  const client = new StravaClient({
    tokens: { getAccessToken: () => Promise.resolve("synthetic-token") },
    limiter: new RateLimiter({ clock, safetyMargin: 0 }),
    baseUrl: "https://strava.invalid/api/v3",
    clock,
    fetch: ((input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      const body = bodies[url.pathname];
      return Promise.resolve(
        body === undefined
          ? new Response('{"message":"Record Not Found"}', { status: 404 })
          : new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    }) as typeof fetch,
  });
  return { client, paths };
}

describe("StravaClient with 64-bit ids", () => {
  it("returns an activity's ids exactly, and asks for it by the exact id", async () => {
    const { client, paths } = clientAnswering({
      [`/api/v3/activities/${ACTIVITY}`]: `{"id":${ACTIVITY},"id_str":"${ACTIVITY}",
        "athlete":{"id":${ATHLETE},"id_str":"${ATHLETE}"},
        "upload_id":${UPLOAD},"upload_id_str":"${UPLOAD}","name":"Synthetic Loop",
        "sport_type":"Run","start_date":"2020-02-02T10:00:00Z",
        "start_date_local":"2020-02-02T10:00:00Z","distance":1000.5,"moving_time":600,
        "elapsed_time":600}`,
    });
    const detail = await client.getActivity(ACTIVITY);
    expect(detail.id).toBe(ACTIVITY);
    expect(detail.athlete?.id).toBe(ATHLETE);
    expect(detail.upload_id).toBe(UPLOAD);
    expect(detail.distance).toBe(1000.5);
    expect(detail.elapsed_time).toBe(600);
    expect(paths).toEqual([`/api/v3/activities/${ACTIVITY}`]);
    // The neighbouring id is a different activity (as numbers they are equal).
    await expect(client.getActivity(ACTIVITY_NEXT)).rejects.toThrow(/404/);
    expect(paths[1]).toBe(`/api/v3/activities/${ACTIVITY_NEXT}`);
  });

  it("lists activities with exact ids", async () => {
    const { client } = clientAnswering({
      "/api/v3/athlete/activities": `[{"id":${ACTIVITY_NEXT}},{"id":${ACTIVITY}}]`,
    });
    expect((await client.listActivities()).map((a) => a.id)).toEqual([ACTIVITY_NEXT, ACTIVITY]);
  });

  it("reads the athlete id exactly", async () => {
    const { client } = clientAnswering({
      "/api/v3/athlete": `{"id":${ATHLETE},"id_str":"${ATHLETE}","firstname":"Synthetic"}`,
    });
    expect((await client.getAthlete()).id).toBe(ATHLETE);
  });

  it("takes the new activity's id from a finished upload, which has no string twin", async () => {
    const { client, paths } = clientAnswering({
      [`/api/v3/uploads/${UPLOAD}`]: `{"id":${UPLOAD},"id_str":"${UPLOAD}","external_id":"x.fit",
        "error":null,"status":"Your activity is ready.","activity_id":${ACTIVITY}}`,
    });
    const result = await client.waitForUpload({ id: UPLOAD, activity_id: null, error: null });
    expect(result).toMatchObject({ kind: "ready", uploadId: UPLOAD, activityId: ACTIVITY });
    expect(paths).toEqual([`/api/v3/uploads/${UPLOAD}`]);
  });
});

describe("upload results with 64-bit ids", () => {
  it("reads the duplicated activity's id from the error text, digit for digit", () => {
    expect(parseDuplicateOf(`x.fit duplicate of activity ${ACTIVITY}`)).toBe(ACTIVITY);
    expect(
      parseDuplicateOf(
        `x.fit duplicate of <a href='/activities/${ACTIVITY_NEXT}' target='_blank'>Synthetic</a>`,
      ),
    ).toBe(ACTIVITY_NEXT);
    expect(parseDuplicateOf("duplicate of activity 9400001")).toBe("9400001");
    expect(parseDuplicateOf("duplicate of activity 0009400001")).toBe("9400001");
  });

  it("rejects an id that could not be a Strava id", () => {
    expect(parseDuplicateOf("duplicate of activity 0")).toBeNull();
    expect(parseDuplicateOf("duplicate of activity 99999999999999999999")).toBeNull();
    expect(parseDuplicateOf(null)).toBeNull();
  });

  it("classifies a 64-bit duplicate as a duplicate, not a plain error", () => {
    const error = `x.fit duplicate of <a href='/activities/${ACTIVITY}'>Synthetic</a>`;
    expect(classifyUpload({ id: UPLOAD, error })).toMatchObject({
      kind: "duplicate",
      uploadId: UPLOAD,
      duplicateOf: ACTIVITY,
    });
    expect(classifyUpload({ id: UPLOAD, activity_id: ACTIVITY })).toMatchObject({
      kind: "ready",
      activityId: ACTIVITY,
    });
  });
});
