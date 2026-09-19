import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Phase 6's rules are about who may say what about whom, and about telling an
 * organizer something useful without letting them see something they should
 * not. These tests drive the real routes against a fake Turso and record every
 * statement, so the scoping can be asserted on the arguments a query was given
 * rather than on a count that happens to look right.
 */

process.env.TURSO_DATABASE_URL = "https://phase6-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret-at-least-32-chars";
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";

const SCHEMA_VERSIONS = {
  campusRide: "2026-09-18.1", scheduledTrips: "2026-09-18.2", tripOrganizers: "2026-09-18.3",
  organizerPayouts: "2026-09-18.2", tripDisputes: "2026-09-18.1",
};

const ACCOUNT_COLUMNS = ["id", "email", "name", "phone", "role", "status", "profile_id"];

const accounts = [
  { id: "acc-admin", email: "admin@example.com", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profile_id: "", token_version: 0 },
  { id: "acc-mod", email: "mod@example.com", name: "Moderator", phone: "", role: "MODERATOR", status: "ACTIVE", profile_id: "", token_version: 0 },
  { id: "acc-a", email: "a@example.com", name: "Organizer A", phone: "0200000001", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-a", token_version: 0 },
  { id: "acc-b", email: "b@example.com", name: "Organizer B", phone: "0200000002", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-b", token_version: 0 },
];

const students = [
  { id: "stu-1", email: "ama@st.umat.edu.gh", name: "Ama", phone: "0244000001", token_version: 0, active: 1 },
  { id: "stu-2", email: "kofi@st.umat.edu.gh", name: "Kofi", phone: "0244000002", token_version: 0, active: 1 },
];

const organizers = [
  { id: "org-a", name: "Organizer A", status: "APPROVED", kyc_status: "VERIFIED", commission_bps: 300 },
  { id: "org-b", name: "Organizer B", status: "APPROVED", kyc_status: "VERIFIED", commission_bps: 300 },
];

const trips = [
  { id: "trip-a", title: "UMaT to Accra", route_from: "UMaT", route_to: "Accra", travel_date: "2026-10-03", departure_time: "06:30", capacity: 50, organizer_id: "org-a", review_status: "APPROVED", active: 1, archived: 0 },
  // Same route, 90 minutes later, another organizer: an overlap, and legitimate.
  { id: "trip-b", title: "UMaT to Accra (later)", route_from: "UMaT", route_to: "Accra", travel_date: "2026-10-03", departure_time: "08:00", capacity: 40, organizer_id: "org-b", review_status: "APPROVED", active: 1, archived: 0 },
  // Same route, four hours later: outside the window, so not an overlap.
  { id: "trip-c", title: "UMaT to Accra (afternoon)", route_from: "UMaT", route_to: "Accra", travel_date: "2026-10-03", departure_time: "10:30", capacity: 40, organizer_id: "org-b", review_status: "APPROVED", active: 1, archived: 0 },
  // The reverse direction is a different service, never an overlap.
  { id: "trip-d", title: "Accra to UMaT", route_from: "Accra", route_to: "UMaT", travel_date: "2026-10-03", departure_time: "06:30", capacity: 40, organizer_id: "org-b", review_status: "APPROVED", active: 1, archived: 0 },
  // Same route and time, but on another day.
  { id: "trip-e", title: "UMaT to Accra (other day)", route_from: "UMaT", route_to: "Accra", travel_date: "2026-10-10", departure_time: "06:30", capacity: 40, organizer_id: "org-b", review_status: "APPROVED", active: 1, archived: 0 },
];

const bookings = [
  { id: "bk-1", reference: "UMX-AMA1", email: "ama@st.umat.edu.gh", trip_id: "trip-a", organizer_id: "org-a", booking_status: "CONFIRMED", amount: 18360 },
  { id: "bk-2", reference: "UMX-KOFI", email: "kofi@st.umat.edu.gh", trip_id: "trip-a", organizer_id: "org-a", booking_status: "CONFIRMED", amount: 18360 },
];

const payouts = [
  { trip_id: "trip-a", gross_amount: 18000, commission_amount: 540, net_amount: 17460, status: "ACCRUED" },
];

const disputes = [];
const audits = [];
const statements = [];
const windows = new Map();

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
const okRows = (count) => ok({ affected_row_count: count });

function disputeRows(rows) {
  return table(
    ["id", "organizer_id", "organizer_name", "trip_id", "booking_reference", "raised_by_role", "raised_by", "category",
      "subject", "details", "status", "resolution", "resolution_note", "resolved_by", "resolved_at", "created_at", "updated_at"],
    rows.map((row) => ({ organizer_name: organizers.find((item) => item.id === row.organizer_id)?.name || "", ...row })),
  );
}

function handle(sql, args) {
  if (/^CREATE |^ALTER |^INSERT OR REPLACE INTO campus_schema_meta/.test(sql)) return ok(empty);
  const version = sql.match(/SELECT version FROM campus_schema_meta WHERE id = '([^']+)'/);
  if (version) return ok(table(["version"], [{ version: SCHEMA_VERSIONS[version[1]] || "0" }]));

  if (/AS token_version FROM console_accounts/.test(sql)) {
    const account = accounts.find((item) => item.id === args[0]);
    return ok(account ? table(["token_version"], [account]) : empty);
  }
  if (/FROM console_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const account = accounts.find((item) => item.id === args[0]);
    return ok(account ? table(ACCOUNT_COLUMNS, [account]) : empty);
  }
  if (/FROM student_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const student = students.find((item) => item.id === args[0]);
    return ok(student ? table(["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active", "password_hash", "password_salt", "password_iterations"], [{
      ...student, created_at: "2026-09-01T00:00:00.000Z", last_login_at: "", password_hash: "", password_salt: "", password_iterations: 1,
    }]) : empty);
  }

  // The dispute ownership read: the booking decides who the dispute is about.
  if (/FROM bookings b LEFT JOIN scheduled_trips t/.test(sql)) {
    const booking = bookings.find((item) => item.reference === args[0]);
    if (!booking) return ok(empty);
    const trip = trips.find((item) => item.id === booking.trip_id);
    return ok(table(["id", "email", "trip_id", "organizer_id", "trip_organizer_id"], [{
      id: booking.id, email: booking.email, trip_id: booking.trip_id,
      organizer_id: booking.organizer_id, trip_organizer_id: trip?.organizer_id || "",
    }]));
  }
  if (/^SELECT COALESCE\(organizer_id,''\) AS organizer_id FROM scheduled_trips WHERE id = \? LIMIT 1/.test(sql)) {
    const trip = trips.find((item) => item.id === args[0]);
    return ok(trip ? table(["organizer_id"], [trip]) : empty);
  }
  if (/^INSERT INTO trip_disputes/.test(sql)) {
    disputes.push({
      id: String(args[0]), organizer_id: String(args[1]), trip_id: String(args[2]), booking_reference: String(args[3]),
      raised_by_role: String(args[4]), raised_by: String(args[5]), raised_by_contact: String(args[6]),
      category: String(args[7]), subject: String(args[8]), details: String(args[9]),
      status: "OPEN", resolution: "", resolution_note: "", resolved_by: "", resolved_at: "",
      created_at: String(args[10]), updated_at: String(args[11]),
    });
    return okRows(1);
  }
  if (/FROM trip_disputes d LEFT JOIN trip_organizers o/.test(sql)) {
    if (/WHERE d\.raised_by_role = 'STUDENT'/.test(sql)) {
      return ok(disputeRows(disputes.filter((row) => row.raised_by_role === "STUDENT" && row.raised_by.toLowerCase() === String(args[0]).toLowerCase())));
    }
    if (/WHERE d\.organizer_id = \? ORDER BY/.test(sql)) {
      return ok(disputeRows(disputes.filter((row) => row.organizer_id === args[0])));
    }
    const status = String(args[0] || "");
    return ok(disputeRows(disputes.filter((row) => !status || row.status === status)));
  }
  if (/^SELECT status, COUNT\(\*\) AS total FROM trip_disputes GROUP BY status/.test(sql)) {
    const grouped = new Map();
    for (const row of disputes) grouped.set(row.status, (grouped.get(row.status) || 0) + 1);
    return ok(table(["status", "total"], [...grouped].map(([status, total]) => ({ status, total }))));
  }
  if (/^SELECT id,status FROM trip_disputes WHERE id = \? LIMIT 1/.test(sql)) {
    const row = disputes.find((item) => item.id === args[0]);
    return ok(row ? table(["id", "status"], [row]) : empty);
  }
  if (/^UPDATE trip_disputes SET status = 'REVIEWING'/.test(sql)) {
    const row = disputes.find((item) => item.id === args[1]);
    if (row) row.status = "REVIEWING";
    return okRows(row ? 1 : 0);
  }
  if (/^UPDATE trip_disputes SET status = \?/.test(sql)) {
    const row = disputes.find((item) => item.id === args[6]);
    if (row) {
      row.status = String(args[0]);
      row.resolution = String(args[1]);
      row.resolution_note = String(args[2]);
      row.resolved_by = String(args[3]);
      row.resolved_at = String(args[4]);
      row.updated_at = String(args[5]);
    }
    return okRows(row ? 1 : 0);
  }
  if (/^INSERT INTO admin_audit_logs/.test(sql)) {
    audits.push({ actor: String(args[1]), action: String(args[2]), target: String(args[4]), details: String(args[5]) });
    return okRows(1);
  }

  // Overlap lookup.
  if (/FROM scheduled_trips t LEFT JOIN trip_organizers o ON o\.id = t\.organizer_id/.test(sql)) {
    const [travelDate, from, to, exclude] = args;
    const rows = trips.filter((trip) => !trip.archived
      && ["APPROVED", "PENDING_REVIEW"].includes(trip.review_status)
      && trip.travel_date === travelDate
      && trip.route_from.toLowerCase().trim() === from
      && trip.route_to.toLowerCase().trim() === to
      && (!exclude || trip.id !== exclude));
    return ok(table(
      ["id", "title", "route_from", "route_to", "travel_date", "departure_time", "organizer_id", "organizer_name"],
      rows.map((trip) => ({ ...trip, organizer_name: organizers.find((item) => item.id === trip.organizer_id)?.name || "" })),
    ));
  }

  // Per-trip performance.
  if (/FROM scheduled_trips t\s+LEFT JOIN \(/.test(sql)) {
    const rows = trips.filter((trip) => trip.organizer_id === args[0] && !trip.archived).map((trip) => {
      const owned = bookings.filter((booking) => booking.trip_id === trip.id && booking.booking_status === "CONFIRMED");
      const ledger = payouts.filter((row) => row.trip_id === trip.id);
      return {
        ...trip,
        booked: owned.length,
        gross: ledger.reduce((total, row) => total + row.gross_amount, 0),
        commission: ledger.reduce((total, row) => total + row.commission_amount, 0),
        net: ledger.reduce((total, row) => total + row.net_amount, 0),
        accrued: ledger.filter((row) => row.status === "ACCRUED").reduce((total, row) => total + row.net_amount, 0),
        released: ledger.filter((row) => row.status === "RELEASED").reduce((total, row) => total + row.net_amount, 0),
      };
    });
    return ok(table(
      ["id", "title", "route_from", "route_to", "travel_date", "departure_time", "review_status", "active", "capacity",
        "booked", "gross", "commission", "net", "accrued", "released"],
      rows,
    ));
  }

  if (/^DELETE FROM rate_limit_windows/.test(sql)) return ok(empty);
  if (/INSERT INTO rate_limit_windows/.test(sql)) {
    const key = `${args[0]}:${args[1]}:${args[2]}`;
    const next = (windows.get(key) || 0) + 1;
    windows.set(key, next);
    return ok(table(["count"], [{ count: next }]));
  }
  if (/SELECT count FROM rate_limit_windows/.test(sql)) return ok(table(["count"], [{ count: windows.get(`${args[0]}:${args[1]}:${args[2]}`) || 1 }]));
  if (/^INSERT INTO rate_limit_windows|^UPDATE scheduled_trips/.test(sql)) return okRows(0);
  return ok(empty);
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init.body));
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
const { STUDENT_SESSION_COOKIE, createStudentSession } = await vite.ssrLoadModule("/lib/student-auth.ts");
const { findRouteOverlaps, organizerInsights, organizerTripPerformance, overlapsRoute } = await vite.ssrLoadModule("/lib/organizer-insights.ts");
const studentRoute = await vite.ssrLoadModule("/app/api/disputes/route.ts");
const consoleRoute = await vite.ssrLoadModule("/app/api/console/disputes/route.ts");

const URL_BASE = "https://umatexpress.test";

async function consoleCookie(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(await createConsoleSession({ id: account.id, role: account.role }))}`;
}

async function studentCookie(accountId) {
  return `${STUDENT_SESSION_COOKIE}=${encodeURIComponent(await createStudentSession(accountId))}`;
}

test.afterEach(() => {
  disputes.length = 0;
  audits.length = 0;
  windows.clear();
});

test("an overlap is the same route, the same day, and a nearby departure", async () => {
  const candidate = { routeFrom: "UMaT", routeTo: "Accra", travelDate: "2026-10-03", departureTime: "06:30" };
  const overlaps = await findRouteOverlaps({ organizerId: "org-a", ...candidate });
  const ids = overlaps.map((row) => row.id).sort();
  assert.deepEqual(ids, ["trip-a", "trip-b"], "both the 06:30 and the 08:00 departure are within three hours on the same route");
  // The organizer's own coach is reported too, and flagged as theirs: running
  // two coaches on one route is a decision, not something to hide from them.
  const own = overlaps.find((row) => row.id === "trip-a");
  const other = overlaps.find((row) => row.id === "trip-b");
  assert.equal(own.own, true);
  assert.equal(other.own, false);
  assert.equal(other.organizerName, "Organizer B");

  // Editing that same 06:30 trip does not report it as clashing with itself.
  const editing = await findRouteOverlaps({ organizerId: "org-a", ...candidate, excludeTripId: "trip-a" });
  assert.deepEqual(editing.map((row) => row.id), ["trip-b"]);

  // The reverse direction is a different service, and another day is another trip.
  assert.equal(overlaps.some((row) => row.id === "trip-d"), false);
  assert.equal(overlaps.some((row) => row.id === "trip-e"), false);
});

test("route names are compared the way a person would read them", () => {
  const row = { id: "x", title: "", routeFrom: "", routeTo: "", travelDate: "2026-10-03", departureTime: "07:00", organizerId: "", organizerName: "", own: false, minutesApart: 7 * 60 };
  assert.equal(overlapsRoute({ routeFrom: "  umat ", routeTo: "ACCRA", travelDate: "2026-10-03", departureTime: "06:30" }, { ...row, routeFrom: "UMaT", routeTo: "Accra" }), true);
  // An unparseable time cannot produce an alarm, because a false one trains
  // the organizer to ignore the real ones.
  assert.equal(overlapsRoute({ routeFrom: "UMaT", routeTo: "Accra", travelDate: "2026-10-03", departureTime: "" }, { ...row, routeFrom: "UMaT", routeTo: "Accra" }), false);
});

test("a passenger may only dispute a booking made with their own account", async () => {
  const ama = await studentCookie("stu-1");
  const allowed = await studentRoute.POST(new Request(`${URL_BASE}/api/disputes`, {
    method: "POST",
    headers: { cookie: ama, "content-type": "application/json" },
    body: JSON.stringify({ bookingReference: "UMX-AMA1", subject: "Coach left early", details: "The coach left thirty minutes before the stated time." }),
  }));
  assert.equal(allowed.status, 201);
  const created = await allowed.json();
  assert.equal(created.dispute.organizerId, "org-a", "the organizer comes from the booking, not the request");
  assert.equal(created.dispute.tripId, "trip-a");

  // The same student, someone else's booking reference.
  const denied = await studentRoute.POST(new Request(`${URL_BASE}/api/disputes`, {
    method: "POST",
    headers: { cookie: ama, "content-type": "application/json" },
    body: JSON.stringify({ bookingReference: "UMX-KOFI", subject: "Not mine", details: "I am trying to file against a booking that is not mine." }),
  }));
  assert.equal(denied.status, 403);
  assert.equal(disputes.length, 1, "the refused dispute is not written");
});

test("a dispute needs a real description, not a subject line", async () => {
  const ama = await studentCookie("stu-1");
  const response = await studentRoute.POST(new Request(`${URL_BASE}/api/disputes`, {
    method: "POST",
    headers: { cookie: ama, "content-type": "application/json" },
    body: JSON.stringify({ bookingReference: "UMX-AMA1", subject: "Bad", details: "too short" }),
  }));
  assert.equal(response.status, 400);
  assert.equal(disputes.length, 0);
});

test("a passenger sees their own disputes and nobody else's", async () => {
  const ama = await studentCookie("stu-1");
  await studentRoute.POST(new Request(`${URL_BASE}/api/disputes`, {
    method: "POST",
    headers: { cookie: ama, "content-type": "application/json" },
    body: JSON.stringify({ bookingReference: "UMX-AMA1", subject: "Seat was taken", details: "Someone else was sitting in my seat for the whole trip." }),
  }));
  const kofi = await studentCookie("stu-2");
  const theirs = await studentRoute.GET(new Request(`${URL_BASE}/api/disputes`, { headers: { cookie: kofi } }));
  assert.equal(theirs.status, 200);
  assert.deepEqual((await theirs.json()).disputes, []);

  const mine = await studentRoute.GET(new Request(`${URL_BASE}/api/disputes`, { headers: { cookie: ama } }));
  assert.equal((await mine.json()).disputes.length, 1);
});

test("an organizer may only dispute a booking on their own trip", async () => {
  const owner = await consoleCookie("acc-a");
  const allowed = await consoleRoute.POST(new Request(`${URL_BASE}/api/console/disputes`, {
    method: "POST",
    headers: { cookie: owner, "content-type": "application/json" },
    body: JSON.stringify({ action: "OPEN", bookingReference: "UMX-AMA1", subject: "Passenger did not board", details: "The passenger did not show up and asked for a refund afterwards." }),
  }));
  assert.equal(allowed.status, 201);

  const stranger = await consoleCookie("acc-b");
  const denied = await consoleRoute.POST(new Request(`${URL_BASE}/api/console/disputes`, {
    method: "POST",
    headers: { cookie: stranger, "content-type": "application/json" },
    body: JSON.stringify({ action: "OPEN", bookingReference: "UMX-AMA1", subject: "Not my trip", details: "Filing against a trip that belongs to another organizer." }),
  }));
  assert.equal(denied.status, 403);
  assert.equal(disputes.length, 1);
});

test("an organizer reads only the disputes about their own trips", async () => {
  disputes.push(
    { id: "d-a", organizer_id: "org-a", trip_id: "trip-a", booking_reference: "UMX-AMA1", raised_by_role: "STUDENT", raised_by: "ama@st.umat.edu.gh", category: "BOOKING", subject: "Mine", details: "", status: "OPEN", resolution: "", resolution_note: "", resolved_by: "", resolved_at: "", created_at: "2026-09-18T00:00:00.000Z", updated_at: "" },
    { id: "d-b", organizer_id: "org-b", trip_id: "trip-b", booking_reference: "UMX-OTHER", raised_by_role: "STUDENT", raised_by: "kofi@st.umat.edu.gh", category: "BOOKING", subject: "Theirs", details: "", status: "OPEN", resolution: "", resolution_note: "", resolved_by: "", resolved_at: "", created_at: "2026-09-18T00:00:00.000Z", updated_at: "" },
  );
  const response = await consoleRoute.GET(new Request(`${URL_BASE}/api/console/disputes`, { headers: { cookie: await consoleCookie("acc-a") } }));
  const body = await response.json();
  assert.deepEqual(body.disputes.map((row) => row.id), ["d-a"]);
  assert.equal(JSON.stringify(body).includes("Theirs"), false);
});

test("resolving is an administrator decision, and a moderator may not make it", async () => {
  disputes.push({ id: "d-1", organizer_id: "org-a", trip_id: "trip-a", booking_reference: "UMX-AMA1", raised_by_role: "STUDENT", raised_by: "ama@st.umat.edu.gh", category: "REFUND", subject: "Coach broke down", details: "", status: "OPEN", resolution: "", resolution_note: "", resolved_by: "", resolved_at: "", created_at: "2026-09-18T00:00:00.000Z", updated_at: "" });

  const moderator = await consoleRoute.POST(new Request(`${URL_BASE}/api/console/disputes`, {
    method: "POST",
    headers: { cookie: await consoleCookie("acc-mod"), "content-type": "application/json" },
    body: JSON.stringify({ action: "RESOLVE", disputeId: "d-1", status: "RESOLVED", resolution: "REFUND", note: "Refund approved" }),
  }));
  assert.equal(moderator.status, 403, "a moderator reads the queue, an administrator decides it");
  assert.equal(disputes[0].status, "OPEN");

  const admin = await consoleRoute.POST(new Request(`${URL_BASE}/api/console/disputes`, {
    method: "POST",
    headers: { cookie: await consoleCookie("acc-admin"), "content-type": "application/json" },
    body: JSON.stringify({ action: "RESOLVE", disputeId: "d-1", status: "RESOLVED", resolution: "REFUND", note: "Coach failed to run; fare refunded." }),
  }));
  assert.equal(admin.status, 200);
  assert.equal(disputes[0].status, "RESOLVED");
  assert.equal(disputes[0].resolution, "REFUND");
  assert.equal(disputes[0].resolved_by, "admin@example.com");
  const audit = audits.find((row) => row.action === "DISPUTE_RESOLVED");
  assert.ok(audit, "a decision is audited with its actor");
  assert.match(audit.details, /Coach failed to run/);
});

test("a decision without a reason is refused, so the record explains itself", async () => {
  disputes.push({ id: "d-2", organizer_id: "org-a", trip_id: "trip-a", booking_reference: "", raised_by_role: "ORGANIZER", raised_by: "org-a", category: "OTHER", subject: "Question", details: "", status: "OPEN", resolution: "", resolution_note: "", resolved_by: "", resolved_at: "", created_at: "2026-09-18T00:00:00.000Z", updated_at: "" });
  const response = await consoleRoute.POST(new Request(`${URL_BASE}/api/console/disputes`, {
    method: "POST",
    headers: { cookie: await consoleCookie("acc-admin"), "content-type": "application/json" },
    body: JSON.stringify({ action: "RESOLVE", disputeId: "d-2", status: "RESOLVED", resolution: "NO_ACTION", note: "" }),
  }));
  assert.equal(response.status, 400);
  assert.equal(disputes[0].status, "OPEN");
});

test("the insight totals reconcile to the ledger, not to a second guess", async () => {
  const insights = await organizerInsights("org-a");
  assert.equal(insights.trips, 1);
  assert.equal(insights.liveTrips, 1);
  assert.equal(insights.seatsSold, 2);
  assert.equal(insights.seatsOffered, 50);
  assert.equal(insights.gross, 18000);
  assert.equal(insights.net, 17460);
  assert.equal(insights.accrued, 17460);
  assert.equal(insights.released, 0);
});

test("a trip with no capacity reports no sell-through rather than a full coach", async () => {
  trips.push({ id: "trip-nocap", title: "No capacity", route_from: "UMaT", route_to: "Takoradi", travel_date: "2026-10-11", departure_time: "05:00", capacity: 0, organizer_id: "org-a", review_status: "APPROVED", active: 1, archived: 0 });
  const performance = await organizerTripPerformance("org-a");
  const noCapacity = performance.find((trip) => trip.tripId === "trip-nocap");
  assert.ok(noCapacity, "a trip without a capacity is still listed");
  assert.equal(noCapacity.capacity, 0);
  assert.equal(noCapacity.sellThrough, 0, "an unknown capacity is not a full coach");

  const insights = await organizerInsights("org-a");
  assert.equal(insights.seatsOffered, 50, "a zero capacity adds nothing to the total");
  assert.equal(insights.sellThrough, 0.04, "the total is seats sold over seats offered, and the unknown-capacity trip adds no seats");
  trips.pop();
});
