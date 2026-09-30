import { describe, expect, it } from "vitest";
import {
  type ActivityMetadata,
  isStravaDefaultTitle,
  mergeDescriptions,
  mergeMetadata,
  stripWandrerBlock,
} from "../src/metadata/merge.ts";

function meta(over: Partial<ActivityMetadata> = {}): ActivityMetadata {
  return {
    name: null,
    description: null,
    sportType: null,
    gearId: null,
    commute: null,
    trainer: null,
    ...over,
  };
}

describe("isStravaDefaultTitle", () => {
  it.each([
    "Morning Run",
    "afternoon ride",
    "Evening Walk",
    "Night Hike",
    "Lunch Ride",
    "Morning Mountain Bike Ride",
    "  Evening   Trail Run ",
    "Morning Weight Training",
    "",
    "   ",
    "Morgendlicher Lauf",
    "Abendlicher Spaziergang",
    "Mittagslauf",
    "Course à pied le matin",
    "Sortie vélo en soirée",
    "Carrera por la mañana",
    "Paseo en bicicleta por la tarde",
    "Corsa mattutina",
    "Giro in bici serale",
    "Corrida matinal",
    "Pedalada da tarde",
    "Ochtendrit",
    "Avondloop",
  ])("treats %j as a default", (name) => {
    expect(isStravaDefaultTitle(name)).toBe(true);
  });

  it("treats null and undefined as default", () => {
    expect(isStravaDefaultTitle(null)).toBe(true);
    expect(isStravaDefaultTitle(undefined)).toBe(true);
  });

  it.each([
    "Morning coffee ride",
    "Hill repeats",
    "Morning Run with friends",
    "Lunch",
    "Run",
    "Tour of the fictional valley",
    "Corsa di prova",
  ])("treats %j as custom", (name) => {
    expect(isStravaDefaultTitle(name)).toBe(false);
  });
});

describe("stripWandrerBlock", () => {
  it("removes a stats block with a footer and surrounding blank lines", () => {
    const text = "Nice loop.\n\n4.2 new miles - 12 new streets\n-- From Wandrer\n\nBring lights.";
    expect(stripWandrerBlock(text)).toBe("Nice loop.\n\nBring lights.");
  });

  it("removes a description that is only a Wandrer block", () => {
    expect(stripWandrerBlock("3.1 new miles\n-- From Wandrer")).toBe("");
  });

  it("removes a bare footer and a trailing url", () => {
    expect(stripWandrerBlock("Text\n\nFrom Wandrer")).toBe("Text");
    expect(stripWandrerBlock("Text\n\nFrom Wandrer\nwandrer.earth/x")).toBe("Text");
  });

  it("keeps user text in the same paragraph as the block", () => {
    expect(stripWandrerBlock("Great day\n5 new miles\n-- From Wandrer")).toBe("Great day");
  });

  it("does not eat unrelated lines above the footer", () => {
    expect(stripWandrerBlock("Windy\nno numbers here\n-- From Wandrer")).toBe(
      "Windy\nno numbers here",
    );
  });

  it("removes several blocks and normalizes CRLF", () => {
    const text = "A\r\n\r\n1 new mile\r\nFrom Wandrer\r\n\r\nB\r\n\r\n2 new miles\r\nFrom Wandrer";
    expect(stripWandrerBlock(text)).toBe("A\n\nB");
  });

  it("leaves text without a block untouched (apart from trim)", () => {
    expect(stripWandrerBlock("  2 new miles of trail\n\nfun  ")).toBe(
      "2 new miles of trail\n\nfun",
    );
  });

  it("removes a block at the start", () => {
    expect(stripWandrerBlock("1 new mile\nFrom Wandrer\n\nAfter")).toBe("After");
  });
});

describe("mergeDescriptions", () => {
  it("returns the only present description", () => {
    expect(mergeDescriptions(null, "b")).toBe("b");
    expect(mergeDescriptions("a", null)).toBe("a");
    expect(mergeDescriptions("  ", "b")).toBe("b");
    expect(mergeDescriptions(null, null)).toBeNull();
  });

  it("does not duplicate identical or contained text", () => {
    expect(mergeDescriptions("Same  text", "same text")).toBe("Same  text");
    expect(mergeDescriptions("Long text here", "text")).toBe("Long text here");
    expect(mergeDescriptions("text", "Long text here")).toBe("Long text here");
  });

  it("keeps both unique texts, app first, and strips Wandrer blocks", () => {
    expect(mergeDescriptions("App\n\n1 new mile\nFrom Wandrer", "Other")).toBe("App\n\nOther");
  });

  it("is empty-safe when a description is only a Wandrer block", () => {
    expect(mergeDescriptions("2 new miles\nFrom Wandrer", null)).toBeNull();
  });
});

describe("mergeMetadata", () => {
  it("custom title beats default in either direction", () => {
    expect(mergeMetadata(meta({ name: "Evening Run" }), meta({ name: "Trail day" })).name).toBe(
      "Trail day",
    );
    const r = mergeMetadata(meta({ name: "Trail day" }), meta({ name: "Evening Run" }));
    expect(r.name).toBe("Trail day");
    expect(r.conflicts).toEqual([]);
  });

  it("both custom: app wins and other title goes in the description", () => {
    const r = mergeMetadata(
      meta({ name: "Phone title", description: "Notes" }),
      meta({ name: "Wrist title" }),
    );
    expect(r.name).toBe("Phone title");
    expect(r.description).toBe("Notes\n\nAlso recorded as: Wrist title");
    expect(r.conflicts).toEqual([
      { field: "name", kept: "Phone title", dropped: "Wrist title", keptFrom: "app" },
    ]);
  });

  it("both custom with no description creates one; equal titles do not", () => {
    expect(mergeMetadata(meta({ name: "A" }), meta({ name: "B" })).description).toBe(
      "Also recorded as: B",
    );
    const same = mergeMetadata(meta({ name: "Same" }), meta({ name: " same " }));
    expect(same.description).toBeNull();
    expect(same.conflicts).toEqual([]);
  });

  it("both default or missing: app wins, falling back to other", () => {
    expect(mergeMetadata(meta({ name: "Morning Run" }), meta({ name: "Lunch Run" })).name).toBe(
      "Morning Run",
    );
    expect(mergeMetadata(meta({ name: null }), meta({ name: "Lunch Run" })).name).toBe("Lunch Run");
    expect(mergeMetadata(meta(), meta()).name).toBeNull();
  });

  it("fills gaps and records conflicts for gear and sport type", () => {
    const filled = mergeMetadata(meta(), meta({ gearId: "g1", sportType: "Run" }));
    expect(filled.gearId).toBe("g1");
    expect(filled.sportType).toBe("Run");
    expect(filled.conflicts).toEqual([]);

    const same = mergeMetadata(meta({ gearId: "g1" }), meta({ gearId: "g1" }));
    expect(same.conflicts).toEqual([]);

    const clash = mergeMetadata(
      meta({ gearId: "g1", sportType: "Run" }),
      meta({ gearId: "g2", sportType: "TrailRun" }),
    );
    expect(clash.gearId).toBe("g1");
    expect(clash.sportType).toBe("Run");
    expect(clash.conflicts).toEqual([
      { field: "sportType", kept: "Run", dropped: "TrailRun", keptFrom: "app" },
      { field: "gearId", kept: "g1", dropped: "g2", keptFrom: "app" },
    ]);

    const noOther = mergeMetadata(meta({ gearId: "g1" }), meta());
    expect(noOther.gearId).toBe("g1");
    expect(noOther.conflicts).toEqual([]);
  });

  it("flags: a set flag survives, disagreements are recorded", () => {
    expect(mergeMetadata(meta(), meta({ commute: true })).commute).toBe(true);
    expect(mergeMetadata(meta({ trainer: false }), meta()).trainer).toBe(false);
    expect(mergeMetadata(meta({ commute: true }), meta({ commute: true })).conflicts).toEqual([]);

    const appTrue = mergeMetadata(meta({ commute: true }), meta({ commute: false }));
    expect(appTrue.commute).toBe(true);
    expect(appTrue.conflicts).toEqual([
      { field: "commute", kept: true, dropped: false, keptFrom: "app" },
    ]);

    const otherTrue = mergeMetadata(meta({ trainer: false }), meta({ trainer: true }));
    expect(otherTrue.trainer).toBe(true);
    expect(otherTrue.conflicts).toEqual([
      { field: "trainer", kept: true, dropped: false, keptFrom: "other" },
    ]);
  });
});
