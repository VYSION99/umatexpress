"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { GOOGLE_MAP_ID, googleMapsEnabled, loadGoogleMaps, MAP_UNAVAILABLE, onGoogleMapsAuthFailure, type GoogleMapLibraries } from "@/lib/google-maps";

export type GoogleMapInstance = GoogleMapLibraries & { map: google.maps.Map };

/** Pass stable options so normal form edits do not recreate a billable map. */
export function useGoogleMap(container: RefObject<HTMLDivElement | null>, options: google.maps.MapOptions) {
  const [instance, setInstance] = useState<GoogleMapInstance | null>(null);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let authorizationFailed = false;
    let current: GoogleMapInstance | null = null;
    let timeout: number | undefined;
    let readyListener: google.maps.MapsEventListener | undefined;
    const fail = (message: string) => {
      if (disposed) return;
      window.clearTimeout(timeout);
      setError(message); setLoading(false);
    };
    const unsubscribe = onGoogleMapsAuthFailure(() => {
      authorizationFailed = true;
      fail(MAP_UNAVAILABLE);
    });
    queueMicrotask(() => {
      if (!disposed) { setError(""); setLoading(true); setDisabled(false); setInstance(null); }
    });
    void googleMapsEnabled().then(enabled => {
      if (disposed) return null;
      if (!enabled) { setDisabled(true); setLoading(false); return null; }
      return loadGoogleMaps();
    }).then(libraries => {
      if (disposed || !libraries) return;
      const map = new libraries.maps.Map(element, {
        mapId: GOOGLE_MAP_ID,
        renderingType: libraries.maps.RenderingType.RASTER,
        gestureHandling: "cooperative",
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
        zoomControl: true,
        clickableIcons: false,
        ...options,
      });
      current = { ...libraries, map };
      setInstance(current);
      timeout = window.setTimeout(() => fail(MAP_UNAVAILABLE), 20_000);
      readyListener = libraries.core.event.addListenerOnce(map, "tilesloaded", () => {
        if (disposed || authorizationFailed) return;
        window.clearTimeout(timeout);
        setError("");
        setLoading(false);
      });
    }).catch(cause => fail(cause instanceof Error ? cause.message : MAP_UNAVAILABLE));
    return () => {
      disposed = true;
      unsubscribe();
      window.clearTimeout(timeout);
      readyListener?.remove();
      if (current) current.core.event.clearInstanceListeners(current.map);
      element.replaceChildren();
    };
  }, [container, options, attempt]);

  return { instance, loading, error, disabled, retry };
}
