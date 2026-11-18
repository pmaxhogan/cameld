import { describe, expect, it } from "vitest";
import { parseStravaJson } from "../src/strava/json.ts";

/**
 * SYNTHETIC bodies only: made-up ids above 2^53 (where JSON.parse rounds) in
 * the shape the live API uses (a number in `id`, a string twin in `id_str`).
 */
const ACTIVITY = "9100000000000000101";
const ATHLETE = "9100000000000515151";
const UPLOAD = "9100000000000600101";

describe("parseStravaJson", () => {
  it("shows the problem: JSON.parse rounds a 64-bit id", () => {
    const plain = JSON.parse(`{"id":${ACTIVITY}}`) as { id: number };
    expect(String(plain.id)).not.toBe(ACTIVITY);
  });

  it("keeps a 64-bit id exact, as a decimal string", () => {
    expect(parseStravaJson(`{"id":${ACTIVITY}}`)).toEqual({ id: ACTIVITY });
  });

  it("reads an activity the way the live API sends it", () => {
    const body = `{
      "id": ${ACTIVITY}, "id_str": "${ACTIVITY}",
      "athlete": { "id": ${ATHLETE}, "id_str": "${ATHLETE}", "resource_state": 1 },
      "upload_id": ${UPLOAD}, "upload_id_str": "${UPLOAD}",
      "name": "Synthetic Loop", "distance": 1234.5, "moving_time": 600,
      "external_id": "synthetic-1.fit", "gear_id": "g123", "map": { "id": "a${ACTIVITY}" }
    }`;
    expect(parseStravaJson(body)).toEqual({
      id: ACTIVITY,
      id_str: ACTIVITY,
      athlete: { id: ATHLETE, id_str: ATHLETE, resource_state: 1 },
      upload_id: UPLOAD,
      upload_id_str: UPLOAD,
      name: "Synthetic Loop",
      distance: 1234.5,
      moving_time: 600,
      external_id: "synthetic-1.fit",
      gear_id: "g123",
      map: { id: `a${ACTIVITY}` },
    });
  });

  it("reads an id that has no string twin from the digits of the body", () => {
    // An upload names its activity in `activity_id`, a bare number with no twin.
    const upload = parseStravaJson(
      `{"id":${UPLOAD},"id_str":"${UPLOAD}","activity_id":${ACTIVITY},"error":null}`,
    );
    expect(upload).toEqual({ id: UPLOAD, id_str: UPLOAD, activity_id: ACTIVITY, error: null });
  });

  it("makes small ids strings too, so an id has one type whatever its size", () => {
    expect(parseStravaJson('{"id":9400001,"activity_id":12,"upload_id":7}')).toEqual({
      id: "9400001",
      activity_id: "12",
      upload_id: "7",
    });
  });

  it("uses the string twin as the id, as Strava recommends", () => {
    // Even if `id` itself were missing or already wrong, `id_str` is the id.
    expect(parseStravaJson(`{"id_str":"${ACTIVITY}"}`)).toEqual({ id: ACTIVITY, id_str: ACTIVITY });
    expect(parseStravaJson(`{"id":5,"id_str":"${ACTIVITY}"}`)).toEqual({
      id: ACTIVITY,
      id_str: ACTIVITY,
    });
    expect(parseStravaJson(`{"upload_id":null,"upload_id_str":"${UPLOAD}"}`)).toEqual({
      upload_id: UPLOAD,
      upload_id_str: UPLOAD,
    });
  });

  it("ignores a twin that is not a canonical id", () => {
    expect(parseStravaJson('{"id":77,"id_str":"seventy-seven"}')).toEqual({
      id: "77",
      id_str: "seventy-seven",
    });
    expect(parseStravaJson('{"upload_id":null,"upload_id_str":null}')).toEqual({
      upload_id: null,
      upload_id_str: null,
    });
    // A `_str` field that is not an id twin is left alone.
    expect(parseStravaJson('{"name":"x","name_str":"123"}')).toEqual({
      name: "x",
      name_str: "123",
    });
  });

  it("never rounds any other integer either (segment effort ids are 64-bit today)", () => {
    const body = `{"segment_efforts":[{"id":${ACTIVITY},"kom_rank":3,"big_count":9007199254740993}]}`;
    expect(parseStravaJson(body)).toEqual({
      segment_efforts: [{ id: ACTIVITY, kom_rank: 3, big_count: "9007199254740993" }],
    });
  });

  it("leaves ordinary numbers as numbers", () => {
    const body =
      '{"distance":1234.5,"moving_time":600,"photo_count":0,"offset":-18000,"big":1e21,' +
      '"achievement_count":9007199254740991,"type_id":2}';
    expect(parseStravaJson(body)).toEqual({
      distance: 1234.5,
      moving_time: 600,
      photo_count: 0,
      offset: -18000,
      big: 1e21,
      achievement_count: 9007199254740991,
      type_id: 2,
    });
  });

  it("keeps an id field that is not a positive integer as it came", () => {
    expect(parseStravaJson('{"id":0,"activity_id":null,"upload_id":-1,"gear_id":"b12"}')).toEqual({
      id: 0,
      activity_id: null,
      upload_id: -1,
      gear_id: "b12",
    });
  });

  it("keeps an id beyond signed 64-bit exact, so it fails loudly later instead of rounding", () => {
    expect(parseStravaJson('{"id":18446744073709551615}')).toEqual({ id: "18446744073709551615" });
  });

  it("reads streams and lists unchanged", () => {
    const body = '{"time":{"data":[0,1,2]},"latlng":{"data":[[0.5,0.5],[0.5001,0.5002]]}}';
    expect(parseStravaJson(body)).toEqual(JSON.parse(body));
    expect(parseStravaJson(`[{"id":${ACTIVITY}},{"id":${ATHLETE}}]`)).toEqual([
      { id: ACTIVITY },
      { id: ATHLETE },
    ]);
  });

  it("reads a body stored before ids were strings to the same ids", () => {
    // Old backups hold what JSON.stringify wrote from a parsed number.
    const stored = JSON.stringify({ id: 9400001, athlete: { id: 515151 }, upload_id: 9900001 });
    expect(parseStravaJson(stored)).toEqual({
      id: "9400001",
      athlete: { id: "515151" },
      upload_id: "9900001",
    });
    // And a body stored by this version reads back unchanged.
    const now = parseStravaJson(`{"id":${ACTIVITY},"id_str":"${ACTIVITY}"}`);
    expect(parseStravaJson(JSON.stringify(now))).toEqual(now);
  });

  it("still throws on malformed JSON", () => {
    expect(() => parseStravaJson("{")).toThrow(SyntaxError);
  });
});
