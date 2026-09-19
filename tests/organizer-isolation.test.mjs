import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Phase 2's acceptance criteria are all isolation properties, so these tests
 * drive the real route handlers against a fake Turso that answers only the
 * handful of queries the organizer surfaces issue, and record every statement
 * so a test can assert on the arguments a query was given.
 */

process.env.TURSO_DATABASE_URL = "https://organizer-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";

const SCHEMA_VERSION = "2026-09-18.1";
const ACCOUNT_COLUMNS = ["id", "email", "name", "phone", "role", "status", "profile_id"];

const accounts = [
  { id: "acc-a", email: "a@example.com", name: "Organizer A", phone: "0200000001", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-a", token_version: 0 },
  { id: "acc-b", email: "b@example.com", name: "Organizer B", phone: "0200000002", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-b", token_version: 0 },
  { id: "acc-mod", email: "mod@example.com", name: "Moderator", phone: "", role: "MODERATOR", status: "ACTIVE", profile_id: "", token_version: 0 },
  { id: "acc-admin", email: "admin@example.com", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profile_id: "", token_version: 0 },
  { id: "acc-pending", email: "p@example.com", name: "Pending", phone: "", role: "ORGANIZER", status: "PENDING", profile_id: "org-p", token_version: 0 },
  { id: "acc-suspended", email: "s@example.com", name: "Suspended", phone: "", role: "ORGANIZER", status: "SUSPENDED", profile_id: "org-s", token_version: 3 },
];

const trips = [
  { id: "trip-a", title: "A to Accra", route_from: "UMaT", route_to: "Accra", travel_date: "2026-09-05", departure_time: "06:30", arrival_time: "11:30", capacity: 50, organizer_id: "org-a", archived: 0 },
  { id: "trip-b", title: "B to Kumasi", route_from: "UMaT", route_to: "Kumasi", travel_date: "2026-09-05", departure_time: "07:00", arrival_time: "12:00", capacity: 40, organizer_id: "org-b", archived: 0 },
];

const bookings = [
  { trip_id: "trip-a", reference: "UMX-A-1", passenger_name: "Ama", seat: 4, phone: "0244000001", booking_status: "CONFIRMED", travel_date: "2026-09-05", created_at: "2026-09-01T00:00:00.000Z" },
  { trip_id: "trip-b", reference: "UMX-B-1", passenger_name: "Kofi", seat: 9, phone: "0244000002", booking_status: "CONFIRMED", travel_date: "2026-09-05", created_at: "2026-09-01T00:00:00.000Z" },
];

const organizers = [
  { id: "org-a", name: "Organizer A", phone: "0200000001", email: "a@example.com", organization: "A Travel", status: "APPROVED", kyc_status: "PENDING", commission_bps: 300, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
  { id: "org-p", name: "Pending", phone: "0200000009", email: "p@example.com", organization: "P Travel", status: "PENDING", kyc_status: "PENDING", commission_bps: 300, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
];

const notices = [];

const statements = [];

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: "integer", value: String(value) };
  return { type: "text", value: String(value) };
}

function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}

const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });

function handle(sql, args) {
  if (/^SELECT version FROM campus_schema_meta/.test(sql)) return ok(table(["version"], [{ version: SCHEMA_VERSION }]));
  if (/AS token_version FROM console_accounts/.test(sql)) {
    const account = accounts.find((item) => item.id === args[0]);
    return ok(account ? table(["token_version"], [account]) : empty);
  }
  if (/FROM console_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const account = accounts.find((item) => item.id === args[0]);
    return ok(account ? table(ACCOUNT_COLUMNS, [account]) : empty);
  }
  // The ownership check: a trip only answers when the organizer id matches the
  // one the caller passed, which is what makes another organizer's trip 404.
  if (/FROM scheduled_trips WHERE id = \? AND organizer_id = \? LIMIT 1/.test(sql)) {
    const [tripId, organizerId] = args;
    const trip = trips.find((item) => item.id === tripId && item.organizer_id === organizerId);
    return ok(trip ? table(["id", "title", "route_from", "route_to", "travel_date", "departure_time", "arrival_time", "capacity"], [trip]) : empty);
  }
  if (/FROM bookings WHERE trip_id = \? ORDER BY seat ASC/.test(sql)) {
    const rows = bookings.filter((item) => item.trip_id === args[0]);
    return ok(table(["reference", "passenger_name", "seat", "phone", "booking_status", "travel_date", "created_at"], rows));
  }
  if (/FROM scheduled_trips t WHERE t\.organizer_id = \?/.test(sql)) {
    const owned = trips.filter((item) => item.organizer_id === args[0]);
    return ok(table(["id", "title", "route_from", "route_to", "travel_date", "departure_time", "arrival_time", "price", "capacity", "coach_type", "review_status", "archived", "booking_count", "confirmed_count"],
      owned.map((trip) => ({ ...trip, price: 180, coach_type: "VIP Coach", review_status: "APPROVED", booking_count: 1, confirmed_count: 1 }))));
  }
  if (/FROM trip_organizers o LEFT JOIN console_accounts a/.test(sql)) {
    const match = /WHERE o\.id = \?/.test(sql)
      ? organizers.filter((item) => item.id === args[0])
      : organizers.filter((item) => !args[0] || item.status === args[0]);
    const account = accounts.find((item) => item.profile_id === match[0]?.id && item.role === "ORGANIZER");
    return ok(table(
      ["id", "name", "phone", "email", "organization", "status", "kyc_status", "commission_bps", "created_at", "updated_at", "account_id", "account_status"],
      match.map((item) => ({ ...item, account_id: account?.id || "", account_status: account?.status || "" })),
    ));
  }
  if (/^SELECT id FROM scheduled_trips WHERE id = \? LIMIT 1/.test(sql)) {
    const trip = trips.find((item) => item.id === args[0]);
    return ok(trip ? table(["id"], [trip]) : empty);
  }
  if (/FROM trip_notices WHERE organizer_id = \? LIMIT 1/.test(sql)) {
    const notice = notices.find((item) => item.organizer_id === args[0]);
    return ok(notice
      ? table(["enabled", "title", "route", "fare", "night_bus", "day_buses", "drop_off_points", "amenities", "contacts"], [notice])
      : empty);
  }
  return ok(empty);
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => {
      const args = (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value));
      statements.push({ sql: stmt.sql, args });
      return handle(stmt.sql, args);
    });
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());

const { CONSOLE_SESSION_COOKIE, createConsoleSession } = await vite.ssrLoadModule("/lib/console-auth.ts");
const tripsRoute = await vite.ssrLoadModule("/app/api/console/trips/route.ts");
const manifestRoute = await vite.ssrLoadModule("/app/api/console/trips/[tripId]/manifest/route.ts");
const organizersRoute = await vite.ssrLoadModule("/app/api/console/organizers/route.ts");

async function cookieFor(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  const value = await createConsoleSession({ id: account.id, role: account.role });
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(value)}`;
}

const URL_BASE = "https://console.example.test";

test("a manifest read is scoped to the signed-in organizer and audited", async () => {
  statements.length = 0;
  const request = new Request(`${URL_BASE}/api/console/trips/trip-a/manifest`, { headers: { cookie: await cookieFor("acc-a") } });
  const response = await manifestRoute.GET(request, { params: Promise.resolve({ tripId: "trip-a" }) });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.passengers.length, 1);
  assert.equal(body.passengers[0].phone, "0244000001");

  const ownership = statements.find((entry) => /FROM scheduled_trips WHERE id = \? AND organizer_id = \?/.test(entry.sql));
  assert.deepEqual(ownership.args, ["trip-a", "org-a"], "ownership must be the session's organizer id");

  const audit = statements.find((entry) => /INSERT INTO admin_audit_logs/.test(entry.sql));
  assert.ok(audit, "a manifest read must write one audit row");
  assert.equal(audit.args[2], "ORGANIZER_MANIFEST_READ");
  assert.equal(audit.args[4], "trip-a");
});

test("organizer B gets 404 for organizer A's trip", async () => {
  const request = new Request(`${URL_BASE}/api/console/trips/trip-a/manifest`, { headers: { cookie: await cookieFor("acc-b") } });
  const response = await manifestRoute.GET(request, { params: Promise.resolve({ tripId: "trip-a" }) });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.passengers, undefined);
});

test("a forged organizerId in the query string changes nothing", async () => {
  statements.length = 0;
  const request = new Request(`${URL_BASE}/api/console/trips/trip-a/manifest?organizerId=org-b`, { headers: { cookie: await cookieFor("acc-a") } });
  const response = await manifestRoute.GET(request, { params: Promise.resolve({ tripId: "trip-a" }) });
  assert.equal(response.status, 200);
  const ownership = statements.find((entry) => /FROM scheduled_trips WHERE id = \? AND organizer_id = \?/.test(entry.sql));
  assert.deepEqual(ownership.args, ["trip-a", "org-a"]);
});

test("the trip list is the session's own and ignores a forged organizerId", async () => {
  statements.length = 0;
  const request = new Request(`${URL_BASE}/api/console/trips?organizerId=org-b`, { headers: { cookie: await cookieFor("acc-a") } });
  const response = await tripsRoute.GET(request);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.trips.map((trip) => trip.id), ["trip-a"]);
  const list = statements.find((entry) => /FROM scheduled_trips t WHERE t\.organizer_id = \?/.test(entry.sql));
  assert.deepEqual(list.args, ["org-a"]);
});

test("a moderator may review organizers but may not assign trips", async () => {
  statements.length = 0;
  const request = new Request(`${URL_BASE}/api/console/trips`, {
    method: "PATCH",
    headers: { cookie: await cookieFor("acc-mod"), "content-type": "application/json" },
    body: JSON.stringify({ tripId: "trip-a", organizerId: "org-b" }),
  });
  const response = await tripsRoute.PATCH(request);
  assert.equal(response.status, 403);
  assert.equal(statements.some((entry) => /UPDATE scheduled_trips SET organizer_id/.test(entry.sql)), false);
});

test("a pending or suspended organizer cannot reach the workspace", async () => {
  for (const accountId of ["acc-pending", "acc-suspended"]) {
    const request = new Request(`${URL_BASE}/api/console/trips`, { headers: { cookie: await cookieFor(accountId) } });
    const response = await tripsRoute.GET(request);
    assert.equal(response.status, 401, `${accountId} must not reach organizer data`);
  }
});

test("suspending an organizer pulls their live trips and revokes the sign-in", async () => {
  statements.length = 0;
  const response = await organizersRoute.PATCH(new Request(`${URL_BASE}/api/console/organizers`, {
    method: "PATCH",
    headers: { cookie: await cookieFor("acc-admin"), "content-type": "application/json" },
    body: JSON.stringify({ organizerId: "org-a", action: "SUSPEND", reason: "Passengers reported the coach did not run." }),
  }));
  assert.equal(response.status, 200);

  const business = statements.find((entry) => /UPDATE trip_organizers SET status = 'SUSPENDED'/.test(entry.sql));
  assert.equal(business.args[2], "org-a");
  const account = statements.find((entry) => /UPDATE console_accounts SET status = 'SUSPENDED'/.test(entry.sql));
  assert.equal(account.args[1], "acc-a", "the console account follows the business record");
  assert.ok(statements.some((entry) => /token_version = COALESCE\(token_version,0\) \+ 1/.test(entry.sql)), "live sessions are retired");

  // The trips leave the public list in the same action: a live trip still on
  // sale would keep taking money the payout gate will not pay out.
  const pulled = statements.find((entry) => /UPDATE scheduled_trips SET review_status = 'SUSPENDED'/.test(entry.sql));
  assert.ok(pulled, "a suspended organizer's live trips must leave the public list");
  assert.match(pulled.sql, /review_status = 'APPROVED'/, "only trips that are live are pulled");
  assert.equal(pulled.args[2], "admin@example.com");
  assert.equal(pulled.args[4], "org-a");
  assert.ok(statements.some((entry) => entry.args[2] === "ORGANIZER_SUSPEND"), "the decision is audited");
});

test("an admin may assign a trip, but never to an unapproved organizer", async () => {
  const admin = await cookieFor("acc-admin");
  statements.length = 0;
  const assigned = await tripsRoute.PATCH(new Request(`${URL_BASE}/api/console/trips`, {
    method: "PATCH",
    headers: { cookie: admin, "content-type": "application/json" },
    body: JSON.stringify({ tripId: "trip-a", organizerId: "org-a" }),
  }));
  assert.equal(assigned.status, 200);
  const update = statements.find((entry) => /UPDATE scheduled_trips SET organizer_id/.test(entry.sql));
  assert.deepEqual(update.args.slice(0, 1), ["org-a"]);

  const refused = await tripsRoute.PATCH(new Request(`${URL_BASE}/api/console/trips`, {
    method: "PATCH",
    headers: { cookie: admin, "content-type": "application/json" },
    body: JSON.stringify({ tripId: "trip-a", organizerId: "org-p" }),
  }));
  assert.equal(refused.status, 409);
});

test("the notice is written for the session's organizer", async () => {
  statements.length = 0;
  const noticeRoute = await vite.ssrLoadModule("/app/api/console/trips/notice/route.ts");
  const response = await noticeRoute.PUT(new Request(`${URL_BASE}/api/console/trips/notice`, {
    method: "PUT",
    headers: { cookie: await cookieFor("acc-a"), "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, title: "A Travel night bus", contacts: ["0200000001"] }),
  }));
  assert.equal(response.status, 200);
  const write = statements.find((entry) => /INSERT INTO trip_notices/.test(entry.sql));
  assert.equal(write.args[0], "org-a");
  assert.equal(Number(write.args[1]), 1);
  assert.equal(write.args[2], "A Travel night bus");
});
