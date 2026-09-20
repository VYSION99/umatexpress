/**
 * Where "campus" is, and how far a building sits from it.
 *
 * A student's first question about a hostel is how far they have to walk, so
 * the browse page needs one honest number. A landlord may declare the distance
 * on the property; when they have dropped a pin instead, the distance is
 * measured from the same campus landmark the map already centres on, so a
 * property is never absent from the distance filter just because nobody typed
 * the number twice.
 */

/** The administration block, the point every other campus distance is measured from. */
export const CAMPUS_REFERENCE = { latitude: 5.3018, longitude: -1.9931 } as const;

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in whole metres: enough precision for a walking decision. */
export function distanceToCampusMeters(latitude: number, longitude: number): number {
  const deltaLat = toRadians(latitude - CAMPUS_REFERENCE.latitude);
  const deltaLon = toRadians(longitude - CAMPUS_REFERENCE.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(CAMPUS_REFERENCE.latitude)) * Math.cos(toRadians(latitude)) * Math.sin(deltaLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, a))));
}

export function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
