import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());
const maps = await vite.ssrLoadModule("/lib/osm-maps.ts");

test("OSM tile templates require HTTPS and a usable zoom/x/y path", () => {
  assert.equal(maps.validTileUrl(maps.DEFAULT_OSM_TILE_URL), true);
  assert.equal(maps.validTileUrl("https://tiles.example.com/{z}/{x}/{y}.png?key=public"), true);
  assert.equal(maps.validTileUrl("http://tile.openstreetmap.org/{z}/{x}/{y}.png"), false);
  assert.equal(maps.validTileUrl("javascript:alert(1)"), false);
  assert.equal(maps.validTileUrl("https://tiles.example.com/{z}/{x}.png"), false);
  assert.equal(maps.osmLocationLink(5.3, -2), "https://www.openstreetmap.org/?mlat=5.3&mlon=-2#map=17/5.3/-2");
});

test("the OSM display adds visible attribution and disposes only once", () => {
  const calls = [];
  const map = { setView(point, zoom) { calls.push(["view", point, zoom]); return this; }, remove() { calls.push(["remove"]); } };
  const tiles = { addTo(target) { calls.push(["tiles", target]); return this; } };
  const L = {
    map(_element, options) { calls.push(["map", options]); return map; },
    tileLayer(url, options) { calls.push(["layer", url, options]); return tiles; },
  };
  const instance = maps.createOsmMap(L, {}, { center: { lat: 5.3, lng: -2 }, zoom: 14 });
  assert.match(calls[2][2].attribution, /OpenStreetMap/);
  assert.equal(calls[2][1], maps.DEFAULT_OSM_TILE_URL);
  maps.disposeOsmMap(instance);
  maps.disposeOsmMap(instance);
  assert.equal(calls.filter(item => item[0] === "remove").length, 1);
});
