"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useOsmMap } from "@/components/maps/useOsmMap";
import { MapStatus } from "@/components/maps/MapStatus";
import { fitOsmMap, mapPoint, osmPolyline } from "@/lib/osm-maps";
import type { WalkingDestination, WalkingRoute } from "@/lib/hostel-engine/walking";
import { distanceLabel } from "./format";

function RouteMap({ route }: { route: Extract<WalkingRoute, { available: true }> }) {
  const element = useRef<HTMLDivElement>(null);
  const options = useMemo(() => ({ center: mapPoint(...route.coordinates[0]), zoom: 15 }), [route]);
  const { instance, loading, error, disabled, retry } = useOsmMap(element, options);
  useEffect(() => {
    if (!instance) return;
    const points = route.coordinates.map(point => mapPoint(...point));
    const path = osmPolyline(instance, points, "#106a48", 6);
    const origin = instance.L.circleMarker([points[0].lat, points[0].lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#0d694d", fillOpacity: 1 }).addTo(instance.map);
    const destination = instance.L.circleMarker([points[points.length - 1].lat, points[points.length - 1].lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#e86a32", fillOpacity: 1 }).addTo(instance.map);
    fitOsmMap(instance, points, 17);
    return () => { if (!instance.disposed) { path.remove(); origin.remove(); destination.remove(); } };
  }, [instance, route]);
  return <div className={`campus-map-frame${disabled ? " is-map-disabled" : ""}`}><div className="hostel-walk-map osm-map-canvas" ref={element} role="region" aria-label={"Walking route to " + route.destination.name} /><MapStatus disabled={disabled} loading={loading} error={error} onRetry={retry} /></div>;
}

export function HostelWalkingRoutes({ propertyId, directDistanceM, destinations }: { propertyId: string; directDistanceM: number | null; destinations: WalkingDestination[] }) {
  const [selected, setSelected] = useState("");
  const [route, setRoute] = useState<WalkingRoute | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function choose(id: string) {
    setSelected(id); setRoute(null); setError("");
    if (!id) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/hostel/walking?propertyId=${encodeURIComponent(propertyId)}&destinationId=${encodeURIComponent(id)}`, { credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Route could not load.");
      setRoute(data.route);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Route could not load."); }
    finally { setBusy(false); }
  }
  return <section className="hostel-walking" aria-label="Campus travel distances">
    <h2>Getting to campus</h2>
    <div className="hostel-walking-direct"><strong>{distanceLabel(directDistanceM)}</strong><span>Approximate straight-line distance to the campus reference point. This is not a walking route.</span></div>
    {destinations.length > 0 && <><label htmlFor="hostel-walk-destination">Walking route to</label><select id="hostel-walk-destination" value={selected} onChange={event => void choose(event.target.value)}><option value="">Choose a campus location</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></>}
    {busy && <p role="status">Finding the pedestrian route…</p>}
    {error && <p role="alert">{error}</p>}
    {route?.available === false && <p role="status">{route.reason}</p>}
    {route?.available && <><div className="hostel-walking-result"><strong>{route.durationMinutes} min walk</strong><span>{(route.distanceM / 1000).toFixed(1)} km along the pedestrian route to {route.destination.name}</span></div><RouteMap route={route} /><p className="hostel-route-source">Walking route: GraphHopper · Map: OpenStreetMap</p></>}
  </section>;
}
