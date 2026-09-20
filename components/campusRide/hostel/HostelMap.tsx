"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LngLatBoundsLike, LngLatLike, Map as MapLibreMap, Marker } from "maplibre-gl";
import { BedDouble, LocateFixed, MapPin } from "lucide-react";
import { bedsLabel, cedis, distanceLabel } from "@/components/campusRide/hostel/format";
import { CAMPUS_REFERENCE } from "@/lib/hostel-engine/geo";

export type HostelMapProperty = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  availableSpaces: number;
  minTotal: number;
  distanceM: number | null;
};

const DEFAULT_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
// The campus and the streets students actually walk to reach these buildings.
const HOSTEL_BOUNDS: LngLatBoundsLike = [
  [-2.08, 5.24],
  [-1.91, 5.37],
];

// A build that never defined the variable can still publish the literal string
// "undefined" through the client env shim. That string is truthy, so a plain
// `|| fallback` would hand MapLibre a relative URL and the map would fail.
function publicValue(value: string | undefined, fallback: string) {
  const candidate = (value || "").trim();
  return !candidate || candidate === "undefined" || candidate === "null" ? fallback : candidate;
}

const MAP_STYLE_URL = publicValue(process.env.NEXT_PUBLIC_MAP_STYLE_URL, DEFAULT_STYLE_URL);

function coordinateOf(property: HostelMapProperty): [number, number] | null {
  if (typeof property.latitude !== "number" || typeof property.longitude !== "number") return null;
  if (!Number.isFinite(property.latitude) || !Number.isFinite(property.longitude)) return null;
  return [property.longitude, property.latitude];
}

function markerElement(label: string) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "real-map-marker hostel-marker";
  element.setAttribute("aria-label", label);
  return element;
}

function markerLabel(element: HTMLElement, text: string) {
  const span = document.createElement("span");
  span.textContent = text;
  element.append(span);
}

function popupContent(property: HostelMapProperty) {
  const container = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = property.name;
  const place = document.createElement("p");
  place.textContent = `${bedsLabel(property.availableSpaces)} · ${distanceLabel(property.distanceM)}`;
  const price = document.createElement("p");
  price.textContent = `From ${cedis(property.minTotal)} a year`;
  const link = document.createElement("a");
  link.href = `/hostel/${encodeURIComponent(property.id)}`;
  link.textContent = "See the beds";
  container.append(heading, place, price, link);
  return container;
}

/**
 * The student map for approved hostels, built the same way as `CampusMap`: pins
 * come from data the server already gated, a building without a pin is simply
 * not drawn, and the list below the map is the full answer either way.
 */
export function HostelMap({ properties, title = "Approved hostels near campus" }: { properties: HostelMapProperty[]; title?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");

  const pinned = useMemo(() => properties.filter((property) => coordinateOf(property)), [properties]);

  useEffect(() => {
    let disposed = false;
    async function setupMap() {
      if (!containerRef.current || mapRef.current) return;
      try {
        const maplibregl = await import("maplibre-gl");
        if (disposed || !containerRef.current) return;
        const map = new maplibregl.Map({
          container: containerRef.current,
          style: MAP_STYLE_URL,
          center: [CAMPUS_REFERENCE.longitude, CAMPUS_REFERENCE.latitude],
          zoom: 14.4,
          minZoom: 12,
          maxZoom: 19,
          maxBounds: HOSTEL_BOUNDS,
          attributionControl: { compact: true },
        });
        mapRef.current = map;
        map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
        map.addControl(new maplibregl.FullscreenControl(), "top-right");
        map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "top-right");
        map.on("load", () => { if (!disposed) setMapReady(true); });
        map.on("error", () => setMapError("Map tiles could not load. Check the map provider or network connection."));
      } catch {
        setMapError("The real map could not start on this device.");
      }
    }
    setupMap();
    return () => {
      disposed = true;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  const syncMarkers = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const maplibregl = await import("maplibre-gl");
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    const coordinates: Array<[number, number]> = [];
    pinned.forEach((property) => {
      const coordinate = coordinateOf(property);
      if (!coordinate) return;
      coordinates.push(coordinate);
      const element = markerElement(`${property.name} — ${bedsLabel(property.availableSpaces)}`);
      markerLabel(element, String(property.availableSpaces));
      const marker = new maplibregl.Marker({ element, anchor: "center" })
        .setLngLat(coordinate as LngLatLike)
        .setPopup(new maplibregl.Popup({ offset: 20 }).setDOMContent(popupContent(property)))
        .addTo(map);
      markersRef.current.push(marker);
    });
    if (coordinates.length === 1) {
      map.easeTo({ center: coordinates[0], zoom: Math.max(map.getZoom(), 15.6), duration: 550 });
    } else if (coordinates.length > 1) {
      const bounds = coordinates.reduce((box, point) => box.extend(point), new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
      map.fitBounds(bounds, { padding: 56, maxZoom: 16, duration: 550 });
    }
  }, [mapReady, pinned]);

  useEffect(() => { syncMarkers(); }, [syncMarkers]);

  return <section className="campus-map-widget real-map-widget hostel-map-widget">
    <div className="campus-map-top">
      <div><p>LIVE MAP</p><h2>{title}</h2></div>
      <span>{pinned.length} {pinned.length === 1 ? "pin" : "pins"}</span>
    </div>
    <div className="campus-map-frame">
      <div ref={containerRef} className="campus-map-canvas real-map-canvas hostel-map-canvas" aria-label="Interactive Hostel Finder map" />
      {!mapReady && !mapError && <div className="real-map-loading"><MapPin size={22} /><span>Loading real map...</span></div>}
      {mapError && <div className="real-map-error"><LocateFixed size={22} /><span>{mapError}</span></div>}
    </div>
    <div className="real-map-legend">
      <span><BedDouble size={14} /> Pin shows beds free</span>
      <span><MapPin size={14} /> Approved hostel</span>
      {properties.length > pinned.length && <span>{properties.length - pinned.length} without a pin, listed below</span>}
      <span>OpenStreetMap</span>
    </div>
  </section>;
}
