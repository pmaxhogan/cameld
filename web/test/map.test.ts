import { describe, expect, it, vi } from "vitest";

const ctor = vi.fn();
const handlers = new Map<string, () => void>();
const addSource = vi.fn();
const addLayer = vi.fn();
const fitBounds = vi.fn();
const layers = new Set<string>();
const getLayer = vi.fn((id: string) => (layers.has(id) ? { id } : undefined));
const setLayoutProperty = vi.fn();

vi.mock("maplibre-gl", () => ({
  Map: class {
    constructor(options: unknown) {
      ctor(options);
    }
    on(event: string, handler: () => void): void {
      handlers.set(event, handler);
    }
    addSource = addSource;
    addLayer = addLayer;
    fitBounds = fitBounds;
    getLayer = getLayer;
    setLayoutProperty = setLayoutProperty;
  },
}));

const { BLANK_STYLE, applyHidden, boundsOf, createTrackMap, lineFeature, styleFor } =
  await import("../src/map.ts");

const line = (coordinates: [number, number][]) => ({ label: "x", coordinates, points: 0 });

describe("map helpers", () => {
  it("computes bounds over every line", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([null, line([])])).toBeNull();
    expect(
      boundsOf([
        line([
          [0.5, 0.5],
          [0.6, 0.4],
        ]),
        null,
        line([[0.45, 0.55]]),
      ]),
    ).toEqual([
      [0.45, 0.4],
      [0.6, 0.55],
    ]);
  });

  it("builds a GeoJSON line feature", () => {
    expect(lineFeature(line([[1, 2]]))).toEqual({
      type: "Feature",
      properties: { label: "x" },
      geometry: { type: "LineString", coordinates: [[1, 2]] },
    });
  });

  it("uses the configured style or a blank one", () => {
    expect(styleFor(null)).toBe(BLANK_STYLE);
    expect(styleFor("https://tiles.example/style.json")).toBe("https://tiles.example/style.json");
  });

  it("draws lines once the style loads and fits the view", () => {
    const container = document.createElement("div");
    createTrackMap(container, null, [
      { id: "app", line: line([[0.5, 0.5]]), color: "#00f", dashed: false },
      { id: "merged", line: line([[0.6, 0.6]]), color: "#0f0", dashed: true },
      { id: "empty", line: line([]), color: "#f00", dashed: false },
      { id: "none", line: null, color: "#f00", dashed: false },
    ]);
    expect(ctor).toHaveBeenCalledWith(expect.objectContaining({ container, style: BLANK_STYLE }));
    handlers.get("load")!();
    expect(addSource).toHaveBeenCalledTimes(2);
    expect(addLayer.mock.calls[0]![0].paint).not.toHaveProperty("line-dasharray");
    expect(addLayer.mock.calls[1]![0].paint["line-dasharray"]).toEqual([2, 2]);
    expect(fitBounds).toHaveBeenCalledWith(
      [
        [0.5, 0.5],
        [0.6, 0.6],
      ],
      { padding: 24, animate: false },
    );
  });

  it("hides the chosen lines once drawn and skips layers not drawn yet", () => {
    setLayoutProperty.mockClear();
    const lines = [
      { id: "app", line: line([[0.5, 0.5]]), color: "#00f", dashed: false },
      { id: "merged", line: line([[0.6, 0.6]]), color: "#0f0", dashed: true },
    ];
    createTrackMap(document.createElement("div"), null, lines, () => ["merged"]);
    layers.add("app");
    layers.add("merged");
    handlers.get("load")!();
    expect(setLayoutProperty.mock.calls).toEqual([
      ["app", "visibility", "visible"],
      ["merged", "visibility", "none"],
    ]);
    setLayoutProperty.mockClear();
    layers.delete("merged");
    applyHidden({ getLayer, setLayoutProperty } as never, lines, ["app"]);
    expect(setLayoutProperty.mock.calls).toEqual([["app", "visibility", "none"]]);
    layers.clear();
  });

  it("skips fitting when there is nothing to show", () => {
    fitBounds.mockClear();
    createTrackMap(document.createElement("div"), "https://tiles.example/s.json", []);
    handlers.get("load")!();
    expect(fitBounds).not.toHaveBeenCalled();
  });
});
