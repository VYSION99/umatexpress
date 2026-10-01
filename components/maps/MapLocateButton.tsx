"use client";

import { useEffect, useRef, useState } from "react";
import { Crosshair } from "@phosphor-icons/react";
import type { HereMapInstance } from "@/lib/here-maps";

export function MapLocateButton({ instance }: { instance: HereMapInstance | null }) {
  const pin = useRef<import("@/lib/here-maps").HereMarker | null>(null);
  const request = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    queueMicrotask(() => setBusy(false));
    return () => {
      request.current += 1;
      if (pin.current && instance) instance.map.removeObject(pin.current);
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
      if (request.current !== id) return;
      setBusy(false);
      const point = { lat: position.coords.latitude, lng: position.coords.longitude };
      if (!pin.current) { pin.current = new instance.api.map.Marker(point); instance.map.addObject(pin.current); }
      else pin.current.setGeometry(point);
      instance.map.setCenter(point);
      instance.map.setZoom(16);
    }, () => {
      if (request.current !== id) return;
      setBusy(false);
      setError("Location could not be accessed. You can still browse the map.");
    }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 });
  }

  return <div className="here-map-location-action">
    <button type="button" disabled={!instance || busy} onClick={locate}><Crosshair size={16} aria-hidden />{busy ? "Finding you…" : "My location"}</button>
    {error && <span role="status">{error}</span>}
  </div>;
}
