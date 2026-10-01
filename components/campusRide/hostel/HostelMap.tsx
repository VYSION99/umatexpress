"use client";

import { useEffect, useMemo, useRef } from "react";
import { Bed, MapPin } from "@phosphor-icons/react";
import { bedsLabel, cedis, distanceLabel } from "@/components/campusRide/hostel/format";
import { CAMPUS_REFERENCE } from "@/lib/hostel-engine/geo";
import { fitGoogleMap, googlePoint, validMapPoint } from "@/lib/google-maps";
import { useGoogleMap } from "@/components/maps/useGoogleMap";
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

const OPTIONS: google.maps.MapOptions = {
  center: googlePoint(CAMPUS_REFERENCE.longitude, CAMPUS_REFERENCE.latitude),
  zoom: 14,
  minZoom: 10,
  maxZoom: 20,
};

function popupContent(property: HostelMapProperty, periodId: string) {
  const container = document.createElement("div");
  container.className = "google-map-popup";
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
  const { instance, loading, error, disabled, retry } = useGoogleMap(container, OPTIONS);
  const pinned = useMemo(() => properties.filter(property => validMapPoint(property.latitude, property.longitude)), [properties]);

  useEffect(() => {
    if (!instance) return;
    const { map, maps, marker, core } = instance;
    const popup = new maps.InfoWindow();
    const events = new AbortController();
    const positions = pinned.map(property => googlePoint(property.longitude!, property.latitude!));
    const pins = pinned.map((property, index) => {
      const element = document.createElement("div");
      element.className = "real-map-marker hostel-marker";
      const label = document.createElement("span");
      label.textContent = String(property.availableSpaces);
      element.append(label);
      const pin = new marker.AdvancedMarkerElement({
        map, position: positions[index], gmpClickable: true,
        title: property.name + " — " + bedsLabel(property.availableSpaces),
      });
      pin.append(element);
      pin.addEventListener("gmp-click", () => {
        popup.setContent(popupContent(property, periodId));
        popup.open({ map, anchor: pin });
      }, { signal: events.signal });
      return pin;
    });
    fitGoogleMap(map, core, positions);
    return () => { events.abort(); popup.close(); pins.forEach(pin => { pin.map = null; }); };
  }, [instance, pinned, periodId]);

  return <section className="campus-map-widget real-map-widget hostel-map-widget">
    <div className="campus-map-top">
      <div><p>HOSTEL MAP</p><h2>{title}</h2></div>
      <span>{pinned.length} {pinned.length === 1 ? "pin" : "pins"}</span>
    </div>
    <div className={`campus-map-frame${disabled ? " is-map-disabled" : ""}`}>
      <div ref={container} className="campus-map-canvas real-map-canvas hostel-map-canvas google-map-canvas" aria-label="Interactive Hostel Finder map" />
      <MapStatus disabled={disabled} loading={loading} error={error} onRetry={retry} />
    </div>
    {!disabled && <MapLocateButton instance={instance} />}
    {!disabled && <div className="real-map-legend">
      <span><Bed size={14} /> Pin shows beds free</span>
      <span><MapPin size={14} /> Approved hostel</span>
      {properties.length > pinned.length && <span>{properties.length - pinned.length} without a pin, available in the list</span>}
      <span>Google Maps</span>
    </div>}
  </section>;
}
