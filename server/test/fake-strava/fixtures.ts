/**
 * Fully synthetic fixtures for the fake strava.com web server. Nothing here
 * is derived from real data: ids are made up, names and places are
 * fictional ("Quillmere" does not exist), and the GPS track sits in open
 * ocean next to 0,0 (Null Island), far from any real route.
 */

export const SYNTHETIC_ATHLETE_ID = 424242;
export const SYNTHETIC_EMAIL = "athlete@example.test";

export interface FakePhoto {
  uuid: string;
  rank: number;
  mediaType: number;
  caption: string;
}

export interface FakeActivity {
  id: number;
  exists: boolean;
  name: string;
  description: string;
  sportType: string;
  privateNote: string;
  visibility: string;
  /** "" when unset, else "1".."10". */
  perceivedExertion: string;
  preferPerceivedExertion: boolean;
  hideFromHome: boolean;
  commute: boolean;
  photos: FakePhoto[];
  original: { filename: string; contentType: string; bytes: Buffer };
  gpx: string;
  /** Test hook: once deleted, the activity URL redirects to an unrelated page. */
  redirectWhenGone?: boolean;
}

/** A short synthetic GPX track in open ocean beside Null Island. */
export function syntheticGpx(name: string, startIso: string, points = 5): string {
  const start = Date.parse(startIso);
  const trkpts = Array.from({ length: points }, (_, i) => {
    const lat = (0.001 * i).toFixed(6);
    const lon = (0.0015 * i).toFixed(6);
    const time = new Date(start + i * 10_000).toISOString();
    return `      <trkpt lat="${lat}" lon="${lon}"><ele>${(2 + i * 0.5).toFixed(1)}</ele><time>${time}</time></trkpt>`;
  }).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="cameld synthetic fixture" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <trk><name>${name}</name><trkseg>`,
    trkpts,
    "  </trkseg></trk>",
    "</gpx>",
    "",
  ].join("\n");
}

/** A 14-byte FIT file header with no records: enough to look like a FIT upload. */
export const SYNTHETIC_FIT_HEADER = Buffer.from([
  0x0e, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2e, 0x46, 0x49, 0x54, 0x00, 0x00,
]);

/** A 1x1 transparent PNG. */
export const SYNTHETIC_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export const RUN_ID = 7000001;
export const RIDE_ID = 7000002;

export function syntheticActivities(): FakeActivity[] {
  const runGpx = syntheticGpx("Quillmere Canal Run", "2030-04-01T06:00:00Z");
  return [
    {
      id: RUN_ID,
      exists: true,
      name: "Quillmere Canal Run",
      description: "Synthetic test activity.\nSecond line.",
      sportType: "Run",
      privateNote: "synthetic note",
      visibility: "everyone",
      perceivedExertion: "4",
      preferPerceivedExertion: true,
      hideFromHome: true,
      commute: false,
      photos: [{ uuid: "synthetic-photo-0001", rank: 1, mediaType: 1, caption: "Synthetic" }],
      original: {
        filename: "quillmere-canal-run.gpx",
        contentType: "application/octet-stream",
        bytes: Buffer.from(runGpx, "utf8"),
      },
      gpx: runGpx,
    },
    {
      id: RIDE_ID,
      exists: true,
      name: "Evening Ride",
      description: "",
      sportType: "Ride",
      privateNote: "",
      visibility: "followers_only",
      perceivedExertion: "",
      preferPerceivedExertion: false,
      hideFromHome: false,
      commute: true,
      photos: [],
      original: {
        filename: "evening-ride.fit",
        contentType: "application/octet-stream",
        bytes: SYNTHETIC_FIT_HEADER,
      },
      gpx: syntheticGpx("Evening Ride", "2030-04-02T18:00:00Z"),
    },
  ];
}
