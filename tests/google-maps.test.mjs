import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const previousWindow = globalThis.window;
const previousGoogle = globalThis.google;
const previousFetch = globalThis.fetch;
const previousKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
let sequence = 0;
const vite = await createServer({
  appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});
beforeEach(() => {
  globalThis.__mapsTest = { imports: [], reject: false, libraries: { maps: {}, marker: {}, core: {} } };
  // Supply the browser API boundary while exercising the real loader package.
  globalThis.google = { maps: { async importLibrary(name) {
    const state = globalThis.__mapsTest;
    state.imports.push(name);
    if (state.reject) throw new Error("network unavailable");
    if (state.wait) await state.wait;
    return state.libraries[name];
  } } };
  globalThis.window = { setTimeout, clearTimeout, google: globalThis.google };
});
after(async () => {
  await vite.close();
  globalThis.fetch = previousFetch;
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (previousGoogle === undefined) delete globalThis.google;
  else globalThis.google = previousGoogle;
  if (previousKey === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  else process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = previousKey;
  delete globalThis.__mapsTest;
});
async function fresh(key = "test-browser-key") {
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = key;
  return vite.ssrLoadModule("/lib/google-maps.ts?test=" + ++sequence);
}

test("missing or stringified missing credentials never request Google", async () => {
  for (const key of ["", "undefined", "null", "  "]) {
    const maps = await fresh(key);
    await assert.rejects(maps.loadGoogleMaps(), /not available yet/);
  }
  assert.deepEqual(globalThis.__mapsTest.imports, []);
});

test("multiple maps share one lazy library load", async () => {
  const maps = await fresh();
  const first = maps.loadGoogleMaps();
  assert.equal(maps.loadGoogleMaps(), first);
  const result = await first;
  assert.equal(result.marker, globalThis.__mapsTest.libraries.marker);
  assert.deepEqual(globalThis.__mapsTest.imports, ["maps", "marker", "core"]);
});

test("a failed library load can be retried successfully", async () => {
  const maps = await fresh();
  globalThis.__mapsTest.reject = true;
  await assert.rejects(maps.loadGoogleMaps(), /unavailable/);
  globalThis.__mapsTest.reject = false;
  assert.ok((await maps.loadGoogleMaps()).maps);
});

test("a stalled script times out and allows a later retry", async () => {
  const maps = await fresh();
  let timeout;
  globalThis.window.setTimeout = callback => { timeout = callback; return 1; };
  globalThis.window.clearTimeout = () => {};
  globalThis.__mapsTest.wait = new Promise(() => {});
  const pending = maps.loadGoogleMaps();
  timeout();
  await assert.rejects(pending, /unavailable/);
  globalThis.__mapsTest.wait = null;
  assert.ok((await maps.loadGoogleMaps()).marker);
});

test("authorization failures after loading notify mounted maps and never expose the key", async () => {
  const maps = await fresh();
  let failures = 0;
  const unsubscribe = maps.onGoogleMapsAuthFailure(() => failures++);
  await maps.loadGoogleMaps();
  globalThis.window.gm_authFailure();
  assert.equal(failures, 1);
  await assert.rejects(maps.loadGoogleMaps(), error => /unavailable/.test(error.message) && !error.message.includes("test-browser-key"));
  unsubscribe();
  globalThis.window.gm_authFailure();
  assert.equal(failures, 1);
});

test("GeoJSON coordinates keep longitude and latitude in the correct order", async () => {
  const maps = await fresh();
  assert.deepEqual(maps.googlePoint(-1.9931, 5.3018), { lat: 5.3018, lng: -1.9931 });
  assert.equal(maps.validMapPoint(null, null), false);
  assert.equal(maps.validMapPoint(NaN, -2), false);
  assert.equal(maps.validMapPoint(95, -2), false);
  assert.equal(maps.validMapPoint(5.3, -1.99), true);
  assert.equal(maps.validMapPoint(0, 0), true);
  assert.equal(new URL(maps.googleMapsLocationLink(5.3018, -1.9931)).searchParams.get("query"), "5.3018,-1.9931");
});


test("map policy reads share a request and recheck the admin switch on the next mount", async () => {
  const maps = await fresh();
  let enabled = false;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/maps/config");
    assert.equal(options.cache, "no-store");
    requests++;
    return Response.json({ googleMapsEnabled: enabled });
  };
  const first = maps.googleMapsEnabled();
  assert.equal(maps.googleMapsEnabled(), first);
  assert.equal(await first, false);
  assert.equal(requests, 1);
  assert.deepEqual(globalThis.__mapsTest.imports, [], "checking policy does not load Google");
  enabled = true;
  assert.equal(await maps.googleMapsEnabled(), true);
  assert.equal(requests, 2);
});

test("unreadable or invalid map policy fails closed and can be retried", async () => {
  const maps = await fresh();
  for (const response of [() => Response.json({}, { status: 503 }), () => Response.json({ googleMapsEnabled: "true" }), () => { throw Error("offline"); }]) {
    globalThis.fetch = async () => response();
    await assert.rejects(maps.googleMapsEnabled(), /unavailable/);
    assert.deepEqual(globalThis.__mapsTest.imports, []);
  }
  globalThis.fetch = async () => Response.json({ googleMapsEnabled: false });
  assert.equal(await maps.googleMapsEnabled(), false);
});
