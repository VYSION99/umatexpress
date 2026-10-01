export type MapPoint = { lat: number; lng: number };
export type MapEvent = { target?: unknown; currentPointer?: { viewportX: number; viewportY: number } };
export type MapObject = { addEventListener(type: string, callback: (event: MapEvent) => void): void; removeEventListener(type: string, callback: (event: MapEvent) => void): void };
export type HereMarker = MapObject & { draggable: boolean; getGeometry(): MapPoint; setGeometry(point: MapPoint): void };
export type HerePolyline = MapObject & { getBoundingBox(): unknown };
export type HereMap = MapObject & {
  addObject(object: MapObject): void; removeObject(object: MapObject): void;
  setCenter(point: MapPoint): void; setZoom(zoom: number): void; getZoom(): number;
  getViewModel(): { setLookAtData(data: { bounds: unknown }): void };
  getViewPort(): { resize(): void };
  screenToGeo(x: number, y: number): MapPoint;
  geoToScreen(point: MapPoint): { x: number; y: number };
  dispose(): void;
};
export type HereUi = { addBubble(bubble: HereBubble): void; removeBubble(bubble: HereBubble): void; dispose(): void };
export type HereBubble = { setContent(content: HTMLElement): void; setPosition(point: MapPoint): void };
export type HereApi = {
  service: { Platform: new (options: { apikey: string }) => { createDefaultLayers(): { vector: { normal: { map: unknown } } } } };
  Map: new (element: HTMLElement, layer: unknown, options: { center: MapPoint; zoom: number; pixelRatio?: number }) => HereMap;
  mapevents: { MapEvents: new (map: HereMap) => object; Behavior: { new (events: object): { disable(feature: unknown): void; enable(feature: unknown): void }; Feature: { PANNING: unknown } }; };
  ui: { UI: { createDefault(map: HereMap, layers: unknown): HereUi }; InfoBubble: new (point: MapPoint, options: { content: HTMLElement }) => HereBubble };
  map: { Marker: new (point: MapPoint) => HereMarker; DomIcon: new (element: HTMLElement) => unknown; DomMarker: new (point: MapPoint, options: { icon: unknown }) => HereMarker; Polyline: new (line: unknown, options: { style: { strokeColor: string; lineWidth: number; lineJoin?: string } }) => HerePolyline };
  geo: { LineString: new () => { pushPoint(point: MapPoint): void }; Rect: new (top: number, left: number, bottom: number, right: number) => unknown };
};

declare global { interface Window { H?: HereApi } }

export const MAP_UNAVAILABLE = "The map is unavailable right now. Please try again.";
const SCRIPT_BASE = "https://js.api.here.com/v3/3.2/";
let pending: Promise<HereApi> | null = null;
let policyRequest: Promise<{ enabled: boolean; apiKey: string }> | null = null;

export function hereMapsConfig(): Promise<{ enabled: boolean; apiKey: string }> {
  if (policyRequest) return policyRequest;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  policyRequest = fetch("/api/maps/config", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
    .then(async response => {
      if (!response.ok) throw new Error(MAP_UNAVAILABLE);
      const data = await response.json();
      if (typeof data.hereMapsEnabled !== "boolean" || typeof data.hereApiKey !== "string") throw new Error(MAP_UNAVAILABLE);
      return { enabled: data.hereMapsEnabled as boolean, apiKey: data.hereApiKey.trim() };
    })
    .catch(() => { throw new Error(MAP_UNAVAILABLE); })
    .finally(() => { clearTimeout(timeout); policyRequest = null; });
  return policyRequest;
}

function loadScript(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_BASE + name;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error(MAP_UNAVAILABLE)); };
    document.head.append(script);
  });
}

/** HERE modules load once, after the admin policy and browser key are checked. */
export function loadHereMaps(): Promise<HereApi> {
  if (typeof window === "undefined") return Promise.reject(new Error(MAP_UNAVAILABLE));
  if (window.H?.ui?.UI) return Promise.resolve(window.H);
  if (pending) return pending;
  pending = new Promise<HereApi>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(MAP_UNAVAILABLE)), 20_000);
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = SCRIPT_BASE + "mapsjs-ui.css";
    document.head.append(css);
    void (async () => {
      if (!window.H?.service) await loadScript("mapsjs-core.js");
      if (!window.H?.service?.Platform) await loadScript("mapsjs-service.js");
      if (!window.H?.mapevents) await loadScript("mapsjs-mapevents.js");
      if (!window.H?.ui) await loadScript("mapsjs-ui.js");
      if (!window.H?.ui?.UI) throw new Error(MAP_UNAVAILABLE);
      return window.H;
    })().then(resolve, reject).finally(() => window.clearTimeout(timeout));
  }).catch(() => { pending = null; throw new Error(MAP_UNAVAILABLE); });
  return pending;
}

export function createHereMap(api: HereApi, element: HTMLElement, options: { center: MapPoint; zoom: number }, apiKey: string) {
  if (!apiKey || ["undefined", "null"].includes(apiKey)) throw new Error("The map is not available yet.");
  const platform = new api.service.Platform({ apikey: apiKey });
  const layers = platform.createDefaultLayers();
  const map = new api.Map(element, layers.vector.normal.map, { ...options, pixelRatio: Math.min(window.devicePixelRatio || 1, 2) });
  const behavior = new api.mapevents.Behavior(new api.mapevents.MapEvents(map));
  const ui = api.ui.UI.createDefault(map, layers);
  return { api, map, ui, behavior };
}
export type HereMapInstance = ReturnType<typeof createHereMap>;
export function herePoint(longitude: number, latitude: number): MapPoint { return { lat: latitude, lng: longitude }; }
export function validMapPoint(latitude: number | null, longitude: number | null): boolean {
  return typeof latitude === "number" && typeof longitude === "number" && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}
export function hereLocationLink(latitude: number, longitude: number) {
  return `https://share.here.com/l/${latitude},${longitude}`;
}
export function fitHereMap(instance: HereMapInstance, points: MapPoint[], maxZoom = 16) {
  if (!points.length) return;
  const { map } = instance;
  if (points.length === 1) { map.setCenter(points[0]); map.setZoom(maxZoom); return; }
  const north = Math.max(...points.map(point => point.lat));
  const south = Math.min(...points.map(point => point.lat));
  const east = Math.max(...points.map(point => point.lng));
  const west = Math.min(...points.map(point => point.lng));
  // HERE accepts a literal rectangular bounding box in look-at data.
  map.getViewModel().setLookAtData({ bounds: new instance.api.geo.Rect(north + .0003, west - .0003, south - .0003, east + .0003) });
  if (map.getZoom() > maxZoom) map.setZoom(maxZoom);
}
export function herePolyline(instance: HereMapInstance, points: MapPoint[], color: string, width: number) {
  const line = new instance.api.geo.LineString();
  points.forEach(point => line.pushPoint(point));
  const path = new instance.api.map.Polyline(line, { style: { strokeColor: color, lineWidth: width, lineJoin: "round" } });
  instance.map.addObject(path);
  return path;
}
export function hereDomMarker(instance: HereMapInstance, point: MapPoint, element: HTMLElement) {
  const pin = new instance.api.map.DomMarker(point, { icon: new instance.api.map.DomIcon(element) });
  instance.map.addObject(pin);
  return pin;
}
export function openHereBubble(instance: HereMapInstance, point: MapPoint, content: HTMLElement) {
  const bubble = new instance.api.ui.InfoBubble(point, { content });
  instance.ui.addBubble(bubble);
  return bubble;
}
