"use client";

import type { CampusRideMatch } from "@/lib/campus-matching";
import { RideMatchCard } from "./RideMatchCard";

export function RideMatchList({ matches, pickupZoneId, destinationZoneId, pickupLatitude, pickupLongitude, selectedRideId, onSelect }: { matches: CampusRideMatch[]; pickupZoneId: string; destinationZoneId: string; pickupLatitude?: number; pickupLongitude?: number; selectedRideId: string; onSelect: (rideId: string) => void }) {
  if (!matches.length) return <p className="campus-empty">No ride is accepting this route right now. Try another pickup or destination.</p>;

  return <div className="ride-match-options" role="list" aria-label="Available campus rides">
    {matches.map((match) => <RideMatchCard
      key={match.id}
      match={match}
      pickupZoneId={pickupZoneId}
      destinationZoneId={destinationZoneId}
      pickupLatitude={pickupLatitude}
      pickupLongitude={pickupLongitude}
      selected={selectedRideId === match.id}
      onSelect={() => onSelect(match.id)}
    />)}
  </div>;
}
