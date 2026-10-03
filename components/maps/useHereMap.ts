"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { createHereMap, disposeHereMap, hereMapsConfig, loadHereMaps, MAP_UNAVAILABLE, type HereMapInstance, type MapPoint } from "@/lib/here-maps";

export function useHereMap(container: RefObject<HTMLDivElement | null>, options: { center: MapPoint; zoom: number }) {
  const [instance, setInstance] = useState<HereMapInstance | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let current: HereMapInstance | null = null;
    let resize: ResizeObserver | null = null;
    queueMicrotask(() => { if (!disposed) { setInstance(null); setLoading(true); setDisabled(false); setError(""); } });
    void hereMapsConfig().then(async config => {
      if (disposed) return;
      if (!config.enabled) { setDisabled(true); setLoading(false); return; }
      if (!config.apiKey) throw new Error(MAP_UNAVAILABLE);
      const api = await loadHereMaps();
      if (disposed) return;
      current = createHereMap(api, element, options, config.apiKey);
      resize = new ResizeObserver(() => current?.map.getViewPort().resize());
      resize.observe(element);
      setInstance(current); setLoading(false);
    }).catch(() => { if (!disposed) { setError(MAP_UNAVAILABLE); setLoading(false); } });
    return () => { disposed = true; resize?.disconnect(); if (current) disposeHereMap(current); element.replaceChildren(); };
  }, [container, options, attempt]);
  return { instance, loading, disabled, error, retry };
}
