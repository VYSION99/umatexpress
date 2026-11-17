import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { splitStatements } from "../scripts/apply-database-migration.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { campusZoneCoordinate, demoCampusZones, demoCampusCorridors, demoCampusRides } = await vite.ssrLoadModule("/lib/campus-ride.ts");
const { nearestCampusPickupZone, resolveCampusRouteSelection } = await vite.ssrLoadModule("/lib/campus-zones.ts");
const { findNearestCampusRides } = await vite.ssrLoadModule("/lib/campus-matching.ts");

test("zone coordinates require finite values in latitude and longitude ranges", () => {
  assert.equal(campusZoneCoordinate("0", "latitude"), 0);
  assert.equal(campusZoneCoordinate(-1.9931, "longitude"), -1.9931);
  assert.throws(() => campusZoneCoordinate("", "latitude"), /required/);
  assert.throws(() => campusZoneCoordinate("abc", "longitude"), /between/);
  assert.throws(() => campusZoneCoordinate(91, "latitude"), /between/);
  assert.throws(() => campusZoneCoordinate(-181, "longitude"), /between/);
});

test("student routes use geocoded active zones and a bookable default", () => {
  const invalid = { ...demoCampusZones.find((zone) => zone.id === "lecture-area"), latitude: null };
  const selected = resolveCampusRouteSelection({
    zones: demoCampusZones.map((zone) => zone.id === "lecture-area" ? invalid : zone),
    corridors: demoCampusCorridors,
    rides: demoCampusRides,
    pickupZoneId: "unknown-zone",
    destinationZoneId: "lecture-area",
  });
  assert.equal(selected.zones.some((zone) => zone.id === "lecture-area"), false);
  assert.equal(selected.corridors.some((corridor) => corridor.destinationZoneId === "lecture-area"), false);
  assert.equal(selected.pickupZoneId, "hostel-area");
  assert.equal(selected.destinationZoneId, "main-campus");
  assert.deepEqual(findNearestCampusRides({
    zones: demoCampusZones.map((zone) => zone.id === "lecture-area" ? invalid : zone),
    corridors: demoCampusCorridors,
    rides: demoCampusRides,
    pickupZoneId: "main-gate",
    destinationZoneId: "lecture-area",
  }), []);
});

test("GPS suggests the nearest zone with an outgoing route and keeps a reachable destination", () => {
  const nearest = nearestCampusPickupZone({
    coordinate: { latitude: 5.3019, longitude: -1.9930 },
    zones: demoCampusZones,
    corridors: demoCampusCorridors,
    destinationZoneId: "market-circle",
  });
  assert.equal(nearest?.zone.id, "main-campus");
  assert.equal(nearest?.destinationZoneId, "market-circle");
  assert.ok(nearest.distanceKm < 0.1);
  const changedDestination = nearestCampusPickupZone({
    coordinate: { latitude: 5.3064, longitude: -1.9972 },
    zones: demoCampusZones,
    corridors: demoCampusCorridors,
    destinationZoneId: "market-circle",
  });
  assert.equal(changedDestination?.zone.id, "hostel-area");
  assert.equal(changedDestination?.destinationZoneId, "main-campus");
  assert.equal(nearestCampusPickupZone({ coordinate: { latitude: 91, longitude: 0 }, zones: demoCampusZones, corridors: demoCampusCorridors }), null);
});

test("zone migration rejects invalid coordinates and corridor references", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE campus_zones (id TEXT PRIMARY KEY, latitude REAL, longitude REAL, active INTEGER NOT NULL DEFAULT 1)");
    db.exec("CREATE TABLE campus_route_corridors (id TEXT PRIMARY KEY, origin_zone_id TEXT NOT NULL, destination_zone_id TEXT NOT NULL)");
    const sql = readFileSync(new URL("../sql/060_campus_zone_coordinates.sql", import.meta.url), "utf8");
    const statements = splitStatements(sql);
    assert.equal(statements.length, 4);
    for (const statement of statements) db.exec(statement);
    db.exec("INSERT INTO campus_zones (id,latitude,longitude) VALUES ('a',5.3018,-1.9931),('b',5.3064,-1.9972)");
    assert.throws(() => db.exec("INSERT INTO campus_zones (id,latitude,longitude) VALUES ('missing',NULL,-1.99)"), /valid latitude and longitude/);
    assert.throws(() => db.exec("UPDATE campus_zones SET longitude=181 WHERE id='a'"), /valid latitude and longitude/);
    assert.throws(() => db.exec("INSERT INTO campus_route_corridors VALUES ('bad','a','unknown')"), /two distinct active zones/);
    assert.throws(() => db.exec("INSERT INTO campus_route_corridors VALUES ('same','a','a')"), /two distinct active zones/);
    db.exec("INSERT INTO campus_route_corridors VALUES ('good','a','b')");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM campus_route_corridors").get().count, 1);
  } finally {
    db.close();
  }
});
