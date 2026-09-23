import { campusAudit, type CampusAuditActorType } from "@/lib/campus-engine/audit";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { CAMPUS_NOTIFY_SUBJECTS, campusNotification, type CampusNotifyTemplate } from "@/lib/campus-engine/notify-templates";
import { applyCampusQueueTransition, releaseCampusSlots } from "@/lib/campus-engine/queue";
import { queueNotification } from "@/lib/notifications";
import { incrementMetric } from "@/lib/observability";
import { initiatePaystackRefund, verifyPaystackRefund } from "@/lib/paystack";
import { platformSettingEnabled, platformSettingNumber } from "@/lib/platform-settings";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Cancelling a campus seat, and the money that follows it.
 *
 * A passenger who paid for a seat has three ways to lose the ride: they change
 * their mind, the driver cancels on them, or nobody ever takes the seat. Before
 * this module all three left the fare with the platform and the passenger with
 * nothing to press — the queue held a `CANCELLED_BY_STUDENT` state that no code
 * could reach.
 *
 * The policy is one line, because the seat is either taken or it is not:
 *
 *   - **Nobody has taken the seat yet** — the fare goes back in full, whether
 *     the passenger cancelled or the platform never found them a driver.
 *   - **A driver has taken the seat** — the passenger may still cancel, and the
 *     fare stays, because the driver has already spent the trip coming to them.
 *
 * The same two-sided reading applies to who ended the ride. The harsh half of
 * the rule is about the passenger's own change of mind; when the driver cancels
 * or the ride closes under a seat nobody boarded, the passenger paid for a
 * journey they did not get and the whole fare goes back.
 *
 * A refund returns what the passenger actually paid, which includes the payment
 * rail's fee, so the platform absorbs that fee on any refund it causes. The
 * amount is small and the alternative — a student losing ten pesewas because the
 * platform could not find them a vehicle — is not a thing to defend.
 *
 * Money leaves through Paystack asynchronously, so a refund is `APPROVED` until
 * the rail says `processed`, and the webhook or the reconcile finishes it. The
 * unmatched sweep can approve refunds on its own: the platform is returning
 * money it already holds for a service it did not deliver, which is a different
 * act from sending a payout, and an administrator can still turn it off.
 *
 * When a driver payout ledger exists for campusRide, a refund must reverse the
 * accrual exactly as the hostel side does — see `lib/hostel-engine/refunds.ts`.
 */

export const REFUND_SCHEMA_VERSION = "2026-09-24.1";

export const CAMPUS_CANCEL_POLICY = [
  { tier: "FULL", note: "No driver has taken the seat yet, so the fare goes back in full." },
  { tier: "NONE", note: "A driver has already taken the seat, so cancelling keeps the fare." },
] as const;

export const CAMPUS_REFUND_STATUSES = ["REQUESTED", "APPROVED", "PAID", "DECLINED", "FAILED"] as const;
export type CampusRefundStatus = (typeof CAMPUS_REFUND_STATUSES)[number];

/** Who ended the ride. The passenger-facing message and the fare outcome differ. */
export type CampusRefundCause = "STUDENT" | "DRIVER" | "PLATFORM";

/** Queue statuses where the passenger is holding a seat but has not sat in it. */
export const UNBOARDED_QUEUE_STATUSES = ["PAID_WAITING", "ACCEPTED_BY_DRIVER", "DRIVER_ARRIVED"] as const;

const MAX_SWEEP_BATCH = 25;

const CAMPUS_REFUND_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS campus_refunds (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    payment_reference TEXT NOT NULL DEFAULT '',
    trip_reference TEXT NOT NULL DEFAULT '',
    passenger_email TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL DEFAULT 0,
    fare_amount INTEGER NOT NULL DEFAULT 0,
    fee_amount INTEGER NOT NULL DEFAULT 0,
    absorbed_fee INTEGER NOT NULL DEFAULT 0,
    policy TEXT NOT NULL DEFAULT 'FULL',
    cause TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'REQUESTED',
    requested_by TEXT NOT NULL DEFAULT '',
    decided_by TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL DEFAULT '',
    paystack_reference TEXT NOT NULL DEFAULT '',
    provider_status TEXT NOT NULL DEFAULT '',
    settled_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_campus_refunds_entry ON campus_refunds(entry_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_campus_refunds_status ON campus_refunds(status, created_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_refunds_provider ON campus_refunds(paystack_reference) WHERE paystack_reference <> ''",
  // One open refund per booking, enforced by the database rather than by the
  // order two taps happen to arrive in.
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_refunds_open ON campus_refunds(entry_id) WHERE status IN ('REQUESTED','APPROVED')",
];

let refundTablesReady: Promise<void> | null = null;

export function ensureCampusRefundTables() {
  refundTablesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "campusRefunds",
    version: REFUND_SCHEMA_VERSION,
    statements: CAMPUS_REFUND_STATEMENTS,
  }).catch((error: unknown) => {
    refundTablesReady = null;
    throw error;
  });
  return refundTablesReady;
}

export type CampusRefund = {
  id: string;
  entryId: string;
  reference: string;
  paymentReference: string;
  tripReference: string;
  passengerEmail: string;
  amount: number;
  fareAmount: number;
  feeAmount: number;
  absorbedFee: number;
  policy: string;
  cause: string;
  reason: string;
  status: CampusRefundStatus;
  requestedBy: string;
  decidedBy: string;
  decidedAt: string;
  paystackReference: string;
  providerStatus: string;
  settledAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CampusRefundQuote = {
  tier: "FULL" | "NONE";
  /** What goes back to the passenger; 0 when nothing is due. */
  amount: number;
  fareAmount: number;
  feeAmount: number;
  canCancel: boolean;
  blockedReason: string;
  note: string;
};

/** The queue entry fields the refund policy reads. */
export type CampusRefundableEntry = {
  id: string;
  reference: string;
  rideId: string;
  queueStatus: string;
  paymentStatus: string;
  amount: number;
  fareAmount: number;
  feeAmount: number;
  email: string;
};

function refundView(row: Record<string, unknown>): CampusRefund {
  return {
    id: String(row.id),
    entryId: String(row.entry_id || ""),
    reference: String(row.reference || ""),
    paymentReference: String(row.payment_reference || ""),
    tripReference: String(row.trip_reference || ""),
    passengerEmail: String(row.passenger_email || ""),
    amount: Number(row.amount || 0),
    fareAmount: Number(row.fare_amount || 0),
    feeAmount: Number(row.fee_amount || 0),
    absorbedFee: Number(row.absorbed_fee || 0),
    policy: String(row.policy || ""),
    cause: String(row.cause || ""),
    reason: String(row.reason || ""),
    status: String(row.status || "REQUESTED").toUpperCase() as CampusRefundStatus,
    requestedBy: String(row.requested_by || ""),
    decidedBy: String(row.decided_by || ""),
    decidedAt: String(row.decided_at || ""),
    paystackReference: String(row.paystack_reference || ""),
    providerStatus: String(row.provider_status || ""),
    settledAt: String(row.settled_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

/**
 * What cancelling would cost the passenger, in one place, so the button, the
 * confirmation and the ledger are all quoting the same policy.
 */
export function campusRefundQuote(entry: CampusRefundableEntry): CampusRefundQuote {
  const status = String(entry.queueStatus || "").toUpperCase();
  const paid = String(entry.paymentStatus || "").toUpperCase() === "SUCCESSFUL";
  const amount = paid ? Math.max(0, Math.round(Number(entry.amount || 0))) : 0;

  if (status === "BOARDED" || status === "COMPLETED") {
    return { tier: "NONE", amount: 0, fareAmount: 0, feeAmount: 0, canCancel: false, blockedReason: "You are already on board. This trip cannot be cancelled.", note: "" };
  }
  if (!(UNBOARDED_QUEUE_STATUSES as readonly string[]).includes(status)) {
    return { tier: "NONE", amount: 0, fareAmount: 0, feeAmount: 0, canCancel: false, blockedReason: "This booking is already closed.", note: "" };
  }
  if (!paid) {
    return { tier: "FULL", amount: 0, fareAmount: 0, feeAmount: 0, canCancel: true, blockedReason: "", note: "No payment was taken for this seat, so cancelling costs nothing." };
  }
  if (status === "PAID_WAITING") {
    return {
      tier: "FULL", amount,
      fareAmount: Math.max(0, Number(entry.fareAmount || 0)),
      feeAmount: Math.max(0, Number(entry.feeAmount || 0)),
      canCancel: true, blockedReason: "", note: CAMPUS_CANCEL_POLICY[0].note,
    };
  }
  return { tier: "NONE", amount: 0, fareAmount: 0, feeAmount: 0, canCancel: true, blockedReason: "", note: CAMPUS_CANCEL_POLICY[1].note };
}

/**
 * What is owed when the ride failed rather than the passenger changing their
 * mind — a driver who cancelled, a ride that closed under a seat nobody ever
 * boarded.
 *
 * `campusRefundQuote` answers "what does giving up cost me?" and is deliberately
 * harsh once a driver has claimed the seat, because the driver has already
 * spent the trip coming. When the *driver* or the *platform* is the cause that
 * reasoning inverts: the passenger paid for a journey they did not get, so the
 * whole fare goes back. Same ledger, opposite question.
 */
export function campusFailedRideQuote(entry: CampusRefundableEntry): CampusRefundQuote {
  const paid = String(entry.paymentStatus || "").toUpperCase() === "SUCCESSFUL";
  const amount = paid ? Math.max(0, Math.round(Number(entry.amount || 0))) : 0;
  return {
    tier: "FULL",
    amount,
    fareAmount: paid ? Math.max(0, Number(entry.fareAmount || 0)) : 0,
    feeAmount: paid ? Math.max(0, Number(entry.feeAmount || 0)) : 0,
    canCancel: false,
    blockedReason: "",
    note: "The ride did not happen, so the fare goes back in full.",
  };
}

/**
 * Records what a failure owes on a seat whose end has already been written by
 * someone else — the driver's cancel, the sweep. Only the ledger leg lives here;
 * the seat itself is not touched.
 */
export async function openCampusFailureRefund(input: { reference: string; cause: CampusRefundCause; actor: string; reason?: string }) {
  await ensureCampusRefundTables();
  const entry = await loadRefundableEntry(input.reference);
  if (!entry) return null;
  const quote = campusFailedRideQuote(entry);
  if (quote.amount <= 0) return null;
  const payment = rowsToObjects(await turso("SELECT reference FROM campus_payments WHERE queue_entry_id = ? ORDER BY created_at DESC LIMIT 1", [entry.id]))[0];
  return openCampusRefund({
    entry,
    quote,
    cause: input.cause,
    actor: input.actor,
    reason: String(input.reason || ""),
    paymentReference: String(payment?.reference || ""),
    nowIso: new Date().toISOString(),
  });
}

export async function listCampusRefunds(options: { status?: string; limit?: number } = {}) {
  await ensureCampusRefundTables();
  const limit = Math.max(1, Math.min(200, Math.round(options.limit || 50)));
  const status = String(options.status || "").toUpperCase();
  const rows = status
    ? await turso("SELECT * FROM campus_refunds WHERE status = ? ORDER BY created_at DESC LIMIT ?", [status, limit])
    : await turso("SELECT * FROM campus_refunds ORDER BY created_at DESC LIMIT ?", [limit]);
  return rowsToObjects(rows).map(refundView);
}

export async function getCampusRefund(refundId: string) {
  await ensureCampusRefundTables();
  const row = rowsToObjects(await turso("SELECT * FROM campus_refunds WHERE id = ? LIMIT 1", [String(refundId || "")]))[0];
  return row ? refundView(row) : null;
}

export async function latestCampusRefundForEntry(entryId: string) {
  await ensureCampusRefundTables();
  const row = rowsToObjects(await turso("SELECT * FROM campus_refunds WHERE entry_id = ? ORDER BY created_at DESC LIMIT 1", [String(entryId || "")]))[0];
  return row ? refundView(row) : null;
}

/** The entry as the refund policy needs it: the seat's state and the money behind it. */
export async function loadRefundableEntry(reference: string): Promise<(CampusRefundableEntry & { queuePosition: number }) | null> {
  const row = rowsToObjects(await turso(
    `SELECT q.id,q.reference,q.ride_id,q.queue_status,q.payment_status,q.amount,q.queue_position,COALESCE(q.email,'') AS email,
        COALESCE(p.fare_amount,0) AS fare_amount, COALESCE(p.fee_amount,0) AS fee_amount, COALESCE(p.reference,'') AS payment_reference
       FROM campus_queue_entries q
       LEFT JOIN campus_payments p ON p.queue_entry_id = q.id
       WHERE q.reference = ? LIMIT 1`,
    [String(reference || "")],
  ))[0];
  if (!row) return null;
  return {
    id: String(row.id),
    reference: String(row.reference || ""),
    rideId: String(row.ride_id || ""),
    queueStatus: String(row.queue_status || ""),
    paymentStatus: String(row.payment_status || ""),
    amount: Number(row.amount || 0),
    fareAmount: Number(row.fare_amount || 0),
    feeAmount: Number(row.fee_amount || 0),
    email: String(row.email || ""),
    queuePosition: Number(row.queue_position || 0),
    ...(row.payment_reference ? { } : {}),
  };
}

/**
 * Records what is owed. Never moves money: that is `approveCampusRefund`, so a
 * refund that is merely recorded cannot be mistaken for one that was sent.
 */
async function openCampusRefund(input: {
  entry: CampusRefundableEntry;
  quote: CampusRefundQuote;
  cause: CampusRefundCause;
  actor: string;
  reason: string;
  paymentReference: string;
  nowIso: string;
}) {
  if (input.quote.amount <= 0) return null;
  const id = crypto.randomUUID();
  const fareAmount = input.quote.fareAmount;
  const feeAmount = Math.max(0, input.quote.amount - fareAmount);
  try {
    await turso(
      `INSERT INTO campus_refunds (id,entry_id,reference,payment_reference,trip_reference,passenger_email,amount,fare_amount,fee_amount,absorbed_fee,policy,cause,reason,status,requested_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'REQUESTED',?,?,?)`,
      [id, input.entry.id, input.entry.reference, input.paymentReference, input.entry.reference, input.entry.email,
        input.quote.amount, fareAmount, input.quote.feeAmount || feeAmount, feeAmount, input.quote.tier, input.cause,
        input.reason, input.actor, input.nowIso, input.nowIso],
    );
  } catch (error) {
    // The open-refund index is the real guard: two paths that both decided the
    // passenger is owed cannot both insert, so the second one reads the first.
    if (/unique|constraint/i.test(error instanceof Error ? error.message : String(error))) {
      return latestCampusRefundForEntry(input.entry.id);
    }
    throw error;
  }
  await incrementMetric("campus_refund_opened");
  return getCampusRefund(id);
}

async function notifyPassenger(entry: { email: string; reference: string }, template: CampusNotifyTemplate, context: { amount: number; windowMinutes?: number }) {
  if (!entry.email) return;
  const notification = campusNotification(template, { driverName: "", queuePosition: 0, ...context });
  await queueNotification(turso, {
    recipient: entry.email,
    template,
    subject: CAMPUS_NOTIFY_SUBJECTS[template],
    message: notification.message,
    reference: `${entry.reference}:${template}`,
    nowIso: new Date().toISOString(),
  }).catch(() => undefined);
}

/**
 * Ends a seat. The seat goes back to the ride, the passenger is told, and any
 * fare the policy owes them is recorded — but not sent, so a cancellation can
 * never move money by itself.
 */
export async function cancelCampusQueueEntry(input: {
  entry: CampusRefundableEntry;
  paymentReference?: string;
  cause: CampusRefundCause;
  actor: string;
  actorType: CampusAuditActorType;
  reason?: string;
}) {
  await ensureCampusRefundTables();
  // Two questions, two answers: whether the seat may still be given up at all,
  // and what the passenger is owed now that it is being given up.
  const gate = campusRefundQuote(input.entry);
  if (!gate.canCancel) throw new CampusEngineError("INVALID_STATE", gate.blockedReason || "This booking can no longer be cancelled.", 409);
  const quote = input.cause === "STUDENT" ? gate : campusFailedRideQuote(input.entry);
  const stamp = new Date().toISOString();
  const next = input.cause === "DRIVER" ? "CANCELLED_BY_DRIVER" : "CANCELLED_BY_STUDENT";
  const applied = await applyCampusQueueTransition(turso, { entryId: input.entry.id, from: input.entry.queueStatus, to: next, timeColumn: "cancelled_at", nowIso: stamp });
  if (!applied) throw new CampusEngineError("INVALID_STATE", "This booking's status just changed. Refresh and try again.", 409);
  // The seat was reserved at claim time, so cancelling is what returns it.
  if (input.entry.rideId) await releaseCampusSlots(turso, { rideId: input.entry.rideId, count: 1, nowIso: stamp });
  const reason = String(input.reason || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const refund = await openCampusRefund({
    entry: input.entry,
    quote,
    cause: input.cause,
    actor: input.actor,
    reason,
    paymentReference: String(input.paymentReference || ""),
    nowIso: stamp,
  });
  await campusAudit({
    actorType: input.actorType, actorId: input.actor, action: `CANCEL_${input.cause}`,
    targetType: "campus_queue_entry", targetReference: input.entry.reference,
    details: { from: input.entry.queueStatus, to: next, tier: quote.tier, refundAmount: quote.amount, reason, refundId: refund?.id || "" },
  });
  await notifyPassenger(input.entry, "campus_cancelled", { amount: quote.amount });
  await incrementMetric("campus_cancelled");
  return { cancelled: true, status: next, quote, refund };
}

/**
 * The passenger's own cancel, on their own payment.
 */
export async function cancelCampusRideBooking(reference: string, reason: unknown, actor: string) {
  await ensureCampusRefundTables();
  const entry = await loadRefundableEntry(reference);
  if (!entry) throw new CampusEngineError("NOT_FOUND", "campusRide booking was not found.", 404);
  const payment = rowsToObjects(await turso("SELECT reference FROM campus_payments WHERE queue_entry_id = ? ORDER BY created_at DESC LIMIT 1", [entry.id]))[0];
  return cancelCampusQueueEntry({ entry, paymentReference: String(payment?.reference || ""), cause: "STUDENT", actor, actorType: "student", reason: String(reason || "") });
}

/**
 * Approves a recorded refund and asks Paystack to send it. Idempotent: a refund
 * that has already left `REQUESTED` is returned as it stands.
 */
export async function approveCampusRefund(input: { refundId: string; actor: string; note?: string }) {
  await ensureCampusRefundTables();
  const refund = await getCampusRefund(input.refundId);
  if (!refund) throw new CampusEngineError("NOT_FOUND", "That refund no longer exists.", 404);
  if (refund.status !== "REQUESTED") return refund;
  const stamp = new Date().toISOString();
  const claimed = await turso(
    "UPDATE campus_refunds SET status = 'APPROVED', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'REQUESTED'",
    [String(input.actor || ""), stamp, stamp, refund.id],
  );
  // A second approver arriving first is not an error: whoever claimed the row
  // is the one that sends it.
  if (Number(claimed.affected_row_count ?? 0) === 0) return (await getCampusRefund(refund.id)) as CampusRefund;

  await campusAudit({ actorType: "admin", actorId: input.actor, action: "CAMPUS_REFUND_APPROVE", targetType: "campus_refund", targetReference: refund.id, details: { amount: refund.amount, cause: refund.cause, note: String(input.note || "") } });
  if (!refund.paymentReference) {
    // Paid outside the rail, so the transfer is recorded by hand in the console.
    return (await getCampusRefund(refund.id)) as CampusRefund;
  }
  return sendCampusRefund(refund.id);
}

/**
 * Refusing a refund an administrator has looked at and judged not owed. The
 * policy gives a fare back when nobody took the seat, so this is the lever for
 * the case the policy cannot see — a duplicate booking, a fare already
 * returned. The passenger is told, because a silent no is the thing that turns
 * a refund into a complaint.
 */
export async function declineCampusRefund(input: { refundId: string; reason?: unknown; actor: string }) {
  await ensureCampusRefundTables();
  const refund = await getCampusRefund(input.refundId);
  if (!refund) throw new CampusEngineError("NOT_FOUND", "That refund no longer exists.", 404);
  if (refund.status !== "REQUESTED") throw new CampusEngineError("INVALID_STATE", `That refund is already ${refund.status.toLowerCase()}.`, 409);
  const reason = String(input.reason || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!reason) throw new CampusEngineError("VALIDATION_ERROR", "Say why the refund is being declined.", 400);
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE campus_refunds SET status = 'DECLINED', decided_by = ?, decided_at = ?, provider_status = ?, updated_at = ? WHERE id = ? AND status = 'REQUESTED'",
    [String(input.actor || ""), stamp, reason, stamp, refund.id],
  );
  if (refund.passengerEmail) {
    await queueNotification(turso, {
      recipient: refund.passengerEmail,
      template: "campus_refund_declined",
      subject: CAMPUS_NOTIFY_SUBJECTS.campus_refund_declined,
      message: `Refund ${refund.reference}: ${reason}`,
      reference: `campus-refund:${refund.id}:DECLINED`,
      nowIso: stamp,
    }).catch(() => undefined);
  }
  await campusAudit({ actorType: "admin", actorId: input.actor, action: "CAMPUS_REFUND_DECLINE", targetType: "campus_refund", targetReference: refund.id, details: { reason } });
  await incrementMetric("campus_refund_declined");
  return (await getCampusRefund(refund.id)) as CampusRefund;
}

/** A refund sent outside Paystack, recorded so the ledger still closes. */
export async function recordCampusRefundPayment(input: { refundId: string; reference?: unknown; actor: string; note?: unknown }) {
  await ensureCampusRefundTables();
  const refund = await getCampusRefund(input.refundId);
  if (!refund) throw new CampusEngineError("NOT_FOUND", "That refund no longer exists.", 404);
  if (!["APPROVED", "FAILED"].includes(refund.status)) {
    throw new CampusEngineError("INVALID_STATE", "Only an approved refund can be recorded as paid.", 409);
  }
  const reference = String(input.reference || "").trim().slice(0, 80);
  if (reference.length < 3) throw new CampusEngineError("VALIDATION_ERROR", "Record the reference the refund was sent under.", 400);
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE campus_refunds SET status = 'PAID', paystack_reference = ?, provider_status = ?, settled_at = ?, updated_at = ? WHERE id = ?",
    [reference, String(input.note || "RECORDED_BY_HAND").slice(0, 200), stamp, stamp, refund.id],
  );
  await campusAudit({ actorType: "admin", actorId: input.actor, action: "CAMPUS_REFUND_RECORD", targetType: "campus_refund", targetReference: refund.id, details: { reference } });
  await incrementMetric("campus_refund_settled");
  return (await getCampusRefund(refund.id)) as CampusRefund;
}

/** The Paystack leg, separated so the reconcile and the sweep can both call it. */
async function sendCampusRefund(refundId: string) {
  const refund = await getCampusRefund(refundId);
  if (!refund || refund.status !== "APPROVED") return refund;
  try {
    const sent = await initiatePaystackRefund({
      transactionReference: refund.paymentReference,
      amount: refund.amount,
      reason: refund.reason || `campusRide refund ${refund.reference}`,
    });
    const stamp = new Date().toISOString();
    const settled = sent.status === "PROCESSED";
    await turso(
      `UPDATE campus_refunds SET paystack_reference = ?, provider_status = ?, status = ?, settled_at = CASE WHEN ? = 1 THEN ? ELSE settled_at END, updated_at = ? WHERE id = ? AND status = 'APPROVED'`,
      [sent.refundReference || refund.paystackReference, sent.rawStatus || sent.status, settled ? "PAID" : "APPROVED", settled ? 1 : 0, stamp, stamp, refund.id],
    );
    if (settled) await incrementMetric("campus_refund_settled");
    return (await getCampusRefund(refund.id)) as CampusRefund;
  } catch (error) {
    // A rail hiccup is not a refused refund: the entry stays APPROVED and the
    // next reconcile tries again, with the reason recorded for the console.
    const message = error instanceof Error ? error.message : "Paystack refund failed.";
    await turso("UPDATE campus_refunds SET provider_status = ?, updated_at = ? WHERE id = ? AND status = 'APPROVED'", [`ERROR: ${message}`.slice(0, 200), new Date().toISOString(), refund.id]);
    await incrementMetric("campus_refund_send_failed");
    return (await getCampusRefund(refund.id)) as CampusRefund;
  }
}

/** Paystack's word on a refund we already asked for. */
export async function applyCampusRefundEvent(input: { event: string; reference?: string; status?: string; amount?: number }) {
  const reference = String(input.reference || "").trim();
  if (!reference) return { handled: false, reason: "MISSING_REFUND_REFERENCE" };
  await ensureCampusRefundTables();
  const row = rowsToObjects(await turso("SELECT * FROM campus_refunds WHERE paystack_reference = ? LIMIT 1", [reference]))[0];
  if (!row) return { handled: false, reason: "CAMPUS_REFUND_NOT_FOUND" };
  const refund = refundView(row);
  const status = String(input.status || "").toUpperCase();
  const stamp = new Date().toISOString();
  if (status === "PROCESSED") {
    await turso("UPDATE campus_refunds SET status = 'PAID', provider_status = ?, settled_at = ?, updated_at = ? WHERE id = ? AND status IN ('APPROVED','REQUESTED')", [status, stamp, stamp, refund.id]);
    await incrementMetric("campus_refund_settled");
    return { handled: true, status: "PAID" };
  }
  if (status === "FAILED") {
    await turso("UPDATE campus_refunds SET status = 'FAILED', provider_status = ?, updated_at = ? WHERE id = ? AND status <> 'PAID'", [status, stamp, refund.id]);
    await incrementMetric("campus_refund_failed");
    return { handled: true, status: "FAILED" };
  }
  await turso("UPDATE campus_refunds SET provider_status = ?, updated_at = ? WHERE id = ? AND status <> 'PAID'", [status || input.event, stamp, refund.id]);
  return { handled: true, status: refund.status };
}

/** Refunds that left for Paystack and have not been heard from since. */
export async function runCampusRefundReconcile(options: { limit?: number; olderThanMinutes?: number } = {}) {
  if (!(await isTursoConfiguredRuntime())) return { configured: false, checked: 0, settled: 0, failed: 0 };
  await ensureCampusRefundTables();
  const limit = Math.max(1, Math.min(MAX_SWEEP_BATCH, Math.round(options.limit || 10)));
  const cutoff = new Date(Date.now() - Math.max(1, Math.round(options.olderThanMinutes || 5)) * 60_000).toISOString();
  const pending = rowsToObjects(await turso(
    "SELECT paystack_reference FROM campus_refunds WHERE status = 'APPROVED' AND paystack_reference <> '' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?",
    [cutoff, limit],
  ));
  let settled = 0;
  let failed = 0;
  for (const row of pending) {
    const reference = String(row.paystack_reference || "");
    try {
      const status = await verifyPaystackRefund(reference);
      if (status.status === "PROCESSED") settled += 1;
      else if (status.status === "FAILED") failed += 1;
      else continue;
      await applyCampusRefundEvent({ event: "refund.reconcile", reference, status: status.status });
    } catch {
      // The rail is allowed to be unavailable; the next pass tries again.
    }
  }
  return { configured: true, checked: pending.length, settled, failed };
}

/**
 * The promise: a passenger whose seat was never taken is given their money back
 * without having to ask.
 *
 * Two cases reach here, and they are told apart by the passenger's own message:
 * nobody took the seat inside the window, or the seat was taken and the ride
 * ended before they boarded. The first is the platform's failure, the second is
 * the driver's, and neither should cost the passenger a fare.
 */
export async function runCampusUnmatchedRefundSweep(options: { limit?: number } = {}) {
  if (!(await isTursoConfiguredRuntime())) return { configured: false, refunded: 0, released: 0, amounts: 0 };
  await ensureCampusRefundTables();
  const limit = Math.max(1, Math.min(MAX_SWEEP_BATCH, Math.round(options.limit || MAX_SWEEP_BATCH)));
  const windowMinutes = Math.max(0, Math.round(await platformSettingNumber("campus_unmatched_refund_minutes")));
  const auto = await platformSettingEnabled("campus_auto_refund_unmatched");
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const placeholders = UNBOARDED_QUEUE_STATUSES.map(() => "?").join(",");
  const stale = rowsToObjects(await turso(
    `SELECT q.id,q.reference,q.ride_id,q.queue_status,q.payment_status,q.amount,q.queue_position,COALESCE(q.email,'') AS email,
        COALESCE(p.fare_amount,0) AS fare_amount, COALESCE(p.fee_amount,0) AS fee_amount, COALESCE(p.reference,'') AS payment_reference,
        COALESCE(r.status,'') AS ride_status, COALESCE(r.accepting_queue,0) AS accepting_queue
       FROM campus_queue_entries q
       JOIN campus_payments p ON p.queue_entry_id = q.id
       LEFT JOIN campus_rides r ON r.id = q.ride_id
       WHERE q.queue_status IN (${placeholders}) AND p.status = 'SUCCESSFUL'
         AND (
           (q.queue_status = 'PAID_WAITING' AND q.created_at < ?)
           OR COALESCE(r.status,'') NOT IN ('OPEN','PAUSED','FULL')
           OR COALESCE(r.accepting_queue,0) = 0
         )
       ORDER BY q.created_at ASC LIMIT ?`,
    [...UNBOARDED_QUEUE_STATUSES, cutoff, limit],
  ));

  let refunded = 0;
  let released = 0;
  let amounts = 0;
  for (const row of stale) {
    const entry: CampusRefundableEntry = {
      id: String(row.id),
      reference: String(row.reference || ""),
      rideId: String(row.ride_id || ""),
      queueStatus: String(row.queue_status || ""),
      paymentStatus: String(row.payment_status || ""),
      amount: Number(row.amount || 0),
      fareAmount: Number(row.fare_amount || 0),
      feeAmount: Number(row.fee_amount || 0),
      email: String(row.email || ""),
    };
    // A ride that ended under a passenger who had already been accepted is a
    // driver cancellation; a seat nobody ever took is the platform's.
    const nobodyTookIt = entry.queueStatus === "PAID_WAITING";
    const cause: CampusRefundCause = nobodyTookIt ? "PLATFORM" : "DRIVER";
    const quote = campusFailedRideQuote(entry);
    const stamp = new Date().toISOString();
    const next = nobodyTookIt ? "NO_DRIVER_FOUND" : "CANCELLED_BY_DRIVER";
    const applied = await applyCampusQueueTransition(turso, { entryId: entry.id, from: entry.queueStatus, to: next, timeColumn: "cancelled_at", nowIso: stamp });
    if (!applied) continue;
    released += 1;
    if (entry.rideId) await releaseCampusSlots(turso, { rideId: entry.rideId, count: 1, nowIso: stamp });
    const refund = await openCampusRefund({
      entry, quote, cause, actor: "system", reason: nobodyTookIt ? "No driver took the seat inside the window." : "The ride ended before boarding.",
      paymentReference: String(row.payment_reference || ""), nowIso: stamp,
    });
    await notifyPassenger(entry, nobodyTookIt ? "campus_no_ride" : "campus_ride_ended", { amount: quote.amount, windowMinutes });
    await campusAudit({
      actorType: "system", actorId: "campus-unmatched-sweep", action: "CAMPUS_UNMATCHED_REFUND",
      targetType: "campus_queue_entry", targetReference: entry.reference,
      details: { from: entry.queueStatus, to: next, rideStatus: String(row.ride_status || ""), refundAmount: quote.amount, refundId: refund?.id || "", autoApproved: auto },
    });
    await incrementMetric(nobodyTookIt ? "campus_unmatched_refunded" : "campus_ride_ended_refunded");
    if (refund) {
      refunded += 1;
      amounts += refund.amount;
      if (auto) await approveCampusRefund({ refundId: refund.id, actor: "campus-unmatched-sweep", note: "Automatic: the seat was never taken." });
    }
  }
  return { configured: true, refunded, released, amounts };
}
