"use client";

import type { CampusRideMatch } from "@/lib/campus-matching";
import { RideMatchCard } from "./RideMatchCard";

export function RideMatchList({ matches, pickupZoneId, destinationZoneId, selectedRideId, onSelect }: { matches: CampusRideMatch[]; pickupZoneId: string; destinationZoneId: string; selectedRideId: string; onSelect: (rideId: string) => void }) {
  if (!matches.length) return <div className="campus-empty"><p>No ride is accepting this route right now. Choose another route or ask for an alert when a place opens.</p><a href="#campus-departures">Back to departures</a></div>;

  return <div className="ride-match-options" role="list" aria-label="Available campus rides">
    {matches.map((match) => <RideMatchCard
      key={match.id}
      match={match}
      pickupZoneId={pickupZoneId}
      destinationZoneId={destinationZoneId}
      selected={selectedRideId === match.id}
      onSelect={() => onSelect(match.id)}
    />)}
  </div>;
}
