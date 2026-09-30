import type { ActivitySample, ParsedActivity, ReadOptions } from "../activity/sample.ts";
import { ActivityReadError, child, listAt, numberAt, parseXml, stringAt, timeAt } from "./xml.ts";

/**
 * GPX 1.1 reader. Reads every track point of every segment of every track, in
 * file order. Heart rate, cadence and speed come from the Garmin
 * TrackPointExtension (v1 or v2, any namespace prefix). GPX has no distance
 * field, and none is derived: readers never invent data.
 */
const ARRAY_PATHS = ["gpx.trk", "gpx.trk.trkseg", "gpx.trk.trkseg.trkpt"];

function toSample(point: unknown, where: string, source: string): ActivitySample {
  const time = timeAt(point, "time", where);
  if (time === undefined) {
    throw new ActivityReadError(`${where}: track point has no time`);
  }
  const lat = numberAt(point, "@_lat", where);
  const lng = numberAt(point, "@_lon", where);
  if (lat === undefined || lng === undefined) {
    throw new ActivityReadError(`${where}: track point needs both lat and lon`);
  }
  const sample: ActivitySample = { time, source, lat, lng };
  const altitude = numberAt(point, "ele", where);
  if (altitude !== undefined) sample.altitude = altitude;
  const extension = child(child(point, "extensions"), "TrackPointExtension");
  const heartRate = numberAt(extension, "hr", where);
  if (heartRate !== undefined) sample.heartRate = heartRate;
  const cadence = numberAt(extension, "cad", where);
  if (cadence !== undefined) sample.cadence = cadence;
  const speed = numberAt(extension, "speed", where);
  if (speed !== undefined) sample.speed = speed;
  return sample;
}

/** Parse a GPX document into normalized samples. */
export function readGpxActivity(xml: string, options: ReadOptions): ParsedActivity {
  const root = child(parseXml(xml, ARRAY_PATHS), "gpx");
  if (root === undefined) {
    throw new ActivityReadError("not a GPX document (no <gpx> root)");
  }
  const samples: ActivitySample[] = [];
  let sport: string | undefined;
  listAt(root, "trk").forEach((track, t) => {
    sport ??= stringAt(track, "type");
    listAt(track, "trkseg").forEach((segment, s) => {
      listAt(segment, "trkpt").forEach((point, p) => {
        samples.push(toSample(point, `trk ${t} seg ${s} pt ${p}`, options.source));
      });
    });
  });
  const declaredStart = timeAt(child(root, "metadata"), "time", "metadata");
  return {
    format: "gpx",
    sport,
    startTime: samples[0]?.time ?? declaredStart,
    samples,
  };
}
