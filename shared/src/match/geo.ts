/** Small geodesy and statistics helpers for matching and filtering. */

/** Mean Earth radius in metres (IUGG). */
const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in metres between two WGS84 points (haversine). */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Nearest-rank percentile (p in [0, 1]) of a non-empty list. p = 0.5 on an
 * even-length list averages the two middle values (the usual median).
 */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  if (p === 0.5 && sorted.length % 2 === 0) {
    const mid = sorted.length / 2;
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank]!;
}

/** Median of a non-empty list. */
export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}
