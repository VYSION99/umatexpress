import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

export type GoogleMapLibraries = {
  maps: google.maps.MapsLibrary;
  marker: google.maps.MarkerLibrary;
  core: google.maps.CoreLibrary;
};

function publicValue(value: string | undefined) {
  const candidate = (value || "").trim();
  return ["undefined", "null"].includes(candidate) ? "" : candidate;
}

const apiKey = publicValue(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY);
export const GOOGLE_MAP_ID = publicValue(process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID) || "DEMO_MAP_ID";
export const MAP_UNAVAILABLE = "The map is unavailable right now. Please try again.";
let configured = false;
let authorizationFailed = false;
let pending: Promise<GoogleMapLibraries> | null = null;
const authListeners = new Set<() => void>();

let policyRequest: Promise<boolean> | null = null;

/** Share concurrent reads, but check the admin policy again on the next mount. */
export function googleMapsEnabled(): Promise<boolean> {
  if (policyRequest) return policyRequest;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  policyRequest = fetch("/api/maps/config", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
    .then(async response => {
      if (!response.ok) throw new Error(MAP_UNAVAILABLE);
      const data = await response.json();
      if (typeof data.googleMapsEnabled !== "boolean") throw new Error(MAP_UNAVAILABLE);
      return data.googleMapsEnabled as boolean;
    })
    .catch(() => { throw new Error(MAP_UNAVAILABLE); })
    .finally(() => { clearTimeout(timeout); policyRequest = null; });
  return policyRequest;
}

export function onGoogleMapsAuthFailure(listener: () => void) {
  authListeners.add(listener);
  return () => { authListeners.delete(listener); };
}

/** One lazy browser load, shared by the student map and every console picker. */
export function loadGoogleMaps(): Promise<GoogleMapLibraries> {
  if (typeof window === "undefined") return Promise.reject(new Error(MAP_UNAVAILABLE));
  if (!apiKey) return Promise.reject(new Error("The map is not available yet."));
  if (authorizationFailed) return Promise.reject(new Error(MAP_UNAVAILABLE));
  if (pending) return pending;
  if (!configured) {
    const browser = window as Window & { gm_authFailure?: () => void };
    const previous = browser.gm_authFailure;
    browser.gm_authFailure = () => {
      authorizationFailed = true;
      authListeners.forEach(listener => listener());
      previous?.();
    };
    setOptions({ key: apiKey, v: "weekly", language: "en", region: "GH" });
    configured = true;
  }
  const loading = Promise.all([importLibrary("maps"), importLibrary("marker"), importLibrary("core")]);
  pending = new Promise<GoogleMapLibraries>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(MAP_UNAVAILABLE)), 20_000);
    loading.then(([maps, marker, core]) => {
      if (authorizationFailed) reject(new Error(MAP_UNAVAILABLE));
      else resolve({ maps, marker, core });
    }, () => reject(new Error(MAP_UNAVAILABLE))).finally(() => window.clearTimeout(timeout));
  }).catch(error => {
    pending = null;
    throw error;
  });
  return pending;
}

/** GeoJSON uses longitude first; Google Maps uses named latitude/longitude. */
export function googlePoint(longitude: number, latitude: number): google.maps.LatLngLiteral {
  return { lat: latitude, lng: longitude };
}

export function validMapPoint(latitude: number | null, longitude: number | null): boolean {
  return typeof latitude === "number" && typeof longitude === "number"
    && Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function googleMapsLocationLink(latitude: number, longitude: number) {
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(latitude + "," + longitude);
}

export function fitGoogleMap(map: google.maps.Map, core: google.maps.CoreLibrary, points: google.maps.LatLngLiteral[], maxZoom = 16) {
  if (!points.length) return;
  if (points.length === 1) { map.setCenter(points[0]); map.setZoom(maxZoom); return; }
  const bounds = new core.LatLngBounds();
  points.forEach(point => bounds.extend(point));
  map.fitBounds(bounds, 48);
  core.event.addListenerOnce(map, "idle", () => {
    if ((map.getZoom() || 0) > maxZoom) map.setZoom(maxZoom);
  });
}
