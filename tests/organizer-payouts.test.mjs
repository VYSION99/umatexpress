import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Phase 4's acceptance criteria are money rules, so these tests drive the real
 * route handlers and the accrual function against a fake Turso that holds the
 * ledger in memory. The criteria are: a confirmed booking accrues exactly one
 * entry, the split is the fare and never the pass-through fee, a release waits
 * for the gate, and a refund reverses the entry it belongs to.
 */

process.env.TURSO_DATABASE_URL = "https://payout-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret-at-least-32-chars";
process.env.PAYSTACK_SECRET_KEY = "sk_test_payout_ledger_key";
process.env.PAYSTACK_CURRENCY = "GHS";

const SCHEMA_VERSIONS = { campusRide: "2026-09-18.1", scheduledTrips: "2026-09-18.2", tripOrganizers: "2026-09-18.3", organizerPayouts: "2026-09-18.2" };
const ACCOUNT_COLUMNS = ["id", "email", "name", "phone", "role", "status", "profile_id"];

const accounts = [
  { id: "acc-admin", email: "admin@example.com", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profile_id: "", token_version: 0 },
  { id: "acc-mod", email: "mod@example.com", name: "Moderator", phone: "", role: "MODERATOR", status: "ACTIVE", profile_id: "", token_version: 0 },
  { id: "acc-a", email: "a@example.com", name: "Organizer A", phone: "0200000001", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-a", token_version: 0 },
  { id: "acc-b", email: "b@example.com", name: "Organizer B", phone: "0200000002", role: "ORGANIZER", status: "ACTIVE", profile_id: "org-b", token_version: 0 },
];

const organizerRows = [
  { id: "org-a", name: "Organizer A", phone: "0200000001", email: "a@example.com", organization: "A Travel", status: "APPROVED", kyc_status: "VERIFIED", commission_bps: 300, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
  { id: "org-b", name: "Organizer B", phone: "0200000002", email: "b@example.com", organization: "B Travel", status: "APPROVED", kyc_status: "VERIFIED", commission_bps: 300, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
  { id: "org-c", name: "Organizer C", phone: "0200000003", email: "c@example.com", organization: "C Travel", status: "APPROVED", kyc_status: "VERIFIED", commission_bps: 300, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
  { id: "org-d", name: "Organizer D", phone: "0200000004", email: "d@example.com", organization: "D Travel", status: "APPROVED", kyc_status: "PENDING", commission_bps: 300, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
];

const profiles = new Map(organizerRows.map((row) => [row.id, {
  id: row.id, kyc_status: row.kyc_status, kyc_id_type: "GHANA_CARD", kyc_id_number: "", kyc_reason: "",
  kyc_submitted_at: "", kyc_reviewed_at: "", payout_method: "MOMO", payout_account_name: row.name,
  payout_account_number: "", payout_account_last4: "", payout_updated_at: "", paystack_recipient_code: "",
}]));

const bookings = [
  // Confirmed and un-accrued: the accrual tests use these.
  { id: "bk-new1", reference: "UMX-NEW1", passenger_name: "Ama", email: "a@example.com", phone: "0244000001", seat: 3, trip_id: "trip-a", travel_date: "2026-10-03", amount: 18360, payment_status: "SUCCESSFUL", booking_status: "CONFIRMED", departure_time: "06:30", organizer_id: "org-a", commission_amount: 0, confirmed_at: "2026-09-20T10:00:00.000Z", created_at: "2026-09-20T09:58:00.000Z" },
  { id: "bk-gap", reference: "UMX-GAP1", passenger_name: "Kofi", email: "k@example.com", phone: "0244000002", seat: 4, trip_id: "trip-a", travel_date: "2026-10-03", amount: 18360, payment_status: "SUCCESSFUL", booking_status: "CONFIRMED", departure_time: "06:30", organizer_id: "org-a", commission_amount: 0, confirmed_at: "2026-09-20T11:00:00.000Z", created_at: "2026-09-20T10:58:00.000Z" },
  { id: "bk-rev", reference: "UMX-REV1", passenger_name: "Yaa", email: "y@example.com", phone: "0244000003", seat: 5, trip_id: "trip-a", travel_date: "2026-10-03", amount: 18360, payment_status: "SUCCESSFUL", booking_status: "CONFIRMED", departure_time: "06:30", organizer_id: "org-a", commission_amount: 0, confirmed_at: "2026-09-20T12:00:00.000Z", created_at: "2026-09-20T11:58:00.000Z" },
  { id: "bk-plat", reference: "UMX-PLAT", passenger_name: "Adwoa", email: "ad@example.com", phone: "0244000004", seat: 6, trip_id: "trip-plat", travel_date: "2026-10-03", amount: 18360, payment_status: "SUCCESSFUL", booking_status: "CONFIRMED", departure_time: "06:30", organizer_id: "", commission_amount: 0, confirmed_at: "2026-09-20T13:00:00.000Z", created_at: "2026-09-20T12:58:00.000Z" },
  { id: "bk-pending", reference: "UMX-PEND", passenger_name: "Kojo", email: "kj@example.com", phone: "0244000005", seat: 7, trip_id: "trip-a", travel_date: "2026-10-03", amount: 18360, payment_status: "PENDING", booking_status: "AWAITING_PAYMENT", departure_time: "06:30", organizer_id: "org-a", commission_amount: 0, confirmed_at: "", created_at: "2026-09-20T13:58:00.000Z" },
  // The booking behind the verify-route test: Paystack says success below.
  { id: "bk-verify", reference: "UMX-VER1", passenger_name: "Esi", email: "e@example.com", phone: "0244000006", seat: 8, trip_id: "trip-a", travel_date: "2026-10-03", amount: 18360, payment_status: "PENDING", booking_status: "AWAITING_PAYMENT", departure_time: "06:30", organizer_id: "org-a", commission_amount: 0, confirmed_at: "", created_at: "2026-09-20T14:00:00.000Z" },
];

const payments = [
  { id: "pay-new1", booking_id: "bk-new1", provider: "PAYSTACK", reference_id: "ref-new1", amount: 18360, fare_amount: 18000, fee_amount: 360, status: "SUCCESSFUL", currency: "GHS" },
  { id: "pay-gap", booking_id: "bk-gap", provider: "PAYSTACK", reference_id: "ref-gap", amount: 18360, fare_amount: 18000, fee_amount: 360, status: "SUCCESSFUL", currency: "GHS" },
  { id: "pay-rev", booking_id: "bk-rev", provider: "PAYSTACK", reference_id: "ref-rev", amount: 18360, fare_amount: 18000, fee_amount: 360, status: "SUCCESSFUL", currency: "GHS" },
  { id: "pay-plat", booking_id: "bk-plat", provider: "PAYSTACK", reference_id: "ref-plat", amount: 18360, fare_amount: 18000, fee_amount: 360, status: "SUCCESSFUL", currency: "GHS" },
  { id: "pay-pending", booking_id: "bk-pending", provider: "PAYSTACK", reference_id: "ref-pending", amount: 18360, fare_amount: 18000, fee_amount: 360, status: "PENDING", currency: "GHS" },
  { id: "pay-verify", booking_id: "bk-verify", provider: "PAYSTACK", reference_id: "ref-verify", amount: 18360, fare_amount: 18000, fee_amount: 360, status: "PENDING", currency: "GHS" },
];

const seatHolds = [{ id: "hold-verify", booking_id: "bk-verify", trip_id: "trip-a", travel_date: "2026-10-03", seat: 8, status: "HELD", expires_at: "2099-01-01T00:00:00.000Z", created_at: "2026-09-20T14:00:00.000Z" }];

const trips = [
  { id: "trip-a", title: "UMaT to Accra", route_from: "UMaT", route_to: "Accra", travel_date: "2026-10-03", departure_time: "06:30", arrival_time: "11:30", price: 180, capacity: 50, coach_type: "VIP Coach", tag: "Morning", amenities: '["AC"]', notes: "", active: 1, archived: 0, display_order: 1, organizer_id: "org-a", review_status: "APPROVED", created_at: "2026-09-01T00:00:00.000Z" },
  { id: "trip-plat", title: "UMaT to Accra", route_from: "UMaT", route_to: "Accra", travel_date: "2026-10-03", departure_time: "06:30", arrival_time: "11:30", price: 180, capacity: 50, coach_type: "VIP Coach", tag: "Morning", amenities: '["AC"]', notes: "", active: 1, archived: 0, display_order: 2, organizer_id: "", review_status: "APPROVED", created_at: "2026-09-01T00:00:00.000Z" },
];

// Ledger rows seeded directly so the release gate can be tested: an entry only
// becomes payable after its release date, which a fresh accrual never is.
const payouts = [
  { id: "po-a1", organizer_id: "org-a", booking_id: "bk-a1", booking_reference: "UMX-A1", trip_id: "trip-a", gross_amount: 18000, commission_amount: 540, net_amount: 17460, commission_bps: 300, release_after: "2026-01-02T00:00:00.000Z", status: "ACCRUED", batch_id: "", transfer_reference: "", released_at: "", transferred_at: "", reversed_at: "", reversed_reason: "", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
  { id: "po-a2", organizer_id: "org-a", booking_id: "bk-a2", booking_reference: "UMX-A2", trip_id: "trip-a", gross_amount: 9000, commission_amount: 270, net_amount: 8730, commission_bps: 300, release_after: "2026-01-03T00:00:00.000Z", status: "ACCRUED", batch_id: "", transfer_reference: "", released_at: "", transferred_at: "", reversed_at: "", reversed_reason: "", created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" },
  { id: "po-b1", organizer_id: "org-b", booking_id: "bk-b1", booking_reference: "UMX-B1", trip_id: "trip-a", gross_amount: 18000, commission_amount: 540, net_amount: 17460, commission_bps: 300, release_after: "2026-01-04T00:00:00.000Z", status: "ACCRUED", batch_id: "", transfer_reference: "", released_at: "", transferred_at: "", reversed_at: "", reversed_reason: "", created_at: "2026-01-03T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z" },
  // Already paid out and then refunded: the platform is out of pocket.
  { id: "po-c1", organizer_id: "org-c", booking_id: "bk-c1", booking_reference: "UMX-C1", trip_id: "trip-a", gross_amount: 18000, commission_amount: 540, net_amount: 17460, commission_bps: 300, release_after: "2026-01-05T00:00:00.000Z", status: "REVERSED", batch_id: "batch-old", transfer_reference: "TRF-OLD", released_at: "2026-01-06T00:00:00.000Z", transferred_at: "2026-01-06T00:00:00.000Z", reversed_at: "2026-02-01T00:00:00.000Z", reversed_reason: "BOOKING_CANCELLED", created_at: "2026-01-04T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z" },
  // Newly refunded before payout: no money moved, so no debt.
  { id: "po-c2", organizer_id: "org-c", booking_id: "bk-c2", booking_reference: "UMX-C2", trip_id: "trip-a", gross_amount: 9000, commission_amount: 270, net_amount: 8730, commission_bps: 300, release_after: "2026-01-07T00:00:00.000Z", status: "ACCRUED", batch_id: "", transfer_reference: "", released_at: "", transferred_at: "", reversed_at: "", reversed_reason: "", created_at: "2026-01-04T00:00:00.000Z", updated_at: "2026-01-04T00:00:00.000Z" },
];

const batches = [];
const audits = [];
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
const okRows = (count) => ok({ affected_row_count: count });

function handle(sql, args) {
  if (/^CREATE |^ALTER |^INSERT OR REPLACE INTO campus_schema_meta|^DELETE FROM organizer_payout_batches/.test(sql)) return ok(empty);
  const version = sql.match(/SELECT version FROM campus_schema_meta WHERE id = '([^']+)'/);
  if (version) return ok(table(["version"], [{ version: SCHEMA_VERSIONS[version[1]] || "0" }]));
  if (/^PRAGMA table_info\((bookings|payments|seat_holds)\)/.test(sql)) {
    const name = sql.match(/table_info\((\w+)\)/)[1];
    const columns = {
      bookings: ["id", "reference", "passenger_name", "email", "phone", "seat", "trip_id", "travel_date", "amount", "payment_status", "booking_status", "hold_expires_at", "confirmed_at", "departure_time", "organizer_id", "commission_amount", "created_at"],
      payments: ["id", "booking_id", "provider", "reference_id", "amount", "status", "fare_amount", "fee_amount"],
      seat_holds: ["id", "booking_id", "status", "expires_at"],
    }[name] || [];
    return ok(table(["name"], columns.map((column) => ({ name: column }))));
  }
  if (/AS token_version FROM console_accounts/.test(sql)) {
    const account = accounts.find((item) => item.id === args[0]);
    return ok(account ? table(["token_version"], [account]) : empty);
  }
  if (/FROM console_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    const account = accounts.find((item) => item.id === args[0]);
    return ok(account ? table(ACCOUNT_COLUMNS, [account]) : empty);
  }

  // Phase 4 accrual read: one row with the fare, the pass-through amount and the rate.
  if (/FROM bookings b\s+LEFT JOIN payments p ON p\.booking_id = b\.id/.test(sql)) {
    const booking = bookings.find((item) => item.id === args[0]);
    if (!booking) return ok(empty);
    // One booking has one successful payment; earlier attempts are ignored, the
    // same way the real query joins only on a successful one.
    const payment = payments.find((item) => item.booking_id === booking.id && item.status === "SUCCESSFUL");
    const owner = organizerRows.find((item) => item.id === booking.organizer_id);
    return ok(table(
      ["booking_id", "reference", "trip_id", "organizer_id", "travel_date", "departure_time", "booking_status", "paid_at", "fare_amount", "amount", "commission_bps"],
      [{
        booking_id: booking.id, reference: booking.reference, trip_id: booking.trip_id, organizer_id: booking.organizer_id,
        travel_date: booking.travel_date, departure_time: booking.departure_time, booking_status: booking.booking_status,
        paid_at: booking.confirmed_at || payment?.created_at || booking.created_at,
        fare_amount: payment?.fare_amount || 0, amount: payment?.amount || 0,
        commission_bps: owner?.commission_bps ?? 300,
      }],
    ));
  }
  if (/^INSERT OR IGNORE INTO organizer_payouts/.test(sql)) {
    const bookingId = String(args[2]);
    if (payouts.some((row) => row.booking_id === bookingId)) return okRows(0);
    payouts.push({
      id: String(args[0]), organizer_id: String(args[1]), booking_id: bookingId, booking_reference: String(args[3]),
      trip_id: String(args[4]), gross_amount: Number(args[5]), commission_amount: Number(args[6]), net_amount: Number(args[7]),
      commission_bps: Number(args[8]), release_after: String(args[9]), status: "ACCRUED", batch_id: "",
      transfer_reference: "", released_at: "", transferred_at: "", reversed_at: "", reversed_reason: "",
      created_at: String(args[10]), updated_at: String(args[11]),
    });
    return okRows(1);
  }
  if (/^UPDATE bookings SET commission_amount = \?/.test(sql)) {
    const booking = bookings.find((item) => item.id === args[1]);
    if (booking && booking.organizer_id) booking.commission_amount = Number(args[0]);
    return okRows(booking ? 1 : 0);
  }
  if (/^SELECT b\.id FROM bookings b/.test(sql)) {
    const limit = Number(args[0]) || 10;
    const missing = bookings
      .filter((booking) => booking.booking_status === "CONFIRMED" && booking.organizer_id)
      .filter((booking) => !payouts.some((row) => row.booking_id === booking.id))
      .slice(0, limit);
    return ok(table(["id"], missing.map((booking) => ({ id: booking.id }))));
  }
  if (/^INSERT INTO organizer_payout_batches/.test(sql)) {
    batches.push({ id: String(args[0]), organizer_id: String(args[1]), total_amount: 0, entry_count: 0, transfer_reference: String(args[2]), note: String(args[3]), created_by: String(args[4]), created_at: String(args[5]) });
    return okRows(1);
  }
  if (/^UPDATE organizer_payouts SET status = 'RELEASED'/.test(sql)) {
    let affected = 0;
    for (const row of payouts) {
      if (row.organizer_id === args[5] && row.status === "ACCRUED" && row.release_after <= String(args[6])) {
        row.status = "RELEASED";
        row.batch_id = String(args[0]);
        row.transfer_reference = String(args[1]);
        row.released_at = String(args[2]);
        row.transferred_at = String(args[3]);
        row.updated_at = String(args[4]);
        affected += 1;
      }
    }
    return okRows(affected);
  }
  if (/^SELECT COUNT\(\*\) AS entry_count, COALESCE\(SUM\(net_amount\),0\) AS total_amount FROM organizer_payouts WHERE batch_id = \?/.test(sql)) {
    const claimed = payouts.filter((row) => row.batch_id === args[0]);
    return ok(table(["entry_count", "total_amount"], [{ entry_count: claimed.length, total_amount: claimed.reduce((total, row) => total + row.net_amount, 0) }]));
  }
  if (/^UPDATE organizer_payout_batches SET total_amount = \?/.test(sql)) {
    const batch = batches.find((item) => item.id === args[2]);
    if (batch) { batch.total_amount = Number(args[0]); batch.entry_count = Number(args[1]); }
    return okRows(batch ? 1 : 0);
  }
  if (/^UPDATE organizer_payouts SET status = 'REVERSED'/.test(sql)) {
    let affected = 0;
    for (const row of payouts) {
      if (row.booking_id === args[3] && row.status !== "REVERSED") {
        row.status = "REVERSED";
        row.reversed_at = String(args[0]);
        row.reversed_reason = String(args[1]);
        row.updated_at = String(args[2]);
        affected += 1;
      }
    }
    return okRows(affected);
  }
  if (/^SELECT id,organizer_id,status,COALESCE\(released_at,''\) AS released_at FROM organizer_payouts WHERE booking_id = \? LIMIT 1/.test(sql)) {
    const row = payouts.find((item) => item.booking_id === args[0]);
    return ok(row ? table(["id", "organizer_id", "status", "released_at"], [row]) : empty);
  }
  if (/^SELECT COUNT\(\*\) AS entry_count, COALESCE\(SUM\(net_amount\),0\) AS total_amount FROM organizer_payouts WHERE organizer_id = \? AND status = 'ACCRUED'/.test(sql)) {
    const rows = payouts.filter((row) => row.organizer_id === args[0] && row.status === "ACCRUED" && row.release_after <= String(args[1]));
    return ok(table(["entry_count", "total_amount"], [{ entry_count: rows.length, total_amount: rows.reduce((total, row) => total + row.net_amount, 0) }]));
  }
  if (/^INSERT INTO admin_audit_logs/.test(sql)) {
    audits.push({ actor: String(args[1]), action: String(args[2]), target: String(args[4]), details: String(args[5]) });
    return okRows(1);
  }
  if (/^UPDATE scheduled_trips/.test(sql)) return okRows(0);
  if (/FROM scheduled_trips WHERE/.test(sql)) {
    return ok(table(
      ["id", "title", "route_from", "route_to", "travel_date", "departure_time", "arrival_time", "price", "capacity", "coach_type", "tag", "amenities", "notes", "active", "archived", "display_order", "created_at", "organizer_id", "review_status"],
      trips.map((trip) => ({ ...trip })),
    ));
  }

  // Ledger totals: the CASE sums are computed here the way the database would.
  if (/FROM organizer_payouts WHERE organizer_id = \?/.test(sql)) {
    const rows = payouts.filter((row) => row.organizer_id === args[1]);
    const now = String(args[0]);
    return ok(table(["accrued", "ready", "released", "reversed", "debt", "entries"], [{
      accrued: rows.filter((row) => ["ACCRUED", "PROCESSING", "FAILED"].includes(row.status)).reduce((total, row) => total + row.net_amount, 0),
      ready: rows.filter((row) => row.status === "ACCRUED" && !row.batch_id && row.release_after <= now).reduce((total, row) => total + row.net_amount, 0),
      released: rows.filter((row) => row.status === "RELEASED").reduce((total, row) => total + row.net_amount, 0),
      reversed: rows.filter((row) => row.status === "REVERSED").reduce((total, row) => total + row.net_amount, 0),
      debt: rows.filter((row) => row.status === "REVERSED" && row.released_at).reduce((total, row) => total + row.net_amount, 0),
      entries: rows.length,
    }]));
  }
  if (/FROM organizer_payouts GROUP BY organizer_id/.test(sql)) {
    const now = String(args[0]);
    const ids = [...new Set(payouts.map((row) => row.organizer_id))];
    return ok(table(["organizer_id", "accrued", "ready", "released", "reversed", "debt", "entries"], ids.map((id) => {
      const rows = payouts.filter((row) => row.organizer_id === id);
      return {
        organizer_id: id,
        accrued: rows.filter((row) => ["ACCRUED", "PROCESSING", "FAILED"].includes(row.status)).reduce((total, row) => total + row.net_amount, 0),
        ready: rows.filter((row) => row.status === "ACCRUED" && !row.batch_id && row.release_after <= now).reduce((total, row) => total + row.net_amount, 0),
        released: rows.filter((row) => row.status === "RELEASED").reduce((total, row) => total + row.net_amount, 0),
        reversed: rows.filter((row) => row.status === "REVERSED").reduce((total, row) => total + row.net_amount, 0),
        debt: rows.filter((row) => row.status === "REVERSED" && row.released_at).reduce((total, row) => total + row.net_amount, 0),
        entries: rows.length,
      };
    })));
  }
  if (/FROM organizer_payouts p LEFT JOIN scheduled_trips t/.test(sql)) {
    const rows = payouts.filter((row) => row.organizer_id === args[0]);
    return ok(table(
      ["id", "booking_id", "booking_reference", "trip_id", "title", "route_from", "route_to", "gross_amount", "commission_amount", "net_amount", "commission_bps", "release_after", "status", "transfer_reference", "released_at", "reversed_at", "reversed_reason", "created_at"],
      rows.map((row) => {
        const trip = trips.find((item) => item.id === row.trip_id);
        return { ...row, title: trip?.title || "", route_from: trip?.route_from || "", route_to: trip?.route_to || "" };
      }),
    ));
  }
  if (/FROM organizer_payout_batches WHERE organizer_id = \?/.test(sql)) {
    return ok(table(["id", "total_amount", "entry_count", "transfer_reference", "note", "created_by", "created_at"], batches.filter((row) => row.organizer_id === args[0])));
  }

  if (/FROM trip_organizers o LEFT JOIN console_accounts a/.test(sql)) {
    const match = /WHERE o\.id = \?/.test(sql) ? organizerRows.filter((item) => item.id === args[0]) : organizerRows;
    return ok(table(
      ["id", "name", "phone", "email", "organization", "status", "kyc_status", "commission_bps", "created_at", "updated_at", "account_id", "account_status"],
      match.map((row) => ({ ...row, account_id: "", account_status: "" })),
    ));
  }
  if (/^SELECT id,COALESCE\(kyc_status/.test(sql)) {
    const profile = profiles.get(args[0]);
    return ok(profile ? table(Object.keys(profile), [profile]) : empty);
  }

  // Payments and the verify route.
  if (/^SELECT id, booking_id, provider, reference_id, amount, status, access_token_hash FROM payments WHERE reference_id = \? LIMIT 1/.test(sql)) {
    const payment = payments.find((item) => item.reference_id === args[0]);
    return ok(payment ? table(["id", "booking_id", "provider", "reference_id", "amount", "status", "access_token_hash"], [{ ...payment, access_token_hash: payment.access_token_hash || "" }]) : empty);
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
  if (/^UPDATE payments SET status = 'FAILED'/.test(sql)) return okRows(1);
  if (/^UPDATE bookings SET payment_status = 'FAILED'/.test(sql)) return okRows(1);
  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes("api.paystack.co/transaction/verify/")) {
    return { ok: true, status: 200, json: async () => ({ status: true, data: { id: 9911, status: "success", amount: 18360, currency: "GHS", gateway_response: "Approved" } }) };
  }
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
const { accrueForBooking, backfillAccruals, releaseAfterFor, reversePayoutForBooking, splitCommission, organizerTotals } = await vite.ssrLoadModule("/lib/organizer-payouts.ts");
const { hashPaymentToken } = await vite.ssrLoadModule("/lib/payment-access.ts");
const payoutsRoute = await vite.ssrLoadModule("/app/api/console/payouts/route.ts");
const statementRoute = await vite.ssrLoadModule("/app/api/console/payouts/statement/route.ts");
const backfillRoute = await vite.ssrLoadModule("/app/api/console/payouts/backfill/route.ts");
const verifyRoute = await vite.ssrLoadModule("/app/api/payments/verify/route.ts");

const URL_BASE = "https://console.example.test";

async function cookieFor(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  return `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(await createConsoleSession({ id: account.id, role: account.role }))}`;
}

async function recordBatch(cookie, body) {
  return payoutsRoute.POST(new Request(`${URL_BASE}/api/console/payouts`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

test("the fare is split by the commission rate and the release gate is a day after the booking was paid", () => {
  assert.deepEqual(splitCommission(18000, 300), { gross: 18000, commission: 540, net: 17460 });
  // GHS 180.00 at 3%: 540 pesewas commission, 17460 net.
  assert.deepEqual(splitCommission(1, 300), { gross: 1, commission: 0, net: 1 }, "a rounding must never lose a pesewa of the net");
  assert.deepEqual(splitCommission(18000, 0), { gross: 18000, commission: 0, net: 18000 });

  assert.equal(
    releaseAfterFor("2026-09-20T13:45:00.000Z", new Date("2026-09-20T14:00:00.000Z")),
    "2026-09-21T13:45:00.000Z",
    "the gate counts from the moment the booking was paid, not from the trip",
  );
  assert.equal(
    releaseAfterFor("not-a-timestamp", new Date("2026-09-20T23:30:00.000Z")),
    "2026-09-21T23:30:00.000Z",
    "an unreadable payment time falls back to the moment the entry is written",
  );
});

test("a confirmed booking accrues exactly one entry from the fare, not the amount charged", async () => {
  const first = await accrueForBooking("bk-new1");
  assert.equal(first.status, "ACCRUED");
  assert.equal(first.gross, 18000);
  assert.equal(first.commission, 540);
  assert.equal(first.net, 17460);

  const entry = payouts.find((row) => row.booking_id === "bk-new1");
  assert.equal(entry.gross_amount, 18000, "the commission base is the fare, never the pass-through fee");
  assert.equal(entry.net_amount, 17460);
  // bk-new1 was confirmed at 2026-09-20T10:00:00.000Z, so its earnings open a day later.
  assert.equal(entry.release_after, "2026-09-21T10:00:00.000Z");
  assert.equal(bookings.find((row) => row.id === "bk-new1").commission_amount, 540, "the booking carries the resolved commission");

  // Verify and the webhook both confirm a booking; the second write is a no-op.
  const second = await accrueForBooking("bk-new1");
  assert.equal(second.status, "ALREADY_ACCRUED");
  assert.equal(payouts.filter((row) => row.booking_id === "bk-new1").length, 1, "a booking can only ever hold one ledger entry");

  assert.equal((await accrueForBooking("bk-plat")).status, "SKIPPED", "a platform-owned booking earns the platform");
  assert.equal((await accrueForBooking("bk-pending")).reason, "BOOKING_NOT_CONFIRMED");
});

test("a paid-but-unaccrued booking is rebuilt by the idempotent backfill", async () => {
  const missingBefore = bookings
    .filter((booking) => booking.booking_status === "CONFIRMED" && booking.organizer_id)
    .filter((booking) => !payouts.some((row) => row.booking_id === booking.id));
  assert.ok(missingBefore.length >= 1, "the gap this test rebuilds must exist");

  statements.length = 0;
  const result = await backfillAccruals({ limit: 5 });
  assert.equal(result.scanned, missingBefore.length, "only confirmed bookings with no ledger row are considered");
  assert.equal(result.accrued, missingBefore.length, "every gap is rebuilt");
  const rebuilt = payouts.find((row) => row.booking_id === "bk-gap");
  assert.equal(rebuilt.net_amount, 17460);

  const again = await backfillAccruals({ limit: 5 });
  assert.equal(again.accrued, 0, "running it twice must not double a ledger entry");
  assert.equal(again.scanned, 0);
});

test("paying a booking through the verify route accrues its entry", async () => {
  const token = "verify-route-token";
  payments.find((item) => item.reference_id === "ref-verify").access_token_hash = await hashPaymentToken(token);
  const request = new Request(`${URL_BASE}/api/payments/verify?reference=ref-verify`, {
    headers: { cookie: `umx_payment_access_ref-verify=${token}` },
  });
  const response = await verifyRoute.GET(request);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.paid, true);

  const booking = bookings.find((item) => item.id === "bk-verify");
  assert.equal(booking.booking_status, "CONFIRMED");
  const entry = payouts.find((row) => row.booking_id === "bk-verify");
  assert.ok(entry, "a confirmed payment must write the ledger entry");
  assert.equal(entry.net_amount, 17460);
  assert.equal(entry.organizer_id, "org-a");
});

test("an organizer's statement is scoped to the session, never a request parameter", async () => {
  statements.length = 0;
  const request = new Request(`${URL_BASE}/api/console/payouts/statement?organizerId=org-b`, {
    headers: { cookie: await cookieFor("acc-a") },
  });
  const response = await statementRoute.GET(request);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.statement.entries.every((entry) => entry.bookingId !== "bk-b1"), true, "organizer A must not see organizer B's entries");
  const read = statements.find((entry) => /FROM organizer_payouts p LEFT JOIN scheduled_trips t/.test(entry.sql));
  assert.equal(read.args[0], "org-a", "the session's organizer id wins over the query string");
});

test("recording a payout releases every ready entry and stores the transfer reference", async () => {
  statements.length = 0;
  const response = await recordBatch(await cookieFor("acc-admin"), { organizerId: "org-a", reference: "TRF-2026-01", note: "January batch" });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.batch.totalAmount, 17460 + 8730);
  assert.equal(body.batch.entryCount, 2);
  assert.equal(body.batch.transferReference, "TRF-2026-01");

  const released = payouts.filter((row) => row.organizer_id === "org-a" && row.status === "RELEASED");
  assert.equal(released.length, 2);
  assert.deepEqual(released.map((row) => row.transfer_reference), ["TRF-2026-01", "TRF-2026-01"]);
  assert.equal(payouts.find((row) => row.id === "po-b1").status, "ACCRUED", "another organizer's entries are untouched");
  assert.equal(batches[0].total_amount, 17460 + 8730);
  assert.ok(audits.some((entry) => entry.action === "ORGANIZER_PAYOUT_RECORDED"), "recording a payout is audited");

  const again = await recordBatch(await cookieFor("acc-admin"), { organizerId: "org-a", reference: "TRF-2026-01" });
  assert.equal(again.status, 409, "the same entries cannot be paid twice");
  assert.equal(batches.length, 1, "a refused batch leaves no batch row behind");
});

test("a payout batch is refused for unverified KYC and for a balance in debt", async () => {
  const moderator = await recordBatch(await cookieFor("acc-mod"), { organizerId: "org-b", reference: "TRF-MOD" });
  assert.equal(moderator.status, 403, "money leaves the platform only on an administrator's say-so");

  const unverified = await recordBatch(await cookieFor("acc-admin"), { organizerId: "org-d", reference: "TRF-D" });
  assert.equal(unverified.status, 409);
  assert.match((await unverified.json()).error, /KYC/);

  const inDebt = await recordBatch(await cookieFor("acc-admin"), { organizerId: "org-c", reference: "TRF-C" });
  assert.equal(inDebt.status, 409);
  assert.match((await inDebt.json()).error, /debt/i);
  assert.equal(payouts.find((row) => row.id === "po-c2").status, "ACCRUED", "a refused batch releases nothing");
});

test("cancelling a booking reverses its entry, and a paid-out reversal becomes debt", async () => {
  await accrueForBooking("bk-rev");
  const reversed = await reversePayoutForBooking({ bookingId: "bk-rev", reason: "BOOKING_CANCELLED", actor: "admin@example.com" });
  assert.equal(reversed.reversed, true);
  assert.equal(reversed.debtCreated, false, "money that never left the platform is un-earned, not owed back");
  const totals = await organizerTotals("org-a");
  assert.equal(totals.debt, 0);

  const paid = payouts.find((row) => row.status === "RELEASED");
  const clawback = await reversePayoutForBooking({ bookingId: paid.booking_id, reason: "BOOKING_CANCELLED", actor: "admin@example.com" });
  assert.equal(clawback.debtCreated, true);
  const owed = await organizerTotals("org-a");
  assert.equal(owed.debt, paid.net_amount, "a reversal after payout is carried as debt");
  assert.equal(owed.balance, owed.accrued - owed.debt);

  const blocked = await recordBatch(await cookieFor("acc-admin"), { organizerId: "org-a", reference: "TRF-AFTER-DEBT" });
  assert.equal(blocked.status, 409);
});

test("the admin overview lists every organizer with a balance and the backfill route is admin-only", async () => {
  const forbidden = await statementRoute.GET(new Request(`${URL_BASE}/api/console/payouts/statement`, { headers: { cookie: await cookieFor("acc-admin") } }));
  assert.equal(forbidden.status, 403, "an administrator is not an organizer");

  const overview = await payoutsRoute.GET(new Request(`${URL_BASE}/api/console/payouts`, { headers: { cookie: await cookieFor("acc-admin") } }));
  const body = await overview.json();
  assert.equal(overview.status, 200);
  const row = body.organizers.find((item) => item.organizerId === "org-b");
  assert.equal(row.totals.ready, 17460);
  assert.equal(row.totals.balance, 17460);

  const refused = await backfillRoute.POST(new Request(`${URL_BASE}/api/console/payouts/backfill`, {
    method: "POST", headers: { cookie: await cookieFor("acc-mod"), "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(refused.status, 403);
});
