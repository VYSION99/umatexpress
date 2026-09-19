import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// The client launcher is the front door: every card must point somewhere real,
// partner cards must leave the app for their own origin, and a layout saved
// before a service existed must pick the new card up instead of hiding it.

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());
const { services, defaultPreferences, normalizePreferences } = await vite.ssrLoadModule("/components/launcher/services.ts");

const ACCENTS = new Set(["cyan", "green", "yellow"]);
const PARTNERS = {
  research: "https://acmdresearch.com",
  clipad: "https://clipad.optavel.com",
};

test("every launcher card is complete and unique", () => {
  assert.ok(services.length >= 7);
  assert.equal(new Set(services.map((service) => service.id)).size, services.length);
  assert.equal(new Set(services.map((service) => service.title)).size, services.length);
  for (const service of services) {
    assert.ok(service.title.trim(), `${service.id} needs a title`);
    assert.ok(service.description.trim(), `${service.id} needs a description`);
    assert.ok(service.detail.trim(), `${service.id} needs a detail line`);
    assert.ok(service.category.trim(), `${service.id} needs a category`);
    assert.ok(ACCENTS.has(service.accent), `${service.id} uses an unknown accent`);
    if (service.available) assert.ok(service.destination, `${service.id} is available but has no destination`);
    if (!service.available) assert.equal(service.destination, null, `${service.id} is coming soon and must not link anywhere`);
  }
});

test("no two neighbouring cards share a hue", () => {
  for (let index = 1; index < services.length; index += 1) {
    assert.notEqual(services[index].accent, services[index - 1].accent, `${services[index].id} repeats its neighbour's accent`);
  }
});

test("partner services open on their own origin in a new tab", () => {
  for (const [id, url] of Object.entries(PARTNERS)) {
    const service = services.find((item) => item.id === id);
    assert.ok(service, `${id} must be on the launcher`);
    assert.equal(service.destination, url);
    assert.equal(service.external, true, `${id} runs outside the app`);
    assert.match(service.description, /\w/, `${id} needs a plain-language description`);
  }
  for (const service of services) {
    if (!service.destination?.startsWith("http")) continue;
    assert.ok(service.external, `${service.id} leaves the app but is not marked external`);
    assert.match(service.destination, /^https:\/\//, `${service.id} must use https`);
  }
});

test("a layout saved before a service existed gains the new cards", () => {
  const stored = [{ id: "campus", hidden: true, pinned: true }];
  const preferences = normalizePreferences(stored);
  assert.equal(preferences.length, services.length, "every service gets a preference row");
  assert.deepEqual(preferences[0], { id: "campus", hidden: true, pinned: true });
  for (const id of Object.keys(PARTNERS)) {
    assert.ok(preferences.some((row) => row.id === id && !row.hidden), `${id} must be visible by default`);
  }
  assert.deepEqual(defaultPreferences().map((row) => row.id), services.map((service) => service.id));
});
