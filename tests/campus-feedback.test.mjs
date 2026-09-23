import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * What a passenger gets to say after a trip, and where it goes.
 *
 * A score and a complaint are different acts and these tests hold them apart: a
 * rating is one row per seat that a driver sees only as an average, while a
 * report becomes a dispute carrying the ride it is about. The threshold that
 * hides a two-trip average is held here too, because a number shown too early
 * is a verdict nobody earned.
 */

process.env.TURSO_DATABASE_URL = "https://campus-feedback-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const SCHEMA_VERSIONS = {
  campusRide: "2026-09-23.2",
  campusRatings: "2026-09-24.1",
  tripDisputes: "2026-09-24.1",
  bookings: "2026-09-18.2",
  scheduledTrips: "2026-09-18.2",
};

const state = { entries: [], rides: [], ratings: [], disputes: [], payments: [] };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}
const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const okOne = () => ok({ cols: [], rows: [], affected_row_count: 1 });
const ratingColumns = ["id", "entry_id", "reference", "driver_id", "driver_name", "corridor_id", "passenger_email", "rating", "comment", "created_at", "updated_at"];

function withDriverName(rating) {
  return { ...rating, driver_name: state.rides.find((ride) => ride.driver_id === rating.driver_id)?.driver_name || rating.driver_id };
}

function handle(sql, args) {
  const version = sql.match(/SELECT version FROM campus_schema_meta WHERE id = '([^']+)'/);
  if (version) return ok(table(["version"], [{ version: SCHEMA_VERSIONS[version[1]] || "0" }]));

  if (/^SELECT q\.id,q\.reference,COALESCE\(q\.email,''\) AS email,q\.queue_status/.test(sql)) {
    const entry = state.entries.find((item) => item.reference === args[0]);
    if (!entry) return ok(empty);
    const ride = state.rides.find((item) => item.id === entry.ride_id) || {};
    return ok(table(["id", "reference", "email", "queue_status", "driver_id", "corridor_id"],
      [{ id: entry.id, reference: entry.reference, email: entry.email, queue_status: entry.queue_status, driver_id: ride.driver_id || "", corridor_id: entry.corridor_id || "" }]));
  }
  if (/^SELECT id,reference,COALESCE\(email,''\) AS email FROM campus_queue_entries WHERE reference = \? LIMIT 1/.test(sql)) {
    const entry = state.entries.find((item) => item.reference === args[0]);
    return ok(entry ? table(["id", "reference", "email"], [entry]) : empty);
  }
  if (/^SELECT id FROM campus_ratings WHERE entry_id = \? LIMIT 1/.test(sql)) {
    const rating = state.ratings.find((item) => item.entry_id === args[0]);
    return ok(rating ? table(["id"], [rating]) : empty);
  }
  if (/^INSERT INTO campus_ratings/.test(sql)) {
    const [id, entryId, reference, driverId, corridorId, email, rating, comment, createdAt, updatedAt] = args;
    state.ratings.push({ id, entry_id: entryId, reference, driver_id: driverId, corridor_id: corridorId, passenger_email: email, rating, comment, created_at: createdAt, updated_at: updatedAt });
    return okOne();
  }
  if (/^UPDATE campus_ratings SET rating = \?/.test(sql)) {
    const rating = state.ratings.find((item) => item.entry_id === args[3]);
    if (rating) { rating.rating = args[0]; rating.comment = args[1]; rating.updated_at = args[2]; }
    return okOne();
  }
  if (/FROM campus_ratings rt LEFT JOIN campus_drivers d ON d\.id = rt\.driver_id WHERE rt\.entry_id = \? LIMIT 1/.test(sql)) {
    const rating = state.ratings.find((item) => item.entry_id === args[0]);
    return ok(rating ? table(ratingColumns, [withDriverName(rating)]) : empty);
  }
  if (/FROM campus_ratings rt LEFT JOIN campus_drivers d ON d\.id = rt\.driver_id WHERE rt\.driver_id = \?/.test(sql)) {
    return ok(table(ratingColumns, state.ratings.filter((item) => item.driver_id === args[0]).map(withDriverName)));
  }
  if (/COUNT\(\*\) AS total, COALESCE\(AVG\(rating\),0\) AS average/.test(sql)) {
    const rows = state.ratings.filter((item) => item.driver_id === args[0]);
    const average = rows.length ? rows.reduce((total, row) => total + Number(row.rating), 0) / rows.length : 0;
    return ok(table(["total", "average", "last_at"], [{ total: rows.length, average, last_at: rows[0]?.created_at || "" }]));
  }
  if (/GROUP BY rt\.driver_id/.test(sql)) {
    const grouped = new Map();
    for (const rating of state.ratings) {
      const current = grouped.get(rating.driver_id) || { driver_id: rating.driver_id, driver_name: rating.driver_id, trips: 0, total: 0 };
      current.trips += 1; current.total += Number(rating.rating);
      grouped.set(rating.driver_id, current);
    }
    const rows = [...grouped.values()].map((row) => ({ ...row, average: row.total / row.trips })).sort((a, b) => a.average - b.average || b.trips - a.trips);
    return ok(table(["driver_id", "driver_name", "trips", "average"], rows));
  }
  if (/^SELECT reference, access_token_hash FROM campus_payments WHERE queue_entry_id = \?/.test(sql)) {
    const payment = state.payments.find((item) => item.queue_entry_id === args[0]);
    return ok(payment ? table(["reference", "access_token_hash"], [payment]) : empty);
  }
  if (/^INSERT INTO trip_disputes/.test(sql)) {
    state.disputes.push({
      id: String(args[0]), campus_reference: String(args[4]), raised_by_role: String(args[5]),
      raised_by: String(args[6]), category: String(args[8]), subject: String(args[9]), details: String(args[10]), status: "OPEN",
    });
    return okOne();
  }
  return okOne();
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => handle(stmt.sql.trim(), (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const feedback = await vite.ssrLoadModule("/lib/campus-engine/feedback.ts");

function seedTrip(overrides = {}) {
  const index = state.entries.length + 1;
  const entry = {
    id: `entry-${index}`, reference: `UMX-FB-${index}`, ride_id: `ride-${index}`,
    queue_status: "COMPLETED", email: "ama@student.umat.edu.gh", corridor_id: "gate-lecture", ...overrides,
  };
  state.entries.push(entry);
  state.rides.push({ id: entry.ride_id, driver_id: overrides.driver_id || `driver-${index}`, driver_name: "Kojo Driver" });
  return entry;
}

test("a completed trip can be rated, and a second thought edits the same rating", async () => {
  const trip = seedTrip();
  const first = await feedback.rateCampusTrip({ reference: trip.reference, rating: 4, comment: "Quick and clean", email: trip.email });
  assert.equal(first.rating, 4);
  assert.equal(first.driverId, trip.ride_id.replace("ride-", "driver-"), "the rating follows the seat to the driver who ran it");
  assert.equal(state.ratings.length, 1);

  const edited = await feedback.rateCampusTrip({ reference: trip.reference, rating: 2, comment: "Actually the trip was late", email: trip.email });
  assert.equal(edited.rating, 2);
  assert.equal(state.ratings.length, 1, "one seat is one rating, however many times it is changed");
});

test("nothing can be rated or reported before the trip is over", async () => {
  const running = seedTrip({ queue_status: "BOARDED" });
  await assert.rejects(() => feedback.rateCampusTrip({ reference: running.reference, rating: 5, email: running.email }), /once it is complete/i);
  await assert.rejects(() => feedback.reportCampusTrip({ reference: running.reference, details: "The driver was on the phone the whole way.", email: running.email }), /once it is complete/i);
  const state0 = await feedback.campusFeedbackState(running.reference, running.email);
  assert.equal(state0.completed, false, "the ticket offers nothing while the passenger is still in the vehicle");
});

test("a score is one to five, and nothing else", async () => {
  const trip = seedTrip();
  await assert.rejects(() => feedback.rateCampusTrip({ reference: trip.reference, rating: 0, email: trip.email }), /one to five/i);
  await assert.rejects(() => feedback.rateCampusTrip({ reference: trip.reference, rating: 9, email: trip.email }), /one to five/i);
  await assert.rejects(() => feedback.rateCampusTrip({ reference: "UMX-NOPE", rating: 4, email: trip.email }), /not found/i);
});

test("an average is withheld until it means something, and the count is not", async () => {
  for (let index = 0; index < 2; index += 1) {
    const trip = seedTrip({ driver_id: "driver-sparse" });
    await feedback.rateCampusTrip({ reference: trip.reference, rating: 1, email: trip.email });
  }
  const two = await feedback.campusDriverRatingSummary("driver-sparse");
  assert.equal(two.count, 2, "the record is always shown");
  assert.equal(two.visible, false);
  assert.equal(two.average, 0, "a two-trip average is suppressed, not merely unlabelled");

  const third = seedTrip({ driver_id: "driver-sparse" });
  await feedback.rateCampusTrip({ reference: third.reference, rating: 4, email: third.email });
  const three = await feedback.campusDriverRatingSummary("driver-sparse");
  assert.equal(three.visible, true);
  assert.equal(three.average, 2);
});

test("the breakdown ranks the weakest run first", async () => {
  const seeds = [
    { driver_id: "driver-good", rating: 5 },
    { driver_id: "driver-bad", rating: 2 },
    { driver_id: "driver-bad", rating: 1 },
    { driver_id: "driver-fine", rating: 4 },
  ];
  for (const seed of seeds) {
    const trip = seedTrip({ driver_id: seed.driver_id });
    await feedback.rateCampusTrip({ reference: trip.reference, rating: seed.rating, email: trip.email });
  }
  const { byDriver, overall } = await feedback.campusRatingBreakdown();
  const order = byDriver.map((row) => row.driverId);
  assert.equal(order[0], "driver-bad", "the question a rating desk answers is which run needs a look");
  assert.ok(order.indexOf("driver-fine") < order.indexOf("driver-good"));
  assert.ok(overall.count > 0);
  assert.ok(byDriver.every((row) => row.trips >= 1));
});

test("a report becomes a dispute carrying the ride it is about", async () => {
  const trip = seedTrip();
  const dispute = await feedback.reportCampusTrip({
    reference: trip.reference,
    category: "CONDUCT",
    details: "The driver was on the phone for the whole trip and missed the hostel turn.",
    email: trip.email,
  });
  assert.equal(dispute.status, "OPEN");
  assert.equal(dispute.campusReference, trip.reference, "the triage row says which ride it is about");
  assert.equal(dispute.raisedByRole, "STUDENT");
  assert.match(dispute.subject, /conduct/i, "the category becomes the subject so the student writes one thing");
  assert.equal(state.disputes.length, 1);

  await assert.rejects(
    () => feedback.reportCampusTrip({ reference: trip.reference, category: "DELAY", details: "late", email: trip.email }),
    /sentence or two/i,
  );
});

test("the ticket's feedback state knows what to offer, and the route refuses a stranger", async () => {
  const { hashPaymentToken } = await vite.ssrLoadModule("/lib/payment-access.ts");
  const trip = seedTrip();
  const token = "tok-feedback-1";
  state.payments.push({ reference: `PAY-${trip.id}`, queue_entry_id: trip.id, access_token_hash: await hashPaymentToken(token) });

  const route = await vite.ssrLoadModule("/app/api/campus/feedback/route.ts");
  const stranger = await route.GET(new Request(`http://localhost/api/campus/feedback?reference=${trip.reference}`));
  assert.equal(stranger.status, 403, "a guessed reference cannot read or rate a stranger's trip");

  const owner = await route.GET(new Request(`http://localhost/api/campus/feedback?reference=${trip.reference}`, {
    headers: { cookie: `umx_payment_access_PAY-${trip.id}=${token}` },
  }));
  assert.equal(owner.status, 200);
  const payload = await owner.json();
  assert.equal(payload.completed, true);
  assert.equal(payload.canRate, true);
  assert.equal(payload.canReport, true);
  assert.equal(payload.rating, null);

  const rated = await route.POST(new Request("http://localhost/api/campus/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `umx_payment_access_PAY-${trip.id}=${token}` },
    body: JSON.stringify({ reference: trip.reference, kind: "RATING", rating: 5, comment: "Great driver" }),
  }));
  assert.equal(rated.status, 200);
  assert.equal((await rated.json()).rating.rating, 5);

  const rejected = await route.POST(new Request("http://localhost/api/campus/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: trip.reference, kind: "RATING", rating: 5 }),
  }));
  assert.equal(rejected.status, 403);
  assert.equal(state.ratings.filter((item) => item.entry_id === trip.id).length, 1);
});
