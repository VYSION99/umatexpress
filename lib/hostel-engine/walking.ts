import { CampusEngineError } from "@/lib/campus-engine/errors";
import { demoCampusZones, type CampusZone } from "@/lib/campus-ride";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { envValue } from "@/lib/runtime-env";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

export type WalkingDestination = { id: string; name: string; latitude: number; longitude: number };
export type WalkingRoute = { available: true; destination: WalkingDestination; distanceM: number; durationMinutes: number; coordinates: Array<[number, number]>; source: "openrouteservice" } | { available: false; reason: string };
function validPoint(latitude: number, longitude: number) { return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= 5.2 && latitude <= 5.4 && longitude >= -2.1 && longitude <= -1.9; }
function destination(zone: Pick<CampusZone, "id" | "name" | "latitude" | "longitude">): WalkingDestination | null {
  const latitude = Number(zone.latitude), longitude = Number(zone.longitude);
  return validPoint(latitude, longitude) ? { id: zone.id, name: zone.name, latitude, longitude } : null;
}
export async function listWalkingDestinations(): Promise<WalkingDestination[]> {
  if (!(await isTursoConfiguredRuntime())) return demoCampusZones.map(destination).filter((item): item is WalkingDestination => Boolean(item)).slice(0, 8);
  const rows = rowsToObjects(await turso("SELECT id,name,latitude,longitude FROM campus_zones WHERE active=1 AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY name LIMIT 8"));
  return rows.map(row => destination({ id: String(row.id), name: String(row.name), latitude: Number(row.latitude), longitude: Number(row.longitude) })).filter((item): item is WalkingDestination => Boolean(item));
}

/** No walking time is estimated from straight-line distance. The routing graph supplies both. */
export async function getHostelWalkingRoute(propertyId: string, destinationId: string): Promise<WalkingRoute> {
  if (!propertyId || propertyId.length > 80 || !destinationId || destinationId.length > 80) throw new CampusEngineError("VALIDATION_ERROR", "Choose a hostel and campus destination.", 400);
  await ensureHostelTables();
  const property = rowsToObjects(await turso(
    `SELECT p.latitude,p.longitude FROM hostel_properties p WHERE p.id=? AND COALESCE(p.status,'DRAFT')<>'SUSPENDED'
       AND EXISTS (SELECT 1 FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id
         JOIN hostel_rooms r ON r.id=s.room_id JOIN hostel_periods pe ON pe.id=l.period_id
         WHERE r.property_id=p.id AND l.status='APPROVED' AND COALESCE(pe.active,1)=1
           AND COALESCE(s.status,'AVAILABLE')='AVAILABLE' AND COALESCE(r.status,'ACTIVE')='ACTIVE') LIMIT 1`, [propertyId],
  ))[0];
  if (!property) throw new CampusEngineError("NOT_FOUND", "That hostel is no longer public.", 404);
  const latitude = Number(property.latitude), longitude = Number(property.longitude);
  if (!validPoint(latitude, longitude)) return { available: false, reason: "This hostel needs a valid location pin before a walking route can be shown." };
  const place = (await listWalkingDestinations()).find(item => item.id === destinationId);
  if (!place) throw new CampusEngineError("NOT_FOUND", "That campus destination was not found.", 404);
  const key = await envValue("OPENROUTESERVICE_API_KEY");
  if (!key) return { available: false, reason: "Pedestrian routing is not configured yet. The distance above is straight-line only." };
  try {
    const response = await fetch("https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson", {
      method: "POST", headers: { "Authorization": key, "Content-Type": "application/json", "Accept": "application/geo+json" },
      body: JSON.stringify({ coordinates: [[longitude, latitude], [place.longitude, place.latitude]] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`routing status ${response.status}`);
    const data = await response.json() as { features?: Array<{ properties?: { summary?: { distance?: number; duration?: number } }; geometry?: { coordinates?: unknown } }> };
    const feature = data.features?.[0];
    const distance = Number(feature?.properties?.summary?.distance);
    const duration = Number(feature?.properties?.summary?.duration);
    const raw = feature?.geometry?.coordinates;
    if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(duration) || duration <= 0 || !Array.isArray(raw) || raw.length < 2 || raw.length > 4000) throw new Error("Invalid pedestrian route");
    const coordinates = raw.map(point => Array.isArray(point) && point.length >= 2 ? [Number(point[0]), Number(point[1])] as [number, number] : null);
    if (coordinates.some(point => !point || !validPoint(point[1], point[0]))) throw new Error("Route left the campus area");
    return { available: true, destination: place, distanceM: Math.round(distance), durationMinutes: Math.max(1, Math.round(duration / 60)), coordinates: coordinates as Array<[number, number]>, source: "openrouteservice" };
  } catch {
    return { available: false, reason: "A pedestrian route is unavailable right now. The straight-line distance above is not a walking estimate." };
  }
}
