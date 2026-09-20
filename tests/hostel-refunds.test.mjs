import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Cancellation and refunds. The policy prices a cancellation by the calendar,
 * the money moves only after a person approves it, the bed's accrual is always
 * reversed, and the booking only closes once the money is actually back. These
 * tests run the engine against a fake Turso and a fake Paystack.
 */

process.env.TURSO_DATABASE_URL = "https://hostel-refunds-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.PAYSTACK_SECRET_KEY = "sk_test_hostel_refund_key";
process.env.PAYSTACK_CURRENCY = "GHS";

const REFUND_COLUMNS = [
  "id", "booking_id", "reference", "landlord_id", "student_email", "amount", "gross_amount", "commission_amount",
  "net_amount", "policy", "percent", "override_reason", "reason", "status", "requested_by", "decided_by",
  "decided_at", "paystack_reference", "provider_status", "settled_at", "created_at", "updated_at",
];

const state = {
  refunds: [],
  bookings: new Map(),
  payouts: [],
  spaces: [],
  outbox: [],
  audits: [],
  paystack: { refunds: new Map(), created: [], refuse: "", verifyFails: false },
};

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
const affected = (count) => ok({ affected_row_count: count });
const newestFirst = (rows) => [...rows].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) return ok(empty);
  if (/^CREATE |^ALTER /.test(sql)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) return affected(1);
  if (/^UPDATE hostel_landlords SET commission_bps/.test(sql)) return affected(0);
  if (/^INSERT INTO metrics_counters/.test(sql)) return ok(table(["count"], [{ count: 1 }]));

  if (/^INSERT INTO notification_outbox/.test(sql)) {
    const [id, , recipient, template, subject, message, reference, , nowIso] = args;
    if (state.outbox.some((item) => item.reference === reference && item.template === template)) return affected(0);
    state.outbox.push({ id, recipient, template, subject, message, reference, createdAt: nowIso });
    return affected(1);
  }
  if (/^INSERT INTO admin_audit_logs/.test(sql)) {
    state.audits.push({ admin_email: args[1], action: args[2], target_type: args[3], target_reference: args[4], details: args[5] });
    return affected(1);
  }

  if (/^INSERT INTO hostel_refunds/.test(sql)) {
    const [id, bookingId, reference, landlordId, studentEmail, amount, grossAmount, commissionAmount, netAmount, policy, percent, reason, actor, createdAt, updatedAt] = args;
    if (state.refundInsertError) return { type: "error", error: { message: state.refundInsertError } };
    if (state.refunds.some((refund) => refund.booking_id === bookingId && ["REQUESTED", "APPROVED"].includes(refund.status))) {
      return { type: "error", error: { message: "UNIQUE constraint failed: idx_hostel_refunds_open" } };
    }
    state.refunds.push({
      id, booking_id: bookingId, reference, landlord_id: landlordId, student_email: studentEmail,
      amount, gross_amount: grossAmount, commission_amount: commissionAmount, net_amount: netAmount,
      policy, percent, override_reason: "", reason, status: "REQUESTED", requested_by: actor,
      decided_by: "", decided_at: "", paystack_reference: "", provider_status: "", settled_at: "",
      created_at: createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (/^SELECT id,booking_id,reference,COALESCE\(landlord_id/.test(sql)) {
    if (/WHERE paystack_reference = \? LIMIT 1/.test(sql)) {
      const row = state.refunds.find((refund) => refund.paystack_reference === args[0]);
      return ok(row ? table(REFUND_COLUMNS, [row]) : empty);
    }
    if (/WHERE id = \? LIMIT 1/.test(sql)) {
      const row = state.refunds.find((refund) => refund.id === args[0]);
      return ok(row ? table(REFUND_COLUMNS, [row]) : empty);
    }
    if (/WHERE student_email = \?/.test(sql)) {
      const rows = newestFirst(state.refunds.filter((refund) => refund.student_email === args[0])).slice(0, Number(args[1]));
      return ok(rows.length ? table(REFUND_COLUMNS, rows) : empty);
    }
    if (/WHERE booking_id = \? AND status IN \('REQUESTED','APPROVED'\)/.test(sql)) {
      const row = newestFirst(state.refunds.filter((refund) => refund.booking_id === args[0] && ["REQUESTED", "APPROVED"].includes(refund.status)))[0];
      return ok(row ? table(REFUND_COLUMNS, [row]) : empty);
    }
    if (/WHERE booking_id = \?/.test(sql)) {
      const row = newestFirst(state.refunds.filter((refund) => refund.booking_id === args[0]))[0];
      return ok(row ? table(REFUND_COLUMNS, [row]) : empty);
    }
    if (/WHERE status = \?/.test(sql)) {
      const rows = newestFirst(state.refunds.filter((refund) => refund.status === args[0])).slice(0, Number(args[1]));
      return ok(rows.length ? table(REFUND_COLUMNS, rows) : empty);
    }
    const rows = newestFirst(state.refunds).slice(0, Number(args[0]));
    return ok(rows.length ? table(REFUND_COLUMNS, rows) : empty);
  }
  if (/^UPDATE hostel_refunds SET policy = \?/.test(sql)) {
    const [policy, percent, amount, grossAmount, netAmount, overrideReason, status, decidedBy, decidedAt, paystackReference, providerStatus, settledAt, updatedAt, id] = args;
    const row = state.refunds.find((refund) => refund.id === id);
    if (row) Object.assign(row, {
      policy, percent, amount, gross_amount: grossAmount, net_amount: netAmount, override_reason: overrideReason,
      status, decided_by: decidedBy, decided_at: decidedAt, paystack_reference: paystackReference,
      provider_status: providerStatus, settled_at: settledAt, updated_at: updatedAt,
    });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE hostel_refunds SET status = 'FAILED', policy/.test(sql)) {
    const [policy, percent, amount, overrideReason, decidedBy, decidedAt, providerStatus, updatedAt, id] = args;
    const row = state.refunds.find((refund) => refund.id === id);
    if (row) Object.assign(row, {
      policy, percent, amount, override_reason: overrideReason, status: "FAILED",
      decided_by: decidedBy, decided_at: decidedAt, provider_status: providerStatus, updated_at: updatedAt,
    });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE hostel_refunds SET status = 'DECLINED'/.test(sql)) {
    const [decidedBy, decidedAt, reason, updatedAt, id] = args;
    const row = state.refunds.find((refund) => refund.id === id);
    if (row) Object.assign(row, { status: "DECLINED", decided_by: decidedBy, decided_at: decidedAt, provider_status: reason, updated_at: updatedAt });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE hostel_refunds SET status = 'PAID', paystack_reference/.test(sql)) {
    const [reference, note, settledAt, updatedAt, id] = args;
    const row = state.refunds.find((refund) => refund.id === id);
    if (row) Object.assign(row, { status: "PAID", paystack_reference: reference, provider_status: note, settled_at: settledAt, updated_at: updatedAt });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE hostel_refunds SET status = 'PAID', provider_status = 'processed'/.test(sql)) {
    const [settledAt, updatedAt, id] = args;
    const row = state.refunds.find((refund) => refund.id === id);
    if (row) Object.assign(row, { status: "PAID", provider_status: "processed", settled_at: settledAt, updated_at: updatedAt });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE hostel_refunds SET status = 'FAILED', provider_status/.test(sql)) {
    const [providerStatus, updatedAt, id] = args;
    const row = state.refunds.find((refund) => refund.id === id);
    if (row) Object.assign(row, { status: "FAILED", provider_status: providerStatus, updated_at: updatedAt });
    return affected(row ? 1 : 0);
  }

  if (/^SELECT id,space_id,status FROM hostel_bookings WHERE id = \? LIMIT 1/.test(sql)) {
    const booking = state.bookings.get(args[0]);
    return ok(booking ? table(["id", "space_id", "status"], [booking]) : empty);
  }
  if (/^SELECT total_amount FROM hostel_bookings WHERE id = \? LIMIT 1/.test(sql)) {
    const booking = state.bookings.get(args[0]);
    return ok(booking ? table(["total_amount"], [{ total_amount: booking.total_amount }]) : empty);
  }
  if (/^UPDATE hostel_bookings SET status = 'CANCELLED'/.test(sql)) {
    const booking = state.bookings.get(args[1]);
    if (booking && ["PAID", "PAYMENT_REVIEW"].includes(booking.status)) {
      booking.status = "CANCELLED";
      return affected(1);
    }
    return affected(0);
  }
  if (/^UPDATE hostel_bookings SET status = 'REFUNDED'/.test(sql)) {
    const booking = state.bookings.get(args[1]);
    if (booking) booking.status = "REFUNDED";
    return affected(booking ? 1 : 0);
  }
  if (/^UPDATE hostel_spaces SET status = 'AVAILABLE'/.test(sql)) {
    const space = state.spaces.find((entry) => entry.id === args[1]);
    if (space && ["OCCUPIED", "RESERVED"].includes(space.status)) {
      space.status = "AVAILABLE";
      return affected(1);
    }
    return affected(0);
  }
  if (/^SELECT status FROM hostel_payouts WHERE booking_id = \? LIMIT 1/.test(sql)) {
    const payout = state.payouts.find((entry) => entry.booking_id === args[0]);
    return ok(payout ? table(["status"], [payout]) : empty);
  }
  if (/^UPDATE hostel_payouts SET status = 'REVERSED'/.test(sql)) {
    const payout = state.payouts.find((entry) => entry.booking_id === args[2] && entry.status === args[3]);
    if (payout) {
      payout.status = "REVERSED";
      payout.last_error = args[0];
      return affected(1);
    }
    return affected(0);
  }

  throw new Error(`Unhandled request: ${sql.slice(0, 120)}`);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes("/v2/pipeline")) {
    const body = typeof options.body === "string" ? JSON.parse(options.body) : {};
    const results = (body.requests || []).filter((request) => request?.stmt).map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
    return { ok: true, json: async () => ({ results }) };
  }
  if (target.endsWith("/refund") && (options.method || "GET") === "POST") {
    if (state.paystack.refuse) return Response.json({ status: false, message: state.paystack.refuse }, { status: 422 });
    const payload = JSON.parse(String(options.body || "{}"));
    const sequence = state.paystack.created.length + 1;
    const refund = {
      reference: `RFD-${sequence}`,
      transaction: String(payload.transaction || ""),
      amount: Number(payload.amount || 0),
      status: "pending",
    };
    state.paystack.created.push(refund);
    state.paystack.refunds.set(refund.reference, { ...refund, reference: refund.reference });
    return Response.json({ status: true, message: "Refund queued", data: refund });
  }
  const verifyMatch = target.match(/\/refund\/([^/?]+)$/);
  if (verifyMatch) {
    if (state.paystack.verifyFails) return Response.json({ status: false, message: "Refund not found" }, { status: 404 });
    const refund = state.paystack.refunds.get(decodeURIComponent(verifyMatch[1]));
    if (!refund) return Response.json({ status: false, message: "Refund not found" }, { status: 404 });
    return Response.json({ status: true, data: refund });
  }
  return originalFetch(url, options);
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => {
  globalThis.fetch = originalFetch;
  await vite.close();
});

const {
  applyHostelRefundEvent, approveHostelRefund, declineHostelRefund, hostelRefundQuote, latestRefundForBooking,
  listHostelRefunds, listHostelRefundsForStudent, openRefundForBooking, recordHostelRefundPayment,
  requestHostelRefund, runHostelRefundReconcile,
} = await vite.ssrLoadModule("/lib/hostel-engine/refunds.ts");

const TOTAL = 500_000;
const COMMISSION = 15_000;
const NET = TOTAL - COMMISSION;
/** Sixty days out, so the default quote is the full 100% tier whenever this runs. */
const daysFromNow = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const PAID_BOOKING = {
  id: "booking-1", reference: "HL-1", spaceId: "space-1", landlordId: "landlord-1",
  studentEmail: "ama@st.umat.edu.gh", studentName: "Ama Mensah", landlordEmail: "owusu@example.com", propertyName: "Owusu Lodge",
  totalAmount: TOTAL, commissionAmount: COMMISSION, netAmount: NET, periodStartsOn: daysFromNow(60), status: "PAID",
};

beforeEach(() => {
  state.refunds.length = 0;
  state.payouts.length = 0;
  state.spaces.length = 0;
  state.outbox.length = 0;
  state.audits.length = 0;
  state.paystack.refunds.clear();
  state.paystack.created.length = 0;
  state.paystack.refuse = "";
  state.paystack.verifyFails = false;
  state.refundInsertError = "";
  state.bookings.clear();
  state.bookings.set("booking-1", { id: "booking-1", space_id: "space-1", status: "PAID", total_amount: TOTAL, commission_amount: COMMISSION, net_amount: NET });
  state.payouts.push({ booking_id: "booking-1", status: "ACCRUED", net_amount: NET, last_error: "" });
  state.spaces.push({ id: "space-1", status: "OCCUPIED" });
});

test("the policy prices the cancellation by the calendar", () => {
  // A fixed year, so the tiers are asserted against the calendar itself and
  // not against the day this suite happens to run.
  const booking = { ...PAID_BOOKING, periodStartsOn: "2026-10-01" };
  const full = hostelRefundQuote(booking, new Date("2026-08-20T09:00:00.000Z"));
  assert.equal(full.policy, "FULL");
  assert.equal(full.percent, 100);
  assert.equal(full.amount, TOTAL);
  assert.equal(full.canRequest, true);

  const half = hostelRefundQuote(booking, new Date("2026-09-15T09:00:00.000Z"));
  assert.equal(half.policy, "HALF");
  assert.equal(half.amount, TOTAL / 2);
  assert.equal(half.commissionAmount, COMMISSION / 2, "the platform gives back its share in the same proportion");
  assert.equal(half.netAmount, (TOTAL - COMMISSION) / 2);

  const none = hostelRefundQuote(booking, new Date("2026-09-28T09:00:00.000Z"));
  assert.equal(none.policy, "NONE");
  assert.equal(none.amount, 0);
  assert.equal(none.canRequest, false, "inside the last week there is nothing to return");

  const unpaid = hostelRefundQuote({ ...booking, status: "PENDING_PAYMENT" }, new Date("2026-08-20T09:00:00.000Z"));
  assert.equal(unpaid.canRequest, false);
  assert.match(unpaid.blockedReason, /paid/i);
});

test("a student asks once, and only for a paid bed", async () => {
  const refund = await requestHostelRefund({ booking: PAID_BOOKING, reason: "My plans changed.", actor: "ama@st.umat.edu.gh" });
  assert.equal(refund.status, "REQUESTED");
  assert.equal(refund.amount, TOTAL);
  assert.equal(refund.studentEmail, "ama@st.umat.edu.gh");
  assert.equal(refund.percent, 100);
  assert.equal(state.outbox.filter((item) => item.template === "hostel_refund_requested").length, 1, "the landlord hears that a bed may come back");

  await assert.rejects(
    () => requestHostelRefund({ booking: PAID_BOOKING, reason: "Again", actor: "ama@st.umat.edu.gh" }),
    (error) => error?.code === "CONFLICT" && error.status === 409,
  );
  assert.equal(state.refunds.length, 1);

  await assert.rejects(
    () => requestHostelRefund({ booking: { ...PAID_BOOKING, id: "booking-2", status: "PENDING_PAYMENT" }, reason: "Early", actor: "ama@st.umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE",
  );
  assert.equal(await openRefundForBooking("booking-1") !== null, true, "the open request is findable");
});

test("the open-refund index turns a lost race into a conflict, not a second row", async () => {
  state.refundInsertError = "UNIQUE constraint failed: idx_hostel_refunds_open";
  await assert.rejects(
    () => requestHostelRefund({ booking: PAID_BOOKING, reason: "First tap.", actor: "ama@st.umat.edu.gh" }),
    (error) => error?.code === "CONFLICT" && error.status === 409,
  );
  assert.equal(state.refunds.length, 0, "a refused insert leaves no half-written request");

  state.refundInsertError = "";
  const refund = await requestHostelRefund({ booking: PAID_BOOKING, reason: "Second tap.", actor: "ama@st.umat.edu.gh" });
  assert.equal(refund.status, "REQUESTED");
});

test("approving frees the bed, reverses the accrual and asks Paystack", async () => {
  const requested = await requestHostelRefund({ booking: PAID_BOOKING, reason: "Going home early.", actor: "ama@st.umat.edu.gh" });
  const approved = await approveHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh" });

  assert.equal(approved.status, "APPROVED", "Paystack has not confirmed yet");
  assert.equal(approved.paystackReference, "RFD-1");
  assert.equal(state.payouts[0].status, "REVERSED");
  assert.equal(state.spaces[0].status, "AVAILABLE", "the bed is free for the next student");
  assert.equal(state.bookings.get("booking-1").status, "CANCELLED");
  assert.equal(state.outbox.filter((item) => item.template === "hostel_refund_decided").length, 1);
  assert.equal(state.audits.filter((item) => item.action === "hostel_refund_approved").length, 1, "money leaving is audited");

  const settled = await applyHostelRefundEvent({ event: "refund.processed", reference: "RFD-1", status: "processed" });
  assert.equal(settled.status, "PAID");
  assert.equal((await latestRefundForBooking("booking-1")).status, "PAID");
  assert.equal(state.bookings.get("booking-1").status, "REFUNDED", "the booking closes only when the money is back");

  const again = await applyHostelRefundEvent({ event: "refund.processed", reference: "RFD-1", status: "processed" });
  assert.equal(again.status, "ALREADY_PAID", "a repeated webhook cannot double-pay");
});

test("an override is priced from the total and needs a stated reason", async () => {
  const requested = await requestHostelRefund({ booking: PAID_BOOKING, reason: "Bereavement.", actor: "ama@st.umat.edu.gh" });

  await assert.rejects(
    () => approveHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh", overridePercent: 25 }),
    (error) => error?.code === "VALIDATION_ERROR" && /why/i.test(error.message),
  );
  await assert.rejects(
    () => approveHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh", overridePercent: 140, reason: "Too much" }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  assert.equal((await listHostelRefunds({ status: "REQUESTED" })).length, 1, "a refused override leaves the request open");

  const approved = await approveHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh", overridePercent: 25, reason: "Goodwill after the burst pipe." });
  assert.equal(approved.policy, "OVERRIDE");
  assert.equal(approved.percent, 25);
  assert.equal(approved.amount, Math.floor((TOTAL * 25) / 100));
  assert.equal(approved.overrideReason, "Goodwill after the burst pipe.");
});

test("a decline needs a reason, and the student hears it", async () => {
  const requested = await requestHostelRefund({ booking: PAID_BOOKING, reason: "Changed my mind.", actor: "ama@st.umat.edu.gh" });
  await assert.rejects(
    () => declineHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh", reason: "  " }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  const declined = await declineHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh", reason: "The room was already occupied in your name." });
  assert.equal(declined.status, "DECLINED");
  assert.match(state.outbox.find((item) => item.template === "hostel_refund_decided").message, /occupied/);
  assert.equal(state.bookings.get("booking-1").status, "PAID", "a declined refund leaves the residency standing");
});

test("a refund paid outside Paystack is recorded and closes the booking", async () => {
  const requested = await requestHostelRefund({ booking: PAID_BOOKING, reason: "Paying me by MoMo.", actor: "ama@st.umat.edu.gh" });
  await approveHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh" });

  const recorded = await recordHostelRefundPayment({ refundId: requested.id, reference: "MOMO-77213", actor: "admin@umat.edu.gh" });
  assert.equal(recorded.status, "PAID");
  assert.equal(recorded.paystackReference, "MOMO-77213");
  assert.equal(state.bookings.get("booking-1").status, "REFUNDED");
  assert.equal(state.audits.filter((item) => item.action === "hostel_refund_recorded").length, 1);

  await assert.rejects(
    () => recordHostelRefundPayment({ refundId: requested.id, reference: "MOMO-77214", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE",
  );
});

test("Paystack refusing the transfer leaves the refund failed, not lost", async () => {
  const requested = await requestHostelRefund({ booking: PAID_BOOKING, reason: "Plans changed.", actor: "ama@st.umat.edu.gh" });
  state.paystack.refuse = "Insufficient balance";
  await assert.rejects(
    () => approveHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh" }),
    (error) => error?.status === 502 && /balance/i.test(error.message),
  );
  const failed = await latestRefundForBooking("booking-1");
  assert.equal(failed.status, "FAILED", "the row survives so the money can still be sent");
  assert.equal(state.spaces[0].status, "AVAILABLE", "the bed is still freed");
  assert.equal(state.payouts[0].status, "REVERSED");

  state.paystack.refuse = "";
  const recorded = await recordHostelRefundPayment({ refundId: requested.id, reference: "BANK-9001", actor: "admin@umat.edu.gh" });
  assert.equal(recorded.status, "PAID");
});

test("a refund cannot race a payout that is already in flight", async () => {
  state.payouts[0].status = "PROCESSING";
  const requested = await requestHostelRefund({ booking: PAID_BOOKING, reason: "Leaving.", actor: "ama@st.umat.edu.gh" });
  await assert.rejects(
    () => approveHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE" && /in flight/i.test(error.message),
  );
  assert.equal((await latestRefundForBooking("booking-1")).status, "REQUESTED", "the request waits for the payout to settle");
  assert.equal(state.paystack.created.length, 0);
});

test("reconcile settles an approved refund Paystack never called back about", async () => {
  const requested = await requestHostelRefund({ booking: PAID_BOOKING, reason: "Leaving.", actor: "ama@st.umat.edu.gh" });
  await approveHostelRefund({ refundId: requested.id, actor: "admin@umat.edu.gh" });
  state.paystack.refunds.get("RFD-1").status = "processed";

  const summary = await runHostelRefundReconcile({ limit: 5 });
  assert.deepEqual(summary, { scanned: 1, settled: 1, failed: 0, stillPending: 0 });
  assert.equal((await latestRefundForBooking("booking-1")).status, "PAID");
  assert.equal(state.bookings.get("booking-1").status, "REFUNDED");

  state.paystack.verifyFails = true;
  const quiet = await runHostelRefundReconcile({ limit: 5 });
  assert.equal(quiet.stillPending, 0, "a settled refund is not asked about again");
});

test("the student sees their own refunds, and the desk sees every one", async () => {
  await requestHostelRefund({ booking: PAID_BOOKING, reason: "Leaving.", actor: "ama@st.umat.edu.gh" });
  assert.equal((await listHostelRefundsForStudent("ama@st.umat.edu.gh")).length, 1);
  assert.equal((await listHostelRefundsForStudent("other@st.umat.edu.gh")).length, 0);
  const all = await listHostelRefunds();
  assert.equal(all.length, 1);
  assert.equal(all[0].reference, "HL-1");
});
