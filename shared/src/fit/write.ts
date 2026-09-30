import {
  Encoder,
  Profile,
  type ActivityMesg,
  type DeviceInfoMesg,
  type EventMesg,
  type FileIdMesg,
  type LapMesg,
  type RecordMesg,
  type SessionMesg,
} from "@garmin/fitsdk";
import { SAMPLE_FIELDS, type ActivitySample } from "../activity/sample.ts";
import {
  FIT_QUANTIZATION,
  degreesToSemicircles,
  epochMsToFitSeconds,
  fitSecondsToEpochMs,
  type FieldQuantum,
} from "./quantization.ts";

/**
 * FIT activity writer. Encoding is delegated to Garmin's @garmin/fitsdk
 * Encoder (header, definitions, field encoding, header and file CRCs); this
 * module decides WHAT is written. Message order follows the FIT activity file
 * recipe: file_id, device_info, event(timer start), record..., event(timer
 * stop_all), lap, session, activity.
 */

export class FitWriteError extends Error {
  override readonly name = "FitWriteError";
}

export interface FitWriteOptions {
  /** FIT sport name, for example "running", "cycling", "walking". Default "generic". */
  sport?: string;
  /** FIT sub_sport name. Default "generic". */
  subSport?: string;
  /** FIT manufacturer name. Default "development" (the id reserved for non-vendor tools). */
  manufacturer?: string;
  /** Product id within the manufacturer. Default 0. */
  product?: number;
  /** Device serial number written to file_id and device_info. Optional. */
  serialNumber?: number;
  /** file_id.time_created in epoch ms. Default: the first sample's time. */
  timeCreated?: number;
}

const MESG = Profile.MesgNum as Record<
  "FILE_ID" | "DEVICE_INFO" | "EVENT" | "RECORD" | "LAP" | "SESSION" | "ACTIVITY",
  number
>;

/** Resolve a FIT enum name (for example sport "running") to its numeric value. */
function enumValue(typeName: string, name: string): number {
  const values = Profile.types[typeName]!;
  for (const [key, label] of Object.entries(values)) {
    if (label === name) {
      return Number(key);
    }
  }
  throw new FitWriteError(`unknown FIT ${typeName} "${name}"`);
}

function checkRange(field: string, value: number, quantum: FieldQuantum, index: number): void {
  if (!Number.isFinite(value) || value < quantum.min || value > quantum.max) {
    throw new FitWriteError(
      `sample ${index}: ${field} ${value} is outside the FIT range ` +
        `[${quantum.min}, ${quantum.max}]`,
    );
  }
}

/** Refuse anything FIT cannot hold rather than clamping it (clamping loses data). */
function validateSamples(samples: readonly ActivitySample[]): void {
  if (samples.length === 0) {
    throw new FitWriteError("cannot write a FIT activity with no samples");
  }
  let previous = -Infinity;
  samples.forEach((sample, index) => {
    checkRange("time", sample.time, FIT_QUANTIZATION.time, index);
    if (sample.time < previous) {
      throw new FitWriteError(`sample ${index}: time goes backwards`);
    }
    previous = sample.time;
    if ((sample.lat === undefined) !== (sample.lng === undefined)) {
      throw new FitWriteError(`sample ${index}: lat and lng must be both present or both absent`);
    }
    for (const field of SAMPLE_FIELDS) {
      const value = sample[field];
      if (value !== undefined) {
        checkRange(field, value, FIT_QUANTIZATION[field], index);
      }
    }
  });
}

function toRecord(sample: ActivitySample): RecordMesg {
  const record: RecordMesg = { timestamp: epochMsToFitSeconds(sample.time) };
  if (sample.lat !== undefined && sample.lng !== undefined) {
    record.positionLat = degreesToSemicircles(sample.lat);
    record.positionLong = degreesToSemicircles(sample.lng);
  }
  if (sample.altitude !== undefined) record.enhancedAltitude = sample.altitude;
  if (sample.heartRate !== undefined) record.heartRate = Math.round(sample.heartRate);
  if (sample.cadence !== undefined) record.cadence = Math.round(sample.cadence);
  if (sample.distance !== undefined) record.distance = sample.distance;
  if (sample.speed !== undefined) record.enhancedSpeed = sample.speed;
  return record;
}

interface Summary {
  startSeconds: number;
  endSeconds: number;
  elapsedSeconds: number;
  totalDistance: number | undefined;
  avgHeartRate: number | undefined;
  maxHeartRate: number | undefined;
  maxSpeed: number | undefined;
  startLat: number | undefined;
  startLng: number | undefined;
}

function summarize(samples: readonly ActivitySample[]): Summary {
  const startSeconds = epochMsToFitSeconds(samples[0]!.time);
  const endSeconds = epochMsToFitSeconds(samples[samples.length - 1]!.time);
  let totalDistance: number | undefined;
  let heartRateSum = 0;
  let heartRateCount = 0;
  let maxHeartRate: number | undefined;
  let maxSpeed: number | undefined;
  let startLat: number | undefined;
  let startLng: number | undefined;
  for (const sample of samples) {
    if (sample.distance !== undefined) {
      totalDistance = Math.max(totalDistance ?? 0, sample.distance);
    }
    if (sample.heartRate !== undefined) {
      const heartRate = Math.round(sample.heartRate);
      heartRateSum += heartRate;
      heartRateCount += 1;
      maxHeartRate = Math.max(maxHeartRate ?? 0, heartRate);
    }
    if (sample.speed !== undefined) {
      maxSpeed = Math.max(maxSpeed ?? 0, sample.speed);
    }
    if (startLat === undefined && sample.lat !== undefined) {
      startLat = sample.lat;
      startLng = sample.lng;
    }
  }
  return {
    startSeconds,
    endSeconds,
    elapsedSeconds: endSeconds - startSeconds,
    totalDistance,
    avgHeartRate: heartRateCount > 0 ? Math.round(heartRateSum / heartRateCount) : undefined,
    maxHeartRate,
    maxSpeed,
    startLat,
    startLng,
  };
}

/** Fields shared by lap and session: totals, averages and the start position. */
function totals(summary: Summary, sport: number, subSport: number): LapMesg & SessionMesg {
  const fields: LapMesg & SessionMesg = {
    timestamp: summary.endSeconds,
    startTime: summary.startSeconds,
    totalElapsedTime: summary.elapsedSeconds,
    totalTimerTime: summary.elapsedSeconds,
    sport,
    subSport,
  };
  if (summary.totalDistance !== undefined) fields.totalDistance = summary.totalDistance;
  if (summary.avgHeartRate !== undefined) fields.avgHeartRate = summary.avgHeartRate;
  if (summary.maxHeartRate !== undefined) fields.maxHeartRate = summary.maxHeartRate;
  if (summary.maxSpeed !== undefined) fields.enhancedMaxSpeed = summary.maxSpeed;
  if (summary.startLat !== undefined && summary.startLng !== undefined) {
    fields.startPositionLat = degreesToSemicircles(summary.startLat);
    fields.startPositionLong = degreesToSemicircles(summary.startLng);
  }
  return fields;
}

/**
 * Encode samples as a complete FIT activity file (one lap, one session).
 * Samples must be in non-decreasing time order and inside the FIT ranges
 * documented in quantization.ts; anything else throws FitWriteError.
 */
export function writeFitActivity(
  samples: readonly ActivitySample[],
  options: FitWriteOptions = {},
): Uint8Array {
  validateSamples(samples);
  const sport = enumValue("sport", options.sport ?? "generic");
  const subSport = enumValue("subSport", options.subSport ?? "generic");
  const manufacturer = enumValue("manufacturer", options.manufacturer ?? "development");
  const product = options.product ?? 0;
  const timeCreated = options.timeCreated ?? samples[0]!.time;
  checkRange("timeCreated", timeCreated, FIT_QUANTIZATION.time, -1);

  const summary = summarize(samples);
  const encoder = new Encoder();

  const fileId: FileIdMesg = {
    type: enumValue("file", "activity"),
    manufacturer,
    product,
    timeCreated: epochMsToFitSeconds(timeCreated),
  };
  const deviceInfo: DeviceInfoMesg = {
    timestamp: summary.startSeconds,
    deviceIndex: enumValue("deviceIndex", "creator"),
    manufacturer,
    product,
  };
  if (options.serialNumber !== undefined) {
    fileId.serialNumber = options.serialNumber;
    deviceInfo.serialNumber = options.serialNumber;
  }
  encoder.writeMesg({ mesgNum: MESG.FILE_ID, ...fileId });
  encoder.writeMesg({ mesgNum: MESG.DEVICE_INFO, ...deviceInfo });

  const timer = enumValue("event", "timer");
  const start: EventMesg = {
    timestamp: summary.startSeconds,
    event: timer,
    eventType: enumValue("eventType", "start"),
  };
  encoder.writeMesg({ mesgNum: MESG.EVENT, ...start });

  for (const sample of samples) {
    encoder.writeMesg({ mesgNum: MESG.RECORD, ...toRecord(sample) });
  }

  const stop: EventMesg = {
    timestamp: summary.endSeconds,
    event: timer,
    eventType: enumValue("eventType", "stopAll"),
  };
  encoder.writeMesg({ mesgNum: MESG.EVENT, ...stop });

  const stopType = enumValue("eventType", "stop");
  const lap: LapMesg = {
    ...totals(summary, sport, subSport),
    messageIndex: 0,
    event: enumValue("event", "lap"),
    eventType: stopType,
  };
  encoder.writeMesg({ mesgNum: MESG.LAP, ...lap });

  const session: SessionMesg = {
    ...totals(summary, sport, subSport),
    messageIndex: 0,
    firstLapIndex: 0,
    numLaps: 1,
    event: enumValue("event", "session"),
    eventType: stopType,
  };
  encoder.writeMesg({ mesgNum: MESG.SESSION, ...session });

  const activity: ActivityMesg = {
    timestamp: summary.endSeconds,
    totalTimerTime: summary.elapsedSeconds,
    numSessions: 1,
    type: enumValue("activity", "manual"),
    event: enumValue("event", "activity"),
    eventType: stopType,
  };
  encoder.writeMesg({ mesgNum: MESG.ACTIVITY, ...activity });

  return encoder.close();
}

/** Exposed for tests and the reader: epoch ms of a FIT-quantized timestamp. */
export function quantizeTime(ms: number): number {
  return fitSecondsToEpochMs(epochMsToFitSeconds(ms));
}
