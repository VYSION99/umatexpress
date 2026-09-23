import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * The number a waiting student is given, and the rules that keep it honest.
 *
 * An ETA is a promise made from someone else's phone. These tests hold the three
 * things that make it trustworthy: it is built from a live position or it says
 * so, it names the pickup zone instead of counting metres once the driver is
 * inside it, and a stale fix falls back to the route's own time rather than
 * pretending the driver has not moved.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const eta = await vite.ssrLoadModule("/lib/campus-engine/eta.ts");
const { waitLabel } = await vite.ssrLoadModule("/lib/campus-engine/progress.ts");

/** A point a given number of kilometres due north of another. */
const northKm = (latitude, km) => ({ latitude: latitude + km / 111.19, longitude: 0.4 });
const ZONE = { latitude: 5.0, longitude: 0.4 };
const now = Date.parse("2026-09-23T09:00:00.000Z");
const freshFix = new Date(now - 20_000).toISOString();

test("a driver inside the pickup zone is here, not '200 m away'", () => {
  const sameZone = eta.campusPickupEta({
    driverPosition: northKm(ZONE.latitude, 0.02), driverPositionAt: freshFix,
    pickupZone: ZONE, driverZoneId: "main-gate", pickupZoneId: "main-gate", now,
  });
  assert.equal(sameZone.source, "AT_PICKUP");
  assert.equal(sameZone.label, "Arriving now");

  const closeBy = eta.campusPickupEta({
    driverPosition: northKm(ZONE.latitude, 0.03), driverPositionAt: freshFix,
    pickupZone: ZONE, driverZoneId: "elsewhere", pickupZoneId: "main-gate", now,
  });
  assert.equal(closeBy.source, "AT_PICKUP", "inside fifty metres is inside the zone");
  assert.equal(closeBy.minutes, 1);
});

test("a live position is turned into minutes at the campus speed, plus marshalling", () => {
  const aboutOneKm = eta.campusPickupEta({
    driverPosition: northKm(ZONE.latitude, 1), driverPositionAt: freshFix,
    pickupZone: ZONE, driverZoneId: "elsewhere", pickupZoneId: "main-gate", corridorMinutes: 8, now,
  });
  // One kilometre at 18 km/h is 3.34 minutes, rounded up to 4, plus 2 to find a bay.
  assert.equal(aboutOneKm.source, "DRIVER_POSITION");
  assert.equal(aboutOneKm.minutes, 6);
  assert.equal(aboutOneKm.label, waitLabel(6));
  assert.ok(aboutOneKm.distanceKm > 0.9 && aboutOneKm.distanceKm < 1.1);
  assert.equal(aboutOneKm.note, "", "a live position needs no caveat");

  const farther = eta.campusPickupEta({
    driverPosition: northKm(ZONE.latitude, 3), driverPositionAt: freshFix,
    pickupZone: ZONE, driverZoneId: "elsewhere", pickupZoneId: "main-gate", now,
  });
  assert.ok(farther.minutes > aboutOneKm.minutes, "more distance is more minutes");
  assert.equal(farther.source, "DRIVER_POSITION");
});

test("a phone that stopped reporting is not a live ETA", () => {
  const stale = eta.campusPickupEta({
    driverPosition: northKm(ZONE.latitude, 0.5),
    driverPositionAt: new Date(now - 20 * 60_000).toISOString(),
    pickupZone: ZONE, driverZoneId: "elsewhere", pickupZoneId: "main-gate", corridorMinutes: 8, now,
  });
  assert.equal(stale.source, "CORRIDOR_ESTIMATE");
  assert.equal(stale.distanceKm, null);
  assert.equal(stale.minutes, 10, "the route takes eight minutes, plus marshalling");
  assert.match(stale.note, /out of date/);
});

test("without a position or a route time there is no number, and no invented one", () => {
  const nothing = eta.campusPickupEta({ pickupZoneId: "main-gate", now });
  assert.equal(nothing.source, "UNKNOWN");
  assert.equal(nothing.minutes, null);
  assert.equal(nothing.label, "On the way");

  const guessed = eta.campusPickupEta({
    driverPosition: northKm(ZONE.latitude, 1), driverPositionAt: freshFix,
    driverZoneId: "elsewhere", pickupZoneId: "main-gate", corridorMinutes: 6, now,
  });
  assert.equal(guessed.source, "CORRIDOR_ESTIMATE", "no pickup coordinates means no distance to measure");
  assert.match(guessed.note, /usual time/);
});

test("an untouched coordinate column is not the Gulf of Guinea", () => {
  const zeroed = eta.campusPickupEta({
    driverPosition: { latitude: 0, longitude: 0 }, driverPositionAt: freshFix,
    pickupZone: ZONE, driverZoneId: "elsewhere", pickupZoneId: "main-gate", corridorMinutes: 5, now,
  });
  assert.equal(zeroed.source, "CORRIDOR_ESTIMATE", "0,0 means nobody has reported a position yet");
});

test("a driver who marked themselves arrived is at the zone regardless of the fix", () => {
  const arrived = eta.campusPickupEta({ arrived: true, pickupZone: ZONE, pickupZoneId: "main-gate", now });
  assert.equal(arrived.source, "AT_PICKUP");
  assert.equal(arrived.label, "At your pickup zone");
});

test("the assumptions the number rests on are named and modest", () => {
  assert.equal(eta.CAMPUS_ASSUMED_SPEED_KMH, 18);
  assert.equal(eta.CAMPUS_MARSHALLING_MINUTES, 2);
  assert.equal(eta.CAMPUS_POSITION_STALE_MINUTES, 3);
  const absurd = eta.campusPickupEta({
    driverPosition: northKm(ZONE.latitude, 60), driverPositionAt: freshFix,
    pickupZone: ZONE, driverZoneId: "elsewhere", pickupZoneId: "main-gate", now,
  });
  assert.ok(absurd.minutes <= 45, "a number nobody believes is not worth showing");
});
