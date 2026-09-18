"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoJSONSource, LngLatBoundsLike, LngLatLike, Map as MapLibreMap, Marker } from "maplibre-gl";
import { CarFront, LocateFixed, MapPin } from "lucide-react";
import type { CampusRideMatch } from "@/lib/campus-matching";
import type { CampusCorridor, CampusRide, CampusZone } from "@/lib/campus-ride";
import { corridorGeometry, routeMetrics } from "@/lib/campus-route-geometry";

type RidePin = {
  id: string;
  label: string;
  status: string;
  slots: number;
  selected: boolean;
  coordinate: [number, number];
};

type RouteFeature = {
  type: "Feature";
  properties: { id: string; selected: boolean; provider: string; distanceMeters: number; durationSeconds: number; fallback: boolean };
  geometry: { type: "LineString"; coordinates: Array<[number, number]> };
};

const DEFAULT_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const UMAT_CENTER: [number, number] = [-1.9931, 5.3018];
const UMAT_BOUNDS: LngLatBoundsLike = [
  [-2.012, 5.284],
  [-1.972, 5.318],
];

// A build that never defined the variable can still publish the literal string
// "undefined" through the client env shim. That string is truthy, so a plain
// `|| fallback` would hand MapLibre a relative URL and the map would fail to
// load with a 404 on /undefined.
function publicValue(value: string | undefined, fallback: string) {
  const candidate = (value || "").trim();
  return !candidate || candidate === "undefined" || candidate === "null" ? fallback : candidate;
}

const MAP_STYLE_URL = publicValue(process.env.NEXT_PUBLIC_MAP_STYLE_URL, DEFAULT_STYLE_URL);

function zoneCoordinate(zone?: Pick<CampusZone, "latitude" | "longitude">): [number, number] | null {
  if (!zone || typeof zone.latitude !== "number" || typeof zone.longitude !== "number") return null;
  if (!Number.isFinite(zone.latitude) || !Number.isFinite(zone.longitude)) return null;
  return [zone.longitude, zone.latitude];
}

function coordinateFromRide(ride: CampusRide | CampusRideMatch, zoneById: Map<string, CampusZone>): [number, number] | null {
  if (typeof ride.currentLatitude === "number" && typeof ride.currentLongitude === "number" && Number.isFinite(ride.currentLatitude) && Number.isFinite(ride.currentLongitude)) {
    return [ride.currentLongitude, ride.currentLatitude];
  }
  return zoneCoordinate(zoneById.get(ride.currentZoneId));
}

/**
 * Builds a route from data the page already holds. A corridor's surveyed path is
 * used when present, otherwise the geometry is generated between the two zones,
 * so drawing a route never depends on an upstream routing service.
 */
function routeFeatureFor(match: CampusRideMatch, zoneById: Map<string, CampusZone>, corridorById: Map<string, CampusCorridor>): RouteFeature | null {
  const origin = coordinateFromRide(match, zoneById);
  const destination = zoneCoordinate(zoneById.get(match.corridor?.destinationZoneId || ""));
  if (!origin || !destination) return null;
  const corridor = corridorById.get(match.corridorId) || match.corridor;
  const originPoint = { latitude: origin[1], longitude: origin[0] };
  const destinationPoint = { latitude: destination[1], longitude: destination[0] };
  const geometry = corridorGeometry(originPoint, destinationPoint, corridor?.path ?? null);
  const estimatedMinutes = corridor?.estimatedMinutes || match.estimatedMinutes || 0;
  const metrics = routeMetrics(originPoint, destinationPoint, geometry, estimatedMinutes);
  return {
    type: "Feature",
    properties: {
      id: match.id,
      selected: false,
      provider: corridor ? "corridor" : "estimated",
      distanceMeters: metrics.distanceMeters,
      durationSeconds: metrics.durationSeconds,
      fallback: !corridor,
    },
    geometry: { type: "LineString", coordinates: geometry },
  };
}

function markerElement(className: string, label: string) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.setAttribute("aria-label", label);
  return element;
}

function appendMarkerLabel(element: HTMLElement, label: string) {
  const span = document.createElement("span");
  span.textContent = label;
  element.append(span);
}

function popupContent(title: string, detail: string) {
  const container = document.createElement("div");
  const heading = document.createElement("strong");
  const paragraph = document.createElement("p");
  heading.textContent = title;
  paragraph.textContent = detail;
  container.append(heading, paragraph);
  return container;
}

type CampusMapProps = { zones: CampusZone[]; corridors?: CampusCorridor[]; rides?: CampusRide[]; matches?: CampusRideMatch[]; selectedRideId?: string; title?: string };

export function CampusMap({ zones, corridors = [], rides = [], matches = [], selectedRideId, title = "Campus map" }: CampusMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const zoneById = useMemo(() => new Map(zones.map((zone) => [zone.id, zone])), [zones]);
  const corridorById = useMemo(() => new Map(corridors.map((corridor) => [corridor.id, corridor])), [corridors]);
  const activeRides = useMemo(() => {
    const merged = new Map<string, CampusRide | CampusRideMatch>();
    rides.forEach((ride) => merged.set(ride.id, ride));
    matches.forEach((ride) => merged.set(ride.id, ride));
    return [...merged.values()];
  }, [rides, matches]);
  const ridePins = useMemo<RidePin[]>(() => activeRides.flatMap((ride) => {
    const coordinate = coordinateFromRide(ride, zoneById);
    if (!coordinate) return [];
    return [{
      id: ride.id,
      label: "corridor" in ride && ride.corridor?.name ? ride.corridor.name : ride.vehicleLabel || "Campus ride",
      status: ride.status,
      slots: ride.availableSlots,
      selected: selectedRideId === ride.id,
      coordinate,
    }];
  }), [activeRides, selectedRideId, zoneById]);
  const routeFeatures = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: matches.flatMap((match) => {
      const feature = routeFeatureFor(match, zoneById, corridorById);
      return feature ? [{ ...feature, properties: { ...feature.properties, selected: selectedRideId === feature.properties.id } }] : [];
    }),
  }), [matches, selectedRideId, zoneById, corridorById]);
  const routeFeaturesRef = useRef(routeFeatures);
  const routeStats = useMemo(() => {
    const selected = routeFeatures.features.find((feature) => feature.properties.selected);
    return selected ? {
      provider: selected.properties.provider,
      durationSeconds: selected.properties.durationSeconds,
      distanceMeters: selected.properties.distanceMeters,
      fallback: selected.properties.fallback,
    } : null;
  }, [routeFeatures]);

  useEffect(() => {
    routeFeaturesRef.current = routeFeatures;
  }, [routeFeatures]);

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
          center: UMAT_CENTER,
          zoom: 14.6,
          minZoom: 12.5,
          maxZoom: 19,
          maxBounds: UMAT_BOUNDS,
          attributionControl: { compact: true },
        });
        mapRef.current = map;
        map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
        map.addControl(new maplibregl.FullscreenControl(), "top-right");
        map.addControl(new maplibregl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
        }), "top-right");
        map.on("load", () => {
          if (disposed) return;
          map.addSource("campus-routes", { type: "geojson", data: routeFeaturesRef.current });
          map.addLayer({
            id: "campus-routes-base",
            type: "line",
            source: "campus-routes",
            paint: { "line-color": "#17684f", "line-width": 5, "line-opacity": 0.72 },
          });
          map.addLayer({
            id: "campus-routes-selected",
            type: "line",
            source: "campus-routes",
            filter: ["==", ["get", "selected"], true],
            paint: { "line-color": "#f4a62a", "line-width": 8, "line-opacity": 0.9 },
          });
          setMapReady(true);
        });
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource("campus-routes") as GeoJSONSource | undefined;
    source?.setData(routeFeatures);
  }, [mapReady, routeFeatures]);

  const syncMarkers = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const maplibregl = await import("maplibre-gl");
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    zones.forEach((zone) => {
      const coordinate = zoneCoordinate(zone);
      if (!coordinate) return;
      const element = markerElement("real-map-marker zone-marker", zone.name);
      appendMarkerLabel(element, zone.name);
      const marker = new maplibregl.Marker({ element, anchor: "bottom" })
        .setLngLat(coordinate as LngLatLike)
        .setPopup(new maplibregl.Popup({ offset: 18 }).setDOMContent(popupContent(zone.name, zone.landmark || zone.description || "Campus zone")))
        .addTo(map);
      markersRef.current.push(marker);
    });
    ridePins.forEach((ride) => {
      const element = markerElement(`real-map-marker ride-marker${ride.selected ? " is-selected" : ""}`, ride.label);
      appendMarkerLabel(element, String(ride.slots));
      const marker = new maplibregl.Marker({ element, anchor: "center" })
        .setLngLat(ride.coordinate as LngLatLike)
        .setPopup(new maplibregl.Popup({ offset: 18 }).setDOMContent(popupContent(ride.label, `${ride.status} · ${ride.slots} slots available`)))
        .addTo(map);
      markersRef.current.push(marker);
    });
    const selected = ridePins.find((ride) => ride.selected);
    if (selected) map.easeTo({ center: selected.coordinate, zoom: Math.max(map.getZoom(), 15.5), duration: 550 });
  }, [mapReady, ridePins, zones]);

  useEffect(() => {
    syncMarkers();
  }, [syncMarkers]);

  return <section className="campus-map-widget real-map-widget">
    <div className="campus-map-top">
      <div><p>LIVE MAP</p><h2>{title}</h2></div>
      <span>{activeRides.length} active rides</span>
    </div>
    <div className="campus-map-frame">
      <div ref={containerRef} className="campus-map-canvas real-map-canvas" aria-label="Interactive CampusRide map" />
      {!mapReady && !mapError && <div className="real-map-loading"><MapPin size={22}/><span>Loading real map...</span></div>}
      {mapError && <div className="real-map-error"><LocateFixed size={22}/><span>{mapError}</span></div>}
    </div>
    <div className="real-map-legend">
      <span><MapPin size={14}/> Zone</span>
      <span><CarFront size={14}/> Ride</span>
      {routeStats && <span>{Math.max(1, Math.round(routeStats.durationSeconds / 60))} min ETA · {(routeStats.distanceMeters / 1000).toFixed(1)} km</span>}
      <span>{routeStats?.fallback ? "Estimated route" : "Surveyed corridor"} · OpenStreetMap</span>
    </div>
  </section>;
}
