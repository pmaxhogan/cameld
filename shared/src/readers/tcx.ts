import type { ActivitySample, ParsedActivity, ReadOptions } from "../activity/sample.ts";
import { ActivityReadError, child, listAt, numberAt, parseXml, stringAt, timeAt } from "./xml.ts";

/**
 * TCX (Training Center Database v2) reader. Reads every trackpoint of every
 * track of every lap of every activity, in file order. Speed and run cadence
 * come from the ActivityExtension v2 TPX block. Trackpoints without a position
 * are kept (indoor sessions, GPS dropouts) with only the fields they carry.
 */
const ACTIVITY = "TrainingCenterDatabase.Activities.Activity";
const ARRAY_PATHS = [
  ACTIVITY,
  `${ACTIVITY}.Lap`,
  `${ACTIVITY}.Lap.Track`,
  `${ACTIVITY}.Lap.Track.Trackpoint`,
];

function toSample(point: unknown, where: string, source: string): ActivitySample {
  const time = timeAt(point, "Time", where);
  if (time === undefined) {
    throw new ActivityReadError(`${where}: trackpoint has no Time`);
  }
  const sample: ActivitySample = { time, source };
  const position = child(point, "Position");
  const lat = numberAt(position, "LatitudeDegrees", where);
  const lng = numberAt(position, "LongitudeDegrees", where);
  if ((lat === undefined) !== (lng === undefined)) {
    throw new ActivityReadError(`${where}: Position needs both latitude and longitude`);
  }
  if (lat !== undefined && lng !== undefined) {
    sample.lat = lat;
    sample.lng = lng;
  }
  const altitude = numberAt(point, "AltitudeMeters", where);
  if (altitude !== undefined) sample.altitude = altitude;
  const heartRate = numberAt(child(point, "HeartRateBpm"), "Value", where);
  if (heartRate !== undefined) sample.heartRate = heartRate;
  const tpx = child(child(point, "Extensions"), "TPX");
  const cadence = numberAt(point, "Cadence", where) ?? numberAt(tpx, "RunCadence", where);
  if (cadence !== undefined) sample.cadence = cadence;
  const distance = numberAt(point, "DistanceMeters", where);
  if (distance !== undefined) sample.distance = distance;
  const speed = numberAt(tpx, "Speed", where);
  if (speed !== undefined) sample.speed = speed;
  return sample;
}

/** Parse a TCX document into normalized samples. */
export function readTcxActivity(xml: string, options: ReadOptions): ParsedActivity {
  const root = child(parseXml(xml, ARRAY_PATHS), "TrainingCenterDatabase");
  if (root === undefined) {
    throw new ActivityReadError("not a TCX document (no <TrainingCenterDatabase> root)");
  }
  const activities = listAt(child(root, "Activities"), "Activity");
  const samples: ActivitySample[] = [];
  activities.forEach((activity, a) => {
    listAt(activity, "Lap").forEach((lap, l) => {
      listAt(lap, "Track").forEach((track, t) => {
        listAt(track, "Trackpoint").forEach((point, p) => {
          samples.push(
            toSample(point, `activity ${a} lap ${l} track ${t} pt ${p}`, options.source),
          );
        });
      });
    });
  });
  const first = activities[0];
  return {
    format: "tcx",
    sport: stringAt(first, "@_Sport"),
    startTime: timeAt(first, "Id", "activity 0") ?? samples[0]?.time,
    samples,
  };
}
