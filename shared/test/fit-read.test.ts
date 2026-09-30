import { CrcCalculator, Encoder, Profile, type RecordMesg } from "@garmin/fitsdk";
import { describe, expect, it } from "vitest";
import { FitReadError, readFitActivity } from "../src/fit/read.ts";
import { epochMsToFitSeconds } from "../src/fit/quantization.ts";
import { writeFitActivity } from "../src/fit/write.ts";
import { SYNTHETIC_START, syntheticTrack } from "./fixtures/synthetic-track.ts";

const opts = { source: "wrist" };

/** A FIT file with valid header and file CRCs wrapped around arbitrary data bytes. */
function fitWithData(data: number[]): Uint8Array {
  const header = new Uint8Array(14);
  const view = new DataView(header.buffer);
  view.setUint8(0, 14);
  view.setUint8(1, 0x20);
  view.setUint16(2, 21_000, true);
  view.setUint32(4, data.length, true);
  header.set([0x2e, 0x46, 0x49, 0x54], 8);
  view.setUint16(12, CrcCalculator.calculateCRC(header, 0, 12), true);
  const body = new Uint8Array([...header, ...data, 0, 0]);
  const crc = CrcCalculator.calculateCRC(body, 0, body.length - 2);
  new DataView(body.buffer).setUint16(body.length - 2, crc, true);
  return body;
}

describe("readFitActivity", () => {
  it("stamps every sample with the given source", () => {
    const parsed = readFitActivity(writeFitActivity(syntheticTrack({ count: 5 })), opts);
    expect(parsed.samples.map((s) => s.source)).toEqual(Array(5).fill("wrist"));
  });

  it("refuses bytes that are not FIT", () => {
    expect(() => readFitActivity(new TextEncoder().encode("<gpx/>"), opts)).toThrow(FitReadError);
  });

  it("refuses a file whose CRC does not match (a single flipped byte)", () => {
    const bytes = writeFitActivity(syntheticTrack({ count: 5 }));
    bytes[40] = bytes[40]! ^ 0xff;
    expect(() => readFitActivity(bytes, opts)).toThrow(/CRC/);
  });

  it("refuses a CRC-valid file that fails to decode", () => {
    // A data message for local type 0 with no definition before it.
    expect(() => readFitActivity(fitWithData([0x00, 0x01]), opts)).toThrow(/FIT decode failed/);
  });

  it("refuses a record without a timestamp rather than guessing one", () => {
    const encoder = new Encoder();
    const record: RecordMesg = { heartRate: 120 };
    encoder.writeMesg({ mesgNum: Profile.MesgNum.RECORD!, ...record });
    expect(() => readFitActivity(encoder.close(), opts)).toThrow(/record 0 has no timestamp/);
  });

  it("falls back to the first record time when there is no session", () => {
    const encoder = new Encoder();
    const record: RecordMesg = { timestamp: epochMsToFitSeconds(SYNTHETIC_START), heartRate: 120 };
    encoder.writeMesg({ mesgNum: Profile.MesgNum.RECORD!, ...record });
    const parsed = readFitActivity(encoder.close(), opts);
    expect(parsed).toEqual({
      format: "fit",
      sport: undefined,
      startTime: SYNTHETIC_START,
      samples: [{ time: SYNTHETIC_START, source: "wrist", heartRate: 120 }],
    });
  });

  it("reads an empty file as no samples and no start time", () => {
    const parsed = readFitActivity(new Encoder().close(), opts);
    expect(parsed).toEqual({ format: "fit", sport: undefined, startTime: undefined, samples: [] });
  });
});
