"use client";

import { useEffect, useRef, useState } from "react";
import { Crosshair } from "@phosphor-icons/react";
import { CAMPUS_REFERENCE } from "@/lib/hostel-engine/geo";
import { hereLocationLink, herePoint, type HereMarker, type MapEvent } from "@/lib/here-maps";
import { MapStatus } from "@/components/maps/MapStatus";
import { useHereMap } from "@/components/maps/useHereMap";

const OPTIONS: { center: { lat: number; lng: number }; zoom: number } = {
  center: herePoint(CAMPUS_REFERENCE.longitude, CAMPUS_REFERENCE.latitude),
  zoom: 14,
};

function propertyPoint(latitude: string, longitude: string) {
  if (!latitude.trim() || !longitude.trim()) return null;
  const lat = Number(latitude), lng = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 5.0 && lat <= 5.6 && lng >= -2.4 && lng <= -1.6 ? { lat, lng } : null;
}

export function HostelLocationPicker({ latitude, longitude, onChange }: { latitude: string; longitude: string; onChange: (latitude: string, longitude: string) => void }) {
  const container = useRef<HTMLDivElement | null>(null);
  const marker = useRef<HereMarker | null>(null);
  const markerVisible = useRef(false);
  const latest = useRef(onChange);
  const active = useRef(true);
  const { instance, loading, error: mapError, disabled, retry } = useHereMap(container, OPTIONS);
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
    const pin = new instance.api.map.Marker({ lat: CAMPUS_REFERENCE.latitude, lng: CAMPUS_REFERENCE.longitude });
    pin.draggable = true;
    marker.current = pin;
    const update = (latitude: number, longitude: number) => {
      const point = propertyPoint(String(latitude), String(longitude));
      if (!point) { setError("Choose a location within the Hostel Finder service area."); return; }
      setError(""); setLocationNotice("");
      latest.current(point.lat.toFixed(6), point.lng.toFixed(6));
    };
    const tap = (event: MapEvent) => {
      if (event.target !== instance.map || !event.currentPointer) return;
      const point = instance.map.screenToGeo(event.currentPointer.viewportX, event.currentPointer.viewportY);
      update(point.lat, point.lng);
    };
    let offset: { x: number; y: number } | null = null;
    const dragStart = (event: MapEvent) => {
      if (event.target !== pin || !event.currentPointer) return;
      instance.behavior.disable(instance.api.mapevents.Behavior.Feature.PANNING);
      const screen = instance.map.geoToScreen(pin.getGeometry());
      offset = { x: event.currentPointer.viewportX - screen.x, y: event.currentPointer.viewportY - screen.y };
    };
    const drag = (event: MapEvent) => {
      if (event.target !== pin || !event.currentPointer || !offset) return;
      pin.setGeometry(instance.map.screenToGeo(event.currentPointer.viewportX - offset.x, event.currentPointer.viewportY - offset.y));
    };
    const dragEnd = (event: MapEvent) => {
      if (event.target !== pin) return;
      instance.behavior.enable(instance.api.mapevents.Behavior.Feature.PANNING);
      offset = null;
      const point = pin.getGeometry();
      update(point.lat, point.lng);
    };
    instance.map.addEventListener("tap", tap);
    instance.map.addEventListener("dragstart", dragStart);
    instance.map.addEventListener("drag", drag);
    instance.map.addEventListener("dragend", dragEnd);
    return () => {
      instance.map.removeEventListener("tap", tap);
      instance.map.removeEventListener("dragstart", dragStart);
      instance.map.removeEventListener("drag", drag);
      instance.map.removeEventListener("dragend", dragEnd);
      if (markerVisible.current) instance.map.removeObject(pin);
      markerVisible.current = false;
      marker.current = null;
    };
  }, [instance]);

  useEffect(() => {
    if (!instance || !marker.current) return;
    const point = propertyPoint(latitude, longitude);
    if (point) marker.current.setGeometry(point);
    if (point && !markerVisible.current) { instance.map.addObject(marker.current); markerVisible.current = true; }
    if (!point && markerVisible.current) { instance.map.removeObject(marker.current); markerVisible.current = false; }
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
      <div ref={container} className="hostel-location-map here-map-canvas" role="region" aria-label="Select hostel location on HERE Maps" />
      <MapStatus disabled={disabled} loading={loading} error={mapError} onRetry={retry} />
    </div>
    {mapError && <p>You can still use your device location or enter the coordinates below.</p>}
    {selected && <p><a href={hereLocationLink(selected.lat, selected.lng)} target="_blank" rel="noreferrer">View selected location in HERE Maps</a></p>}
    {error && <p role="alert">{error}</p>}
    {locationNotice && <p role="status">{locationNotice}</p>}
  </div>;
}
