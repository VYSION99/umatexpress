"use client";

import { useEffect, useMemo, useRef } from "react";
import { useHereMap } from "@/components/maps/useHereMap";
import { MapStatus } from "@/components/maps/MapStatus";
import { MapLocateButton } from "@/components/maps/MapLocateButton";
import { herePoint, hereDomMarker, herePolyline, openHereBubble, type HereMarker } from "@/lib/here-maps";
import { Car, MapPin } from "@phosphor-icons/react";
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

const OPTIONS: { center: { lat: number; lng: number }; zoom: number } = {
  center: herePoint(-1.9931, 5.3018), zoom: 15,
};

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
  const element = document.createElement("div");
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
  container.className = "here-map-popup";
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
  const { instance, loading, error, disabled, retry } = useHereMap(containerRef, OPTIONS);
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
    if (!instance) return;
    const { map } = instance;
    let bubble: ReturnType<typeof openHereBubble> | null = null;
    const pins: HereMarker[] = [];
    const current = instance;
    function addPin(coordinate: [number, number], title: string, detail: string, className: string, label: string) {
      const element = markerElement(className, title);
      appendMarkerLabel(element, label);
      const point = herePoint(...coordinate);
      const pin = hereDomMarker(current, point, element);
      pin.addEventListener("tap", () => {
        if (bubble) current.ui.removeBubble(bubble);
        bubble = openHereBubble(current, point, popupContent(title, detail));
      });
      pins.push(pin);
    }
    zones.forEach(zone => {
      const coordinate = zoneCoordinate(zone);
      if (coordinate) addPin(coordinate, zone.name, zone.landmark || zone.description || "Campus zone", "real-map-marker zone-marker", zone.name);
    });
    ridePins.forEach(ride => addPin(ride.coordinate, ride.label, ride.status + " · " + ride.slots + " slots available", "real-map-marker ride-marker" + (ride.selected ? " is-selected" : ""), String(ride.slots)));
    const paths = routeFeatures.features.map(feature => herePolyline(instance,
      feature.geometry.coordinates.map(point => herePoint(...point)),
      feature.properties.selected ? "#f4a62a" : "#17684f",
      feature.properties.selected ? 8 : 5));
    const selected = ridePins.find(ride => ride.selected);
    if (selected) { map.setCenter(herePoint(...selected.coordinate)); map.setZoom(Math.max(map.getZoom() || 15, 16)); }
    return () => {
      if (bubble) current.ui.removeBubble(bubble);
      pins.forEach(pin => map.removeObject(pin));
      paths.forEach(path => map.removeObject(path));
    };
  }, [instance, ridePins, zones, routeFeatures]);

  return <section className="campus-map-widget real-map-widget">
    <div className="campus-map-top">
      <div><p>LIVE MAP</p><h2>{title}</h2></div>
      <span>{activeRides.length} active rides</span>
    </div>
    <div className={`campus-map-frame${disabled ? " is-map-disabled" : ""}`}>
      <div ref={containerRef} className="campus-map-canvas real-map-canvas here-map-canvas" aria-label="Interactive CampusRide map" />
      <MapStatus disabled={disabled} loading={loading} error={error} onRetry={retry} />
    </div>
    {!disabled && <MapLocateButton instance={instance} />}
    {!disabled && <div className="real-map-legend">
      <span><MapPin size={14}/> Zone</span>
      <span><Car size={14}/> Ride</span>
      {routeStats && <span>{Math.max(1, Math.round(routeStats.durationSeconds / 60))} min ETA · {(routeStats.distanceMeters / 1000).toFixed(1)} km</span>}
      <span>{routeStats?.fallback ? "Estimated route" : "Surveyed corridor"} · HERE Maps</span>
    </div>}
  </section>;
}
