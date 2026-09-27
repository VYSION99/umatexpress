"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { WalkingDestination, WalkingRoute } from "@/lib/hostel-engine/walking";
import { distanceLabel } from "./format";

const DEFAULT_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const envStyle = (process.env.NEXT_PUBLIC_MAP_STYLE_URL || "").trim();
const STYLE = !envStyle || envStyle === "undefined" || envStyle === "null" ? DEFAULT_STYLE : envStyle;

function RouteMap({ route }: { route: Extract<WalkingRoute, { available: true }> }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  useEffect(() => {
    let disposed = false;
    async function mount() {
      const lib = await import("maplibre-gl");
      if (disposed || !element.current) return;
      const coordinates = route.coordinates;
      const instance = new lib.Map({ container: element.current, style: STYLE, center: coordinates[0], zoom: 15, attributionControl: { compact: true } });
      map.current = instance;
      instance.on("load", () => {
        if (disposed) return;
        instance.addSource("walk", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } } });
        instance.addLayer({ id: "walk", type: "line", source: "walk", paint: { "line-color": "#106a48", "line-width": 6, "line-opacity": .9 } });
        new lib.Marker({ color: "#106a48" }).setLngLat(coordinates[0]).addTo(instance);
        new lib.Marker({ color: "#d49a25" }).setLngLat(coordinates[coordinates.length - 1]).addTo(instance);
        const bounds = coordinates.reduce((box, point) => box.extend(point), new lib.LngLatBounds(coordinates[0], coordinates[0]));
        instance.fitBounds(bounds, { padding: 42, maxZoom: 17, duration: 0 });
      });
    }
    void mount();
    return () => { disposed = true; map.current?.remove(); map.current = null; };
  }, [route]);
  return <div className="hostel-walk-map" ref={element} role="img" aria-label={`Walking route to ${route.destination.name}`} />;
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
    {route?.available && <><div className="hostel-walking-result"><strong>{route.durationMinutes} min walk</strong><span>{(route.distanceM / 1000).toFixed(1)} km along the pedestrian route to {route.destination.name}</span></div><RouteMap route={route} /></>}
  </section>;
}
