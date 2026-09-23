import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Giving up a campusRide seat, and the money that follows it.
 *
 * The policy is one line — a seat nobody has taken is a seat the passenger must
 * not pay for — and these tests hold it from the outside: the quote the ticket
 * shows, the state a cancel lands in, the refund it records, and the promise
 * that a seat no driver ever took is refunded without the passenger asking.
 *
 * Nothing here moves real money. The fake Turso records the ledger, and the one
 * refund path that would call Paystack is exercised with a payment made outside
 * the rail, so the assertion is about the ledger and not the network.
 */

process.env.TURSO_DATABASE_URL = "https://campus-cancellation-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.NOTIFICATIONS_FROM_EMAIL = "rides@umatexpress.test";

const CAMPUS_SCHEMA_VERSION = "2026-09-23.2";
const REFUND_SCHEMA_VERSION = "2026-09-24.1";

const state = { entries: [], payments: [], refunds: [], audit: [], notices: [], updates: [] };

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
/** An UPDATE that matched its row: the guarded transitions read this count. */
const okOne = () => ok({ cols: [], rows: [], affected_row_count: 1 });
const entryColumns = ["id", "reference", "ride_id", "queue_status", "payment_status", "amount", "queue_position", "email", "fare_amount", "fee_amount"];
const refundColumns = ["id", "entry_id", "reference", "payment_reference", "trip_reference", "passenger_email", "amount", "fare_amount", "fee_amount", "absorbed_fee", "policy", "cause", "reason", "status", "requested_by", "decided_by", "decided_at", "paystack_reference", "provider_status", "settled_at", "created_at", "updated_at"];

function findEntry(where, value) {
  return state.entries.find((entry) => entry[where] === value);
}

/** The SQL the refund lifecycle issues, answered from the fake ledger. */
function handle(sql, args) {
  // Every schema pass short-circuits on its own marker, so a migrated database
  // never replays its CREATE statements.
  if (/^SELECT version FROM campus_schema_meta/.test(sql)) {
    const version = /'campusRefunds'/.test(sql) ? REFUND_SCHEMA_VERSION : CAMPUS_SCHEMA_VERSION;
    return ok(table(["version"], [{ version }]));
  }
  if (/FROM campus_queue_entries q\s+LEFT JOIN campus_payments p/.test(sql)) {
    const entry = findEntry("reference", args[0]);
    if (!entry) return ok(empty);
    const payment = state.payments.find((item) => item.queue_entry_id === entry.id) || {};
    return ok(table(["id", "reference", "ride_id", "queue_status", "payment_status", "amount", "queue_position", "email", "fare_amount", "fee_amount"],
      [{ ...entry, fare_amount: payment.fare_amount || 0, fee_amount: payment.fee_amount || 0 }]));
  }
  if (/p\.status AS payment_status_db/.test(sql)) {
    // The ticket's live status, joined to everything the passenger sees.
    const entry = state.entries.find((item) => (state.payments.find((payment) => payment.queue_entry_id === item.id) || {}).reference === args[0]);
    if (!entry) return ok(empty);
    const payment = state.payments.find((item) => item.queue_entry_id === entry.id) || {};
    return ok(table(
      ["id", "reference", "ride_id", "queue_position", "payment_status", "queue_status", "amount", "created_at", "accepted_at", "arrived_at", "boarded_at", "completed_at", "cancelled_at", "email", "fare_amount", "fee_amount", "payment_reference", "pickup_zone", "destination_zone", "corridor_name", "estimated_minutes", "capacity", "ride_status", "accepting_queue", "pickup_zone_id", "destination_zone_id", "current_zone_id", "current_latitude", "current_longitude", "last_location_at", "driver_name", "vehicle_label", "plate_number", "driver_zone", "pickup_latitude", "pickup_longitude", "payment_status_db", "access_token_hash"],
      [{ ...entry, fare_amount: payment.fare_amount || 0, fee_amount: payment.fee_amount || 0, payment_reference: payment.reference,
        pickup_zone: "Main Gate", destination_zone: "Lecture Area", corridor_name: "Gate to Lectures", estimated_minutes: 8,
        capacity: 6, driver_name: "", vehicle_label: "",
        // A seeded position wins over the "never reported" default.
        current_latitude: entry.current_latitude ?? 0, current_longitude: entry.current_longitude ?? 0,
        last_location_at: entry.last_location_at ?? "", current_zone_id: entry.current_zone_id ?? "elsewhere",
        plate_number: "", driver_zone: "", pickup_zone_id: "main-gate", destination_zone_id: "lecture-area",
        pickup_latitude: 5.0, pickup_longitude: 0.4,
        payment_status_db: entry.payment_status, access_token_hash: payment.access_token_hash || "" }]),
    );
  }
  if (/FROM campus_queue_entries q\s+JOIN campus_payments p ON p\.queue_entry_id = q\.id/.test(sql)) {
    // The sweep's own conditions, honoured: a seat is stale because nobody took
    // it inside the window, or because the ride it was booked on is no longer
    // taking riders.
    const cutoff = args[args.length - 2];
    const rows = state.entries
      .filter((entry) => ["PAID_WAITING", "ACCEPTED_BY_DRIVER", "DRIVER_ARRIVED"].includes(entry.queue_status))
      .filter((entry) => (state.payments.find((item) => item.queue_entry_id === entry.id) || {}).status === "SUCCESSFUL")
      .filter((entry) => (entry.queue_status === "PAID_WAITING" && entry.created_at < cutoff)
        || !["OPEN", "PAUSED", "FULL"].includes(entry.ride_status)
        || !entry.accepting_queue)
      .map((entry) => ({ ...entry, fare_amount: 0, fee_amount: 0, payment_reference: "" }));
    return ok(table([...entryColumns.slice(0, 7), "email", "fare_amount", "fee_amount", "ride_status", "accepting_queue", "payment_reference"], rows));
  }
  if (/SELECT reference FROM campus_payments WHERE queue_entry_id = \?/.test(sql)) {
    const payment = state.payments.find((item) => item.queue_entry_id === args[0]);
    return ok(payment ? table(["reference"], [{ reference: payment.reference }]) : empty);
  }
  if (/SELECT reference, access_token_hash FROM campus_payments WHERE queue_entry_id = \?/.test(sql)) {
    const payment = state.payments.find((item) => item.queue_entry_id === args[0]);
    return ok(payment ? table(["reference", "access_token_hash"], [{ reference: payment.reference, access_token_hash: payment.access_token_hash }]) : empty);
  }
  if (/^UPDATE campus_queue_entries SET queue_status = \?/.test(sql)) {
    const entry = findEntry("id", args[args.length - 2]);
    if (!entry || entry.queue_status !== args[args.length - 1]) return ok({ cols: [], rows: [], affected_row_count: 0 });
    entry.queue_status = args[0];
    const timeColumn = /, (cancelled_at|accepted_at|arrived_at|boarded_at|completed_at) = \?/.exec(sql)?.[1];
    if (timeColumn) entry[timeColumn] = args[2];
    state.updates.push({ entryId: entry.id, to: entry.queue_status, at: args[1] });
    return okOne();
  }
  if (/^UPDATE campus_rides/.test(sql)) return okOne();
  if (/^INSERT INTO campus_refunds/.test(sql)) {
    const [id, entryId, reference, paymentReference, tripReference, passengerEmail, amount, fareAmount, feeAmount, absorbedFee, policy, cause, reason, requestedBy, createdAt, updatedAt] = args;
    state.refunds.push({
      id, entry_id: entryId, reference, payment_reference: paymentReference, trip_reference: tripReference,
      passenger_email: passengerEmail, amount, fare_amount: fareAmount, fee_amount: feeAmount, absorbed_fee: absorbedFee,
      policy, cause, reason, status: "REQUESTED", requested_by: requestedBy, decided_by: "", decided_at: "",
      paystack_reference: "", provider_status: "", settled_at: "", created_at: createdAt, updated_at: updatedAt,
    });
    return okOne();
  }
  if (/^SELECT \* FROM campus_refunds WHERE id = \? LIMIT 1/.test(sql)) {
    const refund = state.refunds.find((item) => item.id === args[0]);
    return ok(refund ? table(refundColumns, [refund]) : empty);
  }
  if (/^SELECT \* FROM campus_refunds WHERE paystack_reference = \? LIMIT 1/.test(sql)) {
    const refund = state.refunds.find((item) => item.paystack_reference && item.paystack_reference === args[0]);
    return ok(refund ? table(refundColumns, [refund]) : empty);
  }
  if (/^SELECT \* FROM campus_refunds WHERE entry_id = \?/.test(sql)) {
    const refund = state.refunds.filter((item) => item.entry_id === args[0]).pop();
    return ok(refund ? table(refundColumns, [refund]) : empty);
  }
  if (/^SELECT \* FROM campus_refunds ORDER BY created_at DESC/.test(sql)) {
    return ok(table(refundColumns, [...state.refunds].reverse()));
  }
  if (/^UPDATE campus_refunds SET/.test(sql)) {
    const refund = state.refunds.find((item) => item.id === args[args.length - 1]);
    if (!refund) return ok({ cols: [], rows: [], affected_row_count: 0 });
    if (/^UPDATE campus_refunds SET status = 'APPROVED'/.test(sql)) {
      refund.status = "APPROVED"; refund.decided_by = args[0]; refund.decided_at = args[1];
    } else if (/^UPDATE campus_refunds SET status = 'DECLINED'/.test(sql)) {
      refund.status = "DECLINED"; refund.decided_by = args[0]; refund.decided_at = args[1]; refund.provider_status = args[2];
    } else if (/^UPDATE campus_refunds SET paystack_reference = \?/.test(sql)) {
      refund.paystack_reference = args[0]; refund.provider_status = args[1]; refund.status = args[2];
      if (args[3] === 1) refund.settled_at = args[4];
    } else if (/^UPDATE campus_refunds SET status = 'PAID', provider_status = \?/.test(sql)) {
      refund.status = "PAID"; refund.provider_status = args[0]; refund.settled_at = args[1];
    } else if (/^UPDATE campus_refunds SET status = 'PAID', paystack_reference = \?/.test(sql)) {
      refund.status = "PAID"; refund.paystack_reference = args[0]; refund.provider_status = args[1]; refund.settled_at = args[2];
    } else if (/^UPDATE campus_refunds SET status = 'FAILED'/.test(sql)) {
      refund.status = "FAILED"; refund.provider_status = args[0];
    } else if (/^UPDATE campus_refunds SET provider_status = \?/.test(sql)) {
      refund.provider_status = args[0];
    }
    state.updates.push({ refundId: refund.id, status: refund.status });
    return okOne();
  }
  if (/SELECT paystack_reference FROM campus_refunds WHERE status = 'APPROVED'/.test(sql)) {
    const rows = state.refunds.filter((item) => item.status === "APPROVED" && item.paystack_reference)
      .map((item) => ({ paystack_reference: item.paystack_reference }));
    return ok(table(["paystack_reference"], rows));
  }
  if (/^INSERT INTO campus_audit_logs/.test(sql)) {
    state.audit.push({ actorType: args[1], actorId: args[2], action: args[3], targetType: args[4], targetReference: args[5], details: args[6] });
    return okOne();
  }
  if (/^INSERT INTO notification_outbox/.test(sql)) {
    state.notices.push({ recipient: args[2], template: args[3], subject: args[4], message: args[5], reference: args[6] });
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

const refunds = await vite.ssrLoadModule("/lib/campus-engine/refunds.ts");
const notify = await vite.ssrLoadModule("/lib/campus-engine/notify-templates.ts");
const settings = await vite.ssrLoadModule("/lib/platform-settings.ts");
const progress = await vite.ssrLoadModule("/lib/campus-engine/progress.ts");

function seedEntry(overrides = {}) {
  const entry = {
    id: `entry-${state.entries.length + 1}`,
    reference: `UMX-CAMPUS-${state.entries.length + 1}`,
    ride_id: "ride-1",
    queue_status: "PAID_WAITING",
    payment_status: "SUCCESSFUL",
    amount: 1500,
    queue_position: 3,
    email: "ama@student.umat.edu.gh",
    // An hour old, on a ride that is still taking riders: the shape a paid seat
    // has while it waits.
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    ride_status: "OPEN",
    accepting_queue: 1,
    ...overrides,
  };
  state.entries.push(entry);
  state.payments.push({ reference: `PAY-${entry.id}`, queue_entry_id: entry.id, status: "SUCCESSFUL", fare_amount: 1400, fee_amount: 100, access_token_hash: overrides.token_hash || "" });
  return entry;
}

test("the quote is free until a driver takes the seat, and nothing is owed after boarding", () => {
  const waiting = refunds.campusRefundQuote({ id: "e", reference: "r", rideId: "x", queueStatus: "PAID_WAITING", paymentStatus: "SUCCESSFUL", amount: 1500, fareAmount: 1400, feeAmount: 100, email: "" });
  assert.equal(waiting.tier, "FULL");
  assert.equal(waiting.amount, 1500, "the passenger gets back what they paid, rail fee included");
  assert.equal(waiting.canCancel, true);

  const accepted = refunds.campusRefundQuote({ id: "e", reference: "r", rideId: "x", queueStatus: "ACCEPTED_BY_DRIVER", paymentStatus: "SUCCESSFUL", amount: 1500, fareAmount: 1400, feeAmount: 100, email: "" });
  assert.equal(accepted.tier, "NONE");
  assert.equal(accepted.amount, 0);
  assert.equal(accepted.canCancel, true, "the passenger may still give the seat up, they just do not get the fare back");

  const boarded = refunds.campusRefundQuote({ id: "e", reference: "r", rideId: "x", queueStatus: "BOARDED", paymentStatus: "SUCCESSFUL", amount: 1500, fareAmount: 1400, feeAmount: 100, email: "" });
  assert.equal(boarded.canCancel, false);
  assert.match(boarded.blockedReason, /on board/);

  const unpaid = refunds.campusRefundQuote({ id: "e", reference: "r", rideId: "x", queueStatus: "PAID_WAITING", paymentStatus: "PENDING", amount: 0, fareAmount: 0, feeAmount: 0, email: "" });
  assert.equal(unpaid.canCancel, true);
  assert.equal(unpaid.amount, 0);
});

test("the cancellation policy has exactly two tiers and both are named on the ticket", () => {
  assert.deepEqual(refunds.CAMPUS_CANCEL_POLICY.map((entry) => entry.tier), ["FULL", "NONE"]);
  assert.deepEqual([...refunds.UNBOARDED_QUEUE_STATUSES], ["PAID_WAITING", "ACCEPTED_BY_DRIVER", "DRIVER_ARRIVED"]);
});

test("cancelling a paid seat returns the seat, records the refund and tells the passenger", async () => {
  const entry = seedEntry();
  const result = await refunds.cancelCampusRideBooking(entry.reference, "Changed my mind", entry.email);

  assert.equal(result.cancelled, true);
  assert.equal(result.status, "CANCELLED_BY_STUDENT");
  assert.equal(state.entries[0].queue_status, "CANCELLED_BY_STUDENT");
  assert.equal(state.entries[0].cancelled_at && true, true, "the cancel is stamped with a time");
  assert.equal(result.refund.amount, 1500);
  assert.equal(result.refund.status, "REQUESTED", "a cancel records the refund but never sends money by itself");

  const notice = state.notices.find((item) => item.template === "campus_cancelled");
  assert.ok(notice, "the passenger is told the seat is gone");
  assert.match(notice.message, /GH₵ 15\.00/);
  assert.ok(state.audit.some((row) => row.action === "CANCEL_STUDENT"), "the cancellation is audited");
  // The seat went back to the ride.
  assert.ok(state.updates.some((row) => row.entryId === entry.id && row.to === "CANCELLED_BY_STUDENT"));
});

test("a second cancel cannot open a second refund", async () => {
  const entry = seedEntry();
  await refunds.cancelCampusRideBooking(entry.reference, "first", entry.email);
  await assert.rejects(
    () => refunds.cancelCampusRideBooking(entry.reference, "again", entry.email),
    /already closed/i,
  );
  assert.equal(state.refunds.filter((item) => item.entry_id === entry.id).length, 1);
});

test("a seat that has been boarded cannot be cancelled at all", async () => {
  const entry = seedEntry({ queue_status: "BOARDED" });
  await assert.rejects(() => refunds.cancelCampusRideBooking(entry.reference, "", entry.email), /on board/i);
  assert.equal(state.entries.find((item) => item.id === entry.id).queue_status, "BOARDED");
});

test("the unmatched sweep refunds the seats nobody will ride, and skips one that is still live", async () => {
  const stale = seedEntry({ queue_status: "PAID_WAITING", reference: "UMX-STALE-1" });
  const live = seedEntry({ queue_status: "ACCEPTED_BY_DRIVER", reference: "UMX-LIVE-1" });
  // A seat taken, then stranded when the ride closed under it: the driver's
  // failure rather than the platform's, but still not the passenger's fare.
  const stranded = seedEntry({ queue_status: "ACCEPTED_BY_DRIVER", reference: "UMX-STRANDED-1", ride_status: "CLOSED", accepting_queue: 0 });
  const result = await refunds.runCampusUnmatchedRefundSweep({ limit: 10 });

  assert.equal(result.configured, true);
  assert.equal(state.entries.find((item) => item.id === stale.id).queue_status, "NO_DRIVER_FOUND");

  const refund = state.refunds.find((item) => item.entry_id === stale.id);
  assert.ok(refund, "the unpaid-for seat is refunded without the passenger asking");
  assert.equal(refund.cause, "PLATFORM");
  assert.equal(refund.payment_reference, "", "the paid-outside-the-rail case, so no Paystack call is made");
  // Default setting is off, so the sweep records and the desk approves.
  assert.equal(refund.status, "REQUESTED");
  assert.equal(await settings.platformSettingEnabled("campus_auto_refund_unmatched"), false);
  assert.ok(state.notices.some((item) => item.template === "campus_no_ride"));

  const strandedRefund = state.refunds.find((item) => item.entry_id === stranded.id);
  assert.ok(strandedRefund, "a ride closing under a passenger who never boarded is refunded too");
  assert.equal(strandedRefund.cause, "DRIVER");
  assert.equal(Number(strandedRefund.amount), 1500, "the passenger paid for a journey they did not get");
  assert.ok(state.notices.some((item) => item.template === "campus_ride_ended"));

  assert.equal(state.entries.find((item) => item.id === live.id).queue_status, "ACCEPTED_BY_DRIVER", "a seat on a live ride is never swept");
});

test("the sweep's two causes are told apart in the passenger's message and the ledger", () => {
  const noRide = notify.campusNotification("campus_no_ride", { driverName: "", queuePosition: 0, amount: 1500, windowMinutes: 30 });
  const ended = notify.campusNotification("campus_ride_ended", { driverName: "", queuePosition: 0, amount: 1500 });
  assert.match(noRide.message, /GH₵ 15\.00/);
  assert.match(noRide.message, /30 minutes/);
  assert.match(ended.message, /ended before you boarded/);
  assert.match(notify.CAMPUS_NOTIFY_SUBJECTS.campus_no_ride, /no driver/i);
});

test("a cancellation with no fare due says so, and promises no money", () => {
  const cancelled = notify.campusNotification("campus_cancelled", { driverName: "", queuePosition: 0, amount: 0 });
  assert.match(cancelled.message, /No refund is due/);
});

test("a refund is only sent with a decision, and a decline needs a reason", async () => {
  const entry = seedEntry({ reference: "UMX-DECIDE-1" });
  const cancelled = await refunds.cancelCampusRideBooking(entry.reference, "", entry.email);

  await assert.rejects(() => refunds.declineCampusRefund({ refundId: cancelled.refund.id, reason: "", actor: "ops@umat.edu.gh" }), /why/i);
  const declined = await refunds.declineCampusRefund({ refundId: cancelled.refund.id, reason: "Duplicate booking", actor: "ops@umat.edu.gh" });
  assert.equal(declined.status, "DECLINED");
  assert.equal(declined.decidedBy, "ops@umat.edu.gh");
  assert.ok(state.notices.some((item) => item.template === "campus_refund_declined"), "a silent no is the thing that turns a refund into a complaint");
});

test("the refund desk can record a transfer it made by hand", async () => {
  const entry = seedEntry({ reference: "UMX-HAND-1" });
  const cancelled = await refunds.cancelCampusRideBooking(entry.reference, "", entry.email);
  const approved = await refunds.approveCampusRefund({ refundId: cancelled.refund.id, actor: "ops@umat.edu.gh", note: "Paid by momo" });
  // No rail reference on this refund, so approval stops at the decision.
  assert.equal(approved.status, "APPROVED");
  const recorded = await refunds.recordCampusRefundPayment({ refundId: cancelled.refund.id, reference: "MOMO-99123", actor: "ops@umat.edu.gh" });
  assert.equal(recorded.status, "PAID");
  assert.equal(recorded.paystackReference, "MOMO-99123");
  assert.ok(recorded.settledAt);
});

test("Paystack's word closes a refund, and an unknown reference is not an error", async () => {
  const entry = seedEntry({ reference: "UMX-EVENT-1" });
  const cancelled = await refunds.cancelCampusRideBooking(entry.reference, "", entry.email);
  state.refunds.find((item) => item.id === cancelled.refund.id).paystack_reference = "RFD-77";

  const processed = await refunds.applyCampusRefundEvent({ event: "refund.processed", reference: "RFD-77", status: "processed" });
  assert.equal(processed.status, "PAID");
  assert.equal(state.refunds.find((item) => item.id === cancelled.refund.id).status, "PAID");

  const unknown = await refunds.applyCampusRefundEvent({ event: "refund.processed", reference: "RFD-NOPE", status: "processed" });
  assert.equal(unknown.handled, false);
  assert.equal(unknown.reason, "CAMPUS_REFUND_NOT_FOUND");
});

test("the reconcile asks Paystack about a sent refund and survives an unreachable rail", async () => {
  const entry = seedEntry({ reference: "UMX-RECON-1" });
  const cancelled = await refunds.cancelCampusRideBooking(entry.reference, "", entry.email);
  const row = state.refunds.find((item) => item.id === cancelled.refund.id);
  row.paystack_reference = "RFD-99";
  row.status = "APPROVED";
  const result = await refunds.runCampusRefundReconcile({ limit: 5 });
  assert.equal(result.configured, true);
  assert.equal(result.checked, 1, "the refund left for Paystack and has not been heard from since");
});

test("the settings the sweep reads ship with safe defaults", async () => {
  assert.equal(await settings.platformSettingNumber("campus_unmatched_refund_minutes"), 30);
  assert.equal(await settings.platformSettingEnabled("campus_auto_refund_unmatched"), false);
  const detail = await settings.platformSettingState("campus_unmatched_refund_minutes");
  assert.match(detail.detail, /30 is the default/);
});

test("the ticket timeline has a state for a seat no driver took", () => {
  assert.equal(progress.queueProgress("NO_DRIVER_FOUND").state, "terminal");
  assert.match(progress.queueProgress("NO_DRIVER_FOUND").label, /no driver/i);
  assert.match(progress.queueProgress("CANCELLED_BY_STUDENT").hint, /fare due back/i);
});

test("the same seat costs the passenger nothing if the driver ends it, and the fare if they do", async () => {
  const byDriver = seedEntry({ reference: "UMX-DRIVER-CANCEL-1", queue_status: "ACCEPTED_BY_DRIVER" });
  const refund = await refunds.openCampusFailureRefund({ reference: byDriver.reference, cause: "DRIVER", actor: "driver-1", reason: "Van broke down" });
  assert.equal(refund.amount, 1500, "the passenger paid for a journey the driver did not deliver");
  assert.equal(refund.cause, "DRIVER");
  assert.equal(refund.status, "REQUESTED", "recorded, and sent only once the desk says so");

  const byPassenger = seedEntry({ reference: "UMX-DRIVER-CANCEL-2", queue_status: "ACCEPTED_BY_DRIVER" });
  const own = await refunds.cancelCampusRideBooking(byPassenger.reference, "changed my mind", byPassenger.email);
  assert.equal(own.refund, null, "the same seat, given up by the passenger, keeps the fare");
  assert.equal(own.quote.tier, "NONE");
});

test("the ticket's live status carries the quote the Cancel button will use", async () => {
  const { hashPaymentToken } = await vite.ssrLoadModule("/lib/payment-access.ts");
  const token = "tok-status-1";
  const entry = seedEntry({ reference: "UMX-STATUS-1" });
  const payment = state.payments.find((item) => item.queue_entry_id === entry.id);
  payment.access_token_hash = await hashPaymentToken(token);
  const statusRoute = await vite.ssrLoadModule("/app/api/campus/queue/status/route.ts");
  const response = await statusRoute.GET(new Request(`http://localhost/api/campus/queue/status?reference=${payment.reference}`, {
    headers: { cookie: `umx_payment_access_${payment.reference}=${token}` },
  }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "PAID_WAITING");
  assert.equal(payload.cancellation.tier, "FULL");
  assert.equal(payload.cancellation.amount, 1500);
  assert.equal(payload.cancellation.canCancel, true);
  assert.equal(payload.refund, null, "nothing is owed back until someone cancels");
  assert.equal(payload.pickupEta, null, "with nobody assigned there is no driver to measure");
});

test("once a driver is assigned, the ticket's ETA comes from the driver's own position", async () => {
  const { hashPaymentToken } = await vite.ssrLoadModule("/lib/payment-access.ts");
  const token = "tok-eta-1";
  const entry = seedEntry({
    reference: "UMX-ETA-1",
    queue_status: "ACCEPTED_BY_DRIVER",
    // A live fix about a kilometre north of the pickup zone, reported just now.
    current_latitude: 5.0089, current_longitude: 0.4,
    last_location_at: new Date().toISOString(),
  });
  const payment = state.payments.find((item) => item.queue_entry_id === entry.id);
  payment.access_token_hash = await hashPaymentToken(token);
  const statusRoute = await vite.ssrLoadModule("/app/api/campus/queue/status/route.ts");
  const response = await statusRoute.GET(new Request(`http://localhost/api/campus/queue/status?reference=${payment.reference}`, {
    headers: { cookie: `umx_payment_access_${payment.reference}=${token}` },
  }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.pickupEta.source, "DRIVER_POSITION");
  assert.equal(payload.pickupEta.minutes, 6, "a kilometre at 18 km/h, rounded up, plus marshalling");
  assert.equal(payload.pickupEta.label, "About 6 min");
  assert.equal(payload.status, "ACCEPTED_BY_DRIVER");
});

test("the status payload carries the quote, and the cancel route refuses a stranger", async () => {
  const { hashPaymentToken } = await vite.ssrLoadModule("/lib/payment-access.ts");
  const token = "tok-cancel-1";
  const entry = seedEntry({ reference: "UMX-ROUTE-1" });
  const payment = state.payments.find((item) => item.queue_entry_id === entry.id);
  payment.access_token_hash = await hashPaymentToken(token);
  // The cookie is keyed by the payment reference the checkout handed out, not by
  // the queue reference the ticket is shown under.
  const cookie = `umx_payment_access_${payment.reference}=${token}`;

  const cancelRoute = await vite.ssrLoadModule("/app/api/campus/queue/cancel/route.ts");
  const stranger = await cancelRoute.POST(new Request("http://localhost/api/campus/queue/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: entry.reference }),
  }));
  assert.equal(stranger.status, 403, "a booking is not cancellable without the payment token or the owner's session");

  const owner = await cancelRoute.POST(new Request("http://localhost/api/campus/queue/cancel", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ reference: entry.reference, reason: "Lecture moved" }),
  }));
  assert.equal(owner.status, 200);
  const payload = await owner.json();
  assert.equal(payload.cancelled, true);
  assert.equal(payload.cancellation.tier, "FULL");
  assert.equal(payload.refund.amount, 1500);
});
