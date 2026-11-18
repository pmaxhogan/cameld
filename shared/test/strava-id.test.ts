import { describe, expect, it } from "vitest";
import { compareStravaIds, isStravaId, MAX_STRAVA_ID, toStravaId } from "../src/strava-id.ts";

// The first integer a JavaScript number cannot hold: 2^53 + 1.
const BEYOND_NUMBER = "9007199254740993";

describe("isStravaId", () => {
  it("accepts canonical decimal ids up to a signed 64-bit integer", () => {
    for (const id of ["1", "42", "9400001", BEYOND_NUMBER, "9100000000009400001", MAX_STRAVA_ID]) {
      expect(isStravaId(id), id).toBe(true);
    }
  });

  it("rejects anything that is not a canonical positive decimal string", () => {
    const bad: unknown[] = [
      "",
      "0",
      "012",
      "-5",
      "1.5",
      "1e3",
      "12a",
      " 12",
      "12 ",
      "9223372036854775808",
      "18446744073709551615",
      "92233720368547758070",
      12,
      12n,
      null,
      undefined,
      {},
    ];
    for (const value of bad) expect(isStravaId(value), String(value)).toBe(false);
  });
});

describe("toStravaId", () => {
  it("returns a canonical id unchanged, digit for digit", () => {
    expect(toStravaId(BEYOND_NUMBER)).toBe(BEYOND_NUMBER);
    expect(toStravaId(MAX_STRAVA_ID)).toBe(MAX_STRAVA_ID);
  });

  it("accepts a number that is still exact (data written before ids were strings)", () => {
    expect(toStravaId(9400001)).toBe("9400001");
    expect(toStravaId(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
  });

  it("accepts a bigint in range", () => {
    expect(toStravaId(9007199254740993n)).toBe(BEYOND_NUMBER);
    expect(() => toStravaId(9223372036854775808n)).toThrow(TypeError);
  });

  it("refuses a number that may already be rounded", () => {
    // 2^53 + 1 as a number literal IS 2^53: the id is already wrong.
    expect(() => toStravaId(Number.MAX_SAFE_INTEGER + 2)).toThrow(/not a valid Strava id/);
    expect(() => toStravaId(1.5)).toThrow(TypeError);
    expect(() => toStravaId(0)).toThrow(TypeError);
    expect(() => toStravaId(-3)).toThrow(TypeError);
    expect(() => toStravaId(Number.NaN)).toThrow(TypeError);
  });

  it("refuses malformed input and names what it was", () => {
    expect(() => toStravaId("12a", "athlete id")).toThrow("athlete id is not a valid Strava id");
    expect(() => toStravaId(null)).toThrow(TypeError);
    expect(() => toStravaId(undefined)).toThrow(TypeError);
    expect(() => toStravaId("012")).toThrow(TypeError);
  });
});

describe("compareStravaIds", () => {
  it("orders numerically, not as text", () => {
    const ids = ["100", "20", "3", BEYOND_NUMBER, "9007199254740992", MAX_STRAVA_ID, "10000000000"];
    expect([...ids].sort(compareStravaIds)).toEqual([
      "3",
      "20",
      "100",
      "10000000000",
      "9007199254740992",
      BEYOND_NUMBER,
      MAX_STRAVA_ID,
    ]);
    // What a plain string sort would do instead.
    expect([...ids].sort()[0]).toBe("100");
  });

  it("tells neighbours above 2^53 apart, which numbers cannot", () => {
    expect(Number("9007199254740992")).toBe(Number(BEYOND_NUMBER));
    expect(compareStravaIds("9007199254740992", BEYOND_NUMBER)).toBeLessThan(0);
    expect(compareStravaIds(BEYOND_NUMBER, "9007199254740992")).toBeGreaterThan(0);
    expect(compareStravaIds(BEYOND_NUMBER, BEYOND_NUMBER)).toBe(0);
  });
});
