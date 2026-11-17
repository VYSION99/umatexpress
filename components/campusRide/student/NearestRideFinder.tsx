"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Crosshair, MapPin } from "@/components/ui/MaterialIcon";
import type { CampusCorridor, CampusZone } from "@/lib/campus-ride";
import { formatDistance, type Coordinate } from "@/lib/campus-location";
import { nearestCampusPickupZone } from "@/lib/campus-zones";

export function NearestRideFinder({ zones, corridors, initialPickupZoneId, initialDestinationZoneId, autoDetectPickup, onLocation, onDetectedPickup, onRoutePendingChange }: { zones: CampusZone[]; corridors: CampusCorridor[]; initialPickupZoneId: string; initialDestinationZoneId: string; autoDetectPickup: boolean; onLocation: (coordinate: Coordinate | null) => void; onDetectedPickup: (zoneName: string) => void; onRoutePendingChange: (pending: boolean) => void }) {
  const [pickupZoneId, setPickupZoneId] = useState(initialPickupZoneId);
  const [destinationZoneId, setDestinationZoneId] = useState(initialDestinationZoneId);
  const [locationStatus, setLocationStatus] = useState("");
  const [locating, setLocating] = useState(false);
  const selectedRoute = useRef({ pickupZoneId: initialPickupZoneId, destinationZoneId: initialDestinationZoneId });
  const manualChoice = useRef(false);
  const autoDetectionAttempted = useRef(false);
  const mounted = useRef(true);
  const routeChanged = pickupZoneId !== initialPickupZoneId || destinationZoneId !== initialDestinationZoneId;
  const pickups = useMemo(() => {
    const origins = new Set(corridors.map((corridor) => corridor.originZoneId));
    return zones.filter((zone) => origins.has(zone.id));
  }, [corridors, zones]);
  const destinations = useMemo(() => {
    const allowed = corridors.filter((corridor) => corridor.originZoneId === pickupZoneId).map((corridor) => corridor.destinationZoneId);
    return zones.filter((zone) => allowed.includes(zone.id));
  }, [corridors, pickupZoneId, zones]);
  const selectedCorridor = corridors.find((corridor) => corridor.originZoneId === pickupZoneId && corridor.destinationZoneId === destinationZoneId);

  const changePickup = (id: string) => {
    const previousDestination = selectedRoute.current.destinationZoneId;
    const nextDestination = corridors.find((item) => item.originZoneId === id && item.destinationZoneId === previousDestination)?.destinationZoneId
      || corridors.find((item) => item.originZoneId === id)?.destinationZoneId || "";
    manualChoice.current = true;
    selectedRoute.current = { pickupZoneId: id, destinationZoneId: nextDestination };
    setPickupZoneId(id);
    setDestinationZoneId(nextDestination);
    onRoutePendingChange(id !== initialPickupZoneId || nextDestination !== initialDestinationZoneId);
    setLocationStatus("");
    onDetectedPickup("");
    onLocation(null);
  };

  const detectPickup = useCallback((mode: "automatic" | "manual") => {
    if (!navigator.geolocation) {
      if (mode === "manual") setLocationStatus("Location is unavailable. Choose a pickup zone manually.");
      return;
    }
    if (mode === "manual") {
      manualChoice.current = false;
      setLocating(true);
      setLocationStatus("Finding the nearest campus pickup zone…");
    }
    navigator.geolocation.getCurrentPosition((position) => {
      if (!mounted.current) return;
      setLocating(false);
      if (manualChoice.current) return;
      const coordinate = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      const closest = nearestCampusPickupZone({ coordinate, zones, corridors, destinationZoneId: selectedRoute.current.destinationZoneId });
      if (!closest) {
        setLocationStatus("No mapped pickup zone is available. Choose one manually.");
        return;
      }
      const previousDestination = selectedRoute.current.destinationZoneId;
      selectedRoute.current = { pickupZoneId: closest.zone.id, destinationZoneId: closest.destinationZoneId };
      setPickupZoneId(closest.zone.id);
      setDestinationZoneId(closest.destinationZoneId);
      onRoutePendingChange(closest.zone.id !== initialPickupZoneId || closest.destinationZoneId !== initialDestinationZoneId);
      onDetectedPickup(closest.zone.name);
      onLocation(closest.zone.id === initialPickupZoneId && closest.destinationZoneId === initialDestinationZoneId ? coordinate : null);
      const destinationChanged = previousDestination !== closest.destinationZoneId;
      const accuracyNote = position.coords.accuracy > 200 ? " Location is approximate; confirm the meeting point." : " Confirm the meeting point before continuing.";
      setLocationStatus(`Closest mapped pickup: ${closest.zone.name} (${formatDistance(closest.distanceKm)}).${destinationChanged ? " Destination was updated for this route." : ""}${accuracyNote}`);
    }, (error) => {
      if (!mounted.current) return;
      setLocating(false);
      if (manualChoice.current) return;
      if (mode === "manual") setLocationStatus(error.code === 1 ? "Location access was not granted. Choose a pickup zone manually." : error.code === 3 ? "Location timed out. Try again or choose a pickup zone manually." : "Could not read your location. Choose a pickup zone manually.");
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }, [corridors, initialDestinationZoneId, initialPickupZoneId, onDetectedPickup, onLocation, onRoutePendingChange, zones]);

  const keepCurrentRoute = () => {
    manualChoice.current = true;
    selectedRoute.current = { pickupZoneId: initialPickupZoneId, destinationZoneId: initialDestinationZoneId };
    setPickupZoneId(initialPickupZoneId);
    setDestinationZoneId(initialDestinationZoneId);
    setLocationStatus("");
    onDetectedPickup("");
    onRoutePendingChange(false);
    onLocation(null);
  };

  useEffect(() => {
    mounted.current = true;
    if (autoDetectPickup && !autoDetectionAttempted.current && navigator.permissions?.query && navigator.geolocation) {
      autoDetectionAttempted.current = true;
      navigator.permissions.query({ name: "geolocation" }).then((permission) => {
        if (mounted.current && permission.state === "granted") detectPickup("automatic");
      }).catch(() => { /* The manual control remains available. */ });
    }
    return () => { mounted.current = false; };
  }, [autoDetectPickup, detectPickup]);

  return <form className="nearest-ride-finder" action="/campus#campus-rides" aria-labelledby="campus-route-search-title">
    <div className="nearest-ride-intro"><span>ROUTE SEARCH</span><h2 id="campus-route-search-title">Where are you going?</h2><p>Choose a campus pickup point and a destination served from there.</p></div>
    <div className="nearest-ride-fields">
      <label className="campus-route-field"><span><MapPin size={15} aria-hidden /> From · pickup zone</span><select name="pickupZoneId" value={pickupZoneId} onChange={(event)=>changePickup(event.target.value)} disabled={!pickups.length} required>{!pickups.length && <option value="">No campus routes available</option>}{pickups.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}{zone.landmark ? ` · ${zone.landmark}` : ""}</option>)}</select></label>
      <label className="campus-route-field"><span><MapPin size={15} aria-hidden /> To · destination</span><select name="destinationZoneId" value={destinationZoneId} onChange={(event)=>{ manualChoice.current = true; selectedRoute.current = { pickupZoneId, destinationZoneId: event.target.value }; setDestinationZoneId(event.target.value); onRoutePendingChange(pickupZoneId !== initialPickupZoneId || event.target.value !== initialDestinationZoneId); setLocationStatus(""); onDetectedPickup(""); onLocation(null); }} disabled={!destinations.length} required>{!destinations.length && <option value="">No routes from this pickup</option>}{destinations.map((zone)=><option key={zone.id} value={zone.id}>{zone.name}{zone.landmark ? ` · ${zone.landmark}` : ""}</option>)}</select></label>
    </div>
    {selectedCorridor && <div className="campus-route-preview" aria-live="polite"><strong>{selectedCorridor.name}</strong><span>GH₵ {(Math.max(0, Number(selectedCorridor.fare) || 0) / 100).toFixed(2)} flat fare</span><span><Clock size={14} aria-hidden /> {selectedCorridor.estimatedMinutes || "—"} min</span></div>}
    <div className="nearest-ride-actions">
      <button type="submit" disabled={!destinationZoneId}>Show matching rides</button>
      <button type="button" className="nearest-location-button" onClick={() => detectPickup("manual")} disabled={!pickups.length || locating}><Crosshair size={17}/>{locating ? "Finding pickup…" : "Detect nearest pickup"}</button>
    </div>
    {routeChanged && !locationStatus && <small className="nearest-location-status">Review the route, then show matching rides.</small>}
    {locationStatus && <small className="nearest-location-status" role="status">{locationStatus}</small>}
    {routeChanged && <button type="button" className="nearest-keep-route" onClick={keepCurrentRoute}>Keep current route</button>}
  </form>;
}
