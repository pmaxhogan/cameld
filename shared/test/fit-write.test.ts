import { Decoder, Stream } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import type { ActivitySample } from "../src/activity/sample.ts";
import { FIT_QUANTIZATION, FIT_EPOCH_MS } from "../src/fit/quantization.ts";
import { FitWriteError, quantizeTime, writeFitActivity } from "../src/fit/write.ts";
import { SYNTHETIC_START, syntheticTrack } from "./fixtures/synthetic-track.ts";

function decode(bytes: Uint8Array) {
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  expect(decoder.checkIntegrity()).toBe(true);
  const { messages, errors } = decoder.read();
  expect(errors).toEqual([]);
  return messages;
}

describe("writeFitActivity", () => {
  it("writes a CRC-valid activity file with the full message recipe", () => {
    const samples = syntheticTrack({ count: 60 });
    const bytes = writeFitActivity(samples, {
      sport: "running",
      subSport: "street",
      product: 7,
      serialNumber: 424242,
      timeCreated: SYNTHETIC_START - 5000,
    });
    const messages = decode(bytes);

    expect(messages.fileIdMesgs).toEqual([
      {
        type: "activity",
        manufacturer: "development",
        product: 7,
        serialNumber: 424242,
        timeCreated: new Date(SYNTHETIC_START - 5000),
      },
    ]);
    expect(messages.deviceInfoMesgs?.[0]).toMatchObject({
      deviceIndex: "creator",
      manufacturer: "development",
      product: 7,
      serialNumber: 424242,
      timestamp: new Date(SYNTHETIC_START),
    });
    expect(messages.eventMesgs?.map((e) => [e.event, e.eventType])).toEqual([
      ["timer", "start"],
      ["timer", "stopAll"],
    ]);
    expect(messages.recordMesgs).toHaveLength(60);

    const end = new Date(SYNTHETIC_START + 59_000);
    const lastDistance = samples[59]!.distance!;
    const heartRates = samples.map((s) => s.heartRate!);
    const expectedTotals = {
      timestamp: end,
      startTime: new Date(SYNTHETIC_START),
      totalElapsedTime: 59,
      totalTimerTime: 59,
      sport: "running",
      subSport: "street",
      maxHeartRate: Math.max(...heartRates),
      avgHeartRate: Math.round(heartRates.reduce((a, b) => a + b, 0) / heartRates.length),
      event: expect.any(String),
      eventType: "stop",
    };
    const [lap] = messages.lapMesgs!;
    const [session] = messages.sessionMesgs!;
    expect(lap).toMatchObject({ ...expectedTotals, event: "lap" });
    expect(session).toMatchObject({
      ...expectedTotals,
      event: "session",
      numLaps: 1,
      firstLapIndex: 0,
    });
    expect(lap!.totalDistance).toBeCloseTo(lastDistance, 2);
    expect(session!.startPositionLat).toBeTypeOf("number");
    expect(session!.enhancedMaxSpeed).toBeGreaterThan(0);
    expect(messages.activityMesgs).toEqual([
      expect.objectContaining({
        timestamp: end,
        numSessions: 1,
        type: "manual",
        event: "activity",
        eventType: "stop",
      }),
    ]);
  });

  it("defaults to a generic sport, the development manufacturer and the first sample time", () => {
    const samples = syntheticTrack({ count: 3, withPosition: false });
    const messages = decode(writeFitActivity(samples));
    expect(messages.fileIdMesgs?.[0]).toEqual({
      type: "activity",
      manufacturer: "development",
      product: 0,
      timeCreated: new Date(SYNTHETIC_START),
    });
    expect(messages.sessionMesgs?.[0]).toMatchObject({ sport: "generic", subSport: "generic" });
    // No position, distance or speed anywhere: the summary omits them.
    expect(messages.sessionMesgs?.[0]).not.toHaveProperty("startPositionLat");
    expect(messages.sessionMesgs?.[0]).not.toHaveProperty("totalDistance");
    expect(messages.sessionMesgs?.[0]).not.toHaveProperty("enhancedMaxSpeed");
  });

  it("omits heart rate summaries when no sample has heart rate", () => {
    const samples = syntheticTrack({ count: 3, withHeartRate: false });
    const session = decode(writeFitActivity(samples)).sessionMesgs?.[0];
    expect(session).not.toHaveProperty("avgHeartRate");
    expect(session).not.toHaveProperty("maxHeartRate");
    expect(session).toHaveProperty("startPositionLat");
  });

  it("takes the start position from the first sample that has one", () => {
    const samples = syntheticTrack({ count: 10, gpsGap: [0, 4] });
    const session = decode(writeFitActivity(samples)).sessionMesgs?.[0];
    expect(session?.startPositionLat).toBe(Math.round(samples[4]!.lat! * (2 ** 31 / 180)));
  });

  it("stores longitude +180 as -180, the same meridian", () => {
    const bytes = writeFitActivity([{ time: SYNTHETIC_START, source: "s", lat: 0.5, lng: 180 }]);
    expect(decode(bytes).recordMesgs?.[0]?.positionLong).toBe(-(2 ** 31));
  });

  it("rounds sample times to whole seconds", () => {
    expect(quantizeTime(SYNTHETIC_START + 499)).toBe(SYNTHETIC_START);
    expect(quantizeTime(SYNTHETIC_START + 500)).toBe(SYNTHETIC_START + 1000);
    expect(FIT_QUANTIZATION.time.min).toBe(FIT_EPOCH_MS + 268_435_456_000);
    expect(new Date(FIT_QUANTIZATION.time.min).toISOString()).toMatch(/^1998-07-0/);
    expect(new Date(FIT_QUANTIZATION.time.max).toISOString()).toMatch(/^2126-02-0/);
  });

  describe("refuses what FIT cannot hold instead of clamping", () => {
    const base: ActivitySample = { time: SYNTHETIC_START, source: "s" };
    const cases: [string, ActivitySample[], RegExp][] = [
      ["no samples", [], /no samples/],
      ["time before the absolute range", [{ ...base, time: FIT_EPOCH_MS }], /time/],
      ["fractional nonsense time", [{ ...base, time: Number.NaN }], /time NaN/],
      [
        "time going backwards",
        [base, { ...base, time: SYNTHETIC_START - 1 }],
        /sample 1: time goes backwards/,
      ],
      ["lat without lng", [{ ...base, lat: 0.5 }], /both present/],
      ["lat out of range", [{ ...base, lat: 91, lng: 0 }], /lat 91/],
      ["heart rate 255", [{ ...base, heartRate: 255 }], /heartRate 255/],
      ["negative cadence", [{ ...base, cadence: -1 }], /cadence -1/],
      ["altitude below -500", [{ ...base, altitude: -500.5 }], /altitude/],
      ["negative distance", [{ ...base, distance: -0.01 }], /distance/],
      ["infinite speed", [{ ...base, speed: Infinity }], /speed Infinity/],
    ];
    it.each(cases)("%s", (_label, samples, message) => {
      expect(() => writeFitActivity(samples)).toThrow(FitWriteError);
      expect(() => writeFitActivity(samples)).toThrow(message);
    });

    it("an unknown sport name", () => {
      expect(() => writeFitActivity([base], { sport: "underwater-chess" })).toThrow(
        /unknown FIT sport "underwater-chess"/,
      );
    });

    it("a time_created outside the range", () => {
      expect(() => writeFitActivity([base], { timeCreated: 0 })).toThrow(/timeCreated/);
    });
  });
});
