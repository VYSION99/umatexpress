"use client";
import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import { Crosshair } from "@phosphor-icons/react";
import { CAMPUS_REFERENCE } from "@/lib/hostel-engine/geo";
const DEFAULT_STYLE = "https://tiles.openfreemap.org/styles/positron";
export function HostelLocationPicker({ latitude, longitude, onChange }: { latitude: string; longitude: string; onChange: (latitude: string, longitude: string) => void }) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const marker = useRef<MapLibreMarker | null>(null);
  const latest = useRef(onChange);
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState("");
  useEffect(() => { latest.current = onChange; }, [onChange]);
  function useMyLocation() {
    setError("");
    setLocationNotice("");
    if (!navigator.geolocation) {
      setError("This browser cannot access device location. Search for the address or enter coordinates manually.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(position => {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      setLocating(false);
      if (latitude < 5.0 || latitude > 5.6 || longitude < -2.4 || longitude > -1.6) {
        setError("Your current location is outside the Hostel Finder service area. Search for the property address or enter its coordinates manually.");
        return;
      }
      const lat = latitude.toFixed(6);
      const lng = longitude.toFixed(6);
      latest.current(lat, lng);
      setLocationNotice("Pin set from your device. Confirm it marks the building entrance, then adjust it if needed.");
      marker.current?.setLngLat([longitude, latitude]);
      if (marker.current) marker.current.getElement().style.display = "";
      map.current?.easeTo({ center: [longitude, latitude], zoom: 16, duration: 350 });
    }, cause => {
      setLocating(false);
      setLocationNotice("");
      setError(cause.code === cause.PERMISSION_DENIED
        ? "Location access was denied. Search for the property address or enter coordinates manually."
        : cause.code === cause.TIMEOUT
          ? "Getting your location took too long. Try again or enter the address or coordinates manually."
          : "Your device could not determine its location. Try again or enter the address or coordinates manually.");
    }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
  }
  useEffect(() => {
    let disposed = false;
    async function setup() {
      if (!container.current) return;
      try {
        const maplibre = await import("maplibre-gl");
        if (disposed || !container.current) return;
        const instance = new maplibre.Map({ container: container.current, style: !process.env.NEXT_PUBLIC_MAP_STYLE_URL || ["undefined", "null"].includes(process.env.NEXT_PUBLIC_MAP_STYLE_URL) ? DEFAULT_STYLE : process.env.NEXT_PUBLIC_MAP_STYLE_URL, center: [CAMPUS_REFERENCE.longitude, CAMPUS_REFERENCE.latitude], zoom: 14.5, maxBounds: [[-2.4, 5.0], [-1.6, 5.6]], attributionControl: { compact: true }, scrollZoom: false });
        map.current = instance;
        instance.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
        const pin = new maplibre.Marker({ color: "#0d694d", draggable: true }).setLngLat([CAMPUS_REFERENCE.longitude, CAMPUS_REFERENCE.latitude]).addTo(instance);
        pin.getElement().style.display = "none";
        marker.current = pin;
        instance.on("click", event => { setError(""); latest.current(event.lngLat.lat.toFixed(6), event.lngLat.lng.toFixed(6)); });
        pin.on("dragend", () => { const point = pin.getLngLat(); latest.current(point.lat.toFixed(6), point.lng.toFixed(6)); });
        instance.on("error", () => setError("Map tiles could not load. You can still enter the coordinates below."));
      } catch { setError("The map could not start. Enter the location coordinates below."); }
    }
    void setup();
    return () => { disposed = true; marker.current?.remove(); map.current?.remove(); marker.current = null; map.current = null; };
  }, []);
  useEffect(() => {
    const lat = Number(latitude), lng = Number(longitude);
    if (!latitude || !longitude || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < 5.0 || lat > 5.6 || lng < -2.4 || lng > -1.6) return;
    marker.current?.setLngLat([lng, lat]);
    if (marker.current) marker.current.getElement().style.display = "";
    map.current?.easeTo({ center: [lng, lat], zoom: Math.max(map.current.getZoom(), 15), duration: 0 });
  }, [latitude, longitude]);
  return <div className="hostel-location-picker">
    <p>If you are at the property, use your device location to set the entrance. Otherwise search for the address, tap the map, or enter coordinates manually below.</p>
    <div className="hostel-location-actions">
      <button type="button" className="console-secondary" onClick={useMyLocation} disabled={locating}>
        <Crosshair size={15} aria-hidden />{locating ? "Getting location…" : "Use my location"}
      </button>
      <span>Allow location access when your browser asks. You can still adjust the pin on the map.</span>
    </div>
    <div ref={container} className="hostel-location-map" role="application" aria-label="Select hostel location on map" />
    {error && <p role="alert">{error}</p>}
    {locationNotice && <p role="status">{locationNotice}</p>}
  </div>;
}
