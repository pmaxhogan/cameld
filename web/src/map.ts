import type { LngLat, TrackLine } from "@cameld/shared";
import { Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";

/** Blank style: no tiles, no network. Used when MAP_STYLE_URL is not configured. */
export const BLANK_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] };

export function styleFor(styleUrl: string | null): string | StyleSpecification {
  return styleUrl ?? BLANK_STYLE;
}

/** One line to draw: the track, its colour, and whether it is a dashed preview. */
export interface MapLine {
  id: string;
  line: TrackLine | null;
  color: string;
  dashed: boolean;
}

export const APP_COLOR = "#2563eb";
export const FITBIT_COLOR = "#ea580c";
export const MERGED_COLOR = "#16a34a";

export type Bounds = [LngLat, LngLat];

/** [[minLng, minLat], [maxLng, maxLat]] over every coordinate, or null when there are none. */
export function boundsOf(lines: readonly (TrackLine | null)[]): Bounds | null {
  let bounds: Bounds | null = null;
  for (const line of lines) {
    for (const [lng, lat] of line?.coordinates ?? []) {
      if (bounds === null) {
        bounds = [
          [lng, lat],
          [lng, lat],
        ];
        continue;
      }
      bounds = [
        [Math.min(bounds[0][0], lng), Math.min(bounds[0][1], lat)],
        [Math.max(bounds[1][0], lng), Math.max(bounds[1][1], lat)],
      ];
    }
  }
  return bounds;
}

export interface LineFeature {
  type: "Feature";
  properties: { label: string };
  geometry: { type: "LineString"; coordinates: LngLat[] };
}

/** A GeoJSON LineString feature for one track. */
export function lineFeature(line: TrackLine): LineFeature {
  return {
    type: "Feature",
    properties: { label: line.label },
    geometry: { type: "LineString", coordinates: line.coordinates },
  };
}

/** Adds every non-empty line as a source plus a line layer, then fits the view. */
export function drawLines(map: MapLibreMap, lines: readonly MapLine[]): void {
  for (const entry of lines) {
    if (entry.line === null || entry.line.coordinates.length === 0) continue;
    map.addSource(entry.id, { type: "geojson", data: lineFeature(entry.line) });
    map.addLayer({
      id: entry.id,
      type: "line",
      source: entry.id,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": entry.color,
        "line-width": 3,
        ...(entry.dashed ? { "line-dasharray": [2, 2] } : {}),
      },
    });
  }
  const bounds = boundsOf(lines.map((entry) => entry.line));
  if (bounds !== null) map.fitBounds(bounds, { padding: 24, animate: false });
}

/**
 * Shows or hides each drawn line layer. Layers only exist once the style has
 * loaded, so ids without a layer yet are skipped (the load handler applies
 * the current choice when it draws).
 */
export function applyHidden(
  map: Pick<MapLibreMap, "getLayer" | "setLayoutProperty">,
  lines: readonly MapLine[],
  hidden: readonly string[],
): void {
  for (const entry of lines) {
    if (map.getLayer(entry.id) === undefined) continue;
    map.setLayoutProperty(entry.id, "visibility", hidden.includes(entry.id) ? "none" : "visible");
  }
}

/**
 * Builds a map in `container` and draws `lines` once the style has loaded,
 * hiding the ids `hidden()` returns at that moment.
 */
export function createTrackMap(
  container: HTMLElement,
  styleUrl: string | null,
  lines: readonly MapLine[],
  hidden: () => readonly string[] = () => [],
): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: styleFor(styleUrl),
    center: [0, 0],
    zoom: 1,
    attributionControl: false,
  });
  map.on("load", () => {
    drawLines(map, lines);
    applyHidden(map, lines, hidden());
  });
  return map;
}
