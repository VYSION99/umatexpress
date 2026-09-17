import { getCampusData } from "@/lib/campus-ride";
import { findNearestCampusRides } from "@/lib/campus-matching";
import { CampusEngineError } from "@/lib/campus-engine/errors";

export async function matchNearestRide(input: { pickupZoneId?: string; destinationZoneId?: string; pickupLatitude?: number; pickupLongitude?: number; limit?: number }) {
  const data = await getCampusData();
  const matches = findNearestCampusRides({ ...data, pickupZoneId: input.pickupZoneId, destinationZoneId: input.destinationZoneId, pickupLatitude: input.pickupLatitude, pickupLongitude: input.pickupLongitude, limit: input.limit });
  return { ...data, matches };
}

export async function requireNearestRide(input: { pickupZoneId?: string; destinationZoneId?: string; pickupLatitude?: number; pickupLongitude?: number; limit?: number }) {
  const result = await matchNearestRide({ ...input, limit: input.limit || 1 });
  const match = result.matches[0];
  if (!match) throw new CampusEngineError("NO_DRIVER_FOUND", "No available campusRide driver was found for this route.", 404);
  return { ...result, match };
}
