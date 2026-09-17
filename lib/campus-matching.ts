import { distanceKm, formatDistance, type Coordinate } from "@/lib/campus-location";
import type { CampusCorridor, CampusRide, CampusZone } from "@/lib/campus-ride";

export type CampusRideMatch = CampusRide & { corridor?: CampusCorridor; pickupZone?: CampusZone; destinationZone?: CampusZone; score:number; distanceLabel:string; fare:number; estimatedMinutes:number; pickupDistanceKm:number };

function coordinateFromNumbers(latitude?: number | null, longitude?: number | null): Coordinate | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude: Number(latitude), longitude: Number(longitude) };
}

function coordinateFromZone(zone?: CampusZone): Coordinate | null {
  if (!zone || !Number.isFinite(zone.latitude) || !Number.isFinite(zone.longitude)) return null;
  return { latitude: Number(zone.latitude), longitude: Number(zone.longitude) };
}

export function findNearestCampusRides(params: { pickupZoneId?: string; destinationZoneId?: string; pickupLatitude?: number; pickupLongitude?: number; zones: CampusZone[]; corridors: CampusCorridor[]; rides: CampusRide[]; limit?: number }) {
  const pickupZone = params.zones.find((zone) => zone.id === params.pickupZoneId);
  const destinationZone = params.zones.find((zone) => zone.id === params.destinationZoneId);
  const passengerCoordinate = coordinateFromNumbers(params.pickupLatitude, params.pickupLongitude);
  const pickupCoordinate = passengerCoordinate || coordinateFromZone(pickupZone);
  const zoneById = new Map(params.zones.map((zone) => [zone.id, zone]));
  const corridorById = new Map(params.corridors.map((corridor) => [corridor.id, corridor]));

  return params.rides
    .filter((ride) => ride.acceptingQueue && ride.availableSlots > 0 && ride.status === "OPEN")
    .map((ride) => {
      const corridor = corridorById.get(ride.corridorId);
      const rideZone = zoneById.get(ride.currentZoneId);
      const rideCoordinate = coordinateFromNumbers(ride.currentLatitude, ride.currentLongitude) || coordinateFromZone(rideZone);
      const exactPickup = !pickupZone || ride.currentZoneId === pickupZone.id || corridor?.originZoneId === pickupZone.id;
      const exactDestination = !destinationZone || corridor?.destinationZoneId === destinationZone.id;
      const km = distanceKm(pickupCoordinate, rideCoordinate);
      const score = (exactPickup || passengerCoordinate ? 0 : 100) + (exactDestination ? 0 : 200) + (Number.isFinite(km) ? km : 50) - Math.min(ride.availableSlots, 8);
      return { ...ride, corridor, pickupZone: rideZone, destinationZone: corridor ? zoneById.get(corridor.destinationZoneId) : undefined, score, distanceLabel: formatDistance(km), pickupDistanceKm: km, fare: corridor?.fare || 0, estimatedMinutes: corridor?.estimatedMinutes || 0 };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, params.limit || 5);
}
