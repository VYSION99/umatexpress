"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CampusRideMatch } from "@/lib/campus-matching";
import { findNearestCampusRides } from "@/lib/campus-matching";
import type { CampusCorridor, CampusRide, CampusZone } from "@/lib/campus-ride";
import type { Coordinate } from "@/lib/campus-location";
import { CampusAiAssistant } from "@/components/campusRide/shared/CampusAiAssistant";
import { CampusMap } from "@/components/campusRide/shared/CampusMap";
import { NearestRideFinder } from "./NearestRideFinder";
import { RideMatchList } from "./RideMatchList";

export function CampusRideResults({ zones, corridors, rides, initialMatches, pickupZoneId, destinationZoneId, requestedRideId, autoDetectPickup, selectedPickup, selectedDestination }: { zones: CampusZone[]; corridors: CampusCorridor[]; rides: CampusRide[]; initialMatches: CampusRideMatch[]; pickupZoneId: string; destinationZoneId: string; requestedRideId: string; autoDetectPickup: boolean; selectedPickup: string; selectedDestination: string }) {
  const [location, setLocation] = useState<Coordinate | null>(null);
  const [detectedPickup, setDetectedPickup] = useState("");
  const [routePending, setRoutePending] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const routeSearchRef = useRef<HTMLDetailsElement>(null);
  const [selectedRideId, setSelectedRideId] = useState(() => requestedRideId ? initialMatches.some((match) => match.id === requestedRideId) ? requestedRideId : "" : initialMatches[0]?.id || "");
  const matches = useMemo(() => location
    ? findNearestCampusRides({ zones, corridors, rides, pickupZoneId, destinationZoneId, pickupLatitude: location.latitude, pickupLongitude: location.longitude, limit: rides.length || 1 })
    : initialMatches, [location, zones, corridors, rides, pickupZoneId, destinationZoneId, initialMatches]);
  const activeRideId = matches.some((match) => match.id === selectedRideId) ? selectedRideId : requestedRideId ? "" : matches[0]?.id || "";

  useEffect(() => {
    // Clear links created by the old GPS flow without sending the coordinates again.
    const url = new URL(window.location.href);
    if (url.searchParams.has("pickupLatitude") || url.searchParams.has("pickupLongitude")) {
      url.searchParams.delete("pickupLatitude");
      url.searchParams.delete("pickupLongitude");
      window.history.replaceState(window.history.state, "", url);
    }
    if (url.hash !== "#campus-rides") return;
    const frame = window.requestAnimationFrame(() => document.getElementById("campus-rides")?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [pickupZoneId, destinationZoneId]);

  const openRouteSearch = () => {
    if (routeSearchRef.current) {
      routeSearchRef.current.open = true;
      routeSearchRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };

  return <section className="campus-two-column">
    <div>
      <details id="campus-find" className="campus-route-search" ref={routeSearchRef}>
        <summary>{detectedPickup ? `Suggested pickup: ${detectedPickup} · Review route` : "Detect pickup or change route"}</summary>
        <NearestRideFinder key={`${pickupZoneId}:${destinationZoneId}`} zones={zones} corridors={corridors} initialPickupZoneId={pickupZoneId} initialDestinationZoneId={destinationZoneId} autoDetectPickup={autoDetectPickup} onLocation={setLocation} onDetectedPickup={setDetectedPickup} onRoutePendingChange={setRoutePending} />
      </details>
      <div id="campus-rides" className="ride-match-list" aria-labelledby="campus-rides-title">
        <div className="campus-rides-heading"><div><span>STEP 2 · CHOOSE A RIDE</span><h2 id="campus-rides-title">{selectedPickup} → {selectedDestination}</h2><p>{matches.length ? `${matches.length} ${matches.length === 1 ? "ride" : "rides"} with queue places for this route` : "No queue places for this route right now"}</p>{location && <p className="campus-location-note">Distance estimates use your location. Pickup remains {selectedPickup}.</p>}{detectedPickup && detectedPickup !== selectedPickup && <p role="status" className="campus-location-note">Closest mapped pickup is {detectedPickup}. Review the route before choosing a ride.</p>}{requestedRideId && !matches.some((match) => match.id === requestedRideId) && !activeRideId && <p role="status" className="campus-location-note">Your previous ride is no longer available. Select another ride to continue.</p>}</div><button type="button" onClick={openRouteSearch}>Change route</button></div>
        {routePending ? <div className="campus-empty" role="status"><p>Pickup or destination changed. Review the route above, then show matching rides to continue.</p></div> : <RideMatchList matches={matches} pickupZoneId={pickupZoneId} destinationZoneId={destinationZoneId} selectedRideId={activeRideId} onSelect={setSelectedRideId}/>}
      </div>
    </div>
    <div className="campus-extra-tools">
      <button type="button" aria-expanded={mapOpen} aria-controls="campus-route-map" onClick={() => setMapOpen((current) => !current)}>{mapOpen ? "Hide route map" : "View route map"}</button>
      <div id="campus-route-map" hidden={!mapOpen}>{mapOpen && <CampusMap zones={zones} corridors={corridors} matches={matches} selectedRideId={activeRideId} title={`${selectedPickup} → ${selectedDestination}`} showLegend={false} />}</div>
      <button type="button" aria-expanded={helpOpen} aria-controls="campus-ride-help" onClick={() => setHelpOpen((current) => !current)}>{helpOpen ? "Hide ride helper" : "Ask ride helper"}</button>
      <div id="campus-ride-help" hidden={!helpOpen}>{helpOpen && <CampusAiAssistant area="student" context={`Pickup: ${selectedPickup}\nDestination: ${selectedDestination}\nMatches: ${matches.length}`} />}</div>
    </div>
  </section>;
}
