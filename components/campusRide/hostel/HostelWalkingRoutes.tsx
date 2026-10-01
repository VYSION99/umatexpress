"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useHereMap } from "@/components/maps/useHereMap";
import { MapStatus } from "@/components/maps/MapStatus";
import { fitHereMap, herePoint, herePolyline } from "@/lib/here-maps";
import type { WalkingDestination, WalkingRoute } from "@/lib/hostel-engine/walking";
import { distanceLabel } from "./format";

function RouteMap({ route }: { route: Extract<WalkingRoute, { available: true }> }) {
  const element = useRef<HTMLDivElement>(null);
  const options = useMemo(() => ({ center: herePoint(...route.coordinates[0]), zoom: 15 }), [route]);
  const { instance, loading, error, disabled, retry } = useHereMap(element, options);
  useEffect(() => {
    if (!instance) return;
    const points = route.coordinates.map(point => herePoint(...point));
    const path = herePolyline(instance, points, "#106a48", 6);
    const origin = new instance.api.map.Marker(points[0]);
    const destination = new instance.api.map.Marker(points[points.length - 1]);
    instance.map.addObject(origin); instance.map.addObject(destination);
    fitHereMap(instance, points, 17);
    return () => { instance.map.removeObject(path); instance.map.removeObject(origin); instance.map.removeObject(destination); };
  }, [instance, route]);
  return <div className={`campus-map-frame${disabled ? " is-map-disabled" : ""}`}><div className="hostel-walk-map here-map-canvas" ref={element} role="region" aria-label={"Walking route to " + route.destination.name} /><MapStatus disabled={disabled} loading={loading} error={error} onRetry={retry} /></div>;
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
    {route?.available && <><div className="hostel-walking-result"><strong>{route.durationMinutes} min walk</strong><span>{(route.distanceM / 1000).toFixed(1)} km along the pedestrian route to {route.destination.name}</span></div><RouteMap route={route} /><p className="hostel-route-source">Walking route: GraphHopper · Map: HERE</p></>}
  </section>;
}
