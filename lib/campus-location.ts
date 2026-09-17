export type Coordinate = { latitude: number; longitude: number };

export function distanceKm(a?: Coordinate | null, b?: Coordinate | null) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const radiusKm = 6371;
  const toRad = (value: number) => value * Math.PI / 180;
  const deltaLat = toRad(b.latitude - a.latitude);
  const deltaLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function formatDistance(km: number) {
  if (!Number.isFinite(km)) return "Zone match";
  // Zero distance means the ride is already in the pickup zone. Rounding that to
  // "1 m away" reads as a bug to riders, so name the case instead.
  if (km <= 0.05) return "In this zone";
  if (km < 1) return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m away`;
  return `${km.toFixed(km < 10 ? 1 : 0)} km away`;
}

