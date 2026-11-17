import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { bookableCampusRidesForRoute, findNearestCampusRides } = await vite.ssrLoadModule("/lib/campus-matching.ts");
const { demoCampusZones, demoCampusCorridors, demoCampusRides } = await vite.ssrLoadModule("/lib/campus-ride.ts");

const data = { zones: demoCampusZones, corridors: demoCampusCorridors, rides: demoCampusRides };

test("browser ranking receives only open rides accepting this route", () => {
  const rides = [
    ...demoCampusRides,
    { ...demoCampusRides[1], id: "paused", status: "PAUSED" },
    { ...demoCampusRides[1], id: "full", availableSlots: 0 },
    { ...demoCampusRides[1], id: "closed", acceptingQueue: false },
  ];
  const bookable = bookableCampusRidesForRoute({ rides, corridors: demoCampusCorridors, pickupZoneId: "hostel-area", destinationZoneId: "main-campus" });
  assert.deepEqual(bookable.map((ride) => ride.id), ["ride-2"]);
});

test("a selected route contains only rides serving both chosen zones", () => {
  const matches = findNearestCampusRides({ ...data, pickupZoneId: "hostel-area", destinationZoneId: "main-campus" });
  assert.deepEqual(matches.map((match) => match.id), ["ride-2"]);
  assert.ok(matches.every((match) => match.corridor.originZoneId === "hostel-area" && match.corridor.destinationZoneId === "main-campus"));
});

test("a route with no accepting ride stays empty instead of offering another destination", () => {
  const matches = findNearestCampusRides({ ...data, pickupZoneId: "main-campus", destinationZoneId: "market-circle" });
  assert.deepEqual(matches, []);
});

test("a ride cannot create a queue entry for a different route", async () => {
  const { requestCampusRide } = await vite.ssrLoadModule("/lib/campus-engine/rides.ts");
  await assert.rejects(
    () => requestCampusRide({ passengerName: "Test Student", phone: "0200000000", pickupZoneId: "hostel-area", destinationZoneId: "main-campus", rideId: "ride-1" }),
    (error) => error?.status === 409 && /selected route/i.test(error.message),
  );
});
