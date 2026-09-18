"use client";

import { useState } from "react";
import type { CampusRideMatch } from "@/lib/campus-matching";
import type { CampusCorridor, CampusZone } from "@/lib/campus-ride";
import { CampusAiAssistant } from "@/components/campusRide/shared/CampusAiAssistant";
import { CampusMap } from "@/components/campusRide/shared/CampusMap";
import { NearestRideFinder } from "./NearestRideFinder";
import { RideMatchList } from "./RideMatchList";

export function CampusRideResults({ zones, corridors, matches, pickupZoneId, destinationZoneId, pickupLatitude, pickupLongitude, selectedPickup, selectedDestination }: { zones: CampusZone[]; corridors: CampusCorridor[]; matches: CampusRideMatch[]; pickupZoneId: string; destinationZoneId: string; pickupLatitude?: number; pickupLongitude?: number; selectedPickup: string; selectedDestination: string }) {
  const [selectedRideId, setSelectedRideId] = useState(matches[0]?.id || "");
  return <section className="campus-two-column">
    <div>
      <NearestRideFinder zones={zones} corridors={corridors} />
      <div className="ride-match-list">
        <h2>Nearest rides</h2>
        <RideMatchList matches={matches} pickupZoneId={pickupZoneId} destinationZoneId={destinationZoneId} pickupLatitude={pickupLatitude} pickupLongitude={pickupLongitude} selectedRideId={selectedRideId} onSelect={setSelectedRideId}/>
      </div>
    </div>
    <div>
      <CampusMap zones={zones} corridors={corridors} matches={matches} selectedRideId={selectedRideId} title={`${selectedPickup} → ${selectedDestination}`} />
      <CampusAiAssistant area="student" context={`Pickup: ${selectedPickup}\nDestination: ${selectedDestination}\nMatches: ${matches.length}`} />
    </div>
  </section>;
}
