import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

// The public flyer carousel must advertise real coaches only: route lines are
// composed from live trips, placeholder text ("GHS ---") never ships, and each
// approved organizer's notice is a slide of its own.

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());
const { assemblePublicNotices, cleanFlyerPromo, composeRouteLine, isPlaceholderText, noticeDestinations } = await vite.ssrLoadModule("/lib/trip-notice.ts");
const { default: FlyerCarousel } = await vite.ssrLoadModule("/components/vacation/FlyerCarousel.tsx");

const promo = (overrides = {}) => ({
  enabled: true,
  title: "UMaT Express",
  route: "",
  fare: "",
  nightBus: "",
  dayBuses: [],
  dropOffPoints: [],
  amenities: [],
  contacts: [],
  ...overrides,
});

test("a placeholder is never mistaken for content", () => {
  assert.equal(isPlaceholderText("---"), true);
  assert.equal(isPlaceholderText("GHS ---"), true);
  assert.equal(isPlaceholderText("gh₵ —"), true);
  assert.equal(isPlaceholderText("   "), true);
  assert.equal(isPlaceholderText("GH₵ 190"), false);
  assert.equal(isPlaceholderText("Free Wi-Fi"), false);
});

test("cleaning drops placeholders and tidies typed lists", () => {
  const cleaned = cleanFlyerPromo(promo({
    route: "Accra,Kumasi,   Sunyani",
    fare: "GHS ---",
    nightBus: "---",
    dayBuses: ["9th Oct @ 6am", "---"],
    amenities: ["Item 13 assured", " "],
  }));
  assert.equal(cleaned.route, "Accra, Kumasi, Sunyani", "stray commas are tidied, not shown raw");
  assert.equal(cleaned.fare, "");
  assert.equal(cleaned.nightBus, "");
  assert.deepEqual(cleaned.dayBuses, ["9th Oct @ 6am"]);
  assert.deepEqual(cleaned.amenities, ["Item 13 assured"]);
});

test("the route line is composed from live coaches", () => {
  const routes = [
    { from: "UMaT Main Campus", to: "Accra" },
    { from: "UMaT Main Campus", to: "Kumasi" },
    { from: "UMaT Main Campus", to: "Accra" },
    { from: "UMaT Main Campus", to: "Sunyani" },
  ];
  assert.equal(composeRouteLine(routes), "UMaT Main Campus → Accra, Kumasi, Sunyani");
  assert.deepEqual(noticeDestinations(routes), ["Accra", "Kumasi", "Sunyani"]);
  assert.equal(composeRouteLine([]), "", "nothing live means the saved fallback is used");
});

test("several origins are listed as pairs, oldest overflow summarised", () => {
  const routes = [
    { from: "Campus", to: "Accra" },
    { from: "Campus Annex", to: "Kumasi" },
    { from: "Takoradi", to: "Accra" },
    { from: "Tamale", to: "Kumasi" },
  ];
  const line = composeRouteLine(routes, 2);
  assert.equal(line, "Campus → Accra · Campus Annex → Kumasi · +2 more");
});

test("the carousel shows the platform notice first and organizers by name", () => {
  const notices = assemblePublicNotices({
    platform: promo({ route: "Accra" }),
    platformRoutes: [{ from: "UMaT Main Campus", to: "Accra" }],
    organizers: [
      { id: "org-b", name: "Zeta Travel", promo: promo({ title: "Zeta" }), routes: [{ from: "Campus", to: "Takoradi" }] },
      { id: "org-a", name: "Alpha Travel", promo: promo({ title: "Alpha" }), routes: [{ from: "Campus", to: "Accra" }] },
      { id: "org-off", name: "Off Travel", promo: promo({ enabled: false }), routes: [{ from: "Campus", to: "Accra" }] },
      { id: "org-empty", name: "Empty Travel", promo: promo({ title: "", route: "", fare: "" }), routes: [{ from: "Campus", to: "Accra" }] },
      // An approved organizer with no live trip must not be advertised.
      { id: "org-idle", name: "Idle Travel", promo: promo({ title: "Idle Travel" }), routes: [] },
    ],
  });
  assert.deepEqual(notices.map((notice) => notice.id), ["platform", "org-a", "org-b"]);
  assert.equal(notices.some((notice) => notice.id === "org-idle"), false, "a flyer with nothing on sale stays off the public page");
  assert.equal(notices[0].platform, true);
  assert.equal(notices[1].organizerName, "Alpha Travel");
  assert.equal(notices[1].platform, false);
  assert.deepEqual(notices[2].routes, [{ from: "Campus", to: "Takoradi" }]);
});

test("an organizer notice rides along with its live trip", () => {
  const notices = assemblePublicNotices({
    platform: promo({ enabled: false }),
    platformRoutes: [],
    organizers: [{ id: "org-a", name: "Alpha Travel", promo: promo({ title: "Alpha" }), routes: [{ from: "Campus", to: "Accra" }] }],
  });
  assert.deepEqual(notices.map((notice) => notice.id), ["org-a"]);
});

test("a notice holding only placeholders is not a slide", () => {
  const notices = assemblePublicNotices({
    platform: promo({ title: "UMaT Express", route: "GHS ---", fare: "---" }),
    platformRoutes: [],
    organizers: [],
  });
  assert.equal(notices.length, 1, "the title alone still carries the notice");
  assert.equal(notices[0].promo.fare, "");
});

test("the carousel renders one slide per notice with a single set of controls", () => {
  const notices = [
    { id: "platform", organizerName: "UMaTeXPRESS", platform: true, promo: promo({ route: "Accra" }), routes: [{ from: "UMaT Main Campus", to: "Accra" }] },
    { id: "org-a", organizerName: "Alpha Travel", platform: false, promo: promo({ title: "Alpha Travel" }), routes: [{ from: "Campus", to: "Kumasi" }] },
  ];
  const html = renderToStaticMarkup(createElement(FlyerCarousel, { notices }));
  assert.equal((html.match(/flyer-carousel-slide/g) || []).length, 2, "every organizer's flyer is a slide");
  assert.equal((html.match(/flyer-carousel-dots/g) || []).length, 1, "the controls are not repeated per slide");
  assert.match(html, /UMaT Main Campus → Accra/, "the platform route comes from live coaches");
  assert.match(html, /Campus → Kumasi/, "drop-off points come from live coaches");
  assert.match(html, /Alpha Travel/);
  assert.match(html, /Show the trip notice from Alpha Travel/);
});

test("a single notice renders as the plain card, without carousel chrome", () => {
  const html = renderToStaticMarkup(createElement(FlyerCarousel, {
    notices: [{ id: "platform", organizerName: "UMaTeXPRESS", platform: true, promo: promo({ route: "Accra, Kumasi" }), routes: [] }],
  }));
  assert.match(html, /flyer-promo/);
  assert.equal(html.includes("flyer-carousel-dots"), false);
  assert.equal(html.includes("flyer-carousel-arrow"), false);
  assert.match(html, /Accra, Kumasi/, "no live trips means the saved route is the fallback");
});
