import { envValue } from "@/lib/runtime-env";
import { distanceKm } from "@/lib/campus-location";

export type RouteCoordinate = { latitude: number; longitude: number };
export type CampusRouteGeometry = {
  type: "LineString";
  coordinates: Array<[number, number]>;
};

type OsrmRoute = {
  distance?: number;
  duration?: number;
  geometry?: CampusRouteGeometry;
};

type GoogleRoute = {
  distanceMeters?: number;
  duration?: string;
  polyline?: { geoJsonLinestring?: CampusRouteGeometry };
};

const DEFAULT_ROUTING_BASE_URL = "https://router.project-osrm.org";
const DIRECT_SPEED_KPH = 18;

function validCoordinate(value: unknown): value is RouteCoordinate {
  const coordinate = value as RouteCoordinate;
  return Number.isFinite(coordinate?.latitude)
    && Number.isFinite(coordinate?.longitude)
    && coordinate.latitude >= -90
    && coordinate.latitude <= 90
    && coordinate.longitude >= -180
    && coordinate.longitude <= 180;
}

function directRoute(origin: RouteCoordinate, destination: RouteCoordinate, reason = "DIRECT_FALLBACK") {
  const km = distanceKm(origin, destination);
  const durationSeconds = Number.isFinite(km) ? Math.max(60, Math.round((km / DIRECT_SPEED_KPH) * 3600)) : 0;
  const midLatitude = (origin.latitude + destination.latitude) / 2;
  const midLongitude = (origin.longitude + destination.longitude) / 2;
  const bend = Math.min(0.0012, Math.max(0.00035, Math.abs(origin.latitude - destination.latitude) + Math.abs(origin.longitude - destination.longitude)) / 5);
  return {
    geometry: { type: "LineString" as const, coordinates: [
      [origin.longitude, origin.latitude],
      [midLongitude + bend, midLatitude - bend],
      [destination.longitude, destination.latitude],
    ] },
    distanceMeters: Number.isFinite(km) ? Math.round(km * 1000) : 0,
    durationSeconds,
    provider: "direct",
    fallback: true,
    reason,
  };
}

function secondsFromGoogleDuration(value?: string) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.round(Number(match[1])) : 0;
}

async function googleRoute(origin: RouteCoordinate, destination: RouteCoordinate) {
  const apiKey = await envValue("GOOGLE_MAPS_API_KEY", ["GoogleMap_JAVASCRIPT_KEY", "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"]);
  if (!apiKey) return directRoute(origin, destination, "GOOGLE_ROUTES_KEY_MISSING");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.geoJsonLinestring",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
        destination: { location: { latLng: { latitude: destination.latitude, longitude: destination.longitude } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
        polylineEncoding: "GEO_JSON_LINESTRING",
      }),
    });
    if (!response.ok) return directRoute(origin, destination, "GOOGLE_ROUTES_HTTP_ERROR");
    const data = await response.json() as { routes?: GoogleRoute[] };
    const route = data.routes?.[0];
    if (!route) return directRoute(origin, destination, "GOOGLE_ROUTES_NO_ROUTE");
    const geometry = route?.polyline?.geoJsonLinestring;
    if (!geometry?.coordinates?.length) return directRoute(origin, destination, "GOOGLE_ROUTES_NO_ROUTE");
    return {
      geometry,
      distanceMeters: Math.round(Number(route.distanceMeters || 0)),
      durationSeconds: secondsFromGoogleDuration(route.duration),
      provider: "google",
      fallback: false,
      reason: "",
    };
  } catch {
    return directRoute(origin, destination, "GOOGLE_ROUTES_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}

export async function campusRoadRoute(origin: RouteCoordinate, destination: RouteCoordinate) {
  if (!validCoordinate(origin) || !validCoordinate(destination)) {
    throw new Error("Valid origin and destination coordinates are required.");
  }

  const provider = (await envValue("CAMPUS_ROUTING_PROVIDER")).toLowerCase();
  if (provider === "google") return googleRoute(origin, destination);

  const baseUrl = (await envValue("CAMPUS_ROUTING_BASE_URL", ["NEXT_PUBLIC_CAMPUS_ROUTING_BASE_URL"])) || DEFAULT_ROUTING_BASE_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const url = new URL(`/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`, baseUrl);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("steps", "false");
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return directRoute(origin, destination, "ROUTER_HTTP_ERROR");
    const data = await response.json() as { code?: string; routes?: OsrmRoute[] };
    const route = data.routes?.[0];
    if (data.code !== "Ok" || !route?.geometry?.coordinates?.length) return directRoute(origin, destination, "ROUTER_NO_ROUTE");
    return {
      geometry: route.geometry,
      distanceMeters: Math.round(Number(route.distance || 0)),
      durationSeconds: Math.round(Number(route.duration || 0)),
      provider: "osrm",
      fallback: false,
      reason: "",
    };
  } catch {
    return directRoute(origin, destination, "ROUTER_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}
