import { Decoder, Stream, type RecordMesg } from "@garmin/fitsdk";
import type { ActivitySample, ParsedActivity, ReadOptions } from "../activity/sample.ts";
import { semicirclesToDegrees } from "./quantization.ts";

/**
 * FIT reader built on Garmin's @garmin/fitsdk Decoder. The file must pass the
 * header and file CRC checks and decode without errors; a partially readable
 * file is refused rather than half imported.
 */

export class FitReadError extends Error {
  override readonly name = "FitReadError";
}

function toDate(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}

function toSample(record: RecordMesg, index: number, source: string): ActivitySample {
  const timestamp = toDate(record.timestamp);
  if (timestamp === undefined) {
    throw new FitReadError(`record ${index} has no timestamp`);
  }
  const sample: ActivitySample = { time: timestamp.getTime(), source };
  if (record.positionLat !== undefined && record.positionLong !== undefined) {
    sample.lat = semicirclesToDegrees(record.positionLat);
    sample.lng = semicirclesToDegrees(record.positionLong);
  }
  // The decoder expands the legacy altitude and speed fields into their
  // enhanced components, so the enhanced ones are always the complete answer.
  if (record.enhancedAltitude !== undefined) sample.altitude = record.enhancedAltitude;
  if (record.heartRate !== undefined) sample.heartRate = record.heartRate;
  if (record.cadence !== undefined) sample.cadence = record.cadence;
  if (record.distance !== undefined) sample.distance = record.distance;
  if (record.enhancedSpeed !== undefined) sample.speed = record.enhancedSpeed;
  return sample;
}

/** Decode a FIT activity file into normalized samples. */
export function readFitActivity(bytes: Uint8Array, options: ReadOptions): ParsedActivity {
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  if (!decoder.checkIntegrity()) {
    throw new FitReadError("not a FIT file, or its header or file CRC is wrong");
  }
  const { messages, errors } = decoder.read();
  if (errors.length > 0) {
    throw new FitReadError(`FIT decode failed: ${errors.map((error) => error.message).join("; ")}`);
  }
  const records = messages.recordMesgs ?? [];
  const samples = records.map((record, index) => toSample(record, index, options.source));
  const session = messages.sessionMesgs?.[0];
  // The decoder converts enum values to their names, whatever the typings say.
  const sport: unknown = session?.sport;
  const startTime = toDate(session?.startTime)?.getTime() ?? samples[0]?.time;
  return {
    format: "fit",
    sport: typeof sport === "string" ? sport : undefined,
    startTime,
    samples,
  };
}
