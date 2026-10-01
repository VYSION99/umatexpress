"use client";

import { useEffect, useMemo, useRef } from "react";
import { Bed, MapPin } from "@phosphor-icons/react";
import { bedsLabel, cedis, distanceLabel } from "@/components/campusRide/hostel/format";
import { CAMPUS_REFERENCE } from "@/lib/hostel-engine/geo";
import { fitHereMap, herePoint, validMapPoint, hereDomMarker, openHereBubble } from "@/lib/here-maps";
import { useHereMap } from "@/components/maps/useHereMap";
import { MapStatus } from "@/components/maps/MapStatus";
import { MapLocateButton } from "@/components/maps/MapLocateButton";

export type HostelMapProperty = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  availableSpaces: number;
  minTotal: number;
  distanceM: number | null;
};

const OPTIONS: { center: { lat: number; lng: number }; zoom: number } = {
  center: herePoint(CAMPUS_REFERENCE.longitude, CAMPUS_REFERENCE.latitude),
  zoom: 14,
};

function popupContent(property: HostelMapProperty, periodId: string) {
  const container = document.createElement("div");
  container.className = "here-map-popup";
  const heading = document.createElement("strong");
  heading.textContent = property.name;
  const place = document.createElement("p");
  place.textContent = bedsLabel(property.availableSpaces) + " · " + distanceLabel(property.distanceM);
  const price = document.createElement("p");
  price.textContent = "From " + cedis(property.minTotal) + " a year";
  const link = document.createElement("a");
  link.href = "/hostel/" + encodeURIComponent(property.id) + "?periodId=" + encodeURIComponent(periodId);
  link.textContent = "See the beds";
  container.append(heading, place, price, link);
  return container;
}

export function HostelMap({ properties, periodId = "", title = "Approved hostels near campus" }: { properties: HostelMapProperty[]; periodId?: string; title?: string }) {
  const container = useRef<HTMLDivElement | null>(null);
  const { instance, loading, error, disabled, retry } = useHereMap(container, OPTIONS);
  const pinned = useMemo(() => properties.filter(property => validMapPoint(property.latitude, property.longitude)), [properties]);

  useEffect(() => {
    if (!instance) return;
    const { map } = instance;
    let bubble: ReturnType<typeof openHereBubble> | null = null;
    const positions = pinned.map(property => herePoint(property.longitude!, property.latitude!));
    const pins = pinned.map((property, index) => {
      const element = document.createElement("div");
      element.className = "real-map-marker hostel-marker";
      const label = document.createElement("span");
      label.textContent = String(property.availableSpaces);
      element.append(label);
      const pin = hereDomMarker(instance, positions[index], element);
      pin.addEventListener("tap", () => {
        if (bubble) instance.ui.removeBubble(bubble);
        bubble = openHereBubble(instance, positions[index], popupContent(property, periodId));
      });
      return pin;
    });
    fitHereMap(instance, positions);
    return () => { if (bubble) instance.ui.removeBubble(bubble); pins.forEach(pin => map.removeObject(pin)); };
  }, [instance, pinned, periodId]);

  return <section className="campus-map-widget real-map-widget hostel-map-widget">
    <div className="campus-map-top">
      <div><p>HOSTEL MAP</p><h2>{title}</h2></div>
      <span>{pinned.length} {pinned.length === 1 ? "pin" : "pins"}</span>
    </div>
    <div className={`campus-map-frame${disabled ? " is-map-disabled" : ""}`}>
      <div ref={container} className="campus-map-canvas real-map-canvas hostel-map-canvas here-map-canvas" aria-label="Interactive Hostel Finder map" />
      <MapStatus disabled={disabled} loading={loading} error={error} onRetry={retry} />
    </div>
    {!disabled && <MapLocateButton instance={instance} />}
    {!disabled && <div className="real-map-legend">
      <span><Bed size={14} /> Pin shows beds free</span>
      <span><MapPin size={14} /> Approved hostel</span>
      {properties.length > pinned.length && <span>{properties.length - pinned.length} without a pin, available in the list</span>}
      <span>HERE Maps</span>
    </div>}
  </section>;
}
