import type { CampusCorridor, CampusRide, CampusZone } from "@/lib/campus-ride";
import { distanceKm, type Coordinate } from "@/lib/campus-location";

export function hasCampusZoneCoordinates(zone: CampusZone): zone is CampusZone & { latitude: number; longitude: number } {
  return zone.active
    && typeof zone.latitude === "number"
    && typeof zone.longitude === "number"
    && Number.isFinite(zone.latitude)
    && Number.isFinite(zone.longitude)
    && Math.abs(zone.latitude) <= 90
    && Math.abs(zone.longitude) <= 180;
}

/** GPS stays on the device; this chooses the closest usable pickup point. */
export function nearestCampusPickupZone(input: {
  coordinate: Coordinate;
  zones: CampusZone[];
  corridors: CampusCorridor[];
  destinationZoneId?: string;
}) {
  if (!Number.isFinite(input.coordinate.latitude) || !Number.isFinite(input.coordinate.longitude)
    || Math.abs(input.coordinate.latitude) > 90 || Math.abs(input.coordinate.longitude) > 180) return null;
  const corridors = input.corridors.filter((corridor) => corridor.active && corridor.originZoneId !== corridor.destinationZoneId);
  const originIds = new Set(corridors.map((corridor) => corridor.originZoneId));
  const closest = input.zones
    .filter(hasCampusZoneCoordinates)
    .filter((zone) => originIds.has(zone.id))
    .map((zone) => ({ zone, distanceKm: distanceKm(input.coordinate, { latitude: zone.latitude, longitude: zone.longitude }) }))
    .sort((a, b) => a.distanceKm - b.distanceKm || a.zone.name.localeCompare(b.zone.name))[0];
  if (!closest) return null;
  const destinationZoneId = corridors.find((corridor) => corridor.originZoneId === closest.zone.id && corridor.destinationZoneId === input.destinationZoneId)?.destinationZoneId
    || corridors.find((corridor) => corridor.originZoneId === closest.zone.id)?.destinationZoneId
    || "";
  return { ...closest, destinationZoneId };
}

/** Resolve student route IDs against the active, geocoded zone directory. */
export function resolveCampusRouteSelection(input: {
  zones: CampusZone[];
  corridors: CampusCorridor[];
  rides: CampusRide[];
  pickupZoneId?: string;
  destinationZoneId?: string;
}) {
  const zones = input.zones.filter(hasCampusZoneCoordinates);
  const zoneIds = new Set(zones.map((zone) => zone.id));
  const corridors = input.corridors.filter((corridor) => corridor.active
    && corridor.originZoneId !== corridor.destinationZoneId
    && zoneIds.has(corridor.originZoneId)
    && zoneIds.has(corridor.destinationZoneId));
  const seatsByCorridor = new Map<string, number>();
  for (const ride of input.rides) {
    if (ride.status !== "OPEN" || !ride.acceptingQueue || ride.availableSlots <= 0) continue;
    seatsByCorridor.set(ride.corridorId, (seatsByCorridor.get(ride.corridorId) || 0) + ride.availableSlots);
  }
  const fallback = corridors.reduce<CampusCorridor | undefined>((best, corridor) =>
    !best || (seatsByCorridor.get(corridor.id) || 0) > (seatsByCorridor.get(best.id) || 0) ? corridor : best, undefined);
  const pickupZoneId = corridors.some((corridor) => corridor.originZoneId === input.pickupZoneId)
    ? String(input.pickupZoneId)
    : fallback?.originZoneId || zones[0]?.id || "";
  const destinationZoneId = corridors.find((corridor) => corridor.originZoneId === pickupZoneId && corridor.destinationZoneId === input.destinationZoneId)?.destinationZoneId
    || corridors.find((corridor) => corridor.originZoneId === pickupZoneId)?.destinationZoneId
    || "";
  return { zones, corridors, pickupZoneId, destinationZoneId };
}
