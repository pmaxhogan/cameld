import { describe, expect, it } from "vitest";
import type { ActivitySample } from "../src/activity/sample.ts";
import { readGpxActivity } from "../src/readers/gpx.ts";
import { readTcxActivity } from "../src/readers/tcx.ts";
import { ActivityReadError } from "../src/readers/xml.ts";
import { SYNTHETIC_START, syntheticTrack } from "./fixtures/synthetic-track.ts";
import { toGpx, toTcx } from "./fixtures/xml.ts";

const opts = { source: "phone" };

/** Readers never invent data: GPX has no distance, so the expected samples drop it. */
function withoutDistance(samples: ActivitySample[]): ActivitySample[] {
  return samples.map(({ distance: _distance, ...rest }) => ({ ...rest }));
}

describe("readGpxActivity", () => {
  it("reads every point of every segment exactly, with extension channels", () => {
    const samples = syntheticTrack({ count: 50, source: "phone" });
    const parsed = readGpxActivity(toGpx(samples, { type: "running", segments: 3 }), opts);
    expect(parsed.format).toBe("gpx");
    expect(parsed.sport).toBe("running");
    expect(parsed.startTime).toBe(SYNTHETIC_START);
    expect(parsed.samples).toEqual(withoutDistance(samples));
  });

  it("accepts any namespace prefix on the TrackPointExtension", () => {
    const samples = syntheticTrack({ count: 3, source: "phone" });
    const parsed = readGpxActivity(toGpx(samples, { extensionPrefix: "ns3" }), opts);
    expect(parsed.samples).toEqual(withoutDistance(samples));
    expect(parsed.sport).toBeUndefined();
  });

  it("keeps points without optional channels", () => {
    const xml = toGpx([{ time: SYNTHETIC_START, source: "phone", lat: 0.5, lng: 0.5 }]);
    expect(readGpxActivity(xml, opts).samples).toEqual([
      { time: SYNTHETIC_START, source: "phone", lat: 0.5, lng: 0.5 },
    ]);
  });

  it("reads text of elements that carry attributes", () => {
    const xml = `<gpx><trk><trkseg><trkpt lat="0.5" lon="0.5"><ele unit="m">7.5</ele><time>2020-02-02T02:02:02Z</time></trkpt></trkseg></trk></gpx>`;
    expect(readGpxActivity(xml, opts).samples[0]?.altitude).toBe(7.5);
  });

  it("uses metadata time when there are no track points", () => {
    const xml = `<gpx><metadata><time>2020-02-02T02:02:02Z</time></metadata></gpx>`;
    expect(readGpxActivity(xml, opts)).toEqual({
      format: "gpx",
      sport: undefined,
      startTime: SYNTHETIC_START,
      samples: [],
    });
  });

  it.each([
    ["malformed XML", "<gpx><trk></gpx>", /malformed XML/],
    ["a non-GPX root", "<kml></kml>", /not a GPX document/],
    [
      "a point without time",
      `<gpx><trk><trkseg><trkpt lat="0.5" lon="0.5"/></trkseg></trk></gpx>`,
      /has no time/,
    ],
    [
      "a point without lon",
      `<gpx><trk><trkseg><trkpt lat="0.5"><time>2020-02-02T02:02:02Z</time></trkpt></trkseg></trk></gpx>`,
      /both lat and lon/,
    ],
    [
      "a non-numeric elevation",
      `<gpx><trk><trkseg><trkpt lat="0.5" lon="0.5"><ele>high</ele><time>2020-02-02T02:02:02Z</time></trkpt></trkseg></trk></gpx>`,
      /ele "high" is not a number/,
    ],
    [
      "an unparseable time",
      `<gpx><trk><trkseg><trkpt lat="0.5" lon="0.5"><time>yesterday</time></trkpt></trkseg></trk></gpx>`,
      /time "yesterday" is not a timestamp/,
    ],
  ])("refuses %s", (_label, xml, message) => {
    expect(() => readGpxActivity(xml, opts)).toThrow(ActivityReadError);
    expect(() => readGpxActivity(xml, opts)).toThrow(message);
  });
});

describe("readTcxActivity", () => {
  it("reads every trackpoint of every lap exactly, including distance and speed", () => {
    const samples = syntheticTrack({ count: 40, source: "phone" });
    const parsed = readTcxActivity(toTcx(samples, { sport: "Biking", laps: 4 }), opts);
    expect(parsed.format).toBe("tcx");
    expect(parsed.sport).toBe("Biking");
    expect(parsed.startTime).toBe(SYNTHETIC_START);
    expect(parsed.samples).toEqual(samples);
  });

  it("reads run cadence from the TPX extension and keeps position-less points", () => {
    const samples = syntheticTrack({ count: 10, gpsGap: [2, 5], source: "phone" });
    const parsed = readTcxActivity(toTcx(samples, { runCadence: true }), opts);
    expect(parsed.samples).toEqual(samples);
    expect(parsed.samples[3]).not.toHaveProperty("lat");
  });

  it("keeps a trackpoint that has nothing but a time", () => {
    const xml = toTcx([{ time: SYNTHETIC_START, source: "phone" }]);
    expect(readTcxActivity(xml, opts).samples).toEqual([
      { time: SYNTHETIC_START, source: "phone" },
    ]);
  });

  it("reads an activity-less document as empty", () => {
    const xml = `<TrainingCenterDatabase><Activities/></TrainingCenterDatabase>`;
    expect(readTcxActivity(xml, opts)).toEqual({
      format: "tcx",
      sport: undefined,
      startTime: undefined,
      samples: [],
    });
  });

  it("falls back to the first trackpoint when the activity has no Id", () => {
    const xml = toTcx(syntheticTrack({ count: 2 })).replace(/<Id>.*<\/Id>/, "");
    expect(readTcxActivity(xml, opts).startTime).toBe(SYNTHETIC_START);
  });

  const point = (inner: string): string =>
    `<TrainingCenterDatabase><Activities><Activity Sport="Other"><Lap><Track><Trackpoint>${inner}</Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>`;

  it.each([
    ["malformed XML", "<TrainingCenterDatabase>", /malformed XML/],
    ["a non-TCX root", "<gpx></gpx>", /not a TCX document/],
    ["a trackpoint without Time", point("<AltitudeMeters>1</AltitudeMeters>"), /has no Time/],
    [
      "half a position",
      point(
        "<Time>2020-02-02T02:02:02Z</Time><Position><LatitudeDegrees>0.5</LatitudeDegrees></Position>",
      ),
      /both latitude and longitude/,
    ],
    [
      "a non-numeric heart rate",
      point("<Time>2020-02-02T02:02:02Z</Time><HeartRateBpm><Value>x</Value></HeartRateBpm>"),
      /Value "x" is not a number/,
    ],
  ])("refuses %s", (_label, xml, message) => {
    expect(() => readTcxActivity(xml, opts)).toThrow(ActivityReadError);
    expect(() => readTcxActivity(xml, opts)).toThrow(message);
  });
});
