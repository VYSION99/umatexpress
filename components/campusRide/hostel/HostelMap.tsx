"use client";

import { useEffect, useMemo, useRef } from "react";
import { Bed, MapPin } from "@phosphor-icons/react";
import { bedsLabel, cedis, distanceLabel } from "@/components/campusRide/hostel/format";
import { CAMPUS_REFERENCE } from "@/lib/hostel-engine/geo";
import { fitOsmMap, mapPoint, validMapPoint, osmDomMarker, openOsmPopup } from "@/lib/osm-maps";
import { useOsmMap } from "@/components/maps/useOsmMap";
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
  center: mapPoint(CAMPUS_REFERENCE.longitude, CAMPUS_REFERENCE.latitude),
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
  price.textContent = property.availableSpaces ? "From " + cedis(property.minTotal) + " per bed / year" : "Bed availability coming soon";
  const link = document.createElement("a");
  link.href = "/hostel/" + encodeURIComponent(property.id) + "?periodId=" + encodeURIComponent(periodId);
  link.textContent = property.availableSpaces ? "View rooms" : "View property";
  container.append(heading, place, price, link);
  return container;
}

export function HostelMap({ properties, periodId = "", title = "Approved hostels near campus" }: { properties: HostelMapProperty[]; periodId?: string; title?: string }) {
  const container = useRef<HTMLDivElement | null>(null);
  const { instance, loading, error, disabled, retry } = useOsmMap(container, OPTIONS);
  const pinned = useMemo(() => properties.filter(property => validMapPoint(property.latitude, property.longitude)), [properties]);

  useEffect(() => {
    if (!instance) return;
    const positions = pinned.map(property => mapPoint(property.longitude!, property.latitude!));
    const pins = pinned.map((property, index) => {
      const element = document.createElement("div");
      element.className = "real-map-marker hostel-marker";
      const label = document.createElement("span");
      label.textContent = property.availableSpaces ? String(property.availableSpaces) : "•";
      element.append(label);
      const pin = osmDomMarker(instance, positions[index], element);
      pin.on("click", () => openOsmPopup(pin, popupContent(property, periodId)));
      return pin;
    });
    fitOsmMap(instance, positions);
    return () => { if (!instance.disposed) pins.forEach(pin => pin.remove()); };
  }, [instance, pinned, periodId]);

  return <section className="campus-map-widget real-map-widget hostel-map-widget">
    <div className="campus-map-top">
      <div><p>HOSTEL MAP</p><h2>{title}</h2></div>
      <span>{pinned.length} {pinned.length === 1 ? "pin" : "pins"}</span>
    </div>
    <div className={`campus-map-frame${disabled ? " is-map-disabled" : ""}`}>
      <div ref={container} className="campus-map-canvas real-map-canvas hostel-map-canvas osm-map-canvas" aria-label="Interactive Hostel Finder map" />
      <MapStatus disabled={disabled} loading={loading} error={error} onRetry={retry} />
    </div>
    {!disabled && <MapLocateButton instance={instance} />}
    {!disabled && <div className="real-map-legend">
      <span><Bed size={14} /> Pin shows beds free</span>
      <span><MapPin size={14} /> Approved hostel</span>
      {properties.length > pinned.length && <span>{properties.length - pinned.length} without a pin, available in the list</span>}
      <span>OpenStreetMap</span>
    </div>}
  </section>;
}
