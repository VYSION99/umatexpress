import type * as Leaflet from "leaflet";

export type MapPoint = { lat: number; lng: number };
export type OsmMapInstance = { L: typeof Leaflet; map: Leaflet.Map; tiles: Leaflet.TileLayer; disposed: boolean };

export const MAP_UNAVAILABLE = "The map is unavailable right now. Please try again.";
export const DEFAULT_OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

export function mapPoint(longitude: number, latitude: number): MapPoint { return { lat: latitude, lng: longitude }; }
export function validMapPoint(latitude: number | null, longitude: number | null): boolean {
  return typeof latitude === "number" && typeof longitude === "number" && Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}
export function osmLocationLink(latitude: number, longitude: number) {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
}
export function validTileUrl(value: string) {
  if (!["{z}", "{x}", "{y}"].every(part => value.includes(part))) return false;
  try {
    const url = new URL(value.replaceAll("{z}", "1").replaceAll("{x}", "1").replaceAll("{y}", "1"));
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
export function createOsmMap(L: typeof Leaflet, element: HTMLElement, options: { center: MapPoint; zoom: number }, tileUrl = DEFAULT_OSM_TILE_URL): OsmMapInstance {
  if (!validTileUrl(tileUrl)) throw new Error(MAP_UNAVAILABLE);
  const map = L.map(element, { zoomControl: true, attributionControl: true, preferCanvas: true }).setView([options.center.lat, options.center.lng], options.zoom);
  const tiles = L.tileLayer(tileUrl, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
  return { L, map, tiles, disposed: false };
}
export function disposeOsmMap(instance: OsmMapInstance) {
  if (instance.disposed) return;
  instance.disposed = true;
  instance.map.remove();
}
export function fitOsmMap(instance: OsmMapInstance, points: MapPoint[], maxZoom = 16) {
  if (!points.length || instance.disposed) return;
  if (points.length === 1) { instance.map.setView([points[0].lat, points[0].lng], maxZoom); return; }
  instance.map.fitBounds(instance.L.latLngBounds(points.map(point => [point.lat, point.lng] as [number, number])), { padding: [28, 28], maxZoom });
}
export function osmPolyline(instance: OsmMapInstance, points: MapPoint[], color: string, width: number) {
  return instance.L.polyline(points.map(point => [point.lat, point.lng] as [number, number]), { color, weight: width, lineJoin: "round" }).addTo(instance.map);
}
export function osmDomMarker(instance: OsmMapInstance, point: MapPoint, element: HTMLElement) {
  return instance.L.marker([point.lat, point.lng], { icon: instance.L.divIcon({ html: element, className: "osm-marker-icon", iconSize: [36, 36], iconAnchor: [18, 18] }) }).addTo(instance.map);
}
export function openOsmPopup(marker: Leaflet.Marker, content: HTMLElement) {
  marker.bindPopup(content, { maxWidth: 280 }).openPopup();
}
