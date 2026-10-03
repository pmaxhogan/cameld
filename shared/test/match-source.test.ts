import { describe, expect, it } from "vitest";
import { classifySource } from "../src/match/source.ts";

// Synthetic identifiers only: the digit strings are made up to fit the patterns.
describe("classifySource", () => {
  it("recognises a Fitbit by device name", () => {
    expect(classifySource({ deviceName: "Fitbit" })).toBe("fitbit");
    expect(classifySource({ deviceName: "Fitbit Versa 4", externalId: "x.fit" })).toBe("fitbit");
  });

  it("recognises a Fitbit by external id only when the device name is absent", () => {
    expect(classifySource({ externalId: "12345678901.tcx" })).toBe("fitbit");
    expect(classifySource({ deviceName: null, externalId: "fitbit_1234567890123456789.tcx" })).toBe(
      "fitbit",
    );
    expect(classifySource({ externalId: "stripped_health_data_abc.gpx" })).toBe("fitbit");
    expect(classifySource({ deviceName: "Bike Computer", externalId: "12345678901.tcx" })).toBe(
      "other",
    );
  });

  it("rejects external ids outside the Fitbit digit range", () => {
    expect(classifySource({ externalId: "1234567890.tcx" })).toBe("other");
    expect(classifySource({ externalId: "12345678901234567890.tcx" })).toBe("other");
    expect(classifySource({ externalId: "12345678901.gpx" })).toBe("other");
  });

  it("recognises the app by device name, including a null external id", () => {
    expect(classifySource({ deviceName: "Strava App", externalId: null })).toBe("app");
    expect(classifySource({ deviceName: "Strava App" })).toBe("app");
  });

  it("recognises the app by external id suffix whatever the device name", () => {
    expect(classifySource({ externalId: "abc-activity.fit" })).toBe("app");
    expect(classifySource({ deviceName: "Phone", externalId: "abc-activity.fit" })).toBe("app");
  });

  it("falls back to other", () => {
    expect(classifySource({})).toBe("other");
    expect(classifySource({ deviceName: "Bike Computer", externalId: "ride.fit" })).toBe("other");
    expect(classifySource({ deviceName: "strava app" })).toBe("other");
  });
});
