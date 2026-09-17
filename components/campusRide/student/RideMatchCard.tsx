"use client";

import type { CampusRideMatch } from "@/lib/campus-matching";
import { QueueJoinCard } from "@/components/campusRide/student/QueueJoinCard";
import { Check, Clock3, Users } from "lucide-react";

export function RideMatchCard({ match, pickupZoneId, destinationZoneId, pickupLatitude, pickupLongitude, selected, onSelect }: { match: CampusRideMatch; pickupZoneId: string; destinationZoneId: string; pickupLatitude?: number; pickupLongitude?: number; selected: boolean; onSelect: () => void }) {
  const titleId = `ride-${match.id}-title`;
  return <article className={`ride-match-card${selected ? " is-selected" : ""}`} aria-labelledby={titleId}>
    <div><span>{match.distanceLabel}</span><strong id={titleId}>{match.corridor?.name || "Campus ride"}</strong></div>
    <p>{match.vehicleLabel} {match.plateNumber ? `· ${match.plateNumber}` : ""}</p>
    <ul>
      <li>{match.driverName}</li>
      <li><Users size={14}/>{match.availableSlots} queue slots</li>
      <li><Clock3 size={14}/>{match.estimatedMinutes || "—"} min</li>
      <li>GH₵ {(match.fare / 100).toFixed(2)}</li>
    </ul>
    {!selected ? <button type="button" className="ride-select-control" onClick={onSelect}>Select this ride</button> : <div className="ride-selected-actions"><span><Check size={16}/> Selected ride</span><QueueJoinCard match={match} pickupZoneId={pickupZoneId} destinationZoneId={destinationZoneId} pickupLatitude={pickupLatitude} pickupLongitude={pickupLongitude} /></div>}
  </article>;
}
