import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

// The client launcher is the front door: every card must point somewhere real,
// partner cards must leave the app for their own origin, and a layout saved
// before a service existed must pick the new card up instead of hiding it.

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());
const { services, defaultPreferences, normalizePreferences, homepageServices, isServiceHidden, navServices, navLabel } = await vite.ssrLoadModule("/components/launcher/services.ts");
const { default: CampusLauncher } = await vite.ssrLoadModule("/components/launcher/CampusLauncher.tsx");

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

test("the homepage and the services sheet only carry live services", () => {
  const open = services.filter((service) => service.available).map((service) => service.id);
  assert.deepEqual(homepageServices(defaultPreferences()).map((service) => service.id), open, "the rail mirrors the open services in registry order");
  assert.ok(!open.includes("food"), "coming-soon services stay in On the way");

  const hidden = normalizePreferences([{ id: "vacation", hidden: true, pinned: false }]);
  assert.ok(isServiceHidden(hidden, "vacation"), "a hidden service reports itself");
  assert.ok(!isServiceHidden(hidden, "campus"), "untouched services stay visible");
  assert.deepEqual(homepageServices(hidden).map((service) => service.id), open.filter((id) => id !== "vacation"), "hiding a service drops its banner card");

  const pinned = homepageServices(normalizePreferences([{ id: "cinema", pinned: true }]));
  assert.ok(pinned.findIndex((service) => service.id === "cinema") < pinned.findIndex((service) => service.id === "hostels"), "pinned cards lead the rail");
});

test("the bottom bar carries the live in-app services the student kept", () => {
  const internal = services
    .filter((service) => service.available && service.destination?.startsWith("/"))
    .map((service) => service.id);
  assert.deepEqual(navServices(defaultPreferences()).map((service) => service.id), internal, "the bar mirrors the live in-app services");
  assert.ok(internal.includes("cinema"), "a service that is open belongs in the bar");
  for (const id of Object.keys(PARTNERS)) assert.ok(!internal.includes(id), `${id} runs outside the app and stays off the bar`);
  assert.ok(!internal.includes("food"), "coming-soon services stay off the bar");

  const hidden = normalizePreferences([{ id: "cinema", hidden: true, pinned: false }]);
  assert.deepEqual(navServices(hidden).map((service) => service.id), internal.filter((id) => id !== "cinema"), "hiding a service drops it from the bar");

  const pinned = navServices(normalizePreferences([{ id: "cinema", pinned: true }]));
  assert.equal(pinned[0].id, "cinema", "the bar follows the rail's pinned-first order");
});

test("every bar label is short enough for a phone", () => {
  for (const service of services) {
    const label = navLabel(service);
    assert.ok(label.trim(), `${service.id} needs a bar label`);
    assert.ok(label.length <= 14, `${service.id}'s bar label is too long: ${label}`);
  }
  assert.equal(navLabel(services.find((service) => service.id === "hostels")), "Hostels");
  assert.equal(navLabel(services.find((service) => service.id === "cinema")), "Cinema");
});

test("the shell's bottom bar renders Home plus the live in-app services", async () => {
  const { CampusNav } = await vite.ssrLoadModule("/components/campusRide/shared/CampusNav.tsx");
  const html = renderToStaticMarkup(createElement(CampusNav, { area: "CINEMA", variant: "mobile" }));
  for (const label of ["Home", "CampusRide", "VacationRide", "Hostels", "Cinema"]) {
    assert.ok(html.includes(`>${label}<`), `the bar is missing ${label}`);
  }
  assert.ok(!html.includes("Food"), "a coming-soon service stays off the bar");
  for (const url of Object.values(PARTNERS)) assert.ok(!html.includes(url), `${url} opens another origin and stays off the bar`);
  assert.match(html, /<a[^>]*aria-current="page"[^>]*href="\/cinema"/, "the area the shell is in is marked current");
});

test("each partner carries the banner its spotlight card renders", () => {
  for (const id of Object.keys(PARTNERS)) {
    const service = services.find((item) => item.id === id);
    assert.ok(service.feature.trim(), `${id} needs long-form copy for the big card`);
    assert.ok(service.banner?.src.startsWith("/"), `${id} must serve its brand asset from our own origin`);
    assert.ok(existsSync(new URL(`../public${service.banner.src}`, import.meta.url)), `${id} points at a missing asset: ${service.banner.src}`);
    if (service.banner.kind === "image") assert.ok(service.banner.alt.trim(), `${id} banner needs alt text`);
    if (service.banner.kind === "mark") assert.ok(service.banner.word.trim(), `${id} needs the wordmark text`);
  }
});

test("the homepage gives every partner the same full-width card as the rides", () => {
  const html = renderToStaticMarkup(createElement(CampusLauncher));
  const rides = ["CampusRide", "VacationRide"].every((name) => html.includes(name));
  assert.ok(rides, "the ride cards must still render");
  for (const [id, url] of Object.entries(PARTNERS)) {
    const service = services.find((item) => item.id === id);
    assert.ok(html.includes(`id="home-${id}-title"`), `${id} needs a spotlight card heading`);
    assert.ok(html.includes(`src="${service.banner.src}"`), `${id} needs its brand asset on the card`);
    assert.ok(html.includes(`href="${url}"`), `${id} card must link to the service`);
    assert.ok(html.includes(service.feature), `${id} card must carry its spotlight copy`);
  }
  assert.equal((html.match(/target="_blank"/g) || []).length >= 4, true, "rail and spotlight cards both leave the app");
});

test("the homepage rail never advertises a service that is not open", () => {
  const html = renderToStaticMarkup(createElement(CampusLauncher));
  const rail = html.slice(html.indexOf('class="home-rail"'), html.indexOf("home-feature"));
  assert.ok(rail.includes("home-card"), "the rail still renders live cards");
  assert.ok(!rail.includes("Food"), "Food belongs to the On the way strip, not the rail");
});
