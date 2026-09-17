"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoJSONSource, LngLatBoundsLike, LngLatLike, Map as MapLibreMap, Marker } from "maplibre-gl";
import { CarFront, LocateFixed, MapPin } from "lucide-react";
import type { CampusRideMatch } from "@/lib/campus-matching";
import type { CampusRide, CampusZone } from "@/lib/campus-ride";
import { loadGoogleMaps } from "@/lib/google-maps-loader";

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

function publicEnvValue(name: string) {
  return typeof process !== "undefined" ? process.env?.[name] || "" : "";
}

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

function directRouteFeature(match: CampusRideMatch, zoneById: Map<string, CampusZone>): RouteFeature | null {
  const origin = coordinateFromRide(match, zoneById);
  const destination = zoneCoordinate(zoneById.get(match.corridor?.destinationZoneId || ""));
  if (!origin || !destination) return null;
  return {
    type: "Feature",
    properties: { id: match.id, selected: false, provider: "direct", distanceMeters: 0, durationSeconds: match.estimatedMinutes * 60, fallback: true },
    geometry: { type: "LineString", coordinates: [origin, destination] },
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

type CampusMapProps = { zones: CampusZone[]; rides?: CampusRide[]; matches?: CampusRideMatch[]; selectedRideId?: string; title?: string };

export function CampusMap(props: CampusMapProps) {
  const [clientMapConfig, setClientMapConfig] = useState({ provider: "maplibre", googleKey: "" });
  const [googleUnavailable, setGoogleUnavailable] = useState(false);
  const handleGoogleUnavailable = useCallback(() => setGoogleUnavailable(true), []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const googleKey = publicEnvValue("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY") || publicEnvValue("GoogleMap_JAVASCRIPT_KEY");
      setClientMapConfig({
        googleKey,
        provider: (publicEnvValue("NEXT_PUBLIC_MAP_PROVIDER") || (googleKey ? "google" : "maplibre")).toLowerCase(),
      });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  if (!googleUnavailable && clientMapConfig.provider === "google" && clientMapConfig.googleKey) return <GoogleCampusMap {...props} apiKey={clientMapConfig.googleKey} onUnavailable={handleGoogleUnavailable} />;
  return <MapLibreCampusMap {...props} />;
}

function MapLibreCampusMap({ zones, rides = [], matches = [], selectedRideId, title = "Campus map" }: CampusMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState("");
  const styleUrl = publicEnvValue("NEXT_PUBLIC_MAP_STYLE_URL") || DEFAULT_STYLE_URL;
  const zoneById = useMemo(() => new Map(zones.map((zone) => [zone.id, zone])), [zones]);
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
  const directRouteFeatures = useMemo<RouteFeature[]>(() => matches.flatMap((match) => {
    const feature = directRouteFeature(match, zoneById);
    return feature ? [feature] : [];
  }), [matches, zoneById]);
  const [roadRouteFeatures, setRoadRouteFeatures] = useState<RouteFeature[]>(directRouteFeatures);
  const routeFeatures = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: (roadRouteFeatures.length ? roadRouteFeatures : directRouteFeatures).map((feature) => ({ ...feature, properties: { ...feature.properties, selected: selectedRideId === feature.properties.id } })),
  }), [directRouteFeatures, roadRouteFeatures, selectedRideId]);
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
    let cancelled = false;
    async function loadRoadRoutes() {
      const direct = directRouteFeatures;
      setRoadRouteFeatures(direct);
      const routes = await Promise.all(matches.slice(0, 5).map(async (match) => {
        const origin = coordinateFromRide(match, zoneById);
        const destination = zoneCoordinate(zoneById.get(match.corridor?.destinationZoneId || ""));
        if (!origin || !destination) return direct.find((feature) => feature.properties.id === match.id) || null;
        const url = new URL("/api/campus/route", window.location.origin);
        url.searchParams.set("fromLat", String(origin[1]));
        url.searchParams.set("fromLng", String(origin[0]));
        url.searchParams.set("toLat", String(destination[1]));
        url.searchParams.set("toLng", String(destination[0]));
        try {
          const response = await fetch(url, { cache: "force-cache" });
          if (!response.ok) throw new Error("Routing failed.");
          const data = await response.json();
          const route = data.route || data;
          return {
            type: "Feature" as const,
            properties: { id: match.id, selected: selectedRideId === match.id, provider: String(route.provider || "osrm"), distanceMeters: Number(route.distanceMeters || 0), durationSeconds: Number(route.durationSeconds || 0), fallback: Boolean(route.fallback) },
            geometry: route.geometry,
          };
        } catch {
          return direct.find((feature) => feature.properties.id === match.id) || null;
        }
      }));
      if (cancelled) return;
      const filtered = routes.filter((route): route is RouteFeature => Boolean(route?.geometry?.coordinates?.length));
      setRoadRouteFeatures(filtered.length ? filtered : direct);
    }
    loadRoadRoutes();
    return () => { cancelled = true; };
  }, [directRouteFeatures, matches, selectedRideId, zoneById]);

  useEffect(() => {
    let disposed = false;
    async function setupMap() {
      if (!containerRef.current || mapRef.current) return;
      try {
        const maplibregl = await import("maplibre-gl");
        if (disposed || !containerRef.current) return;
        const map = new maplibregl.Map({
          container: containerRef.current,
          style: styleUrl,
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
  }, [styleUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource("campus-routes") as GeoJSONSource | undefined;
    source?.setData(routeFeatures);
  }, [mapReady, routeFeatures]);

  useEffect(() => {
    let cancelled = false;
    async function syncMarkers() {
      const map = mapRef.current;
      if (!map || !mapReady) return;
      const maplibregl = await import("maplibre-gl");
      if (cancelled) return;
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
    }
    syncMarkers();
    return () => { cancelled = true; };
  }, [mapReady, ridePins, zones]);

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
      <span>{routeStats?.fallback ? "Fallback route" : "Road route"} · OpenStreetMap</span>
    </div>
  </section>;
}

function GoogleCampusMap({ zones, rides = [], matches = [], selectedRideId, title = "Campus map", apiKey, onUnavailable }: CampusMapProps & { apiKey: string; onUnavailable?: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlaysRef = useRef<Array<{ setMap: (map: google.maps.Map | null) => void }>>([]);
  const [mapReady, setMapReady] = useState(false);
  const zoneById = useMemo(() => new Map(zones.map((zone) => [zone.id, zone])), [zones]);
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
  const directRouteFeatures = useMemo<RouteFeature[]>(() => matches.flatMap((match) => {
    const feature = directRouteFeature(match, zoneById);
    return feature ? [feature] : [];
  }), [matches, zoneById]);
  const [roadRouteFeatures, setRoadRouteFeatures] = useState<RouteFeature[]>(directRouteFeatures);
  const routeFeatures = useMemo(() => (roadRouteFeatures.length ? roadRouteFeatures : directRouteFeatures).map((feature) => ({
    ...feature,
    properties: { ...feature.properties, selected: selectedRideId === feature.properties.id },
  })), [directRouteFeatures, roadRouteFeatures, selectedRideId]);
  const routeStats = useMemo(() => {
    const selected = routeFeatures.find((feature) => feature.properties.selected);
    return selected ? selected.properties : null;
  }, [routeFeatures]);

  useEffect(() => {
    let disposed = false;
    // Google renders its own blocking "can't load Google Maps correctly" dialog for
    // an invalid or unbilled key, which would cover the map and hide our fallback.
    const authWindow = window as Window & { gm_authFailure?: () => void };
    const previousAuthFailure = authWindow.gm_authFailure;
    authWindow.gm_authFailure = () => {
      previousAuthFailure?.();
      if (!disposed) onUnavailable?.();
    };
    async function setupMap() {
      if (!containerRef.current || mapRef.current) return;
      try {
        const googleApi = await loadGoogleMaps(apiKey);
        if (disposed || !containerRef.current) return;
        mapRef.current = new googleApi.maps.Map(containerRef.current, {
          center: { lat: UMAT_CENTER[1], lng: UMAT_CENTER[0] },
          zoom: 15,
          minZoom: 13,
          maxZoom: 20,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          zoomControl: true,
          zoomControlOptions: { position: googleApi.maps.ControlPosition.RIGHT_TOP },
        });
        setMapReady(true);
      } catch {
        if (!disposed) onUnavailable?.();
      }
    }
    setupMap();
    return () => {
      disposed = true;
      if (authWindow.gm_authFailure) authWindow.gm_authFailure = previousAuthFailure;
      overlaysRef.current.forEach((overlay) => overlay.setMap(null));
      overlaysRef.current = [];
      mapRef.current = null;
    };
  }, [apiKey, onUnavailable]);

  // The auth callback is not always fired (for example when the loader is already
  // cached), so also watch the container for Google's error dialog text.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if ((containerRef.current?.textContent || "").includes("load Google Maps correctly")) {
        window.clearInterval(timer);
        onUnavailable?.();
      }
    }, 700);
    const giveUp = window.setTimeout(() => window.clearInterval(timer), 8000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(giveUp);
    };
  }, [onUnavailable]);

  useEffect(() => {
    let cancelled = false;
    async function loadRoadRoutes() {
      const direct = directRouteFeatures;
      setRoadRouteFeatures(direct);
      const routes = await Promise.all(matches.slice(0, 5).map(async (match) => {
        const origin = coordinateFromRide(match, zoneById);
        const destination = zoneCoordinate(zoneById.get(match.corridor?.destinationZoneId || ""));
        if (!origin || !destination) return direct.find((feature) => feature.properties.id === match.id) || null;
        const url = new URL("/api/campus/route", window.location.origin);
        url.searchParams.set("fromLat", String(origin[1]));
        url.searchParams.set("fromLng", String(origin[0]));
        url.searchParams.set("toLat", String(destination[1]));
        url.searchParams.set("toLng", String(destination[0]));
        try {
          const response = await fetch(url, { cache: "force-cache" });
          if (!response.ok) throw new Error("Routing failed.");
          const data = await response.json();
          const route = data.route || data;
          return {
            type: "Feature" as const,
            properties: { id: match.id, selected: selectedRideId === match.id, provider: String(route.provider || "route"), distanceMeters: Number(route.distanceMeters || 0), durationSeconds: Number(route.durationSeconds || 0), fallback: Boolean(route.fallback) },
            geometry: route.geometry,
          };
        } catch {
          return direct.find((feature) => feature.properties.id === match.id) || null;
        }
      }));
      if (cancelled) return;
      const filtered = routes.filter((route): route is RouteFeature => Boolean(route?.geometry?.coordinates?.length));
      setRoadRouteFeatures(filtered.length ? filtered : direct);
    }
    loadRoadRoutes();
    return () => { cancelled = true; };
  }, [directRouteFeatures, matches, selectedRideId, zoneById]);

  useEffect(() => {
    const map = mapRef.current;
    const googleApi = window.google;
    if (!mapReady || !map || !googleApi?.maps) return;
    overlaysRef.current.forEach((overlay) => overlay.setMap(null));
    overlaysRef.current = [];
    const bounds = new googleApi.maps.LatLngBounds();

    zones.forEach((zone) => {
      const coordinate = zoneCoordinate(zone);
      if (!coordinate) return;
      const position = { lat: coordinate[1], lng: coordinate[0] };
      bounds.extend(position);
      const marker = new googleApi.maps.Marker({ map, position, title: zone.name, label: { text: "Z", color: "#17684f", fontWeight: "800" } });
      const info = new googleApi.maps.InfoWindow({ content: popupContent(zone.name, zone.landmark || zone.description || "Campus zone") });
      marker.addListener("click", () => info.open({ anchor: marker, map }));
      overlaysRef.current.push(marker);
    });

    routeFeatures.forEach((route) => {
      const path = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      path.forEach((point) => bounds.extend(point));
      const polyline = new googleApi.maps.Polyline({
        map,
        path,
        strokeColor: route.properties.selected ? "#f4a62a" : "#17684f",
        strokeOpacity: route.properties.selected ? 0.92 : 0.68,
        strokeWeight: route.properties.selected ? 7 : 4,
      });
      overlaysRef.current.push(polyline);
    });

    ridePins.forEach((ride) => {
      const position = { lat: ride.coordinate[1], lng: ride.coordinate[0] };
      bounds.extend(position);
      const marker = new googleApi.maps.Marker({
        map,
        position,
        title: ride.label,
        label: { text: String(ride.slots), color: "#0d563f", fontWeight: "900" },
        zIndex: ride.selected ? 20 : 10,
      });
      const info = new googleApi.maps.InfoWindow({ content: popupContent(ride.label, `${ride.status} · ${ride.slots} slots available`) });
      marker.addListener("click", () => info.open({ anchor: marker, map }));
      overlaysRef.current.push(marker);
    });

    const selected = ridePins.find((ride) => ride.selected);
    if (selected) {
      map.panTo({ lat: selected.coordinate[1], lng: selected.coordinate[0] });
      map.setZoom(Math.max(map.getZoom() || 15, 15));
    } else if (zones.length) {
      map.fitBounds(bounds, 48);
    }
  }, [mapReady, ridePins, routeFeatures, zones]);

  return <section className="campus-map-widget real-map-widget google-map-widget">
    <div className="campus-map-top">
      <div><p>LIVE MAP</p><h2>{title}</h2></div>
      <span>{activeRides.length} active rides</span>
    </div>
    <div className="campus-map-frame">
      <div ref={containerRef} className="campus-map-canvas real-map-canvas google-map-canvas" aria-label="Interactive Google CampusRide map" />
      {!mapReady && <div className="real-map-loading"><MapPin size={22}/><span>Loading Google Maps...</span></div>}
    </div>
    <div className="real-map-legend">
      <span><MapPin size={14}/> Zone</span>
      <span><CarFront size={14}/> Ride</span>
      {routeStats && <span>{Math.max(1, Math.round(routeStats.durationSeconds / 60))} min ETA · {(routeStats.distanceMeters / 1000).toFixed(1)} km</span>}
      <span>{routeStats?.fallback ? "Fallback route" : "Road route"} · Google Maps</span>
    </div>
  </section>;
}
