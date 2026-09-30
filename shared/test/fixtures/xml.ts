/**
 * SYNTHETIC GPX and TCX builders for reader tests. See README.md in this
 * directory. They serialize generated samples; they never embed real files.
 */
import type { ActivitySample } from "../../src/activity/sample.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

export interface GpxOptions {
  type?: string;
  /** Namespace prefix for the Garmin TrackPointExtension (exporters differ). */
  extensionPrefix?: string;
  /** Split the points into this many segments. */
  segments?: number;
}

export function toGpx(samples: readonly ActivitySample[], options: GpxOptions = {}): string {
  const prefix = options.extensionPrefix ?? "gpxtpx";
  const segments = options.segments ?? 1;
  const perSegment = Math.ceil(samples.length / segments);
  const point = (s: ActivitySample): string => {
    const ext: string[] = [];
    if (s.heartRate !== undefined) ext.push(`<${prefix}:hr>${s.heartRate}</${prefix}:hr>`);
    if (s.cadence !== undefined) ext.push(`<${prefix}:cad>${s.cadence}</${prefix}:cad>`);
    if (s.speed !== undefined) ext.push(`<${prefix}:speed>${s.speed}</${prefix}:speed>`);
    const extensions =
      ext.length > 0
        ? `<extensions><${prefix}:TrackPointExtension>${ext.join("")}</${prefix}:TrackPointExtension></extensions>`
        : "";
    const ele = s.altitude !== undefined ? `<ele>${s.altitude}</ele>` : "";
    return `<trkpt lat="${s.lat}" lon="${s.lng}">${ele}<time>${iso(s.time)}</time>${extensions}</trkpt>`;
  };
  const segs: string[] = [];
  for (let i = 0; i < samples.length; i += perSegment) {
    segs.push(
      `<trkseg>${samples
        .slice(i, i + perSegment)
        .map(point)
        .join("\n")}</trkseg>`,
    );
  }
  const type = options.type !== undefined ? `<type>${options.type}</type>` : "";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="cameld synthetic fixture" xmlns="http://www.topografix.com/GPX/1/1"`,
    ` xmlns:${prefix}="http://www.garmin.com/xmlschemas/TrackPointExtension/v2">`,
    `<metadata><time>${iso(samples[0]?.time ?? 0)}</time></metadata>`,
    `<trk><name>Synthetic loop</name>${type}${segs.join("")}</trk>`,
    `</gpx>`,
  ].join("\n");
}

export interface TcxOptions {
  sport?: string;
  /** Put cadence in the TPX RunCadence extension instead of <Cadence>. */
  runCadence?: boolean;
  /** Split the points into this many laps. */
  laps?: number;
}

export function toTcx(samples: readonly ActivitySample[], options: TcxOptions = {}): string {
  const laps = options.laps ?? 1;
  const perLap = Math.ceil(samples.length / laps);
  const point = (s: ActivitySample): string => {
    const parts = [`<Time>${iso(s.time)}</Time>`];
    if (s.lat !== undefined && s.lng !== undefined) {
      parts.push(
        `<Position><LatitudeDegrees>${s.lat}</LatitudeDegrees><LongitudeDegrees>${s.lng}</LongitudeDegrees></Position>`,
      );
    }
    if (s.altitude !== undefined) parts.push(`<AltitudeMeters>${s.altitude}</AltitudeMeters>`);
    if (s.distance !== undefined) parts.push(`<DistanceMeters>${s.distance}</DistanceMeters>`);
    if (s.heartRate !== undefined) {
      parts.push(`<HeartRateBpm><Value>${s.heartRate}</Value></HeartRateBpm>`);
    }
    if (s.cadence !== undefined && options.runCadence !== true) {
      parts.push(`<Cadence>${s.cadence}</Cadence>`);
    }
    const tpx: string[] = [];
    if (s.speed !== undefined) tpx.push(`<ns3:Speed>${s.speed}</ns3:Speed>`);
    if (s.cadence !== undefined && options.runCadence === true) {
      tpx.push(`<ns3:RunCadence>${s.cadence}</ns3:RunCadence>`);
    }
    if (tpx.length > 0) parts.push(`<Extensions><ns3:TPX>${tpx.join("")}</ns3:TPX></Extensions>`);
    return `<Trackpoint>${parts.join("")}</Trackpoint>`;
  };
  const lapXml: string[] = [];
  for (let i = 0; i < samples.length; i += perLap) {
    const slice = samples.slice(i, i + perLap);
    lapXml.push(
      `<Lap StartTime="${iso(slice[0]!.time)}"><TotalTimeSeconds>${slice.length}</TotalTimeSeconds>` +
        `<Track>${slice.map(point).join("\n")}</Track></Lap>`,
    );
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"`,
    ` xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">`,
    `<Activities><Activity Sport="${options.sport ?? "Running"}">`,
    `<Id>${iso(samples[0]?.time ?? 0)}</Id>`,
    lapXml.join("\n"),
    `</Activity></Activities></TrainingCenterDatabase>`,
  ].join("\n");
}
