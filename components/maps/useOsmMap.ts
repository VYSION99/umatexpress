"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { createOsmMap, disposeOsmMap, MAP_UNAVAILABLE, type MapPoint, type OsmMapInstance } from "@/lib/osm-maps";
import "leaflet/dist/leaflet.css";

type MapConfig = { mapsEnabled: boolean; tileUrl: string };
let pendingConfig: Promise<MapConfig> | null = null;
export function osmMapsConfig(): Promise<MapConfig> {
  if (pendingConfig) return pendingConfig;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  pendingConfig = fetch("/api/maps/config", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
    .then(async response => {
      if (!response.ok) throw new Error(MAP_UNAVAILABLE);
      const data = await response.json();
      if (typeof data.mapsEnabled !== "boolean" || typeof data.tileUrl !== "string") throw new Error(MAP_UNAVAILABLE);
      return { mapsEnabled: data.mapsEnabled, tileUrl: data.tileUrl };
    })
    .finally(() => { clearTimeout(timeout); pendingConfig = null; });
  return pendingConfig;
}

export function useOsmMap(container: RefObject<HTMLDivElement | null>, options: { center: MapPoint; zoom: number }) {
  const [instance, setInstance] = useState<OsmMapInstance | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let current: OsmMapInstance | null = null;
    let resize: ResizeObserver | null = null;
    queueMicrotask(() => { if (!disposed) { setInstance(null); setLoading(true); setDisabled(false); setError(""); } });
    void osmMapsConfig().then(async config => {
      if (disposed) return;
      if (!config.mapsEnabled) { setDisabled(true); setLoading(false); return; }
      const L = await import("leaflet");
      if (disposed) return;
      current = createOsmMap(L, element, options, config.tileUrl);
      let tileErrors = 0;
      current.tiles.on("tileerror", () => { if (!disposed && ++tileErrors >= 4) setError(MAP_UNAVAILABLE); });
      current.tiles.on("tileload", () => { if (!disposed) { tileErrors = 0; setError(""); } });
      if (typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(() => current?.map.invalidateSize());
        resize.observe(element);
      }
      setInstance(current);
      setLoading(false);
    }).catch(() => { if (!disposed) { setError(MAP_UNAVAILABLE); setLoading(false); } });
    return () => { disposed = true; resize?.disconnect(); if (current) disposeOsmMap(current); element.replaceChildren(); };
  }, [container, options, attempt]);
  return { instance, loading, disabled, error, retry };
}
