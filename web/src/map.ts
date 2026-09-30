import { Map as MapLibreMap } from "maplibre-gl";

/**
 * Placeholder map. A style with no sources renders a blank canvas, so Wave 1
 * makes no network requests for tiles. Later waves add a real basemap and the
 * side-by-side track comparison used by the review queue.
 */
export function createMap(container: HTMLElement): MapLibreMap {
  return new MapLibreMap({
    container,
    style: { version: 8, sources: {}, layers: [] },
    center: [0, 0],
    zoom: 1,
    attributionControl: false,
  });
}
