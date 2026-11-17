import { distanceKm, formatDistance, type Coordinate } from "@/lib/campus-location";
import type { CampusCorridor, CampusRide, CampusZone } from "@/lib/campus-ride";
import { hasCampusZoneCoordinates } from "@/lib/campus-zones";

export type CampusRideMatch = CampusRide & { corridor?: CampusCorridor; pickupZone?: CampusZone; destinationZone?: CampusZone; score:number; distanceLabel:string; fare:number; estimatedMinutes:number; pickupDistanceKm:number };

function coordinateFromNumbers(latitude?: number | null, longitude?: number | null): Coordinate | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude: Number(latitude), longitude: Number(longitude) };
}

function coordinateFromZone(zone?: CampusZone): Coordinate | null {
  if (!zone || !Number.isFinite(zone.latitude) || !Number.isFinite(zone.longitude)) return null;
  return { latitude: Number(zone.latitude), longitude: Number(zone.longitude) };
}

export function bookableCampusRidesForRoute(params: { rides: CampusRide[]; corridors: CampusCorridor[]; pickupZoneId?: string; destinationZoneId?: string }) {
  const corridorById = new Map(params.corridors.map((corridor) => [corridor.id, corridor]));
  return params.rides.filter((ride) => {
    const corridor = corridorById.get(ride.corridorId);
    return ride.acceptingQueue && ride.availableSlots > 0 && ride.status === "OPEN"
      && Boolean(corridor)
      && (!params.pickupZoneId || corridor?.originZoneId === params.pickupZoneId)
      && (!params.destinationZoneId || corridor?.destinationZoneId === params.destinationZoneId);
  });
}

export function findNearestCampusRides(params: { pickupZoneId?: string; destinationZoneId?: string; pickupLatitude?: number; pickupLongitude?: number; zones: CampusZone[]; corridors: CampusCorridor[]; rides: CampusRide[]; limit?: number }) {
  const usableZones = params.zones.filter(hasCampusZoneCoordinates);
  const zoneById = new Map(usableZones.map((zone) => [zone.id, zone]));
  if ((params.pickupZoneId && !zoneById.has(params.pickupZoneId)) || (params.destinationZoneId && !zoneById.has(params.destinationZoneId))) return [];
  const corridors = params.corridors.filter((corridor) => corridor.active && zoneById.has(corridor.originZoneId) && zoneById.has(corridor.destinationZoneId));
  const pickupZone = zoneById.get(params.pickupZoneId || "");
  const passengerCoordinate = coordinateFromNumbers(params.pickupLatitude, params.pickupLongitude);
  const pickupCoordinate = passengerCoordinate || coordinateFromZone(pickupZone);
  const corridorById = new Map(corridors.map((corridor) => [corridor.id, corridor]));

  return bookableCampusRidesForRoute({ ...params, corridors })
    .map((ride) => {
      const corridor = corridorById.get(ride.corridorId);
      const rideZone = zoneById.get(ride.currentZoneId);
      const rideCoordinate = coordinateFromNumbers(ride.currentLatitude, ride.currentLongitude) || coordinateFromZone(rideZone);
      const km = distanceKm(pickupCoordinate, rideCoordinate);
      const score = (Number.isFinite(km) ? km : 50) - Math.min(ride.availableSlots, 8);
      return { ...ride, corridor, pickupZone: rideZone, destinationZone: corridor ? zoneById.get(corridor.destinationZoneId) : undefined, score, distanceLabel: formatDistance(km), pickupDistanceKm: km, fare: corridor?.fare || 0, estimatedMinutes: corridor?.estimatedMinutes || 0 };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, params.limit || 5);
}
