"use client";

import { useMemo, useState } from "react";
import { LocateFixed } from "lucide-react";
import type { CampusCorridor, CampusZone } from "@/lib/campus-ride";

export function NearestRideFinder({ zones, corridors }: { zones: CampusZone[]; corridors: CampusCorridor[] }) {
  const [pickupZoneId, setPickupZoneId] = useState(zones[0]?.id || "");
  const [destinationZoneId, setDestinationZoneId] = useState(corridors.find((item)=>item.originZoneId===pickupZoneId)?.destinationZoneId || zones[1]?.id || "");
  const [locationStatus, setLocationStatus] = useState("");
  const destinations = useMemo(() => {
    const allowed = corridors.filter((corridor) => corridor.originZoneId === pickupZoneId).map((corridor) => corridor.destinationZoneId);
    return zones.filter((zone) => zone.id !== pickupZoneId && (!allowed.length || allowed.includes(zone.id)));
  }, [corridors, pickupZoneId, zones]);

  const useCurrentLocation = () => {
    setLocationStatus("");
    if (!navigator.geolocation) {
      setLocationStatus("Location is not available on this device.");
      return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
      const url = new URL("/campus", window.location.origin);
      url.searchParams.set("pickupZoneId", pickupZoneId);
      url.searchParams.set("destinationZoneId", destinationZoneId);
      url.searchParams.set("pickupLatitude", String(position.coords.latitude));
      url.searchParams.set("pickupLongitude", String(position.coords.longitude));
      window.location.assign(url.toString());
    }, () => setLocationStatus("Location permission was not granted."), { enableHighAccuracy: true, timeout: 9000, maximumAge: 15000 });
  };

  return <form className="nearest-ride-finder" action="/campus">
    <div className="nearest-ride-fields">
      <label>Pickup zone<select name="pickupZoneId" value={pickupZoneId} onChange={(event)=>{ setPickupZoneId(event.target.value); setDestinationZoneId(""); }}>{zones.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
      <label>Destination<select name="destinationZoneId" value={destinationZoneId} onChange={(event)=>setDestinationZoneId(event.target.value)}>{destinations.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
    </div>
    <div className="nearest-ride-actions">
      <button type="submit">Find nearest ride</button>
      <button type="button" className="nearest-location-button" onClick={useCurrentLocation}><LocateFixed size={17}/> Use my location</button>
    </div>
    {locationStatus && <small className="nearest-location-status">{locationStatus}</small>}
  </form>;
}
