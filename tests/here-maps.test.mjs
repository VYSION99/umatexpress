import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const previousWindow = globalThis.window;
const previousDocument = globalThis.document;
const previousFetch = globalThis.fetch;
let sequence = 0;
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => {
  await vite.close();
  globalThis.fetch = previousFetch;
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
});
async function fresh() {
  return vite.ssrLoadModule("/lib/here-maps.ts?test=" + ++sequence);
}

test("missing credentials refuse map creation before loading layers", async () => {
  const maps = await fresh();
  for (const key of ["", "undefined", "null"]) {
    assert.throws(() => maps.createHereMap({}, {}, { center: { lat: 5.3, lng: -2 }, zoom: 14 }, key), /not available yet/);
  }
});

test("map policy is checked again for each mount and fails closed", async () => {
  const maps = await fresh();
  let requests = 0;
  let enabled = false;
  globalThis.fetch = async (_url, options) => {
    assert.equal(_url, "/api/maps/config");
    assert.equal(options.cache, "no-store");
    requests++;
    return Response.json({ hereMapsEnabled: enabled, hereApiKey: enabled ? "test-key" : "" });
  };
  const first = maps.hereMapsConfig();
  assert.equal(maps.hereMapsConfig(), first);
  assert.deepEqual(await first, { enabled: false, apiKey: "" });
  enabled = true;
  assert.deepEqual(await maps.hereMapsConfig(), { enabled: true, apiKey: "test-key" });
  assert.equal(requests, 2);
  globalThis.fetch = async () => Response.json({ hereMapsEnabled: "true", hereApiKey: "test-key" });
  await assert.rejects(maps.hereMapsConfig(), /unavailable/);
});

test("GeoJSON coordinates preserve longitude/latitude order", async () => {
  const maps = await fresh();
  assert.deepEqual(maps.herePoint(-1.9931, 5.3018), { lat: 5.3018, lng: -1.9931 });
  assert.equal(maps.validMapPoint(null, null), false);
  assert.equal(maps.validMapPoint(5.3, -1.99), true);
  assert.equal(maps.validMapPoint(95, -2), false);
  assert.equal(maps.hereLocationLink(5.3018, -1.9931), "https://share.here.com/l/5.3018,-1.9931");
});

test("HERE modules load once in dependency order and share a concurrent request", async () => {
  const scripts = [];
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.document = {
    createElement(tag) { return { tagName: tag, remove() {} }; },
    head: { append(node) {
      if (node.tagName !== "script") return;
      const name = node.src.split("/").at(-1);
      scripts.push(name);
      queueMicrotask(() => {
        if (name === "mapsjs-core.js") globalThis.window.H = { service: {} };
        if (name === "mapsjs-service.js") globalThis.window.H.service.Platform = class {};
        if (name === "mapsjs-mapevents.js") globalThis.window.H.mapevents = {};
        if (name === "mapsjs-ui.js") globalThis.window.H.ui = { UI: {} };
        node.onload();
      });
    } },
  };
  const maps = await fresh();
  const first = maps.loadHereMaps();
  assert.equal(maps.loadHereMaps(), first);
  assert.equal(await first, globalThis.window.H);
  assert.deepEqual(scripts, ["mapsjs-core.js", "mapsjs-service.js", "mapsjs-mapevents.js", "mapsjs-ui.js"]);
  await maps.loadHereMaps();
  assert.equal(scripts.length, 4);
});
