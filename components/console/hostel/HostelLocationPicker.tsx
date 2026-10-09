"use client";

import { useEffect, useRef, useState } from "react";
import { Crosshair } from "@/components/ui/MaterialIcon";
import type { Marker } from "leaflet";
import { CAMPUS_REFERENCE } from "@/lib/hostel-engine/geo";
import { mapPoint, osmLocationLink } from "@/lib/osm-maps";
import { MapStatus } from "@/components/maps/MapStatus";
import { useOsmMap } from "@/components/maps/useOsmMap";

const OPTIONS: { center: { lat: number; lng: number }; zoom: number } = {
  center: mapPoint(CAMPUS_REFERENCE.longitude, CAMPUS_REFERENCE.latitude),
  zoom: 14,
};

function propertyPoint(latitude: string, longitude: string) {
  if (!latitude.trim() || !longitude.trim()) return null;
  const lat = Number(latitude), lng = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 5.0 && lat <= 5.6 && lng >= -2.4 && lng <= -1.6 ? { lat, lng } : null;
}

export function HostelLocationPicker({ latitude, longitude, onChange }: { latitude: string; longitude: string; onChange: (latitude: string, longitude: string) => void }) {
  const container = useRef<HTMLDivElement | null>(null);
  const marker = useRef<Marker | null>(null);
  const latest = useRef(onChange);
  const active = useRef(true);
  const { instance, loading, error: mapError, disabled, retry } = useOsmMap(container, OPTIONS);
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
    if (!instance || instance.disposed) return;
    const pin = instance.L.marker([CAMPUS_REFERENCE.latitude, CAMPUS_REFERENCE.longitude], {
      draggable: true,
      icon: instance.L.divIcon({ className: "osm-property-pin", html: '<span aria-hidden="true"></span>', iconSize: [32, 40], iconAnchor: [16, 39] }),
    });
    marker.current = pin;
    const update = (nextLatitude: number, nextLongitude: number) => {
      const point = propertyPoint(String(nextLatitude), String(nextLongitude));
      if (!point) { setError("Choose a location within the Hostel Finder service area."); return; }
      setError(""); setLocationNotice("");
      latest.current(point.lat.toFixed(6), point.lng.toFixed(6));
    };
    const tap = (event: { latlng: { lat: number; lng: number } }) => update(event.latlng.lat, event.latlng.lng);
    const dragEnd = () => {
      const point = pin.getLatLng();
      update(point.lat, point.lng);
    };
    instance.map.on("click", tap);
    pin.on("dragend", dragEnd);
    return () => {
      if (!instance.disposed) { instance.map.off("click", tap); pin.off("dragend", dragEnd); pin.remove(); }
      marker.current = null;
    };
  }, [instance]);

  useEffect(() => {
    if (!instance || instance.disposed || !marker.current) return;
    const pin = marker.current;
    const point = propertyPoint(latitude, longitude);
    if (point) {
      pin.setLatLng([point.lat, point.lng]);
      if (!instance.map.hasLayer(pin)) pin.addTo(instance.map);
      instance.map.setView([point.lat, point.lng], Math.max(instance.map.getZoom(), 16));
    } else if (instance.map.hasLayer(pin)) pin.remove();
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
      <div ref={container} className="hostel-location-map osm-map-canvas" role="region" aria-label="Select hostel location on OpenStreetMap" />
      <MapStatus disabled={disabled} loading={loading} error={mapError} onRetry={retry} />
    </div>
    {mapError && <p>You can still use your device location or enter the coordinates below.</p>}
    {selected && <p><a href={osmLocationLink(selected.lat, selected.lng)} target="_blank" rel="noreferrer">View selected location in OpenStreetMap</a></p>}
    {error && <p role="alert">{error}</p>}
    {locationNotice && <p role="status">{locationNotice}</p>}
  </div>;
}
