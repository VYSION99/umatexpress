"use client";

import { useEffect, useRef, useState } from "react";
import { Crosshair } from "@phosphor-icons/react";
import { CAMPUS_REFERENCE } from "@/lib/hostel-engine/geo";
import { googleMapsLocationLink, googlePoint } from "@/lib/google-maps";
import { MapStatus } from "@/components/maps/MapStatus";
import { useGoogleMap } from "@/components/maps/useGoogleMap";

const OPTIONS: google.maps.MapOptions = {
  center: googlePoint(CAMPUS_REFERENCE.longitude, CAMPUS_REFERENCE.latitude),
  zoom: 14,
  restriction: { latLngBounds: { south: 5.0, north: 5.6, west: -2.4, east: -1.6 }, strictBounds: false },
};

function propertyPoint(latitude: string, longitude: string) {
  if (!latitude.trim() || !longitude.trim()) return null;
  const lat = Number(latitude), lng = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 5.0 && lat <= 5.6 && lng >= -2.4 && lng <= -1.6 ? { lat, lng } : null;
}

export function HostelLocationPicker({ latitude, longitude, onChange }: { latitude: string; longitude: string; onChange: (latitude: string, longitude: string) => void }) {
  const container = useRef<HTMLDivElement | null>(null);
  const marker = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const latest = useRef(onChange);
  const active = useRef(true);
  const { instance, loading, error: mapError, disabled, retry } = useGoogleMap(container, OPTIONS);
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState("");
  const selected = propertyPoint(latitude, longitude);
  useEffect(() => { latest.current = onChange; }, [onChange]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  function useMyLocation() {
    setError(""); setLocationNotice("");
    if (!navigator.geolocation) {
      setError("This browser cannot access device location. Search for the address or enter coordinates manually.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(position => {
      if (!active.current) return;
      setLocating(false);
      const point = propertyPoint(String(position.coords.latitude), String(position.coords.longitude));
      if (!point) {
        setError("Your current location is outside the Hostel Finder service area. Search for the property address or enter its coordinates manually.");
        return;
      }
      latest.current(point.lat.toFixed(6), point.lng.toFixed(6));
      setLocationNotice("Location captured. Confirm it marks the building entrance, then adjust it if needed.");
    }, cause => {
      if (!active.current) return;
      setLocating(false);
      setError(cause.code === cause.PERMISSION_DENIED
        ? "Location access was denied. Search for the property address or enter coordinates manually."
        : cause.code === cause.TIMEOUT
          ? "Getting your location took too long. Try again or enter the address or coordinates manually."
          : "Your device could not determine its location. Try again or enter the address or coordinates manually.");
    }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
  }

  useEffect(() => {
    if (!instance) return;
    const pin = new instance.marker.AdvancedMarkerElement({ map: instance.map, gmpDraggable: true, title: "Property entrance. Drag to adjust." });
    marker.current = pin;
    const update = (latitude: number, longitude: number) => {
      const point = propertyPoint(String(latitude), String(longitude));
      if (!point) { setError("Choose a location within the Hostel Finder service area."); return; }
      setError(""); setLocationNotice("");
      latest.current(point.lat.toFixed(6), point.lng.toFixed(6));
    };
    const click = instance.map.addListener("click", (event: google.maps.MapMouseEvent) => {
      if (event.latLng) update(event.latLng.lat(), event.latLng.lng());
    });
    const drag = () => {
      const position = pin.position;
      if (position) update(typeof position.lat === "function" ? position.lat() : position.lat, typeof position.lng === "function" ? position.lng() : position.lng);
    };
    pin.addEventListener("gmp-dragend", drag);
    return () => { click.remove(); pin.removeEventListener("gmp-dragend", drag); pin.map = null; marker.current = null; };
  }, [instance]);

  useEffect(() => {
    if (!instance || !marker.current) return;
    const point = propertyPoint(latitude, longitude);
    marker.current.position = point;
    if (point) {
      instance.map.setCenter(point);
      instance.map.setZoom(Math.max(instance.map.getZoom() || 14, 16));
    }
  }, [instance, latitude, longitude]);

  return <div className="hostel-location-picker">
    <p>{disabled
      ? "If you are at the property, use your device location to set the entrance. Otherwise search for the address or enter coordinates manually below."
      : "If you are at the property, use your device location to set the entrance. Otherwise search for the address, tap the map, or enter coordinates manually below."}</p>
    <div className="hostel-location-actions">
      <button type="button" className="console-secondary" onClick={useMyLocation} disabled={locating}>
        <Crosshair size={15} aria-hidden />{locating ? "Getting location…" : "Use my location"}
      </button>
      <span>Allow location access when your browser asks. {disabled ? "You can still adjust the coordinates below." : "You can still adjust the pin on the map."}</span>
    </div>
    <div className={`campus-map-frame${disabled ? " is-map-disabled" : ""}`}>
      <div ref={container} className="hostel-location-map google-map-canvas" role="region" aria-label="Select hostel location on Google Maps" />
      <MapStatus disabled={disabled} loading={loading} error={mapError} onRetry={retry} />
    </div>
    {mapError && <p>You can still use your device location or enter the coordinates below.</p>}
    {selected && <p><a href={googleMapsLocationLink(selected.lat, selected.lng)} target="_blank" rel="noreferrer">View selected location in Google Maps</a></p>}
    {error && <p role="alert">{error}</p>}
    {locationNotice && <p role="status">{locationNotice}</p>}
  </div>;
}
