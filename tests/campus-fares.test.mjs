import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * A campus fare does not move with demand, which is what makes a hike impossible
 * and what leaves the tariff unable to defend itself. These tests hold the two
 * numbers that defend it: a floor below which the driver is not paid, and a
 * ceiling above which the platform has invented a price. They also hold the bug
 * that made the guard necessary — a corridor with no fare used to be priced at a
 * built-in GH₵5.00, and the driver was paid on that basis.
 *
 * The numbers pinned here are the ones quoted in
 * `docs/CampusRide/FARE_POLICY.md`, so the document and the code cannot drift.
 */

process.env.TURSO_DATABASE_URL = "https://campus-fares-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const SCHEMA_VERSION = "2026-09-23.2";
const statements = [];

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => {
      const args = (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value));
      statements.push({ sql: stmt.sql, args });
      // A migrated database: the schema pass reads the marker and stops.
      if (/SELECT version FROM campus_schema_meta/.test(stmt.sql)) return ok(table(["version"], [{ version: SCHEMA_VERSION }]));
      return ok({ cols: [], rows: [] });
    });
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const math = await vite.ssrLoadModule("/lib/campus-fare-math.ts");
const { assertCampusFareAllowed, campusFareReport } = await vite.ssrLoadModule("/lib/campus-engine/fares.ts");
const { demoCampusCorridors, upsertCampusCorridor } = await vite.ssrLoadModule("/lib/campus-ride.ts");

const policy = math.DEFAULT_CAMPUS_FARE_POLICY;
/** The corridor the worked example in the fare policy is built from. */
const corridor = { distanceKm: 3, minutes: 8, policy };

test("the shipped cost model is the recommended one, and every part of the floor scales with it", () => {
  assert.deepEqual(
    { costPerKm: policy.costPerKm, costPerMinute: policy.costPerMinute, standingCost: policy.standingCost, commissionBps: policy.commissionBps },
    { costPerKm: 240, costPerMinute: 30, standingCost: 150, commissionBps: 1000 },
  );
});

test("the floor divides a round trip's cost over the seats a trip is planned to sell", () => {
  assert.equal(math.campusTripCost(corridor), 2070, "both legs of the distance and the time, plus the standing cost");
  assert.equal(math.campusFareSeats(policy), 4, "six planned seats at seventy percent is four sold seats");
  assert.equal(math.campusCostFloor(corridor), 518);
  assert.equal(math.campusFareFloor(corridor), 576, "the commission comes out of the price, not out of the driver's cost");
  assert.equal(math.campusFareCeiling({ floor: 576, policy }), 922);
});

test("a fare on the floor leaves the driver whole and the platform paid", () => {
  const atFloor = math.simulateCampusTrip({ fare: 576, capacity: 6, ...corridor });
  assert.equal(atFloor.atPlannedLoad.gross, 2304);
  assert.equal(atFloor.atPlannedLoad.platformMargin, 230);
  assert.ok(atFloor.atPlannedLoad.driverSurplus >= 0, "a trip at the floor must not cost the driver money");

  // The reason the floor is divided by the commission's complement: a fare that
  // only covers the driver's cost leaves the driver short by the platform's share.
  const atCostFloor = math.simulateCampusTrip({ fare: 518, capacity: 6, ...corridor });
  assert.ok(atCostFloor.atPlannedLoad.driverSurplus < 0, "at the bare cost floor the commission still has to come from somewhere");
});

test("the two numbers an administrator owns move the floor predictably", () => {
  const cheaper = math.inspectCampusFare({ fare: 400, distanceKm: 2, minutes: 8, policy: { ...policy, costPerKm: 200, costPerMinute: 20 } });
  const dearer = math.inspectCampusFare({ fare: 400, distanceKm: 2, minutes: 8, policy: { ...policy, costPerKm: 280, costPerMinute: 40 } });
  // The corners of the sensitivity table in the fare policy.
  assert.equal(cheaper.floor, 354);
  assert.equal(dearer.floor, 532);
  assert.ok(cheaper.floor < dearer.floor);
});

test("a corridor that names its own planned load lowers its own floor", () => {
  const market = demoCampusCorridors.find((entry) => entry.id === "campus-market");
  const fourSeats = math.inspectCampusFare({ fare: market.fare, distanceKm: market.distanceKm, minutes: market.estimatedMinutes, policy });
  const tenSeats = math.inspectCampusFare({ fare: market.fare, distanceKm: market.distanceKm, minutes: market.estimatedMinutes, seats: 10, policy });
  assert.equal(fourSeats.floor, 756);
  assert.equal(tenSeats.floor, 303, "the same run on a vehicle that suits it needs less than half the fare");
  assert.equal(tenSeats.ceiling, 485);
  // And the driver, at the tariff the corridor already charges.
  const simulation = math.simulateCampusTrip({ fare: market.fare, distanceKm: market.distanceKm, minutes: market.estimatedMinutes, seats: 10, capacity: 14, policy });
  assert.equal(simulation.atPlannedLoad.driverSurplus, 4482);
});

test("a plan that rounds to nothing still divides by a seat", () => {
  assert.equal(math.campusFareSeats({ ...policy, assumedSeats: 1 }), 1);
  assert.equal(math.campusFareSeats({ ...policy, assumedSeats: 6, loadFactorBps: 100 }), 1);
  assert.equal(math.campusFareSeats(policy, 7), 7, "a corridor's own plan wins over the platform plan");
});

test("a fare below the floor is reported with its loss, and a mistyped one as a typo", () => {
  const below = math.inspectCampusFare({ fare: 500, ...corridor });
  assert.equal(below.belowFloor, true);
  assert.equal(below.perSeatLoss, 76);
  assert.match(below.message, /below the GH₵ 5.76 floor/);

  const typo = math.inspectCampusFare({ fare: 5_000, ...corridor });
  assert.equal(typo.outOfRange, true);
  assert.equal(typo.belowFloor, false, "a fare outside the band is a typo, not an economics argument");

  const high = math.inspectCampusFare({ fare: 2_000, ...corridor });
  assert.equal(high.aboveCeiling, true);

  const inside = math.inspectCampusFare({ fare: 800, ...corridor });
  assert.equal(inside.ok, true);
  assert.equal(inside.message, "");
});

test("the guard refuses what it cannot defend and accepts a loss someone owns", () => {
  const below = math.inspectCampusFare({ fare: 500, ...corridor });
  assert.throws(() => assertCampusFareAllowed(below, {}), /below the GH₵ 5.76 floor/);
  assert.doesNotThrow(() => assertCampusFareAllowed(below, { acknowledgeBelowFloor: true }), "a subsidised route is a decision, not a mistake");
  assert.throws(() => assertCampusFareAllowed(math.inspectCampusFare({ fare: 5_000, ...corridor }), { acknowledgeBelowFloor: true }), /must be between/);
  assert.throws(() => assertCampusFareAllowed(math.inspectCampusFare({ fare: 2_000, ...corridor }), { acknowledgeBelowFloor: true }), /above the ceiling/);
});

test("a corridor with no tariff is never priced at a default", async () => {
  const { quoteCampusFare } = await vite.ssrLoadModule("/lib/campus-engine/pricing.ts");
  assert.equal(quoteCampusFare({}).total, 0);
  assert.equal(quoteCampusFare({ corridor: { fare: 0 } }).subtotal, 0, "GH₵5.00 is not a price the platform may invent");
  const priced = quoteCampusFare({ corridor: { fare: 576 }, paystackFeePercent: 1.95 });
  assert.equal(priced.subtotal, 576);
  assert.ok(priced.total > priced.subtotal, "the rail's fee is charged on top and stays visible as its own number");
});

test("a sub-floor tariff is refused before a corridor exists", async () => {
  statements.length = 0;
  await assert.rejects(
    () => upsertCampusCorridor({ name: "Cheap run", originZoneId: "gate", destinationZoneId: "lecture", fare: 5, distanceKm: 3, estimatedMinutes: 8 }),
    /below the GH₵ 5.76 floor/,
  );
  assert.equal(statements.some((entry) => /INSERT INTO campus_route_corridors/i.test(entry.sql)), false, "a refused fare must not leave a corridor behind it");
});

test("an acknowledged tariff is saved with the guardrails it was checked against", async () => {
  statements.length = 0;
  await upsertCampusCorridor({ name: "Subsidised run", originZoneId: "gate", destinationZoneId: "lecture", fare: 5, distanceKm: 3, estimatedMinutes: 8, acknowledgeBelowFloor: true, actor: "ops@umat.edu.gh" });

  const saved = statements.find((entry) => /INSERT INTO campus_route_corridors/i.test(entry.sql));
  assert.ok(saved, "an acknowledged fare is written");
  assert.equal(Number(saved.args[9]), 3, "the distance the floor is computed from is stored");

  const fare = statements.find((entry) => /INSERT INTO campus_fares/i.test(entry.sql));
  assert.equal(Number(fare.args[2]), 500);
  assert.equal(Number(fare.args[4]), 0, "no plan of its own, so the platform plan decides");
  assert.equal(Number(fare.args[5]), 576, "the floor in force is recorded");
  assert.equal(Number(fare.args[6]), 922, "the ceiling in force is recorded");
  assert.equal(fare.args[7], "ops@umat.edu.gh", "the administrator who accepted the loss is recorded");
});

test("a corridor's own planned load is stored and lowers what it must charge", async () => {
  statements.length = 0;
  await upsertCampusCorridor({ name: "Big vehicle run", originZoneId: "campus", destinationZoneId: "market", fare: 4.5, distanceKm: 3.6, estimatedMinutes: 14, plannedSeats: 10 });
  const fare = statements.find((entry) => /INSERT INTO campus_fares/i.test(entry.sql));
  assert.equal(Number(fare.args[4]), 10, "the corridor plan is stored, not the platform plan");
  assert.equal(Number(fare.args[5]), 303, "and the floor follows it down");
});

test("a bigger vehicle caps what the corridor may charge, which is the point of running one", async () => {
  statements.length = 0;
  // The same run that is inside the band at four seats is above the ceiling at
  // ten: the plan is what the platform is willing to charge against, so a
  // corridor cannot name a bigger vehicle and keep a small vehicle's price.
  await assert.rejects(
    () => upsertCampusCorridor({ name: "Big vehicle, old price", originZoneId: "campus", destinationZoneId: "market", fare: 8, distanceKm: 3.6, estimatedMinutes: 14, plannedSeats: 10 }),
    /above the ceiling of GH₵ 4.85/,
  );
  assert.equal(statements.some((entry) => /INSERT INTO campus_fares/i.test(entry.sql)), false);
});

test("a deactivated corridor keeps a live fare row", async () => {
  statements.length = 0;
  await upsertCampusCorridor({ name: "Paused run", originZoneId: "gate", destinationZoneId: "lecture", fare: 8, distanceKm: 3, estimatedMinutes: 8, active: false });
  const fare = statements.find((entry) => /INSERT INTO campus_fares/i.test(entry.sql));
  // Deactivating the corridor used to deactivate its fare too, and the read path
  // then joined nothing and priced the ride at a built-in default.
  assert.match(fare.sql, /VALUES \(\?,\?,\?,\?,1,\?,\?,\?,\?,\?,\?\)/);
  assert.match(fare.sql, /DO UPDATE SET amount=excluded.amount,active=1/);
  assert.equal(fare.args[7], "", "a fare inside the band needs nobody's acknowledgement");
});

test("every seeded corridor clears its floor at the tariff it already has", async () => {
  const report = await campusFareReport(demoCampusCorridors);
  // The table in docs/CampusRide/FARE_POLICY.md, pinned so the two cannot drift.
  assert.deepEqual(report.rows.map((row) => row.floor), [346, 416, 669, 756]);
  assert.deepEqual(report.rows.map((row) => row.ceiling), [554, 666, 1071, 1210]);
  assert.deepEqual(report.rows.map((row) => row.plannedSeats), [4, 4, 4, 4]);
  assert.equal(report.summary.belowFloor, 0, "the placeholder cost inputs were what made these look underwater");
  assert.equal(report.summary.worstPerSeatLoss, 0);
  assert.equal(report.summary.commissionBps, 1000);
  // Priced, inside the band, but never measured against a saved floor.
  assert.deepEqual(report.rows.map((row) => row.status), ["UNCHECKED", "UNCHECKED", "UNCHECKED", "UNCHECKED"]);
});

test("the report separates a tariff that passed from one nobody measured", async () => {
  const report = await campusFareReport([
    { id: "a", name: "Checked", fare: 700, estimatedMinutes: 8, distanceKm: 3, floorAmount: 576, ceilingAmount: 922 },
    { id: "b", name: "Never checked", fare: 700, estimatedMinutes: 8, distanceKm: 3 },
    { id: "c", name: "Under the floor", fare: 500, estimatedMinutes: 8, distanceKm: 3 },
    { id: "d", name: "No fare", fare: 0, estimatedMinutes: 8, distanceKm: 3 },
  ]);
  assert.deepEqual(report.rows.map((row) => row.status), ["OK", "UNCHECKED", "BELOW_FLOOR", "UNPRICED"]);
  assert.equal(report.summary.belowFloor, 1);
  assert.equal(report.summary.unchecked, 2, "the unpriced corridor belongs in the same queue as the unchecked one");
  assert.equal(report.summary.worstPerSeatLoss, 76);
  assert.equal(report.summary.costInputsConfirmed, false, "the console must not present a recommendation as a measurement");
});

test("a corridor's own planned load reaches the report", async () => {
  const report = await campusFareReport([
    { id: "a", name: "Big vehicle", fare: 800, estimatedMinutes: 14, distanceKm: 3.6, plannedSeats: 10 },
    { id: "b", name: "Platform plan", fare: 800, estimatedMinutes: 14, distanceKm: 3.6 },
  ]);
  assert.equal(report.rows[0].plannedSeatsOverride, 10);
  assert.equal(report.rows[0].plannedSeats, 10);
  assert.equal(report.rows[0].floor, 303);
  assert.equal(report.rows[1].plannedSeatsOverride, 0);
  assert.equal(report.rows[1].plannedSeats, 4);
  assert.equal(report.rows[1].floor, 756);
});
