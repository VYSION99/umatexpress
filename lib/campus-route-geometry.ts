export type RoutePoint = { latitude: number; longitude: number };
export type LngLat = [number, number];

const EARTH_RADIUS_M = 6_371_000;
const SYNTHETIC_SEGMENTS = 6;
const DIRECT_SPEED_KPH = 18;
const MAX_BEND_DEGREES = 0.0009;
const POINT_MERGE_METERS = 12;

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

export function validRoutePoint(point: unknown): point is RoutePoint {
  const candidate = point as RoutePoint;
  return Number.isFinite(candidate?.latitude)
    && Number.isFinite(candidate?.longitude)
    && candidate.latitude >= -90
    && candidate.latitude <= 90
    && candidate.longitude >= -180
    && candidate.longitude <= 180;
}

export function metersBetween(a: RoutePoint, b: RoutePoint) {
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function polylineLengthMeters(points: LngLat[]) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [lngA, latA] = points[index - 1];
    const [lngB, latB] = points[index];
    total += metersBetween({ latitude: latA, longitude: lngA }, { latitude: latB, longitude: lngB });
  }
  return total;
}

function mergePoint(points: LngLat[], point: LngLat) {
  const last = points[points.length - 1];
  if (!last) {
    points.push(point);
    return;
  }
  const gap = metersBetween({ latitude: last[1], longitude: last[0] }, { latitude: point[1], longitude: point[0] });
  if (gap > POINT_MERGE_METERS) points.push(point);
}

/**
 * Draws a gentle arc between two points so a route reads as a path rather than a
 * ruler line. Used only when a corridor has no surveyed geometry of its own.
 */
function syntheticLine(origin: RoutePoint, destination: RoutePoint): LngLat[] {
  const spanLat = destination.latitude - origin.latitude;
  const spanLng = destination.longitude - origin.longitude;
  const span = Math.hypot(spanLat, spanLng);
  if (span === 0) return [[origin.longitude, origin.latitude]];
  const bend = Math.min(MAX_BEND_DEGREES, span * 0.08);
  // Perpendicular offset, so the arc never shortens the straight-line distance.
  const normalLat = -spanLng / span;
  const normalLng = spanLat / span;
  const points: LngLat[] = [[origin.longitude, origin.latitude]];
  for (let step = 1; step < SYNTHETIC_SEGMENTS; step += 1) {
    const t = step / SYNTHETIC_SEGMENTS;
    const offset = bend * Math.sin(Math.PI * t);
    points.push([
      origin.longitude + spanLng * t + normalLng * offset,
      origin.latitude + spanLat * t + normalLat * offset,
    ]);
  }
  points.push([destination.longitude, destination.latitude]);
  return points;
}

function nearestVertexIndex(path: LngLat[], target: RoutePoint) {
  let bestIndex = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  path.forEach(([lng, lat], index) => {
    const gap = metersBetween({ latitude: lat, longitude: lng }, target);
    if (gap < bestGap) {
      bestGap = gap;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * Trims a surveyed corridor down to the stretch the rider actually travels, so a
 * ride midway along a corridor does not draw the whole line back to its origin.
 */
export function spliceCorridorPath(path: LngLat[], origin: RoutePoint, destination: RoutePoint): LngLat[] {
  const originIndex = nearestVertexIndex(path, origin);
  const destinationIndex = nearestVertexIndex(path, destination);
  if (originIndex === destinationIndex) return syntheticLine(origin, destination);
  const forward = originIndex < destinationIndex;
  const slice = path.slice(Math.min(originIndex, destinationIndex), Math.max(originIndex, destinationIndex) + 1);
  const segment = forward ? slice : [...slice].reverse();
  const points: LngLat[] = [];
  mergePoint(points, [origin.longitude, origin.latitude]);
  segment.forEach((point) => mergePoint(points, point));
  mergePoint(points, [destination.longitude, destination.latitude]);
  return points.length >= 2 ? points : syntheticLine(origin, destination);
}

export function corridorGeometry(origin: RoutePoint, destination: RoutePoint, path?: LngLat[] | null) {
  if (path && path.length >= 2) return spliceCorridorPath(path, origin, destination);
  return syntheticLine(origin, destination);
}

/**
 * Turns geometry into the numbers the UI shows. A corridor's own estimated
 * minutes are trusted over any speed model, then scaled to the distance actually
 * travelled so a partial ride is not billed the full corridor ETA.
 */
export function routeMetrics(origin: RoutePoint, destination: RoutePoint, geometry: LngLat[], estimatedMinutes = 0) {
  const distanceMeters = Math.round(polylineLengthMeters(geometry));
  const straightMeters = metersBetween(origin, destination);
  const fullCorridorMeters = estimatedMinutes > 0
    ? Math.max(straightMeters, distanceMeters)
    : 0;
  const durationSeconds = estimatedMinutes > 0 && fullCorridorMeters > 0
    ? Math.max(60, Math.round((distanceMeters / fullCorridorMeters) * estimatedMinutes * 60))
    : Math.max(60, Math.round((distanceMeters / 1000 / DIRECT_SPEED_KPH) * 3600));
  return { distanceMeters, durationSeconds };
}
