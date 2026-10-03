"use client";

import { useEffect, useRef, useState } from "react";
import { Crosshair } from "@phosphor-icons/react";
import type { CircleMarker } from "leaflet";
import type { OsmMapInstance } from "@/lib/osm-maps";

export function MapLocateButton({ instance }: { instance: OsmMapInstance | null }) {
  const pin = useRef<CircleMarker | null>(null);
  const request = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    queueMicrotask(() => setBusy(false));
    return () => {
      request.current += 1;
      if (pin.current && instance && !instance.disposed) instance.map.removeLayer(pin.current);
      pin.current = null;
    };
  }, [instance]);

  function locate() {
    if (!instance) return;
    setError("");
    if (!navigator.geolocation) { setError("Location is unavailable on this device."); return; }
    const id = ++request.current;
    setBusy(true);
    navigator.geolocation.getCurrentPosition(position => {
      if (request.current !== id || instance.disposed) return;
      setBusy(false);
      const point: [number, number] = [position.coords.latitude, position.coords.longitude];
      if (!pin.current) pin.current = instance.L.circleMarker(point, { radius: 8, color: "#fff", weight: 3, fillColor: "#0d694d", fillOpacity: 1 }).addTo(instance.map);
      else pin.current.setLatLng(point);
      instance.map.setView(point, 16);
    }, () => {
      if (request.current !== id || instance.disposed) return;
      setBusy(false);
      setError("Location could not be accessed. You can still browse the map.");
    }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 });
  }

  return <div className="here-map-location-action">
    <button type="button" disabled={!instance || busy} onClick={locate}><Crosshair size={16} aria-hidden />{busy ? "Finding you…" : "My location"}</button>
    {error && <span role="status">{error}</span>}
  </div>;
}
