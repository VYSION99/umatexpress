import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * The vacationRide confirmation is the passenger's copy of a payment: the
 * outbox row is both the email and the in-app message. These tests drive the
 * real verify route, the real Paystack webhook and the real cancellation route
 * against a fake Turso, so what is covered is the idempotency that matters —
 * verification and the webhook can both confirm the same booking, and the
 * passenger must still receive exactly one message.
 */

process.env.TURSO_DATABASE_URL = "https://vacation-notify-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.PAYSTACK_SECRET_KEY = "sk_test_vacation_notifications";
process.env.PAYSTACK_CURRENCY = "GHS";
process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret-at-least-32-chars";
process.env.ADMIN_EMAILS = "admin@example.com";
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";

const SCHEMA_VERSIONS = { campusRide: "2026-09-18.1", scheduledTrips: "2026-09-18.2", tripOrganizers: "2026-09-18.3", organizerPayouts: "2026-09-18.2" };

const trips = [
  { id: "trip-a", title: "UMaT to Accra", route_from: "UMaT", route_to: "Accra", travel_date: "2026-10-03", departure_time: "06:30", arrival_time: "11:30", price: 180, capacity: 50, coach_type: "VIP Coach", tag: "Morning", amenities: '["AC"]', notes: "", active: 1, archived: 0, display_order: 1, organizer_id: "org-a", review_status: "APPROVED", created_at: "2026-09-01T00:00:00.000Z" },
];

const bookings = [
  { id: "bk-pending", reference: "UMX-VAC1", passenger_name: "Esi", email: "esi@st.umat.edu.gh", phone: "0244000001", seat: 8, trip_id: "trip-a", travel_date: "2026-10-03", amount: 18360, payment_status: "PENDING", booking_status: "AWAITING_PAYMENT", departure_time: "06:30", organizer_id: "org-a", confirmed_at: "", created_at: "2026-09-20T14:00:00.000Z" },
  { id: "bk-paid", reference: "UMX-VAC2", passenger_name: "Ama", email: "ama@st.umat.edu.gh", phone: "0244000002", seat: 3, trip_id: "trip-a", travel_date: "2026-10-03", amount: 18360, payment_status: "SUCCESSFUL", booking_status: "CONFIRMED", departure_time: "06:30", organizer_id: "org-a", confirmed_at: "2026-09-20T12:00:00.000Z", created_at: "2026-09-20T11:00:00.000Z" },
  { id: "bk-unpaid", reference: "UMX-VAC3", passenger_name: "Kofi", email: "kofi@st.umat.edu.gh", phone: "0244000003", seat: 4, trip_id: "trip-a", travel_date: "2026-10-03", amount: 18360, payment_status: "PENDING", booking_status: "AWAITING_PAYMENT", departure_time: "06:30", organizer_id: "org-a", confirmed_at: "", created_at: "2026-09-20T13:00:00.000Z" },
];

const payments = [
  { id: "pay-vac1", booking_id: "bk-pending", provider: "PAYSTACK", reference_id: "ref-vac1", amount: 18360, status: "PENDING", access_token_hash: "" },
  { id: "pay-vac2", booking_id: "bk-paid", provider: "PAYSTACK", reference_id: "ref-vac2", amount: 18360, status: "SUCCESSFUL", access_token_hash: "" },
];

// Two accounts so the ownership rule can be tested with a real second party:
// Ama's booking must open for Ama and stay shut for Kofi.
const students = [
  { id: "stu-ama", email: "ama@st.umat.edu.gh", name: "Ama", phone: "0244000002", token_version: 0, active: 1 },
  { id: "stu-kofi", email: "kofi@st.umat.edu.gh", name: "Kofi", phone: "0244000003", token_version: 0, active: 1 },
];

const seatHolds = [{ id: "hold-vac1", booking_id: "bk-pending", trip_id: "trip-a", travel_date: "2026-10-03", seat: 8, status: "HELD", expires_at: "2099-01-01T00:00:00.000Z" }];

const outbox = [];
const paymentEvents = [];

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

function handle(sql, args) {
  if (/^CREATE |^ALTER |^INSERT OR REPLACE INTO campus_schema_meta|^INSERT INTO admin_audit_logs/.test(sql)) return ok(empty);
  const version = sql.match(/SELECT version FROM campus_schema_meta WHERE id = '([^']+)'/);
  if (version) return ok(table(["version"], [{ version: SCHEMA_VERSIONS[version[1]] || "0" }]));

  if (/FROM student_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const student = students.find((item) => item.id === args[0]);
    return ok(student ? table(["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active"], [{ ...student, created_at: "", last_login_at: "" }]) : empty);
  }

  if (/^SELECT id, booking_id, provider, reference_id, amount, status, access_token_hash FROM payments WHERE reference_id = \? LIMIT 1/.test(sql)) {
    const payment = payments.find((item) => item.reference_id === args[0]);
    return ok(payment ? table(["id", "booking_id", "provider", "reference_id", "amount", "status", "access_token_hash"], [payment]) : empty);
  }
  if (/^SELECT booking_id, amount, status FROM payments WHERE reference_id = \? AND provider = 'PAYSTACK' LIMIT 1/.test(sql)) {
    const payment = payments.find((item) => item.reference_id === args[0]);
    return ok(payment ? table(["booking_id", "amount", "status"], [payment]) : empty);
  }
  if (/^UPDATE seat_holds SET status = 'BOOKED'/.test(sql)) {
    const hold = seatHolds.find((item) => item.booking_id === args[0] && item.status === "HELD" && item.expires_at >= String(args[1]));
    if (hold) { hold.status = "BOOKED"; return okRows(1); }
    return okRows(0);
  }
  if (/^SELECT status FROM seat_holds WHERE booking_id = \? AND status = 'BOOKED' LIMIT 1/.test(sql)) {
    const hold = seatHolds.find((item) => item.booking_id === args[0] && item.status === "BOOKED");
    return ok(hold ? table(["status"], [hold]) : empty);
  }
  if (/^UPDATE payments SET status = 'SUCCESSFUL'/.test(sql)) {
    const payment = payments.find((item) => item.reference_id === args[3]);
    if (payment) payment.status = "SUCCESSFUL";
    return okRows(payment ? 1 : 0);
  }
  if (/^UPDATE bookings SET payment_status = 'SUCCESSFUL', booking_status = 'CONFIRMED'/.test(sql)) {
    const booking = bookings.find((item) => item.id === args[1]);
    if (booking) { booking.payment_status = "SUCCESSFUL"; booking.booking_status = "CONFIRMED"; booking.confirmed_at = String(args[0]); }
    return okRows(booking ? 1 : 0);
  }
  if (/^SELECT reference, passenger_name, seat, trip_id, travel_date, departure_time, amount FROM bookings WHERE id = \?/.test(sql)) {
    const booking = bookings.find((item) => item.id === args[0]);
    return ok(booking ? table(["reference", "passenger_name", "seat", "trip_id", "travel_date", "departure_time", "amount"], [booking]) : empty);
  }
  if (/^SELECT email FROM bookings WHERE id = \? LIMIT 1/.test(sql)) {
    const booking = bookings.find((item) => item.id === args[0]);
    return ok(booking ? table(["email"], [booking]) : empty);
  }
  if (/FROM scheduled_trips WHERE 1 = 1/.test(sql)) {
    return ok(table(
      ["id", "title", "route_from", "route_to", "travel_date", "departure_time", "arrival_time", "price", "capacity", "coach_type", "tag", "amenities", "notes", "active", "archived", "display_order", "created_at", "organizer_id", "review_status"],
      trips,
    ));
  }

  // The notification helper's own lookup: the booking plus its trip's route.
  if (/FROM bookings b LEFT JOIN scheduled_trips t ON t\.id = b\.trip_id/.test(sql)) {
    const booking = bookings.find((item) => item.id === args[0]);
    if (!booking) return ok(empty);
    const trip = trips.find((item) => item.id === booking.trip_id);
    return ok(table(
      ["reference", "email", "seat", "travel_date", "departure_time", "amount", "booking_status", "route_from", "route_to"],
      [{ ...booking, route_from: trip?.route_from || "", route_to: trip?.route_to || "" }],
    ));
  }

  // The outbox's unique (reference, template) index, faked faithfully.
  if (/^INSERT INTO notification_outbox/.test(sql)) {
    const row = { id: args[0], channel: args[1], recipient: args[2], template: args[3], subject: args[4], message: args[5], reference: args[6] };
    if (outbox.some((item) => item.reference === row.reference && item.template === row.template)) return okRows(0);
    outbox.push(row);
    return okRows(1);
  }
  if (/^INSERT INTO payment_events/.test(sql)) {
    const [provider, eventId] = args;
    if (paymentEvents.some((item) => item.provider === provider && item.event_id === eventId)) return okRows(0);
    paymentEvents.push({ provider, event_id: eventId });
    return okRows(1);
  }

  // The cancellation route's own statements.
  if (/^SELECT id, reference, passenger_name, email, phone, seat, trip_id, travel_date, amount, payment_status, booking_status, departure_time, created_at FROM bookings WHERE reference = \? LIMIT 1/.test(sql)) {
    const booking = bookings.find((item) => item.reference === args[0]);
    return ok(booking ? table(["id", "reference", "passenger_name", "email", "phone", "seat", "trip_id", "travel_date", "amount", "payment_status", "booking_status", "departure_time", "created_at"], [booking]) : empty);
  }
  if (/^UPDATE bookings SET payment_status = 'CANCELLED', booking_status = 'CANCELLED' WHERE reference = \?/.test(sql)) {
    const booking = bookings.find((item) => item.reference === args[0]);
    if (booking) { booking.payment_status = "CANCELLED"; booking.booking_status = "CANCELLED"; }
    return okRows(booking ? 1 : 0);
  }
  if (/FROM organizer_payouts WHERE booking_id = \? LIMIT 1/.test(sql)) return ok(empty);

  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes("api.paystack.co/transaction/verify/")) {
    return { ok: true, status: 200, json: async () => ({ status: true, data: { id: 7788, status: "success", amount: 18360, currency: "GHS", gateway_response: "Approved" } }) };
  }
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => {
      const args = (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value));
      return handle(stmt.sql, args);
    });
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true }, hmr: false });
after(async () => vite.close());

const URL_BASE = "https://umatexpress.test";

async function signWebhook(payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.PAYSTACK_SECRET_KEY), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("a confirmed payment queues one message naming the seat, route, date and fare", async () => {
  const { hashPaymentToken } = await vite.ssrLoadModule("/lib/payment-access.ts");
  payments.find((item) => item.reference_id === "ref-vac1").access_token_hash = await hashPaymentToken("vacation-token");
  const { GET } = await vite.ssrLoadModule("/app/api/payments/verify/route.ts");

  const request = () => new Request(`${URL_BASE}/api/payments/verify?reference=ref-vac1`, { headers: { cookie: "umx_payment_access_ref-vac1=vacation-token" } });
  const response = await GET(request());
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.paid, true);

  assert.equal(outbox.length, 1, "one confirmation, and only one");
  const notice = outbox[0];
  assert.equal(notice.template, "vacation_booking_confirmed");
  assert.equal(notice.recipient, "esi@st.umat.edu.gh", "the passenger's own address, from the booking");
  assert.equal(notice.reference, "UMX-VAC1");
  assert.match(notice.message, /seat 8/);
  assert.match(notice.message, /UMaT → Accra/);
  assert.match(notice.message, /3 Oct 2026 at 06:30/);
  assert.match(notice.message, /GHS 183\.60/);
  assert.match(notice.message, /UMX-VAC1/);

  // Reading the ticket again must not send the confirmation twice.
  await GET(request());
  assert.equal(outbox.length, 1);
});

test("the webhook cannot send a second confirmation for a booking verify already confirmed", async () => {
  const { POST } = await vite.ssrLoadModule("/app/api/payments/webhook/route.ts");
  const payload = JSON.stringify({ event: "charge.success", data: { id: 5150, reference: "ref-vac1", amount: 18360, status: "success" } });
  const response = await POST(new Request(`${URL_BASE}/api/payments/webhook`, { method: "POST", headers: { "x-paystack-signature": await signWebhook(payload) }, body: payload }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.status, "SUCCESSFUL");
  assert.equal(outbox.length, 1, "the outbox dedupe is the second line of defence behind the ledger's");
});

test("cancelling a paid booking tells the passenger; an unpaid hold is not news", async () => {
  const { DELETE } = await vite.ssrLoadModule("/app/api/admin/bookings/route.ts");
  const session = await vite.ssrLoadModule("/lib/admin-auth.ts");
  const cookie = `umx_admin_session=${encodeURIComponent(await session.createAdminSession("admin@example.com"))}`;

  const cancel = (reference) => DELETE(new Request(`${URL_BASE}/api/admin/bookings`, {
    method: "DELETE",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ reference }),
  }));

  const paid = await cancel("UMX-VAC2");
  assert.equal(paid.status, 200);
  const cancelled = outbox.filter((row) => row.template === "vacation_booking_cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].recipient, "ama@st.umat.edu.gh");
  assert.match(cancelled[0].message, /UMX-VAC2/);

  const unpaid = await cancel("UMX-VAC3");
  assert.equal(unpaid.status, 200);
  assert.equal(outbox.filter((row) => row.template === "vacation_booking_cancelled").length, 1, "a booking that was never paid for gets no message");
});

test("a signed-in passenger can open their own ticket without the payment cookie", async () => {
  const { STUDENT_SESSION_COOKIE, createStudentSession } = await vite.ssrLoadModule("/lib/student-auth.ts");
  const { GET } = await vite.ssrLoadModule("/app/api/payments/verify/route.ts");

  // No payment access cookie: the session is the only credential here.
  const cookie = `${STUDENT_SESSION_COOKIE}=${encodeURIComponent(await createStudentSession("stu-ama"))}`;
  const response = await GET(new Request(`${URL_BASE}/api/payments/verify?reference=ref-vac2`, { headers: { cookie } }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.paid, true);
  assert.equal(body.ticket.reference, "UMX-VAC2");
  assert.equal(String(body.ticket.seat), "3", "the same seat the booking carries");
});

test("another signed-in student cannot open a ticket that is not theirs", async () => {
  const { STUDENT_SESSION_COOKIE, createStudentSession } = await vite.ssrLoadModule("/lib/student-auth.ts");
  const { GET } = await vite.ssrLoadModule("/app/api/payments/verify/route.ts");

  // Kofi knows Ama's reference and has a valid account; the booking's address
  // is what refuses him, not the secrecy of the reference.
  const cookie = `${STUDENT_SESSION_COOKIE}=${encodeURIComponent(await createStudentSession("stu-kofi"))}`;
  const response = await GET(new Request(`${URL_BASE}/api/payments/verify?reference=ref-vac2`, { headers: { cookie } }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).ticket, undefined);
});

test("a guest without a payment token is still refused", async () => {
  const { GET } = await vite.ssrLoadModule("/app/api/payments/verify/route.ts");
  const response = await GET(new Request(`${URL_BASE}/api/payments/verify?reference=ref-vac2`));
  assert.equal(response.status, 403);
});
